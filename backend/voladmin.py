"""Docker volumes on the Docker host: list, inspect, browse, create, delete, clean up.

As with networks (netadmin.py), "is this volume used?" is answered from the containers'
side: every container, running or stopped, lists its mounts. Docker refuses to delete a
volume any container uses, even a stopped one, so those are shown, and named.

A volume's files live in Docker's data folder on the host, readable only by root. To
show them without sudo, a small helper container mounts the volume read-only and lists
it (the same alpine image DockerLab uses to set addresses in images without `ip`).
"""
from __future__ import annotations

import re

import docker
from docker.errors import APIError, NotFound

from deployer import HELPER_IMAGE, LABEL, _helper_image

NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$")


class VolError(Exception):
    """A problem the user can act on."""


def _err(e: Exception) -> str:
    return (getattr(e, "explanation", None) or str(e)).strip()


def _users(client) -> dict[str, list[dict]]:
    """volume name -> containers that mount it (running or stopped)."""
    out: dict[str, list[dict]] = {}
    for c in client.containers.list(all=True):
        for m in c.attrs.get("Mounts") or []:
            if m.get("Type") == "volume" and m.get("Name"):
                out.setdefault(m["Name"], []).append({
                    "id": c.id[:12], "name": c.name, "state": c.status, "lab": c.labels.get(LABEL),
                    "target": m.get("Destination", ""), "rw": bool(m.get("RW", True)),
                })
    return out


def _anonymous(v: dict) -> bool:
    """Volumes Docker made up a name for (VOLUME in a Dockerfile, `-v /path`): 64 hex digits."""
    return bool(re.fullmatch(r"[0-9a-f]{64}", v.get("Name", "")))


def _row(v: dict, users: dict, lab_refs: dict[str, list[str]]) -> dict:
    opts = v.get("Options") or {}
    return {
        "name": v["Name"], "driver": v.get("Driver", ""), "mountpoint": v.get("Mountpoint", ""),
        "created": v.get("CreatedAt", ""), "labels": v.get("Labels") or {}, "scope": v.get("Scope", ""),
        "anonymous": _anonymous(v),
        # a local volume bound to a host folder (`--opt type=none --opt o=bind --opt device=...`)
        "device": opts.get("device", "") if opts.get("o") == "bind" else "",
        "containers": sorted(users.get(v["Name"], []), key=lambda r: r["name"]),
        "labs": lab_refs.get(v["Name"], []),
    }


def inventory(client: docker.DockerClient, lab_refs: dict[str, list[str]]) -> dict:
    """Every volume, with the containers using it and the saved labs that mention it.
    lab_refs: volume name -> labs whose lab file mounts it."""
    users = _users(client)
    vols = client.api.volumes().get("Volumes") or []
    rows = [_row(v, users, lab_refs) for v in vols]
    rows.sort(key=lambda r: (r["anonymous"], r["name"].lower()))
    return {"volumes": rows, "unused": sum(1 for r in rows if not r["containers"])}


def sizes(client: docker.DockerClient) -> dict[str, int]:
    """volume name -> bytes used. Docker walks every volume for this, so it's asked for separately."""
    df = client.api.df()
    return {v["Name"]: (v.get("UsageData") or {}).get("Size", -1) for v in df.get("Volumes") or []}


def inspect(client: docker.DockerClient, name: str, lab_refs: dict[str, list[str]]) -> dict:
    v = client.api.inspect_volume(name)
    return {"attrs": v, **_row(v, _users(client), lab_refs)}


def files(client: docker.DockerClient, name: str, path: str = "") -> dict:
    """The entries of one folder in the volume, read by a helper container that mounts it read-only."""
    client.api.inspect_volume(name)                                  # NotFound if it's gone
    path = "/" + "/".join(p for p in path.split("/") if p and p not in (".", ".."))
    try:
        image = _helper_image(client)
    except Exception as e:  # noqa: BLE001
        raise VolError(f"Listing files needs the {HELPER_IMAGE} image, which couldn't be pulled ({_err(e)}).")
    # one entry per line: type, size, modification time, name (busybox find + stat)
    script = r"""
cd "/v$1" 2>/dev/null || { echo '!nosuch'; exit 0; }
for f in .* *; do
  case "$f" in .|..) continue ;; esac
  [ -e "$f" ] || [ -L "$f" ] || continue
  if [ -L "$f" ]; then t=l; elif [ -d "$f" ]; then t=d; else t=f; fi
  printf '%s\t%s\t%s\t%s\n' "$t" "$(stat -c %s "$f")" "$(stat -c %Y "$f")" "$f"
done
"""
    out = client.containers.run(image, ["sh", "-c", script, "sh", path], remove=True, network_mode="none",
                                volumes={name: {"bind": "/v", "mode": "ro"}}).decode(errors="replace")
    if out.startswith("!nosuch"):
        raise VolError(f"{path} isn't a folder in {name}.")
    entries = []
    for ln in out.splitlines():
        parts = ln.split("\t", 3)
        if len(parts) == 4:
            t, size, mtime, fname = parts
            entries.append({"type": t, "size": int(size or 0), "mtime": int(mtime or 0), "name": fname})
    entries.sort(key=lambda e: (e["type"] != "d", e["name"].lower()))
    return {"path": path, "entries": entries[:500], "truncated": len(entries) > 500}


def create(client: docker.DockerClient, spec: dict) -> dict:
    name = (spec.get("name") or "").strip()
    if not NAME_RE.match(name):
        raise VolError("Name: letters, digits, dot, dash and underscore, starting with a letter or digit.")
    try:
        client.api.inspect_volume(name)
        raise VolError(f"A volume called {name} already exists.")
    except NotFound:
        pass
    opts = None
    device = (spec.get("device") or "").strip()
    if device:                      # keep the files in a folder of the Docker host instead
        if not device.startswith("/"):
            raise VolError("Host folder: a full path on the Docker host, such as /srv/labs/site.")
        opts = {"type": "none", "o": "bind", "device": device}
    try:
        client.api.create_volume(name, driver="local", driver_opts=opts, labels={"dockerlab.created": "manual"})
    except APIError as e:
        raise VolError(_err(e))
    return {"created": name}


def remove(client: docker.DockerClient, name: str) -> dict:
    used = _users(client).get(name, [])
    if used:
        raise VolError("Used by " + ", ".join(c["name"] for c in used)
                       + ". Delete those containers first (Docker keeps a volume as long as any container has it).")
    try:
        client.api.remove_volume(name)
    except APIError as e:
        raise VolError(_err(e))
    return {"removed": name}


def prune(client: docker.DockerClient, scope: str = "anonymous") -> dict:
    """Delete volumes no container uses: Docker's nameless ones, or every unused one."""
    users = _users(client)
    removed, errors = [], []
    for v in client.api.volumes().get("Volumes") or []:
        if v["Name"] in users or (scope != "all" and not _anonymous(v)):
            continue
        try:
            client.api.remove_volume(v["Name"])
            removed.append(v["Name"])
        except APIError as e:
            errors.append(f"{v['Name'][:12]}: {_err(e)}")
    return {"removed": removed, "errors": errors}
