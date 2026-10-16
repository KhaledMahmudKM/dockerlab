"""Docker networks on the Docker host: list, inspect, create, delete, clean up.

Docker's own network list only shows *running* containers on a network, so "is this
network used?" is answered from the containers' side instead: every container,
running or stopped, says which networks it's attached to. A network that only
stopped containers use isn't free: removing it breaks their next start.
"""
from __future__ import annotations

import ipaddress
import re

import docker
from docker.errors import APIError, NotFound
from docker.types import IPAMConfig, IPAMPool

from deployer import LABEL

BUILTIN = {"bridge", "host", "none"}
NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$")


class NetError(Exception):
    """A problem the user can act on."""


def _err(e: Exception) -> str:
    return (getattr(e, "explanation", None) or str(e)).strip()


def _users(client) -> dict[str, list[dict]]:
    """network id -> containers attached to it (running or stopped)."""
    out: dict[str, list[dict]] = {}
    for c in client.containers.list(all=True):
        nets = (c.attrs.get("NetworkSettings") or {}).get("Networks") or {}
        for name, ep in nets.items():
            out.setdefault(ep.get("NetworkID") or name, []).append({
                "id": c.id[:12], "name": c.name, "state": c.status,
                "ip": ep.get("IPAddress", ""), "prefix": ep.get("IPPrefixLen"),
                "mac": ep.get("MacAddress", ""), "lab": c.labels.get(LABEL),
            })
    return out


def _attached(users: dict, attrs: dict) -> list[dict]:
    """Containers on this network. A container that never started has no network id
    yet for its networks, only their names, so look both up."""
    return sorted(users.get(attrs["Id"], []) + users.get(attrs.get("Name", ""), []), key=lambda r: r["name"])


def _subnets(attrs: dict) -> list[dict]:
    return [{"subnet": c.get("Subnet", ""), "gateway": c.get("Gateway", ""), "range": c.get("IPRange", "")}
            for c in ((attrs.get("IPAM") or {}).get("Config") or []) if c.get("Subnet")]


def inventory(client: docker.DockerClient, lab_files: set[str]) -> dict:
    users = _users(client)
    rows = []
    for n in client.networks.list():
        a = n.attrs
        labels = a.get("Labels") or {}
        lab = labels.get(LABEL)
        attached = _attached(users, a)
        rows.append({
            "id": a["Id"][:12], "name": a.get("Name", ""), "driver": a.get("Driver", ""),
            "scope": a.get("Scope", ""), "internal": a.get("Internal", False),
            "subnets": _subnets(a), "created": a.get("Created", ""),
            "builtin": a.get("Name") in BUILTIN,
            "lab": lab, "lab_has_file": bool(lab) and lab in lab_files,
            "carrier": labels.get("dockerlab.carrier", ""),
            "containers": attached,
        })
    leftovers = [r for r in rows if r["lab"] and not r["containers"]]
    unused_other = [r for r in rows if not r["lab"] and not r["builtin"] and not r["containers"]]
    return {"networks": sorted(rows, key=lambda r: (not r["builtin"], r["lab"] or "", r["name"])),
            "leftovers": len(leftovers), "unused_other": len(unused_other)}


def inspect(client: docker.DockerClient, nid: str) -> dict:
    n = client.networks.get(nid)
    users = _users(client)
    a = n.attrs
    return {"attrs": a, "containers": _attached(users, a)}


def remove(client: docker.DockerClient, nid: str, disconnect: bool = False) -> dict:
    n = client.networks.get(nid)
    if n.name in BUILTIN:
        raise NetError(f"{n.name} is one of Docker's built-in networks and can't be deleted.")
    attached = _attached(_users(client), n.attrs)
    if attached and not disconnect:
        raise NetError("In use by " + ", ".join(c["name"] for c in attached))
    for c in attached:
        try:
            n.disconnect(c["id"], force=True)
        except APIError as e:
            raise NetError(f"Couldn't disconnect {c['name']}: {_err(e)}")
    n.remove()
    return {"removed": n.name, "disconnected": [c["name"] for c in attached]}


def prune(client: docker.DockerClient, scope: str = "dockerlab") -> dict:
    """Delete networks no container uses: DockerLab's leftovers, or every unused one."""
    users = _users(client)
    removed, errors = [], []
    for n in client.networks.list():
        a = n.attrs
        is_lab = LABEL in (a.get("Labels") or {})
        if a.get("Name") in BUILTIN or _attached(users, a):
            continue
        if scope == "dockerlab" and not is_lab:
            continue
        try:
            n.remove()
            removed.append(a["Name"])
        except APIError as e:
            errors.append(f"{a['Name']}: {_err(e)}")
    return {"removed": removed, "errors": errors}


DRIVERS = ("bridge", "macvlan", "ipvlan")


def create(client: docker.DockerClient, spec: dict) -> dict:
    name = (spec.get("name") or "").strip()
    driver = spec.get("driver") or "bridge"
    if not NAME_RE.match(name):
        raise NetError("Name: letters, digits, dot, dash and underscore, starting with a letter or digit.")
    if driver not in DRIVERS:
        raise NetError(f"Driver must be one of {', '.join(DRIVERS)}.")
    if any(n.name == name for n in client.networks.list(names=[name])):
        raise NetError(f"A network called {name} already exists.")

    def net(v, what):
        try:
            return ipaddress.ip_network(v.strip(), strict=True)
        except ValueError:
            raise NetError(f"{what}: '{v}' isn't a subnet (e.g. 10.10.0.0/24).")

    def addr(v, what, within):
        try:
            a = ipaddress.ip_address(v.strip())
        except ValueError:
            raise NetError(f"{what}: '{v}' isn't an address.")
        if a not in within:
            raise NetError(f"{what}: {a} isn't in {within}.")
        return str(a)

    pools = []
    if (spec.get("subnet") or "").strip():
        sub = net(spec["subnet"], "Subnet")
        pool = {"subnet": str(sub)}
        if (spec.get("gateway") or "").strip():
            pool["gateway"] = addr(spec["gateway"], "Gateway", sub)
        if (spec.get("ip_range") or "").strip():
            rng = net(spec["ip_range"], "IP range")
            if not rng.subnet_of(sub):
                raise NetError(f"IP range {rng} isn't inside {sub}.")
            pool["iprange"] = str(rng)
        pools.append(IPAMPool(**pool))
    elif driver in ("macvlan", "ipvlan"):
        raise NetError(f"A {driver} network shares a real network, so give it that network's subnet "
                       "(and its router as the gateway).")
    v6 = bool(spec.get("ipv6"))
    if v6 and (spec.get("subnet6") or "").strip():
        pools.append(IPAMPool(subnet=str(net(spec["subnet6"], "IPv6 subnet"))))

    options = {}
    if driver == "bridge":
        if (spec.get("bridge_name") or "").strip():
            if not re.match(r"^[a-zA-Z0-9_.-]{1,15}$", spec["bridge_name"].strip()):
                raise NetError("Bridge name: up to 15 letters, digits, dot, dash or underscore.")
            options["com.docker.network.bridge.name"] = spec["bridge_name"].strip()
        if spec.get("mtu"):
            options["com.docker.network.driver.mtu"] = str(int(spec["mtu"]))
    else:
        parent = (spec.get("parent") or "").strip()
        if not parent:
            raise NetError(f"A {driver} network needs the Docker host's interface to attach to (its parent), e.g. eth0.")
        options["parent"] = parent
        mode = spec.get("mode") or ("bridge" if driver == "macvlan" else "l2")
        options[f"{driver}_mode"] = mode
    try:
        n = client.networks.create(
            name, driver=driver, internal=bool(spec.get("internal")), enable_ipv6=v6,
            attachable=True, options=options or None,
            ipam=IPAMConfig(pool_configs=pools) if pools else None,
            labels={"dockerlab.created": "manual"},
        )
    except APIError as e:
        msg = _err(e)
        if "overlap" in msg.lower():
            msg += ". Another network already uses (part of) that subnet."
        raise NetError(msg)
    return {"created": name, "id": n.id[:12]}
