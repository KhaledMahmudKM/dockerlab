"""Export a lab as a docker-compose file.

The result runs with plain `docker compose up -d`. Differences from DockerLab itself:
- NAT/internet access uses a user-defined network `nat` (Compose can't attach
  containers to Docker's default `bridge` with service aliases).
- Startup commands run as `post_start` hooks (Compose 2.30 or newer): Compose runs them
  in the container each time it starts it (`up`, `start`, `restart`), as DockerLab does.
  A plain `docker start` doesn't run them. `$` is written as `$$`, so Compose leaves
  the shell's variables alone.
- Images DockerLab built (Router, Host, the example labs' images...) can't be pulled from
  anywhere: their Dockerfiles are written into the file (`build: dockerfile_inline`), so
  `docker compose up` builds them on the new host (Compose 2.17 or newer). `pull_policy:
  build` makes sure Compose never pulls an unrelated image of the same name instead.
- When the host has bridge netfilter on, its firewall would drop traffic routed between
  the lab's networks; a one-off service, dockerlab-hostfw, adds the same two iptables
  rules DockerLab adds (hostfw.py) before the lab's containers start.
- Docker gets the lab's own subnets here (Compose can't set addresses after start),
  so they must not overlap other networks on that engine. Docker's gateway address
  is moved to a free one, so the lab can keep .1.
"""
from __future__ import annotations

import yaml

import deployer
import hostfw
import images
from models import Topology

# The Docker host's firewall drops routed lab traffic when bridge netfilter is on (see
# hostfw.py). DockerLab fixes that on the hosts it deploys to; an exported lab carries the
# same fix as a one-off service that the lab's containers wait for.
HOSTFW_SERVICE = "dockerlab-hostfw"
HOSTFW_IMAGE = """\
FROM alpine:latest
RUN apk add --no-cache iptables
"""


class _Dumper(yaml.SafeDumper):
    """Multi-line text (Dockerfiles, the description) as readable | blocks."""


def _str(dumper, data):
    if "\n" in data:
        return dumper.represent_scalar("tag:yaml.org,2002:str", data, style="|")
    return dumper.represent_scalar("tag:yaml.org,2002:str", data)


_Dumper.add_representer(str, _str)


def _literal(text: str) -> str:
    """Compose replaces ${VAR} and $VAR in the file with its own variables; $$ is a literal $."""
    return text.replace("$", "$$")


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
        recipe = topo.images.get(images.full_tag(node.image))
        if recipe:                                   # built by DockerLab: build it there too
            svc["build"] = {"context": ".", "dockerfile_inline": _literal(recipe if recipe.endswith("\n") else recipe + "\n")}
            svc["pull_policy"] = "build"
        if node.command.strip():
            svc["command"] = _literal(node.command)
        if node.startup.strip():                     # DockerLab's startup commands, run by Compose after each start
            svc["post_start"] = [{"command": ["sh", "-c", _literal(node.startup)]}]
        if node.privileged:
            svc["privileged"] = True
        if deployer.node_sysctls(node):
            svc["sysctls"] = deployer.node_sysctls(node)
        env = {e.key: _literal(e.value) for e in node.env if e.key}
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
            if i["link"] and node.set_addresses and plan.get((node.id, i["link"])):
                ep["ipv4_address"] = plan[(node.id, i["link"])].split("/")[0]
            nets[key] = ep
        if nets:
            svc["networks"] = nets
        else:
            svc["network_mode"] = "none"
        services[node.name] = svc

    if networks and services:                     # lab networks: make sure the host lets their traffic through
        rules = "; ".join(
            "iptables {0}-C {1} 2>/dev/null || iptables {0}-I {1}".format(*hostfw._split(r)) for r in hostfw.RULES)
        services[HOSTFW_SERVICE] = {
            "image": "dockerlab/hostfw:latest",
            "build": {"context": ".", "dockerfile_inline": HOSTFW_IMAGE},
            "pull_policy": "build",
            "network_mode": "host",
            "cap_add": ["NET_ADMIN", "NET_RAW"],
            "restart": "no",
            "command": ["sh", "-c", _literal(
                'if [ "$(cat /proc/sys/net/bridge/bridge-nf-call-iptables 2>/dev/null)" = 1 ]; then '
                + rules + '; echo "bridge netfilter is on: lab traffic allowed"; '
                'else echo "bridge netfilter is off: nothing to do"; fi')],
        }
        for name, svc in services.items():
            if name != HOSTFW_SERVICE:
                svc["depends_on"] = {HOSTFW_SERVICE: {"condition": "service_completed_successfully"}}

    if nat_needed:
        networks["nat"] = {"name": f"dl-{lab}-nat", "driver": "bridge"}

    doc: dict = {"name": f"dl-{lab}", "services": services}
    if topo.description.strip():
        doc["x-dockerlab-description"] = _literal(topo.description)
    if networks:
        doc["networks"] = networks
    startup = any(n.startup.strip() for n in topo.nodes)

    header = (f"# DockerLab lab '{lab}' exported for docker compose.\n"
              f"# Run: docker compose -f {lab}.compose.yaml up -d\n"
              "# Interface names (eth0, nat0, ...) need Docker 28 or newer.\n")
    if HOSTFW_SERVICE in services:
        header += ("# dockerlab-hostfw runs once at 'up': if the host's bridge netfilter is on, it adds two\n"
                   "# iptables rules on the host so traffic routed between the lab's networks isn't dropped.\n")
    if any("build" in svc for svc in services.values()):
        header += ("# Images built by DockerLab are built here too, from the Dockerfiles below\n"
                   "# (needs Docker Compose 2.17 or newer, and internet access while building).\n")
    if startup:
        header += ("# Startup commands run as post_start hooks (Docker Compose 2.30 or newer) each time\n"
                   "# Compose starts a container; a plain `docker start` doesn't run them.\n")
    return header + yaml.dump(doc, Dumper=_Dumper, sort_keys=False, default_flow_style=False, allow_unicode=True, width=1000)
