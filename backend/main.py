"""DockerLab backend — FastAPI app that drives a (remote) Docker engine.

Run:  python main.py            (serves the UI on http://127.0.0.1:8000)
The Docker host is chosen in the app (see connection.py), or by DOCKER_HOST, e.g. ssh://gns3@192.168.56.101
"""
from __future__ import annotations

import asyncio
import logging
import io
import json
import re
from contextlib import asynccontextmanager
import os
import threading
from pathlib import Path

import docker
from docker.errors import APIError, DockerException, NotFound
from docker.transport.sshconn import SSHConnectionPool, SSHHTTPAdapter
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi import Request
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import ValidationError
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import capture
import compose
import connection
import deployer
import hostfw
import hostload
import netadmin
import paths
import images as labimages
import templates
import vmadmin
import vmshell
from models import NAME_RE, Topology

LABS_DIR = paths.LABS_DIR
LABS_DIR.mkdir(parents=True, exist_ok=True)
STATIC_DIR = paths.STATIC_DIR
MIGRATED = paths.migrate_old_labs()            # labs from backend/labs, where older versions kept them

@asynccontextmanager
async def lifespan(_app):
    yield
    # App is exiting (Ctrl+C or the window closing): stop every DockerLab lab, so
    # nothing keeps running in the VM unnoticed. DOCKERLAB_KEEP_RUNNING=1 opts out.
    if connection.active() is None:            # not connected to any Docker host
        return
    if os.environ.get("DOCKERLAB_KEEP_RUNNING") == "1":
        print("DockerLab: leaving lab containers running (DOCKERLAB_KEEP_RUNNING=1).", flush=True)
        return
    if not await asyncio.to_thread(connection.reachable):
        print(f"DockerLab: the Docker host ({connection.active()}) isn't reachable, so its lab containers "
              "were left as they are.", flush=True)
        return
    # in a daemon thread, so a host that stops answering half-way can't keep DockerLab from exiting
    out: dict = {}

    def stop():
        try:
            out["r"] = deployer.stop_everything(client())
        except Exception as e:  # noqa: BLE001
            out["e"] = getattr(e, "detail", None) or str(e) or type(e).__name__

    t = threading.Thread(target=stop, daemon=True)
    t.start()
    await asyncio.to_thread(t.join, 20)
    if "r" in out:
        r = out["r"]
        if r["stopped"]:
            n = r["stopped"]
            print(f"DockerLab: stopped {n} container{'s' if n != 1 else ''} in {', '.join(r['labs'])}.", flush=True)
        for e in r["errors"]:
            print(f"DockerLab: couldn't stop {e}", flush=True)
    else:
        print(f"DockerLab: couldn't stop lab containers on exit ({out.get('e', 'the Docker host stopped answering')}).",
              flush=True)


connection.init()                              # DOCKER_HOST from the environment, or the saved host

app = FastAPI(title="DockerLab", lifespan=lifespan)

# ---------------------------------------------------------------- docker client
# Over SSH, every Docker API connection is a session channel on ONE SSH connection,
# and OpenSSH allows only 10 sessions per connection (MaxSessions). docker-py keeps
# a separate connection pool for every distinct URL (/_ping, /containers/<id>/start,
# ...), each holding idle channels open, so the count grows with use until the VM
# refuses one: "ChannelException(2, 'Connect failed')". Fix: one shared pool per
# client, capped at POOL_SIZE, where extra requests wait instead of opening more.
POOL_SIZE = 6
_orig_get_connection = SSHHTTPAdapter.get_connection
_orig_pool_init = SSHConnectionPool.__init__


def _single_pool(self, url, proxies=None):
    return _orig_get_connection(self, "ssh://shared-pool", proxies)


def _blocking_pool_init(self, *args, **kwargs):
    _orig_pool_init(self, *args, **kwargs)
    self.block = True            # wait for a free connection; never exceed maxsize


SSHHTTPAdapter.get_connection = _single_pool
SSHConnectionPool.__init__ = _blocking_pool_init

_client: docker.DockerClient | None = None
_lock = threading.Lock()


def new_client(pool_size: int = POOL_SIZE, timeout: int = 60) -> docker.DockerClient:
    """DOCKER_HOST=ssh://... uses paramiko, or the system `ssh` binary when
    DOCKERLAB_SSH_CLIENT=1 (honours ~/.ssh/config)."""
    use_ssh = os.environ.get("DOCKERLAB_SSH_CLIENT") == "1"
    return docker.from_env(use_ssh_client=use_ssh, timeout=timeout, max_pool_size=pool_size)


def reset_client() -> None:
    """Forget the shared client, e.g. after switching to another Docker host."""
    global _client
    with _lock:
        if _client is not None:
            try:
                _client.close()
            except Exception:  # noqa: BLE001
                pass
        _client = None


NOT_CONNECTED = "Not connected to a Docker host. Press Connect in the Docker Host pane."


def _quick_ping(c: docker.DockerClient) -> None:
    """Docker's ping, but giving up after 5 s: a switched-off VM never answers, and the
    client's normal timeout (60 s) would leave every request hanging that long."""
    c.api._raise_for_status(c.api._get(c.api._url("/_ping"), timeout=5))


def _short(e: Exception) -> str:
    """One line for the UI and the log, without the traceback."""
    msg = (getattr(e, "explanation", None) or str(e) or type(e).__name__).strip()
    return msg.splitlines()[-1] if msg else type(e).__name__


def client() -> docker.DockerClient:
    """The shared client, (re)connected lazily."""
    global _client
    if connection.active() is None:
        raise HTTPException(503, NOT_CONNECTED)
    with _lock:
        if _client is not None:
            try:
                _quick_ping(_client)
                return _client
            except Exception:
                try:
                    _client.close()
                except Exception:  # noqa: BLE001
                    pass
                _client = None
        if not connection.reachable(3):
            raise HTTPException(503, f"The Docker host ({os.environ.get('DOCKER_HOST', '')}) doesn't answer. "
                                     "Is the VM running, and is this still its address?")
        try:
            _client = new_client()
            _quick_ping(_client)
            return _client
        except Exception as e:  # noqa: BLE001 — over SSH, a lost host raises paramiko/socket errors, not DockerException
            _client = None
            raise HTTPException(503, f"Cannot reach Docker engine "
                                     f"({os.environ.get('DOCKER_HOST', 'local socket')}): {_short(e)}")


# ---------------------------------------------------------------- connection
@app.get("/api/connection")
def get_connection():
    return connection.describe()


@app.post("/api/connection")
async def connect(request: Request):
    """Body: {mode: "ssh"|"local", host, user, port, auto_connect, trust?, password?, sudo_rule?}.
    Returns {"ok": true, ...}, or {"need": ...} when the user has to confirm a host key or
    give the password once."""
    b = await request.json()
    mode = "local" if b.get("mode") == "local" else "ssh"
    host, user = (b.get("host") or "").strip(), (b.get("user") or "gns3").strip()
    try:
        port = int(b.get("port") or 22)
    except ValueError:
        raise HTTPException(400, "The SSH port must be a number.")
    try:
        r = await asyncio.to_thread(connection.check, mode, host, user, port, trust=b.get("trust"),
                                    password=b.get("password"), sudo_rule=b.get("sudo_rule", True))
    except connection.ConnectError as e:
        raise HTTPException(400, str(e))
    if not r.get("ok"):
        return r
    url = connection.url_of(mode, host, user, port)
    previous = connection.active()
    connection.activate(url)
    reset_client()
    try:
        v = (await asyncio.to_thread(lambda: client().version())).get("Version")
    except HTTPException as e:
        connection.activate(previous)          # stay on the old host, and don't remember this one
        reset_client()
        raise HTTPException(400, f"Docker didn't answer on {'this computer' if mode == 'local' else host}: {e.detail}")
    # remembered (as the default and in Recent) only once Docker has answered
    connection.activate(url, remember={"mode": mode, "host": host, "user": user, "port": port,
                                       "auto_connect": bool(b.get("auto_connect", False))})
    return {"ok": True, "url": url, "version": v, "notes": r.get("notes", [])}


@app.post("/api/connection/disconnect")
def disconnect():
    connection.activate(None)
    reset_client()
    return {"ok": True}


# ---------------------------------------------------------------- engine
@app.get("/api/status")
def status():
    if connection.active() is None:
        # not an error: the user hasn't connected yet (nothing is contacted)
        return {"connected": False}
    c = client()
    try:
        v = c.version()
    except Exception as e:  # noqa: BLE001 — the host went away between the ping and this call
        reset_client()
        raise HTTPException(503, f"Cannot reach Docker engine ({os.environ.get('DOCKER_HOST', 'local socket')}): {_short(e)}")
    return {"connected": True,
            "docker_host": os.environ.get("DOCKER_HOST", "local socket"),
            "server_version": v.get("Version"), "api_version": v.get("ApiVersion"),
            "os": v.get("Os"), "arch": v.get("Arch"),
            "fixed_ifnames": deployer.supports_ifname(c),
            "wireshark": capture.wireshark_path() is not None,
            "ssh": capture.ssh_target() is not None,
            "vm": vmshell.target()}


@app.get("/api/images")
def images():
    # one request for all images (images.list() inspects each one: slow over SSH, and it
    # fails if an image is deleted in between)
    out = []
    for img in client().api.images():
        for tag in img.get("RepoTags") or []:
            if tag.startswith("<none>"):
                continue
            out.append({"tag": tag, "id": img["Id"].replace("sha256:", "")[:12],
                        "size_mb": round(img.get("Size", 0) / 1e6, 1)})
    return sorted(out, key=lambda i: i["tag"])


class PullReq(BaseModel):
    name: str


@app.post("/api/images/pull")
def pull(req: PullReq):
    name = req.name.strip()
    if ":" not in name.split("/")[-1]:
        name += ":latest"
    repo, tag = name.rsplit(":", 1)
    try:
        img = client().images.pull(repo, tag=tag)
    except APIError as e:
        raise HTTPException(400, e.explanation or str(e))
    return {"pulled": img.tags}


@app.get("/api/images/templates")
def image_templates():
    return templates.TEMPLATES


# lowercase repository path plus an optional tag, e.g. dockerlab/router:latest
TAG_RE = re.compile(r"^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?$")


class BuildReq(BaseModel):
    tag: str
    dockerfile: str


@app.post("/api/images/build")
def build_image(req: BuildReq):
    """Build an image on the engine from a Dockerfile. Can take minutes (package
    downloads), so it uses its own connection with a long timeout."""
    tag = req.tag.strip()
    if not TAG_RE.match(tag):
        raise HTTPException(400, "Image name: lowercase letters, digits and . _ - /, optionally :tag "
                                 "(e.g. dockerlab/router:latest).")
    if ":" not in tag.split("/")[-1]:
        tag += ":latest"
    client()                                   # clear error if the engine is down
    c = new_client(1, timeout=900)
    try:
        return labimages.build(c, tag, req.dockerfile)
    finally:
        c.close()


# ---------------------------------------------------------------- topologies
def _path(name: str) -> Path:
    if not NAME_RE.match(name):
        raise HTTPException(400, "bad lab name")
    return LABS_DIR / f"{name}.json"


# Lab files are UTF-8. Without an explicit encoding, Python on Windows reads them as
# cp1252, turning e.g. "→" into "â†’"; a lab saved after that kept the garbled text.
_MOJIBAKE = re.compile("[\u00c2\u00c3\u00e2][\u0080-\u00bf\u2010-\u203a\u20ac\u2122\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc]")


def _heal(text: str) -> str:
    """Undo UTF-8 text that was read as cp1252, if that's what this looks like."""
    if not _MOJIBAKE.search(text):
        return text
    try:
        return text.encode("cp1252").decode("utf-8")
    except UnicodeError:
        return text


def _heal_all(v):
    if isinstance(v, str):
        return _heal(v)
    if isinstance(v, list):
        return [_heal_all(x) for x in v]
    if isinstance(v, dict):
        return {k: _heal_all(x) for k, x in v.items()}
    return v


def read_lab(p: Path) -> Topology:
    raw = p.read_bytes()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:                 # saved in a Windows code page by some editor
        text = raw.decode("cp1252", errors="replace")
    return Topology.model_validate(_heal_all(json.loads(text)))


def write_lab(p: Path, topo: Topology) -> None:
    p.write_text(json.dumps(topo.model_dump(), indent=2, ensure_ascii=False), encoding="utf-8")


def _load(name: str) -> Topology:
    p = _path(name)
    if not p.exists():
        raise HTTPException(404, f"lab '{name}' not found")
    return read_lab(p)


@app.get("/api/about")
def about():
    migrated = MIGRATED[:]
    MIGRATED.clear()                           # say it once, not on every page load
    return {"version": paths.VERSION, "labs_dir": str(LABS_DIR), "migrated": migrated}


# ---------------------------------------------------------------- example labs
def _example(name: str) -> Path:
    p = paths.EXAMPLES_DIR / f"{name}.json"
    if not NAME_RE.match(name) or not p.exists():
        raise HTTPException(404, f"There's no example called {name}.")
    return p


@app.get("/api/examples")
def list_examples():
    out = []
    for p in sorted(paths.EXAMPLES_DIR.glob("*.json")):
        try:
            t = read_lab(p)
        except Exception:  # noqa: BLE001
            continue
        out.append({"name": p.stem, "summary": re.sub(r"[*_`#>]|\[!\w+\]", "", (t.description.strip().splitlines() or [""])[0]).strip()[:160]})
    return out


@app.post("/api/examples/{name}/copy")
def copy_example(name: str, replace: bool = False):
    """Examples ship with the app and stay as they are; you work on your own copy,
    saved in your labs folder under the example's name."""
    topo = read_lab(_example(name))
    target = _path(name)
    if target.exists() and not replace:
        raise HTTPException(409, f"You already have a lab called {name}.")
    topo.name = name
    write_lab(target, topo)
    return {"name": name}


@app.get("/api/labs")
def list_labs():
    return sorted(p.stem for p in LABS_DIR.glob("*.json"))


@app.get("/api/labs/{name}")
def get_lab(name: str):
    return _load(name)


@app.put("/api/labs/{name}")
def save_lab(name: str, topo: Topology):
    if topo.name != name:
        raise HTTPException(400, "name in body must match URL")
    local_only: list[str] = []
    try:                                       # keep Dockerfiles of built images, so the file is portable
        c = client()
        topo.images = labimages.recipes(c, topo)
        local_only = labimages.unshareable(c, topo)
    except HTTPException:                      # engine unreachable: keep what the file had, for images still used
        used = {labimages.full_tag(n.image) for n in topo.nodes}
        topo.images = {k: v for k, v in topo.images.items() if k in used}
    write_lab(_path(name), topo)
    return {"saved": name, "warnings": deployer.validate(topo), "local_only": local_only}


@app.get("/api/labs/{name}/file")
def export_lab(name: str):
    """The lab file itself, for sharing. It includes the Dockerfiles of images built in
    DockerLab, so it deploys on another VM too."""
    p = _path(name)
    if not p.exists():
        raise HTTPException(404, f"lab '{name}' not found")
    return PlainTextResponse(json.dumps(read_lab(p).model_dump(), indent=2, ensure_ascii=False),
                             media_type="application/json; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="{name}.dockerlab.json"'})


# ---------------------------------------------------------------- housekeeping
def _lab_files() -> dict[str, Topology]:
    out = {}
    for p in LABS_DIR.glob("*.json"):
        try:
            out[p.stem] = read_lab(p)
        except Exception:  # noqa: BLE001 — a broken file shouldn't hide the rest
            pass
    return out


@app.get("/api/vm/containers")
def vm_containers():
    return vmadmin.containers(client(), set(_lab_files()))


@app.delete("/api/vm/containers/{cid}")
def vm_remove_container(cid: str):
    try:
        return vmadmin.remove_container(client(), cid)
    except NotFound:
        raise HTTPException(404, "That container no longer exists.")
    except APIError as e:
        raise HTTPException(400, e.explanation or str(e))


@app.get("/api/vm/containers/{cid}/inspect")
def vm_inspect_container(cid: str):
    """`docker inspect` of a container, for the details view. The lab-file label (the
    whole lab, compressed) is replaced by its size."""
    try:
        a = client().api.inspect_container(cid)
    except NotFound:
        raise HTTPException(404, "That container no longer exists.")
    # the addresses actually set inside (for lab containers, Docker only knows the carrier ones)
    a["DockerLabInside"] = []
    if (a.get("State") or {}).get("Running"):
        try:
            res = client().containers.get(cid).exec_run(["sh", "-c", "ip -o -4 addr show 2>/dev/null"])
            for line in (res.output or b"").decode(errors="replace").splitlines():
                parts = line.split()
                if "inet" in parts and parts[1] != "lo":
                    a["DockerLabInside"].append({"ifname": parts[1].split("@")[0], "cidr": parts[parts.index("inet") + 1]})
        except Exception:  # noqa: BLE001 — a nicety
            pass
    labels = (a.get("Config") or {}).get("Labels") or {}
    if "dockerlab.lab-file" in labels:
        labels["dockerlab.lab-file"] = f"(the whole lab, compressed: {len(labels['dockerlab.lab-file'])} characters)"
    return a


# ---------------------------------------------------------------- networks
@app.get("/api/vm/networks")
def vm_networks():
    return netadmin.inventory(client(), set(_lab_files()))


@app.get("/api/vm/networks/{nid}")
def vm_network(nid: str):
    try:
        return netadmin.inspect(client(), nid)
    except NotFound:
        raise HTTPException(404, "That network no longer exists.")


@app.post("/api/vm/networks")
async def vm_create_network(request: Request):
    spec = await request.json()
    try:
        return await asyncio.to_thread(netadmin.create, client(), spec)
    except netadmin.NetError as e:
        raise HTTPException(400, str(e))


@app.delete("/api/vm/networks/{nid}")
def vm_remove_network(nid: str, disconnect: bool = False):
    try:
        return netadmin.remove(client(), nid, disconnect)
    except netadmin.NetError as e:
        raise HTTPException(409, str(e))
    except NotFound:
        raise HTTPException(404, "That network no longer exists.")
    except APIError as e:
        raise HTTPException(400, e.explanation or str(e))


@app.post("/api/vm/networks/prune")
def vm_prune_networks(scope: str = "dockerlab"):
    return netadmin.prune(client(), "all" if scope == "all" else "dockerlab")


@app.get("/api/vm/load")
def vm_load():
    """CPU and memory of the Docker host, for the Docker Host pane."""
    if connection.active() is None:
        raise HTTPException(503, NOT_CONNECTED)
    try:
        return hostload.load()
    except Exception as e:  # noqa: BLE001 — a host that went away: say so in one line
        raise HTTPException(503, f"Couldn't read the Docker host's load: {_short(e)}")


@app.get("/api/vm/load/containers")
def vm_load_containers():
    """CPU and memory per running container, busiest first, with their lab and node."""
    if connection.active() is None:
        raise HTTPException(503, NOT_CONNECTED)
    try:
        rows = hostload.containers()
        labels = {c.name: c.labels for c in client().containers.list()}
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"Couldn't read the containers' load: {_short(e)}")
    for r in rows:
        lb = labels.get(r["name"], {})
        lab = lb.get(deployer.LABEL)
        prefix = f"dl-{lab}-"
        r["lab"], r["node"] = lab, (r["name"][len(prefix):] if lab and r["name"].startswith(prefix) else None)
    return {"containers": rows}


@app.get("/api/vm/interfaces")
def vm_interfaces():
    """The Docker host's network interfaces, as suggestions for a macvlan/ipvlan parent."""
    cmd = "for i in /sys/class/net/*; do n=${i##*/}; [ -e $i/device ] && echo \"$n\"; done"
    try:
        if connection.active() and connection.active().startswith("ssh://"):
            _, out = vmshell.run(cmd, timeout=10)
        else:
            import subprocess
            out = subprocess.run(["sh", "-c", cmd], capture_output=True, text=True, timeout=10).stdout
    except Exception:  # noqa: BLE001 — only suggestions
        out = ""
    return sorted({l.strip() for l in out.splitlines() if l.strip()})


@app.get("/api/vm/images")
def vm_images():
    tags: dict[str, list[str]] = {}
    for name, topo in _lab_files().items():
        for t in {labimages.full_tag(n.image) for n in topo.nodes}:
            tags.setdefault(t, []).append(name)
    return vmadmin.images(client(), tags)


@app.get("/api/vm/image")
def vm_inspect_image(ref: str):
    """`docker inspect` of an image (by tag or id), plus its layer history and who uses it."""
    c = client()
    try:
        img = c.images.get(ref)
    except NotFound:
        raise HTTPException(404, f"{ref} isn't on the Docker host.")
    try:
        history = c.api.history(img.id)
    except APIError:
        history = []
    used_by = [{"id": x.id[:12], "name": x.name, "state": x.status}
               for x in c.containers.list(all=True) if x.image and x.image.id == img.id]
    tags = set(img.tags)
    labs = sorted(name for name, topo in _lab_files().items()
                  if tags & {labimages.full_tag(n.image) for n in topo.nodes})
    return {"attrs": img.attrs, "history": history, "containers": used_by, "labs": labs}


@app.delete("/api/vm/images/{tag:path}")
def vm_remove_image(tag: str):
    try:
        return vmadmin.remove_image(client(), tag)
    except vmadmin.InUse as e:
        raise HTTPException(409, str(e))
    except NotFound:
        raise HTTPException(404, f"{tag} isn't in the VM.")
    except APIError as e:
        raise HTTPException(400, e.explanation or str(e))


@app.post("/api/vm/images/prune")
def vm_prune_images():
    return vmadmin.prune_dangling(client())


@app.post("/api/vm/labs/{lab}/recover")
def vm_recover_lab(lab: str, overwrite: bool = False):
    p = _path(lab)
    if p.exists() and not overwrite:
        raise HTTPException(409, f"A lab file called {lab} already exists.")
    try:
        topo, exact = vmadmin.recover(client(), lab)
    except NotFound as e:
        raise HTTPException(404, str(e))
    write_lab(p, topo)
    return {"recovered": lab, "exact": exact, "nodes": len(topo.nodes), "switches": len(topo.switches),
            "cables": len(topo.links)}


@app.post("/api/labs/import")
async def import_lab(request: Request, overwrite: bool = False, rename: str = ""):
    """Add a lab from a shared lab file. If a lab with that name exists, answer 409
    with a free name to use, unless overwrite=true."""
    try:
        topo = Topology.model_validate_json(await request.body())
    except ValidationError as e:
        first = e.errors()[0]
        where = ".".join(str(x) for x in first["loc"])
        raise HTTPException(400, f"That isn't a DockerLab lab file ({where}: {first['msg']}).")
    if rename:
        topo.name = rename
        if not NAME_RE.match(rename):
            raise HTTPException(400, "bad lab name")
    if _path(topo.name).exists() and not overwrite:
        i = 2
        while _path(f"{topo.name}-{i}").exists():
            i += 1
        return JSONResponse(status_code=409, content={
            "detail": f"A lab called {topo.name} already exists.", "name": topo.name, "suggest": f"{topo.name}-{i}"})
    write_lab(_path(topo.name), topo)
    needed = sorted({labimages.full_tag(n.image) for n in topo.nodes})
    try:
        have = {t for i in client().images.list() for t in i.tags}
        missing = [t for t in needed if t not in have]
    except HTTPException:
        missing = []
    return {"imported": topo.name, "warnings": deployer.validate(topo), "images": needed,
            "missing": missing, "recipes": sorted(topo.images)}


@app.delete("/api/labs/{name}")
def delete_lab(name: str):
    p = _path(name)
    if p.exists():
        p.unlink()
    return {"deleted": name}


@app.post("/api/labs/{name}/deploy")
def deploy_lab(name: str):
    topo = _load(name)
    errors = deployer.validate(topo)
    if errors:
        return {"ok": False, "errors": errors}
    client()                                   # clear error if the engine is down
    c = new_client(1, timeout=900)             # pulls and builds can take minutes
    try:
        prepared = labimages.ensure(c, topo)
    finally:
        c.close()
    result = deployer.deploy(client(), topo)
    result["images"] = prepared
    fw = hostfw.ensure()                       # routed lab traffic must not be dropped by the host
    if fw:
        result["warnings"] = [fw]
    if prepared["errors"]:
        result["errors"] = prepared["errors"] + result.get("errors", [])
        result["ok"] = False
    return result


@app.post("/api/labs/{name}/destroy")
def destroy_lab(name: str):
    _path(name)
    return deployer.destroy(client(), name)


@app.get("/api/labs/{name}/state")
def lab_state(name: str):
    return deployer.state(client(), _load(name))


async def _with_bench_startup(request: Request, name: str):
    """The saved lab, with startup commands as they are on the bench: they run at
    every start, so an edit applies on the next start without a save or redeploy.
    The request body, if any, is {"startup": {node_id: commands}}."""
    topo = _load(name)
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 — no body
        body = None
    startup = (body or {}).get("startup") or {}
    for n in topo.nodes:
        if isinstance(startup.get(n.id), str):
            n.startup = startup[n.id]
    return topo


@app.post("/api/labs/{name}/start")
async def start_lab(name: str, request: Request):
    topo = await _with_bench_startup(request, name)
    return await asyncio.to_thread(deployer.start_all, client(), topo)


@app.post("/api/labs/{name}/stop")
def stop_lab(name: str):
    _path(name)                                   # validates the name; the file may be gone
    return deployer.stop_lab(client(), name)


@app.get("/api/running")
def running():
    return deployer.running(client())


@app.get("/api/labs/{name}/compose", response_class=PlainTextResponse)
def compose_lab(name: str):
    return PlainTextResponse(compose.to_compose(_load(name)), media_type="application/yaml", headers={
        "Content-Disposition": f'attachment; filename="{name}.compose.yaml"'})


def _port(name: str, link_id: str) -> tuple[int, str]:
    try:
        return deployer.port_ifindex(client(), _load(name), link_id)
    except deployer.CaptureError as e:
        raise HTTPException(409, str(e))


@app.get("/api/labs/{name}/links/{link_id}/capture")
def capture_command(name: str, link_id: str):
    """The capture command for running by hand. The port's interface index changes
    when the container restarts, so it's looked up now rather than shown in /state."""
    idx, container = _port(name, link_id)
    return {"command": capture.command_line(idx), "port_of": container}


@app.post("/api/labs/{name}/links/{link_id}/capture")
def capture_link(name: str, link_id: str):
    idx, container = _port(name, link_id)
    try:
        capture.start(idx)
    except RuntimeError as e:
        raise HTTPException(400, str(e))
    return {"started": True, "port_of": container}


@app.post("/api/labs/{name}/nodes/{node_id}/{action}")
async def node_action(name: str, node_id: str, action: str, request: Request):
    if action not in ("start", "stop", "restart"):
        raise HTTPException(400, "action must be start, stop or restart")
    topo = await _with_bench_startup(request, name)
    try:
        return await asyncio.to_thread(deployer.node_action, client(), topo, node_id, action)
    except KeyError:
        raise HTTPException(404, "no such node")
    except NotFound:
        raise HTTPException(409, "container not deployed yet")
    except APIError as e:
        raise HTTPException(400, e.explanation or str(e))


# ---------------------------------------------------------------- console
SHELL = ["sh", "-c", "if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi"]


@app.websocket("/api/labs/{name}/nodes/{node_id}/console")
async def console(ws: WebSocket, name: str, node_id: str):
    """Interactive shell: browser <-> WebSocket <-> `docker exec -it` socket.
    Binary frames carry terminal bytes; text frames carry JSON control messages."""
    await ws.accept()
    c = None
    try:
        client()                                   # fail fast with a clear error if the engine is down
        # each console gets its own connection, so open consoles never use up the
        # shared connection's session budget (see POOL_SIZE). Pool of 2: the terminal
        # stream holds one connection for good; resize requests need the other.
        c = await asyncio.to_thread(new_client, 2)
        topo = _load(name)
        node = next((n for n in topo.nodes if n.id == node_id), None)
        if node is None:
            raise RuntimeError("This node isn't in the saved lab. Save and deploy first.")
        container = deployer.node_container(c, name, node.id)
        if container is None:
            raise RuntimeError(f"{node.name} isn't deployed. Deploy the lab first.")
        if container.status != "running":
            raise RuntimeError(f"{node.name} is {container.status}. Start it first.")
        exec_id = c.api.exec_create(container.id, SHELL, stdin=True, tty=True,
                                    environment={"TERM": "xterm-256color"})["Id"]
        sock = c.api.exec_start(exec_id, socket=True, tty=True)
    except Exception as e:  # noqa: BLE001 — shown in the terminal
        detail = getattr(e, "detail", None) or getattr(e, "explanation", None) or str(e) or type(e).__name__
        await ws.send_text(json.dumps({"error": detail}))
        await ws.close()
        if c is not None:
            c.close()
        return

    raw = getattr(sock, "_sock", sock)          # unix/npipe socket, paramiko channel or ssh socket
    loop = asyncio.get_running_loop()
    closed = threading.Event()

    def pump():                                 # container -> browser
        try:
            while not closed.is_set():
                data = raw.recv(4096)
                if not data:
                    break
                asyncio.run_coroutine_threadsafe(ws.send_bytes(data), loop).result()
        except Exception:  # noqa: BLE001
            pass
        finally:
            closed.set()
            asyncio.run_coroutine_threadsafe(_close_quietly(ws), loop)

    threading.Thread(target=pump, daemon=True).start()
    try:
        while not closed.is_set():
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if msg.get("bytes") is not None:
                await asyncio.to_thread(raw.sendall, msg["bytes"])
            elif msg.get("text"):
                ctl = json.loads(msg["text"])
                if "resize" in ctl:
                    cols, rows = ctl["resize"]
                    await asyncio.to_thread(c.api.exec_resize, exec_id, height=rows, width=cols)
    except (WebSocketDisconnect, RuntimeError, OSError):
        pass
    finally:
        closed.set()
        for thing in (raw, sock, c):               # channel, its wrapper, then the SSH connection
            try:
                thing.close()
            except Exception:  # noqa: BLE001
                pass


@app.websocket("/api/vm/console")
async def vm_console(ws: WebSocket):
    """Interactive shell on the Docker host (the GNS3 VM), same framing as the
    container console: binary frames are terminal bytes, text frames JSON control."""
    await ws.accept()
    try:
        client_, chan = await asyncio.to_thread(vmshell.open_shell)
    except vmshell.VMShellError as e:
        await ws.send_text(json.dumps({"error": str(e)}))
        await ws.close()
        return

    loop = asyncio.get_running_loop()
    closed = threading.Event()

    def pump():                                 # VM -> browser
        try:
            while not closed.is_set():
                data = chan.recv(4096)
                if not data:
                    break
                asyncio.run_coroutine_threadsafe(ws.send_bytes(data), loop).result()
        except Exception:  # noqa: BLE001
            pass
        finally:
            closed.set()
            asyncio.run_coroutine_threadsafe(_close_quietly(ws), loop)

    threading.Thread(target=pump, daemon=True).start()
    try:
        while not closed.is_set():
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if msg.get("bytes") is not None:
                await asyncio.to_thread(chan.sendall, msg["bytes"])
            elif msg.get("text"):
                ctl = json.loads(msg["text"])
                if "resize" in ctl:
                    cols, rows = ctl["resize"]
                    await asyncio.to_thread(chan.resize_pty, width=cols, height=rows)
    except (WebSocketDisconnect, RuntimeError, OSError):
        pass
    finally:
        closed.set()
        for thing in (chan, client_):
            try:
                thing.close()
            except Exception:  # noqa: BLE001
                pass


async def _close_quietly(ws: WebSocket):
    try:
        await ws.close()
    except Exception:  # noqa: BLE001
        pass


# ---------------------------------------------------------------- UI
if STATIC_DIR.exists():
    # registered last, so every /api route above takes precedence
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="ui")


if __name__ == "__main__":
    import signal
    import sys
    import time

    import uvicorn

    class Server(uvicorn.Server):
        """Uvicorn server that says *why* it is stopping. A signal right after
        start-up usually comes from the terminal, not from the person."""
        def handle_exit(self, sig, frame):
            HANDLED.append(sig)
            name = signal.Signals(sig).name
            age = time.monotonic() - T0
            print(f"DockerLab: received {name} {age:.1f}s after start; stopping.", flush=True)
            if age < 5:
                print("DockerLab: if you didn't press Ctrl+C, the terminal or another program sent this. "
                      "Start it again; if it keeps happening, try a plain PowerShell or cmd window.", flush=True)
            super().handle_exit(sig, frame)

    T0 = time.monotonic()
    HANDLED: list[int] = []
    host = os.environ.get("DOCKERLAB_BIND", "127.0.0.1")
    port = int(os.environ.get("DOCKERLAB_PORT", "8000"))
    print(f"DockerLab {paths.VERSION}: Python {sys.version.split()[0]}, labs in {LABS_DIR}", flush=True)
    if MIGRATED:
        print(f"DockerLab: copied {len(MIGRATED)} lab{'s' if len(MIGRATED) != 1 else ''} from backend/labs (where older versions kept them): "
              f"{', '.join(MIGRATED)}", flush=True)
    print(f"DockerLab: "
          f"DOCKER_HOST={os.environ.get('DOCKER_HOST', '(not set: local Docker)')}", flush=True)
    try:
        # Requests still waiting on an unreachable Docker host get 3 seconds, then are cancelled
        config = uvicorn.Config(app, host=host, port=port, timeout_graceful_shutdown=3)

        class QuietCancel(logging.Filter):
            """Requests cancelled at shutdown aren't errors: drop their tracebacks."""
            def filter(self, record):
                if record.exc_info and isinstance(record.exc_info[1], asyncio.CancelledError):
                    return False
                if "timeout graceful shutdown exceeded" in record.getMessage():
                    print("DockerLab: gave up on requests still waiting for the Docker host.", flush=True)
                    return False
                return True

        logging.getLogger("uvicorn.error").addFilter(QuietCancel())
        Server(config).run()
    except KeyboardInterrupt:
        # uvicorn re-raises a handled Ctrl+C after shutting down; only report the
        # case where it arrived before uvicorn's handler was installed
        if not HANDLED:
            print(f"DockerLab: received SIGINT {time.monotonic() - T0:.1f}s after start, while starting up; stopped.",
                  flush=True)
    finally:
        # Worker threads may still be blocked on an SSH connection to a host that's gone
        # (a VM that was switched off). Python would wait for them before exiting, so the
        # window wouldn't close; everything worth saving is saved, so leave right away.
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(0)
