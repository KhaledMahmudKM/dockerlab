"""Topology data model shared by the API and the deployer."""
from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator

NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,40}$")
IFNAME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_.-]{0,14}$")
IFNAME_SERIES_RE = re.compile(r"^(?=.{1,15}$)[a-zA-Z][a-zA-Z0-9_.-]*?\d+$")


def ifname_series(first: str):
    """eth0 -> eth0, eth1, ...;  e1-1 -> e1-1, e1-2, ..."""
    m = re.match(r"^(.*?)(\d+)$", first or "eth0")
    prefix, start = m.group(1), int(m.group(2))
    return lambda i: f"{prefix}{start + i}"


class PortMap(BaseModel):
    host: int = Field(ge=1, le=65535)
    container: int = Field(ge=1, le=65535)
    proto: Literal["tcp", "udp"] = "tcp"


class VolumeMap(BaseModel):
    source: str          # host path on the Docker server, or a named volume
    target: str          # path inside the container
    mode: Literal["rw", "ro"] = "rw"


class EnvVar(BaseModel):
    key: str
    value: str = ""


class Node(BaseModel):
    id: str
    name: str
    image: str
    x: float = 0
    y: float = 0
    command: str = ""            # empty = image default
    ports: list[PortMap] = []
    volumes: list[VolumeMap] = []
    env: list[EnvVar] = []
    internet: bool = False       # attach to Docker's default bridge (NAT to outside)
    router: bool = False         # enable IPv4 forwarding inside the container
    privileged: bool = False
    startup: str = ""            # shell commands run after every container start
    interfaces: int = Field(default=0, ge=0, le=64)   # cable interfaces it has; 0 = one per cable, no limit
    # For network operating systems (e.g. Nokia SR Linux) that expect their own names and set their own addresses:
    ifname_first: str = ""       # name of the first cable interface, e.g. e1-1; the rest count up. "" = eth0
    nat_ifname: str = ""         # name of the NAT interface; "" = nat0
    set_addresses: bool = True   # False: DockerLab leaves the cable interfaces without addresses
    sysctls: list[EnvVar] = []   # extra kernel settings, e.g. net.ipv6.conf.all.disable_ipv6=0

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        if not NAME_RE.match(v):
            raise ValueError("node name: letters, digits, '_', '.', '-' (max 41 chars)")
        return v

    @field_validator("ifname_first")
    @classmethod
    def _ifname_first(cls, v: str) -> str:
        v = v.strip()
        if v and not IFNAME_SERIES_RE.match(v):
            raise ValueError("first interface name: letters, '-', '_' or '.', ending in a number, e.g. eth1 or e1-1 (max 15 chars)")
        return v

    @field_validator("nat_ifname")
    @classmethod
    def _nat_ifname(cls, v: str) -> str:
        v = v.strip()
        if v and not IFNAME_RE.match(v):
            raise ValueError("NAT interface name: letters, digits, '-', '_' or '.' (max 15 chars)")
        return v

    @field_validator("sysctls")
    @classmethod
    def _sysctls(cls, v: list) -> list:
        for e in v:
            if e.key and not re.match(r"^(net|kernel)\.[a-zA-Z0-9_./-]+$", e.key):
                raise ValueError(f"sysctl {e.key}: only net.* and kernel.* settings can be set per container")
        return v


class Switch(BaseModel):
    """A shared segment (Ethernet switch): one network that many containers plug into."""
    id: str
    name: str
    x: float = 0
    y: float = 0
    subnet: str = ""             # optional, e.g. 10.0.10.0/24; empty = Docker picks

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        if not NAME_RE.match(v):
            raise ValueError("switch name: letters, digits, '_', '.', '-' (max 41 chars)")
        return v


class Note(BaseModel):
    """A text note on the bench. Only for people: deploy ignores it."""
    id: str
    x: float = 0
    y: float = 0
    w: float = 200
    h: float = 100
    text: str = ""
    color: Literal["yellow", "blue", "green", "pink", "grey"] = "yellow"


class Link(BaseModel):
    """A cable. Between two containers it is its own network; between a container and
    a switch it plugs the container into the switch's network."""
    id: str
    source: str                  # container or switch id
    target: str                  # container or switch id
    subnet: str = ""             # container-to-container cables only; empty = Docker picks
    source_ip: str = ""          # optional fixed address of the source end (needs a subnet)
    target_ip: str = ""          # optional fixed address of the target end (needs a subnet)


class Topology(BaseModel):
    name: str
    description: str = ""        # Markdown from the lab's author (tasks, notes)
    nodes: list[Node] = []
    switches: list[Switch] = []
    links: list[Link] = []
    notes: list[Note] = []
    images: dict[str, str] = {}  # image tag -> Dockerfile, for images built in DockerLab (portability)

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        if not NAME_RE.match(v):
            raise ValueError("lab name: letters, digits, '_', '.', '-' (max 41 chars)")
        return v
