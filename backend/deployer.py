"""Turns a Topology into Docker networks and containers, and tears it down.

Design:
- A cable between two containers becomes an *internal* bridge network holding just
  those two. A switch is one internal bridge network, and every cable to it plugs
  that container into it: one shared segment (subnet) for all of them. Together,
  cables and switches are "segments".
- A node with `internet` on, or with published ports, is also attached to Docker's
  default `bridge` network (NAT); published ports only work on a non-internal network.
- Interface names are fixed: a node's cables become eth0, eth1, ... in the order the
  cables were drawn, and the NAT interface is nat0. This needs Docker 28 or newer
  (endpoint `ifname` option); on older engines Docker picks names and we report the
  real ones by matching MAC addresses.
- Everything we create is labelled `dockerlab.lab=<lab>` so containers belonging to
  GNS3 or anything else on the same engine are never touched.
- Each lab has its own address space. Docker insists that its networks' subnets never
  overlap, across all labs on the engine, so lab subnets aren't given to Docker at all:
  each segment gets a private "carrier" subnet from 100.64.0.0/10 that only Docker
  sees, and after every container start DockerLab replaces the carrier addresses with
  the lab's own (ip addr flush/add inside the container). Two labs can then use the
  same subnets at the same time, and .1 isn't reserved by Docker any more.
"""
from __future__ import annotations

import base64
import gzip
import hashlib
import ipaddress
import json
import shlex
from functools import lru_cache
from concurrent.futures import ThreadPoolExecutor, wait

import docker
from docker.errors import APIError, NotFound
from docker.types import EndpointConfig, IPAMConfig, IPAMPool

from models import Link, Node, Switch, Topology

LABEL = "dockerlab.lab"
CARRIER_POOL = ipaddress.ip_network("100.64.0.0/10")   # Docker's side only; never seen in a lab
AUTO_POOL = ipaddress.ip_network("172.31.0.0/16")      # subnets for cables and switches left without one
HELPER_IMAGE = "alpine:latest"                          # sets addresses in images that have no `ip`
IFNAME_OPT = "com.docker.network.endpoint.ifname"
STOP_TIMEOUT = 3          # seconds; shells as PID 1 ignore SIGTERM, so don't wait 10
STARTUP_TIMEOUT = 20      # seconds per node for startup commands


# ---------------------------------------------------------------- naming
def container_name(lab: str, node: Node) -> str:
    return f"dl-{lab}-{node.name}"


def network_name(lab: str, seg: Link | Switch) -> str:
    return f"dl-{lab}-{seg.id}"


def bridge_ifname(lab: str, seg: Link | Switch) -> str:
    """Host-side Linux bridge name (max 15 chars)."""
    return "dl" + hashlib.sha1(f"{lab}/{seg.id}".encode()).hexdigest()[:10]


def segment(topo: Topology, link: Link) -> Link | Switch:
    """The network a cable belongs to: its switch, or the cable itself."""
    sw = {s.id: s for s in topo.switches}
    return sw.get(link.source) or sw.get(link.target) or link


def segments(topo: Topology) -> list[Link | Switch]:
    """Every network to create: all switches, plus container-to-container cables."""
    sw = {s.id for s in topo.switches}
    return list(topo.switches) + [l for l in topo.links if l.source not in sw and l.target not in sw]


def _labels(lab: str, **extra: str) -> dict[str, str]:
    return {LABEL: lab, **{f"dockerlab.{k}": v for k, v in extra.items()}}


def pack_lab(topo: Topology) -> str:
    """The lab file, gzip + base64, without image Dockerfiles (those live on the images)."""
    raw = topo.model_dump_json(exclude={"images"}).encode()
    return base64.b64encode(gzip.compress(raw, mtime=0)).decode()


def unpack_lab(blob: str) -> Topology:
    return Topology.model_validate_json(gzip.decompress(base64.b64decode(blob)))


@lru_cache(maxsize=16)
def deployed_view(blob: str) -> dict:
    """What a deploy baked into its containers: the lab's containers, switches and
    cables (no positions that matter, no notes). Cached: the state poll asks often."""
    return unpack_lab(blob).model_dump(include={"nodes", "switches", "links"})


def node_container(client, lab: str, node_id: str):
    """A node's container, found by labels rather than by name, so renaming a node
    (without redeploying) doesn't lose track of it. None if it isn't deployed."""
    found = client.containers.list(all=True, filters={"label": [f"{LABEL}={lab}", f"dockerlab.node={node_id}"]})
    return found[0] if found else None


def config_hash(topo: Topology, node: Node) -> str:
    """Fingerprint of everything Deploy bakes into a node's container. Startup
    commands are left out: they apply on the next start, without a redeploy."""
    segs = {s.id: s for s in segments(topo)}
    ifaces = [{k: i[k] for k in ("ifname", "ip", "seg")} | {"subnet": segs[i["seg"]].subnet if i["seg"] in segs else ""}
              for i in interfaces(topo, node)]
    data = node.model_dump(exclude={"x", "y", "startup"}) | {"ifaces": ifaces}
    return hashlib.sha1(json.dumps(data, sort_keys=True).encode()).hexdigest()[:12]


def supports_ifname(client: docker.DockerClient) -> bool:
    """Docker 28 (API 1.48) added the endpoint `ifname` driver option."""
    try:
        major, minor = (int(x) for x in client.version()["ApiVersion"].split(".")[:2])
        return (major, minor) >= (1, 48)
    except Exception:
        return False


def interfaces(topo: Topology, node: Node) -> list[dict]:
    """The planned interfaces of a node, in order: {net, ifname, ip, link, seg}."""
    out = []
    if node.internet or node.ports:
        out.append({"net": "bridge", "ifname": "nat0", "ip": "", "link": None, "seg": None})
    i = 0
    for l in topo.links:
        if node.id in (l.source, l.target):
            ip = l.source_ip if node.id == l.source else l.target_ip
            seg = segment(topo, l)
            out.append({"net": network_name(topo.name, seg), "ifname": f"eth{i}", "ip": ip,
                        "link": l.id, "seg": seg.id})
            i += 1
    return out


# ---------------------------------------------------------------- validation
def _check_ips(label: str, subnet: str, ips: list[str], errors: list[str]) -> None:
    """Validate fixed addresses against a segment's subnet."""
    if not subnet:
        if any(ips):
            errors.append(f"{label}: set a subnet to use fixed addresses")
        return
    try:
        net = ipaddress.ip_network(subnet, strict=True)
    except ValueError:
        errors.append(f"{label}: '{subnet}' is not a valid subnet (e.g. 10.0.1.0/24)")
        return
    seen = []
    for ip in ips:
        if not ip:
            continue
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            errors.append(f"{label}: '{ip}' is not an IP address")
            continue
        if addr not in net or addr in (net.network_address, net.broadcast_address):
            errors.append(f"{label}: {ip} is not a usable address in {subnet}")
        elif ip in seen:
            errors.append(f"{label}: {ip} is used twice")
        seen.append(ip)


def validate(topo: Topology) -> list[str]:
    errors = []
    containers = {n.id: n.name for n in topo.nodes}
    switches = {s.id: s for s in topo.switches}
    names = [n.name for n in topo.nodes] + [s.name for s in topo.switches]
    dupes = {n for n in names if names.count(n) > 1}
    if dupes:
        errors.append(f"duplicate names: {', '.join(sorted(dupes))}")
    name = lambda i: containers.get(i) or (switches[i].name if i in switches else "?")
    plugged: dict[str, list[tuple[str, str]]] = {s: [] for s in switches}   # switch -> [(container, ip)]
    for l in topo.links:
        label = f"cable {name(l.source)} to {name(l.target)}"
        if l.source not in containers and l.source not in switches \
                or l.target not in containers and l.target not in switches:
            errors.append(f"{label} points at a missing node")
            continue
        if l.source == l.target:
            errors.append(f"{label} connects a node to itself")
            continue
        if l.source in switches and l.target in switches:
            errors.append(f"{label}: switches can't be cabled to each other yet; use one switch for the segment")
            continue
        sw_id = l.source if l.source in switches else l.target if l.target in switches else None
        if sw_id is None:
            _check_ips(label, l.subnet, [l.source_ip, l.target_ip], errors)
        else:
            cid = l.target if sw_id == l.source else l.source
            plugged[sw_id].append((cid, l.target_ip if sw_id == l.source else l.source_ip))
    for n in topo.nodes:
        used = sum(1 for l in topo.links if n.id in (l.source, l.target))
        if n.interfaces and used > n.interfaces:
            errors.append(f"{n.name} has {n.interfaces} interface{'s' if n.interfaces != 1 else ''} but "
                          f"{used} cables. Raise its Interfaces setting or remove a cable.")
    for sw_id, ports in plugged.items():
        sw = switches[sw_id]
        cids = [c for c, _ in ports]
        twice = {containers[c] for c in cids if cids.count(c) > 1}
        if twice:
            errors.append(f"switch {sw.name}: {', '.join(sorted(twice))} is cabled to it more than once")
        _check_ips(f"switch {sw.name}", sw.subnet, [ip for _, ip in ports], errors)
    host_ports = [(p.host, p.proto) for n in topo.nodes for p in n.ports]
    clash = {p for p in host_ports if host_ports.count(p) > 1}
    if clash:
        errors.append("host port used twice: " + ", ".join(f"{p}/{t}" for p, t in sorted(clash)))
    return errors


# ---------------------------------------------------------------- helpers
def _containers(client, lab: str):
    return client.containers.list(all=True, filters={"label": f"{LABEL}={lab}"})


def _parallel(fn, items, timeout=None) -> dict:
    """Run fn(item) concurrently; returns {item_key: result or Exception}."""
    out = {}
    if not items:
        return out
    # not a `with` block: its exit would wait for a hung job and defeat the timeout
    # 4 at a time: leaves room in the shared SSH connection for the UI's own requests
    pool = ThreadPoolExecutor(max_workers=min(4, len(items)))
    futs = {pool.submit(fn, it): key for key, it in items}
    done, pending = wait(futs, timeout=timeout)
    for f in done:
        try:
            out[futs[f]] = f.result()
        except Exception as e:  # noqa: BLE001 — reported to the user
            out[futs[f]] = e
    for f in pending:
        out[futs[f]] = TimeoutError(f"still running after {timeout}s")
    pool.shutdown(wait=False, cancel_futures=True)
    return out


def _err(e: Exception) -> str:
    if type(e).__name__ == "ChannelException":   # paramiko: the SSH server refused a session
        return ("the VM's SSH server refused another session (too many at once). "
                "Try again; if it repeats, restart DockerLab.")
    return getattr(e, "explanation", None) or str(e)


def run_startup(client, topo: Topology, node_ids=None) -> dict:
    """Run each node's startup commands; returns {node_id: {exit, output}}."""
    nodes = [n for n in topo.nodes if n.startup.strip() and (node_ids is None or n.id in node_ids)]

    def one(node):
        c = node_container(client, topo.name, node.id)
        if c is None:
            raise RuntimeError("not deployed")
        res = c.exec_run(["sh", "-c", node.startup])
        out = (res.output or b"").decode(errors="replace")
        return {"exit": res.exit_code, "output": out[-4000:]}

    results = _parallel(one, [(n.id, n) for n in nodes], timeout=STARTUP_TIMEOUT)
    return {k: (v if isinstance(v, dict) else {"exit": None, "output": _err(v)}) for k, v in results.items()}


def _startup_errors(topo, logs) -> list[str]:
    names = {n.id: n.name for n in topo.nodes}
    return [f"{names[k]}: startup commands failed (exit {v['exit']}). Click the node to see the output."
            for k, v in logs.items() if v["exit"] != 0]


# ---------------------------------------------------------------- lab addressing
def addressing(topo: Topology) -> dict[tuple[str, str], str]:
    return lab_addresses(topo)[0]


def lab_addresses(topo: Topology) -> tuple[dict[tuple[str, str], str], dict[str, ipaddress.IPv4Network]]:
    """The lab's own addresses: {(node id, link id): "10.0.1.10/24"}. Fixed addresses
    are kept; the rest get the lowest free host address of their segment's subnet, and
    segments without a subnet get one of their own from AUTO_POOL. Deterministic, so
    a redeploy gives the same addresses. Also returns each segment's subnet."""
    segs = segments(topo)
    switch_ids = {s.id for s in topo.switches}
    explicit = []
    for seg in segs:
        try:
            explicit.append(ipaddress.ip_network(seg.subnet)) if seg.subnet else None
        except ValueError:
            pass
    auto = (n for n in AUTO_POOL.subnets(new_prefix=24) if not any(n.overlaps(e) for e in explicit))
    out, subnets = {}, {}
    for seg in segs:
        try:
            net = ipaddress.ip_network(seg.subnet) if seg.subnet else next(auto)
        except (ValueError, StopIteration):
            continue
        subnets[seg.id] = net
        if isinstance(seg, Switch):
            ends = [(l.target if l.source == seg.id else l.source, l.id,
                     l.target_ip if l.source == seg.id else l.source_ip)
                    for l in topo.links if seg.id in (l.source, l.target)]
        else:
            ends = [(seg.source, seg.id, seg.source_ip), (seg.target, seg.id, seg.target_ip)]
        ends = [e for e in ends if e[0] not in switch_ids]
        used = {ip for _, _, ip in ends if ip}
        free = (str(h) for h in net.hosts() if str(h) not in used)
        for node_id, link_id, ip in ends:
            ip = ip or next(free, "")
            out[(node_id, link_id)] = f"{ip}/{net.prefixlen}" if ip else ""
    return out, subnets


def _carriers(client, count: int) -> list[str]:
    """`count` subnets from CARRIER_POOL that no Docker network on the engine uses."""
    taken = []
    for n in client.networks.list():
        for cfg in (n.attrs.get("IPAM") or {}).get("Config") or []:
            try:
                taken.append(ipaddress.ip_network(cfg.get("Subnet", ""), strict=False))
            except ValueError:
                pass
    out = []
    for cand in CARRIER_POOL.subnets(new_prefix=24):
        if len(out) == count:
            break
        if not any(cand.overlaps(t) for t in taken):
            out.append(str(cand))
            taken.append(cand)
    return out


IP_SCRIPT = r"""
command -v ip >/dev/null 2>&1 || exit 127
fix() {
  for i in /sys/class/net/*; do
    [ "$(cat "$i/address" 2>/dev/null)" = "$1" ] || continue
    IF="${i##*/}"
    ip -f inet addr flush dev "$IF"
    [ -n "$2" ] && ip addr add "$2" dev "$IF"
    ip link set "$IF" up
  done
}
"""

HOSTS_SCRIPT = r"""
if [ -w /etc/hosts ] && command -v grep >/dev/null 2>&1; then
  # drop our old lines, and Docker's line for this container's carrier address (100.64.0.0/10)
  H="$(grep -v -E -e '# dockerlab$' -e '^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.' /etc/hosts)"
  printf '%s\n' "$H" {lines} > /etc/hosts
fi
"""


def _helper_image(client) -> str:
    try:
        client.images.get(HELPER_IMAGE)
    except docker.errors.ImageNotFound:
        repo, tag = HELPER_IMAGE.split(":")
        client.images.pull(repo, tag=tag)
    return HELPER_IMAGE


def apply_addresses(client, topo: Topology, node_ids=None) -> list[str]:
    """Give running containers their lab addresses (replacing Docker's carrier ones),
    and /etc/hosts entries for every node's name. Needed after every container start:
    a restart brings Docker's addresses back. Returns error messages."""
    plan = addressing(topo)
    nodes = {n.id: n for n in topo.nodes}
    host_lines = []
    for (node_id, _), cidr in plan.items():
        if cidr and node_id in nodes:
            line = f"{cidr.split('/')[0]} {nodes[node_id].name} # dockerlab"
            if line not in host_lines:
                host_lines.append(line)
    hosts = HOSTS_SCRIPT.replace("{lines}", " ".join(shlex.quote(l) for l in host_lines))

    def one(node):
        c = node_container(client, topo.name, node.id)
        if c is None or c.status != "running":
            return None
        nets = c.attrs.get("NetworkSettings", {}).get("Networks", {}) or {}
        calls = []
        for i in interfaces(topo, node):
            if i["link"] and i["net"] in nets:
                calls.append(f"fix {shlex.quote(nets[i['net']].get('MacAddress', ''))} {shlex.quote(plan.get((node.id, i['link']), ''))}")
        if not calls:
            return None
        script = IP_SCRIPT + "\n".join(calls) + "\n"
        res = c.exec_run(["sh", "-c", hosts + script])
        if res.exit_code == 127:            # no `ip` in this image: set them from a helper container
            try:
                helper = _helper_image(client)
            except Exception as e:  # noqa: BLE001
                raise RuntimeError(f"its image has no `ip` command, and the helper image {HELPER_IMAGE} "
                                   f"couldn't be pulled ({_err(e)}). Connect the Docker host to the internet once, "
                                   f"or pull {HELPER_IMAGE} in Manage → Images.")
            client.containers.run(helper, ["sh", "-c", script], remove=True,
                                        network_mode=f"container:{c.id}", cap_add=["NET_ADMIN"])
            return None
        if res.exit_code:
            raise RuntimeError((res.output or b"").decode(errors="replace").strip()[-300:])
        return None

    todo = [(n.id, n) for n in topo.nodes if node_ids is None or n.id in node_ids]
    errors = []
    for node_id, res in _parallel(one, todo, timeout=60).items():
        if isinstance(res, Exception):
            errors.append(f"{nodes[node_id].name}: couldn't set its lab addresses: {_err(res)}")
    return errors


# ---------------------------------------------------------------- lifecycle
def destroy(client: docker.DockerClient, lab: str) -> dict:
    removed = {"containers": [], "networks": []}
    found = _containers(client, lab)
    _parallel(lambda c: c.remove(force=True), [(c.name, c) for c in found])
    removed["containers"] = [c.name for c in found]
    for n in client.networks.list(filters={"label": f"{LABEL}={lab}"}):
        try:
            n.remove()
            removed["networks"].append(n.name)
        except NotFound:
            pass
    return removed


def deploy(client: docker.DockerClient, topo: Topology) -> dict:
    errors = validate(topo)
    if errors:
        return {"ok": False, "errors": errors}

    lab = topo.name
    destroy(client, lab)  # deploy is idempotent: always start from clean
    # every container carries the whole lab (compressed), so a lost lab file can be recovered
    lab_blob = pack_lab(topo)
    named = supports_ifname(client)
    api_version = client.api._version

    result = {"ok": True, "errors": [], "networks": {}, "containers": {}, "startup": {},
              "fixed_ifnames": named}

    # 1. one network per segment: each switch, and each container-to-container cable.
    # Docker gets a carrier subnet; the lab's own addresses are set in step 3.
    segs = segments(topo)
    carriers = _carriers(client, len(segs))
    isolated = True       # Docker 28+: no address on the host's bridge at all
    for seg, carrier in zip(segs, carriers):
        what = f"switch {seg.name}" if isinstance(seg, Switch) else f"cable {seg.id}"
        kwargs = dict(
            name=network_name(lab, seg), driver="bridge", internal=True,
            labels=_labels(lab, segment=seg.id, carrier=carrier),
            options={"com.docker.network.bridge.name": bridge_ifname(lab, seg)},
            ipam=IPAMConfig(pool_configs=[IPAMPool(subnet=carrier)]),
        )
        for attempt in (1, 2):
            if isolated:
                kwargs["options"]["com.docker.network.bridge.gateway_mode_ipv4"] = "isolated"
            else:
                kwargs["options"].pop("com.docker.network.bridge.gateway_mode_ipv4", None)
            try:
                client.networks.create(**kwargs)
                result["networks"][seg.id] = {"name": kwargs["name"], "bridge": bridge_ifname(lab, seg)}
                break
            except APIError as e:
                if isolated and "gateway" in _err(e).lower():   # older engine: no isolated mode
                    isolated = False
                    continue
                result["errors"].append(f"{what}: {_err(e)}")
                break
    if len(carriers) < len(segs):
        result["errors"].append("No free carrier subnets left in 100.64.0.0/10 on the Docker host.")

    # 2. containers (created one by one so errors are clear), then started together
    created = []
    for node in topo.nodes:
        ifaces = [i for i in interfaces(topo, node)
                  if i["net"] == "bridge" or i["seg"] in result["networks"]]

        def endpoint(i):
            return dict(driver_opt={IFNAME_OPT: i["ifname"]} if named else None)

        kwargs = dict(
            image=node.image, name=container_name(lab, node), hostname=node.name,
            labels=_labels(lab, node=node.id, config=config_hash(topo, node), **{"lab-file": lab_blob}),
            environment={e.key: e.value for e in node.env if e.key},
            ports={f"{p.container}/{p.proto}": p.host for p in node.ports} or None,
            volumes={v.source: {"bind": v.target, "mode": v.mode} for v in node.volumes} or None,
            cap_add=["NET_ADMIN", "NET_RAW"], privileged=node.privileged,
            sysctls={"net.ipv4.ip_forward": "1"} if node.router else None,
            tty=True, stdin_open=True,   # keeps shell-only images (alpine, ubuntu) alive
        )
        if node.command.strip():
            kwargs["command"] = node.command
        if ifaces:
            first = ifaces[0]
            kwargs["network"] = first["net"]
            kwargs["networking_config"] = {first["net"]: EndpointConfig(api_version, **endpoint(first))}
        else:
            kwargs["network_mode"] = "none"

        try:
            c = client.containers.create(**kwargs)
            for i in ifaces[1:]:
                client.api.connect_container_to_network(c.id, i["net"], **endpoint(i))
            created.append((node.id, c))
            result["containers"][node.id] = c.name
        except APIError as e:
            result["errors"].append(f"{node.name}: {_err(e)}")

    for node_id, res in _parallel(lambda c: c.start(), created).items():
        if isinstance(res, Exception):
            name = next(n.name for n in topo.nodes if n.id == node_id)
            result["errors"].append(f"{name}: {_err(res)}")
            result["containers"].pop(node_id, None)

    # 3. the lab's own addresses, then startup commands, on the containers that came up
    result["errors"] += apply_addresses(client, topo, set(result["containers"]))
    result["startup"] = run_startup(client, topo, set(result["containers"]))
    result["errors"] += _startup_errors(topo, result["startup"])
    result["ok"] = not result["errors"]
    return result


def start_all(client, topo: Topology) -> dict:
    todo = [(c.labels.get("dockerlab.node"), c) for c in _containers(client, topo.name)
            if c.status != "running"]
    res = _parallel(lambda c: c.start(), todo)
    started = {k for k, v in res.items() if not isinstance(v, Exception)}
    errors = [f"{k}: {_err(v)}" for k, v in res.items() if isinstance(v, Exception)]
    errors += apply_addresses(client, topo, started)
    logs = run_startup(client, topo, started)
    return {"started": len(started), "errors": errors + _startup_errors(topo, logs), "startup": logs}


def stop_lab(client, lab: str) -> dict:
    """Stop a lab's running containers by label; works even if the lab file is gone."""
    todo = [(c.name, c) for c in _containers(client, lab) if c.status == "running"]
    res = _parallel(lambda c: c.stop(timeout=STOP_TIMEOUT), todo)
    return {"stopped": len(todo), "errors": [f"{k}: {_err(v)}" for k, v in res.items() if isinstance(v, Exception)]}


def stop_all(client, topo: Topology) -> dict:
    return stop_lab(client, topo.name)


def running(client) -> dict:
    """Every running container on the engine: DockerLab ones grouped by lab, and the
    rest. One list request (sparse), so it's cheap enough to poll over SSH."""
    labs: dict[str, list] = {}
    other = []
    for c in client.containers.list(filters={"status": "running"}, sparse=True):
        a = c.attrs
        name = (a.get("Names") or ["?"])[0].lstrip("/")
        labels = a.get("Labels") or {}
        lab = labels.get(LABEL)
        if lab:
            labs.setdefault(lab, []).append({"name": name, "node": labels.get("dockerlab.node", "")})
        else:
            other.append({"name": name, "image": a.get("Image", ""), "status": a.get("Status", "")})
    return {
        "labs": [{"lab": k, "containers": sorted(v, key=lambda x: x["name"])} for k, v in sorted(labs.items())],
        "other": sorted(other, key=lambda x: x["name"]),
    }


def stop_everything(client) -> dict:
    """Stop the running containers of every DockerLab lab (used when the app exits)."""
    todo = [(c.name, c) for c in client.containers.list(filters={"label": LABEL, "status": "running"})]
    res = _parallel(lambda c: c.stop(timeout=STOP_TIMEOUT), todo)
    labs = sorted({c.labels.get(LABEL, "?") for _, c in todo})
    return {"stopped": len(todo), "labs": labs,
            "errors": [f"{k}: {_err(v)}" for k, v in res.items() if isinstance(v, Exception)]}


def node_action(client, topo: Topology, node_id: str, action: str) -> dict:
    node = next((n for n in topo.nodes if n.id == node_id), None)
    if not node:
        raise KeyError(node_id)
    c = node_container(client, topo.name, node_id)
    if c is None:
        raise NotFound(f"{node.name} isn't deployed")
    if action == "stop":
        c.stop(timeout=STOP_TIMEOUT)
    elif action == "restart":
        c.restart(timeout=STOP_TIMEOUT)
    else:
        c.start()
    c.reload()
    if action == "stop":
        return {"status": c.status, "startup": {}}
    errors = apply_addresses(client, topo, {node_id})
    if errors:
        raise RuntimeError(errors[0])
    return {"status": c.status, "startup": run_startup(client, topo, {node_id})}


# ---------------------------------------------------------------- status
_ifname_cache: dict[tuple, dict] = {}   # (container id, StartedAt) -> {mac: ifname}


def _actual_ifnames(c) -> dict:
    key = (c.id, c.attrs.get("State", {}).get("StartedAt"))
    if key not in _ifname_cache:
        res = c.exec_run(["sh", "-c", 'for i in /sys/class/net/*; do echo "${i##*/} $(cat $i/address)"; done'])
        _ifname_cache[key] = {mac: name for name, mac in
                              (l.split() for l in res.output.decode().splitlines() if len(l.split()) == 2)}
    return _ifname_cache[key]


def state(client: docker.DockerClient, topo: Topology) -> dict:
    """Per-node container status and interfaces, per-link bridge names."""
    by_node = {}
    nodes = {n.id: n for n in topo.nodes}
    containers = _containers(client, topo.name)
    # the lab as last deployed, from the newest container's copy of it (None for
    # containers deployed by versions that didn't store one)
    blobs = sorted((c.attrs.get("Created", ""), c.labels["dockerlab.lab-file"])
                   for c in containers if c.labels.get("dockerlab.lab-file"))
    deployed = deployed_view(blobs[-1][1]) if blobs else None
    plan = addressing(topo)
    for c in containers:
        node_id = c.labels.get("dockerlab.node")
        nets = c.attrs.get("NetworkSettings", {}).get("Networks", {}) or {}
        planned = {i["net"]: i["ifname"] for i in interfaces(topo, nodes[node_id])} if node_id in nodes else {}
        actual = {}
        if c.status == "running":
            try:
                actual = _actual_ifnames(c)
            except Exception:  # noqa: BLE001 — names are a nicety, never fail the poll
                actual = {}
        node = nodes.get(node_id)
        lab_ip = {i["net"]: plan.get((node_id, i["link"]), "") for i in interfaces(topo, node)
                  if i["link"]} if node else {}

        def addr(n, v):    # the lab's address on lab networks (Docker only knows the carrier one)
            if n in lab_ip:
                ip, _, prefix = lab_ip[n].partition("/")
                return ip, int(prefix) if prefix else None
            return v.get("IPAddress", ""), v.get("IPPrefixLen")
        by_node[node_id] = {
            "container": c.name,
            "status": c.status,
            # deployed with different settings than the saved lab: needs Redeploy
            "stale": node is not None and c.labels.get("dockerlab.config") != config_hash(topo, node),
            "networks": {
                n: {"ip": addr(n, v)[0], "prefix": addr(n, v)[1],
                    "mac": v.get("MacAddress", ""),
                    "ifname": actual.get(v.get("MacAddress", ""), planned.get(n, ""))}
                for n, v in nets.items()
            },
        }
    links = {l.id: {"network": network_name(topo.name, segment(topo, l))} for l in topo.links}
    switches = {s.id: {"network": network_name(topo.name, s)} for s in topo.switches}
    return {"nodes": by_node, "links": links, "switches": switches, "deployed": deployed}


# ---------------------------------------------------------------- capture
class CaptureError(Exception):
    pass


def port_ifindex(client, topo: Topology, link_id: str) -> tuple[int, str]:
    """The VM-side interface index of a cable's container port, and that container's name.

    Capturing on a Linux bridge's own interface misses unicast frames forwarded
    between its ports, so we capture on the container's port instead (the host end of
    its veth pair), which sees every frame that container sends and receives on that
    cable. Looked up at capture time, since it changes when the container restarts."""
    link = next((l for l in topo.links if l.id == link_id), None)
    if link is None:
        raise CaptureError("This cable isn't in the saved lab. Save and Redeploy first.")
    nodes = {n.id: n for n in topo.nodes}
    net = network_name(topo.name, segment(topo, link))
    ends = [nodes[i] for i in (link.source, link.target) if i in nodes]
    reasons = []
    for node in ends:
        c = node_container(client, topo.name, node.id)
        if c is None:
            reasons.append(f"{node.name} isn't deployed")
            continue
        if c.status != "running":
            reasons.append(f"{node.name} is {c.status}")
            continue
        mac = (c.attrs["NetworkSettings"]["Networks"].get(net) or {}).get("MacAddress")
        if not mac:
            reasons.append(f"{node.name} isn't connected to this cable yet (Redeploy to apply cable changes)")
            continue
        res = c.exec_run(["sh", "-c",
                          f'for d in /sys/class/net/*; do [ "$(cat $d/address)" = "{mac}" ] && cat $d/iflink; done'])
        idx = (res.output or b"").decode().strip()
        if idx.isdigit():
            return int(idx), node.name
        reasons.append(f"couldn't find {node.name}'s interface for this cable")
    raise CaptureError("Can't capture on this cable: " + "; ".join(reasons) + ".")
