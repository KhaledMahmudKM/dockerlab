"""Keep the Docker host's firewall from dropping lab traffic.

DockerLab's cables and switches are Docker "internal" networks. For those, Docker
adds firewall rules that drop any packet on the network whose source or destination
is outside the network's subnet, and the subnet Docker knows is DockerLab's carrier
subnet, not the lab's (see deployer.py), so that's every lab packet. Normally they never
see a lab's traffic, because packets between two containers on one network are switched
by the Linux bridge, not routed by the host. But when the host has bridge netfilter on
(the br_netfilter module, net.bridge.bridge-nf-call-iptables = 1), switched packets go
through the firewall too, and are dropped at the bridge.

The fix is one rule in DOCKER-USER, the chain Docker reserves for its users and
checks first: accept packets switched within a DockerLab bridge (all are named dl…).

Bridge netfilter also runs switched packets through the NAT table, where Docker's own
rule masquerades everything from its default network (172.17.0.0/16) that doesn't leave
by docker0. A connection from the Docker host itself to a lab's published port (e.g.
`curl localhost:8080` in the host's console) enters the lab with such an address, so
it got masqueraded on its way across a lab switch, and the reply was lost. A second
rule keeps packets going into DockerLab bridges out of NAT.

Both only matter, and are only added, when bridge netfilter is on.
"""
from __future__ import annotations

import os
import subprocess
import sys

import vmshell

RULES = ["DOCKER-USER -i dl+ -o dl+ -j ACCEPT",          # filter: don't drop switched lab traffic
         "-t nat POSTROUTING -o dl+ -j RETURN"]          # nat: don't masquerade it either


def _split(rule: str) -> tuple[str, str]:
    return ("-t nat ", rule.removeprefix("-t nat ")) if rule.startswith("-t nat ") else ("", rule)


def _one(rule: str) -> str:
    t, r = _split(rule)
    return f"if $SUDO iptables {t}-C {r} 2>/dev/null || $SUDO iptables {t}-I {r}; then echo ok; else echo failed; fi"


SCRIPT = ('if [ "$(cat /proc/sys/net/bridge/bridge-nf-call-iptables 2>/dev/null)" != 1 ]; then echo off; else '
          + "; ".join(_one(r) for r in RULES) + "; fi")
MANUAL = "; ".join("sudo iptables {}-I {}".format(*_split(r)) for r in RULES)


def ensure() -> str | None:
    """Make sure the rule is in place where it's needed. Returns a warning, or None."""
    host = os.environ.get("DOCKER_HOST", "")
    try:
        if host.startswith("ssh://"):
            _, out = vmshell.run("SUDO='sudo -n'; " + SCRIPT)
        elif not host and sys.platform.startswith("linux"):
            sudo = "" if os.geteuid() == 0 else "sudo -n"
            out = subprocess.run(["sh", "-c", f"SUDO='{sudo}'; " + SCRIPT], capture_output=True, text=True, timeout=20).stdout
        else:
            return None                      # e.g. tcp:// or Docker Desktop: nothing we can reach
    except Exception as e:  # noqa: BLE001 — never fail a deploy over this
        return (f"Couldn't check the Docker host's firewall ({e}). If routing through lab routers doesn't work, "
                f"run this on the Docker host: {MANUAL}")
    lines = out.strip().splitlines()
    if lines and (lines[-1] == "off" or "failed" not in lines):
        return None
    return ("The Docker host filters switched traffic (bridge netfilter is on), so it drops lab traffic, and "
            "DockerLab couldn't add its firewall rules (sudo needs a password, or iptables is missing). "
            f"Run this once on the Docker host, e.g. in its Console: {MANUAL}")
