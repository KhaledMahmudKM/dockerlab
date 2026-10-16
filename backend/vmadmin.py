"""Housekeeping for the Docker engine in the VM: what's there, deleting it, and
recovering lab files from deployed containers.

Recovery: containers deployed by this version carry the whole lab file in a label,
so recovery is exact. Containers deployed by earlier versions carry only their node
id; for those the lab is rebuilt from what Docker knows (image, cables, subnets,
addresses, router and internet settings). Bench positions, startup commands, the
description and interface limits weren't stored then, so they can't come back.
"""
from __future__ import annotations

import docker
from docker.errors import APIError, ImageNotFound, NotFound

import deployer
import images as labimages
from deployer import LABEL, IFNAME_OPT
from models import EnvVar, Link, Node, PortMap, Switch, Topology, VolumeMap


def _err(e: Exception) -> str:
    return (getattr(e, "explanation", None) or str(e)).strip()


# ---------------------------------------------------------------- inventory
def containers(client: docker.DockerClient, lab_files: set[str]) -> dict:
    """Every container on the engine: DockerLab ones grouped by lab (with whether the
    lab file exists), and the rest. Labs left with only networks are listed too."""
    labs: dict[str, dict] = {}
    other = []
    for c in client.containers.list(all=True, sparse=True):
        a = c.attrs
        name = (a.get("Names") or ["?"])[0].lstrip("/")
        labels = a.get("Labels") or {}
        row = {"id": a["Id"][:12], "name": name, "image": a.get("Image", ""), "state": a.get("State", ""),
               "status": a.get("Status", "")}
        lab = labels.get(LABEL)
        if lab:
            g = labs.setdefault(lab, {"lab": lab, "containers": [], "networks": 0})
            g["containers"].append(row | {"node": labels.get("dockerlab.node", "")})
        else:
            other.append(row)
    for n in client.networks.list(filters={"label": LABEL}):
        lab = (n.attrs.get("Labels") or {}).get(LABEL)
        labs.setdefault(lab, {"lab": lab, "containers": [], "networks": 0})["networks"] += 1
    out = []
    for lab, g in sorted(labs.items()):
        g["containers"].sort(key=lambda r: r["name"])
        g["running"] = sum(r["state"] == "running" for r in g["containers"])
        g["has_file"] = lab in lab_files
        out.append(g)
    return {"labs": out, "other": sorted(other, key=lambda r: r["name"])}


def remove_container(client: docker.DockerClient, cid: str) -> dict:
    c = client.containers.get(cid)
    lab = c.labels.get(LABEL)
    c.remove(force=True)
    # drop the lab's networks once its last container is gone
    if lab and not client.containers.list(all=True, filters={"label": f"{LABEL}={lab}"}):
        for n in client.networks.list(filters={"label": f"{LABEL}={lab}"}):
            try:
                n.remove()
            except (NotFound, APIError):
                pass
    return {"removed": c.name, "lab": lab}


def images(client: docker.DockerClient, lab_tags: dict[str, list[str]]) -> dict:
    """Every tagged image, with which containers and saved labs use it; plus a summary
    of untagged leftovers from builds and pulls (dangling images)."""
    users: dict[str, list[str]] = {}
    for c in client.containers.list(all=True, sparse=True):
        users.setdefault(c.attrs.get("ImageID", ""), []).append((c.attrs.get("Names") or ["?"])[0].lstrip("/"))
    rows, dangling, dangling_size = [], 0, 0
    for img in client.api.images():               # one request; see main.images()
        size = img.get("Size", 0)
        tags = [t for t in img.get("RepoTags") or [] if not t.startswith("<none>")]
        if not tags:
            dangling += 1
            dangling_size += size
            continue
        for tag in tags:
            rows.append({"tag": tag, "id": img["Id"].replace("sha256:", "")[:12], "size_mb": round(size / 1e6, 1),
                         "created": img.get("Created", 0), "containers": sorted(users.get(img["Id"], [])),
                         "labs": sorted(lab_tags.get(tag, [])),
                         "built_here": labimages.RECIPE_LABEL in (img.get("Labels") or {})})
    return {"images": sorted(rows, key=lambda r: r["tag"]),
            "dangling": {"count": dangling, "size_mb": round(dangling_size / 1e6, 1)}}


class InUse(Exception):
    pass


def remove_image(client: docker.DockerClient, tag: str) -> dict:
    img = client.images.get(tag)
    using = [c.name for c in client.containers.list(all=True) if c.image and c.image.id == img.id]
    if using:
        raise InUse(f"{tag} is used by {', '.join(sorted(using))}. Delete those containers first "
                    f"(or remove their lab's containers), then delete the image.")
    # with several tags on one image, untag only this one
    client.images.remove(tag, noprune=False)
    return {"removed": tag}


def prune_dangling(client: docker.DockerClient) -> dict:
    """Remove untagged images left behind by rebuilds and pulls (not used by any container)."""
    before = client.api.images(filters={"dangling": True})
    r = client.images.prune(filters={"dangling": True})
    after = client.api.images(filters={"dangling": True})
    return {"removed": len(before) - len(after), "kept": len(after),
            "freed_mb": round((r.get("SpaceReclaimed") or 0) / 1e6, 1)}


# ---------------------------------------------------------------- recovery
def recover(client: docker.DockerClient, lab: str) -> tuple[Topology, bool]:
    """Rebuild a lab from its deployed containers. Returns (topology, exact)."""
    found = client.containers.list(all=True, filters={"label": f"{LABEL}={lab}"})
    if not found:
        raise NotFound(f"No containers of lab {lab} are left in the VM.")
    blobs = [c for c in found if c.labels.get("dockerlab.lab-file")]
    if blobs:                                     # exact: newest copy of the lab file
        newest = max(blobs, key=lambda c: c.attrs.get("Created", ""))
        topo = deployer.unpack_lab(newest.labels["dockerlab.lab-file"])
        topo.name = lab
        topo.images = labimages.recipes(client, topo)
        return topo, True
    return _rebuild(client, lab, found), False


def _image_defaults(client, image: str) -> tuple[list, list]:
    try:
        cfg = client.images.get(image).attrs.get("Config") or {}
        return cfg.get("Cmd") or [], cfg.get("Env") or []
    except (ImageNotFound, APIError):
        return [], []


def _in_eth_order(links: list[tuple[dict, Link]]) -> list[Link]:
    """Order cables so every container meets its cables in eth0, eth1, ... order:
    DockerLab numbers a container's interfaces by the order of the cables in the lab."""
    remaining = list(links)
    seen: dict[str, int] = {}                     # container -> cables placed so far
    out = []
    while remaining:
        ready = [x for x in remaining if all(sorted(i for (y, _) in links for (n2, i) in y.items() if n2 == n).index(i)
                                             == seen.get(n, 0) for n, i in x[0].items())]
        pick = ready[0] if ready else min(remaining, key=lambda x: max(x[0].values()))
        remaining.remove(pick)
        for n in pick[0]:
            seen[n] = seen.get(n, 0) + 1
        out.append(pick[1])
    return out


def _rebuild(client, lab: str, found) -> Topology:
    """Best effort for containers deployed before the lab file was embedded."""
    prefix = f"dl-{lab}-"
    nets = {n.name: n for n in client.networks.list(filters={"label": f"{LABEL}={lab}"})}
    nodes: list[Node] = []
    attach: dict[str, list[tuple[str, str, int]]] = {}   # network -> [(node id, fixed ip, eth index)]
    for c in sorted(found, key=lambda c: c.name):
        a = c.attrs
        cfg, host = a.get("Config") or {}, a.get("HostConfig") or {}
        node_id = c.labels.get("dockerlab.node") or c.name
        image = cfg.get("Image", "")
        d_cmd, d_env = _image_defaults(client, image)
        cmd = cfg.get("Cmd") or []
        env = [e for e in (cfg.get("Env") or []) if e not in d_env]
        ports = [PortMap(host=int(b[0]["HostPort"]), container=int(k.split("/")[0]), proto=k.split("/")[1])
                 for k, b in (host.get("PortBindings") or {}).items() if b and b[0].get("HostPort")]
        vols = []
        for spec in host.get("Binds") or []:
            parts = spec.split(":")
            if len(parts) >= 2:
                vols.append(VolumeMap(source=parts[0], target=parts[1], mode="ro" if parts[2:3] == ["ro"] else "rw"))
        networks = (a.get("NetworkSettings") or {}).get("Networks") or {}
        for net, ep in networks.items():
            if net in nets:
                ifname = ((ep.get("DriverOpts") or {}).get(IFNAME_OPT) or "eth99")
                idx = int(ifname[3:]) if ifname.startswith("eth") and ifname[3:].isdigit() else 99
                attach.setdefault(net, []).append((node_id, (ep.get("IPAMConfig") or {}).get("IPv4Address") or "", idx))
        nodes.append(Node(
            id=node_id, name=c.name[len(prefix):] if c.name.startswith(prefix) else c.name, image=image,
            command=" ".join(cmd) if cmd and cmd != d_cmd else "",
            ports=ports, volumes=vols,
            env=[EnvVar(key=e.split("=", 1)[0], value=e.split("=", 1)[1] if "=" in e else "") for e in env],
            internet="bridge" in networks,
            router=(host.get("Sysctls") or {}).get("net.ipv4.ip_forward") == "1",
            privileged=bool(host.get("Privileged")),
        ))

    switches: list[Switch] = []
    links: list[tuple[dict, Link]] = []           # (container id -> its eth index on this cable, cable)
    for name, n in sorted(nets.items()):
        labels = n.attrs.get("Labels") or {}
        seg = labels.get("dockerlab.segment") or labels.get("dockerlab.link") or name[len(prefix):]
        cfgs = (n.attrs.get("IPAM") or {}).get("Config") or []
        subnet = cfgs[0].get("Subnet", "") if cfgs else ""
        members = attach.get(name, [])
        if len(members) == 2 and not seg.startswith("s"):
            (a_id, a_ip, a_i), (b_id, b_ip, b_i) = members
            links.append(({a_id: a_i, b_id: b_i}, Link(id=seg, source=a_id, target=b_id, subnet=subnet,
                                                         source_ip=a_ip, target_ip=b_ip)))
        else:
            sw = Switch(id=seg, name=f"switch{len(switches) + 1}", subnet=subnet)
            switches.append(sw)
            for node_id, ip, i in members:
                links.append(({node_id: i}, Link(id=f"{seg}-{node_id}", source=node_id, target=sw.id, source_ip=ip)))
    links = _in_eth_order(links)

    # lay out: routers on top, switches in the middle, everything else below
    rows = [[n for n in nodes if n.router], switches, [n for n in nodes if not n.router]]
    for r, row in enumerate(rows):
        for i, item in enumerate(row):
            item.x, item.y = 60 + i * 260, 40 + r * 200
    topo = Topology(name=lab, nodes=nodes, switches=switches, links=links,
                    description="Recovered from the containers in the VM. Positions and startup commands "
                                "weren't stored when this lab was deployed, so check them before redeploying.")
    topo.images = labimages.recipes(client, topo)
    return topo
