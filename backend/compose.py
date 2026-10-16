"""Export a lab as a docker-compose file.

The result runs with plain `docker compose up -d`. Differences from DockerLab itself:
- NAT/internet access uses a user-defined network `nat` (Compose can't attach
  containers to Docker's default `bridge` with service aliases).
- Startup commands are kept under `x-dockerlab-startup` for reference; Compose
  ignores `x-` keys, so run them yourself after `up`.
- Docker gets the lab's own subnets here (Compose can't set addresses after start),
  so they must not overlap other networks on that engine. Docker's gateway address
  is moved to a free one, so the lab can keep .1.
"""
from __future__ import annotations

import yaml

import deployer
from models import Topology


def to_compose(topo: Topology) -> str:
    lab = topo.name
    networks: dict = {}
    services: dict = {}
    nat_needed = False

    plan, subnets = deployer.lab_addresses(topo)
    for seg in deployer.segments(topo):            # switches and container-to-container cables
        net = {
            "name": deployer.network_name(lab, seg),
            "driver": "bridge",
            "internal": True,
            "driver_opts": {"com.docker.network.bridge.name": deployer.bridge_ifname(lab, seg)},
        }
        if seg.id in subnets:
            sub = subnets[seg.id]
            used = {v.split("/")[0] for (n, l), v in plan.items() if v and deployer.segment(topo, next(
                x for x in topo.links if x.id == l)).id == seg.id}
            gateway = next((str(h) for h in reversed(list(sub.hosts())) if str(h) not in used), None)
            net["ipam"] = {"config": [{"subnet": str(sub), **({"gateway": gateway} if gateway else {})}]}
        networks[seg.id] = net

    for node in topo.nodes:
        svc: dict = {
            "image": node.image,
            "container_name": deployer.container_name(lab, node),
            "hostname": node.name,
            "tty": True,
            "stdin_open": True,
            "cap_add": ["NET_ADMIN", "NET_RAW"],
        }
        if node.command.strip():
            svc["command"] = node.command
        if node.privileged:
            svc["privileged"] = True
        if node.router:
            svc["sysctls"] = {"net.ipv4.ip_forward": "1"}
        env = {e.key: e.value for e in node.env if e.key}
        if env:
            svc["environment"] = env
        if node.ports:
            svc["ports"] = [f"{p.host}:{p.container}/{p.proto}" for p in node.ports]
        if node.volumes:
            svc["volumes"] = [f"{v.source}:{v.target}:{v.mode}" for v in node.volumes]

        nets = {}
        for i in deployer.interfaces(topo, node):
            key = "nat" if i["net"] == "bridge" else i["seg"]
            nat_needed |= key == "nat"
            ep = {"driver_opts": {deployer.IFNAME_OPT: i["ifname"]}}
            if i["link"] and plan.get((node.id, i["link"])):
                ep["ipv4_address"] = plan[(node.id, i["link"])].split("/")[0]
            nets[key] = ep
        if nets:
            svc["networks"] = nets
        else:
            svc["network_mode"] = "none"
        services[node.name] = svc

    if nat_needed:
        networks["nat"] = {"name": f"dl-{lab}-nat", "driver": "bridge"}

    doc: dict = {"name": f"dl-{lab}", "services": services}
    if topo.description.strip():
        doc["x-dockerlab-description"] = topo.description
    if networks:
        doc["networks"] = networks
    startup = {n.name: n.startup for n in topo.nodes if n.startup.strip()}
    if startup:
        doc["x-dockerlab-startup"] = startup

    header = (f"# DockerLab lab '{lab}' exported for docker compose.\n"
              f"# Run: docker compose -f {lab}.compose.yaml up -d\n"
              "# Interface names (eth0, nat0, ...) need Docker 28 or newer.\n")
    if startup:
        header += "# Startup commands are listed under x-dockerlab-startup; run them after 'up'.\n"
    return header + yaml.safe_dump(doc, sort_keys=False, default_flow_style=False)
