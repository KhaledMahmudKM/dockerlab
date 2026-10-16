"""Live packet capture: `ssh <vm> sudo tcpdump ... -w -` piped into local Wireshark.

The backend runs on the same PC as the browser, so it can launch Wireshark itself.
We capture on a container's port (the VM end of its veth pair), found by interface
index, because a Linux bridge's own interface doesn't see unicast between its ports.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlparse

_running: list[tuple[subprocess.Popen, subprocess.Popen]] = []


def ssh_target() -> tuple[str, list[str]] | None:
    """('user@host', ['-p', '2222']) from DOCKER_HOST=ssh://user@host:port."""
    url = os.environ.get("DOCKER_HOST", "")
    if not url.startswith("ssh://"):
        return None
    u = urlparse(url)
    target = f"{u.username}@{u.hostname}" if u.username else u.hostname
    return target, (["-p", str(u.port)] if u.port else [])


def wireshark_path() -> str | None:
    env = os.environ.get("DOCKERLAB_WIRESHARK")
    if env:
        return env if (os.path.exists(env) or shutil.which(env)) else None
    if sys.platform == "win32":
        for base in (os.environ.get("ProgramFiles", r"C:\Program Files"),
                     os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")):
            p = os.path.join(base, "Wireshark", "Wireshark.exe")
            if os.path.exists(p):
                return p
        return None
    return shutil.which("wireshark")


def remote_command(ifindex: int, sudo_flags: str = "") -> str:
    """Shell command run on the VM: find the interface with this index, capture on it."""
    return (f"IF=$(grep -lx {ifindex} /sys/class/net/*/ifindex | cut -d/ -f5); "
            f"sudo {sudo_flags}tcpdump -i $IF -U -w -").replace("sudo  ", "sudo ")


def command_line(ifindex: int) -> str:
    """The equivalent command for people who want to run it by hand (cmd.exe)."""
    t = ssh_target()
    target = " ".join((t[1] if t else []) + [t[0] if t else "gns3@<vm-ip>"])
    ws = wireshark_path() or r"C:\Program Files\Wireshark\Wireshark.exe"
    return f'ssh {target} "{remote_command(ifindex)}" | "{ws}" -k -i -'


def start(ifindex: int) -> None:
    """Launch the pipeline. Raises RuntimeError with a readable reason on failure."""
    t = ssh_target()
    if not t:
        raise RuntimeError("Capture needs DockerLab connected to the Docker host over SSH.")
    ws = wireshark_path()
    if not ws:
        raise RuntimeError("Wireshark wasn't found. Install it, or set DOCKERLAB_WIRESHARK to Wireshark.exe's full path.")
    target, port = t
    # prune finished pipelines
    _running[:] = [p for p in _running if p[1].poll() is None]

    err = tempfile.TemporaryFile()
    ssh = subprocess.Popen(
        ["ssh", "-o", "BatchMode=yes", *port, target, remote_command(ifindex, "-n ")],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=err,
    )
    shark = subprocess.Popen([ws, "-k", "-i", "-"], stdin=ssh.stdout)
    ssh.stdout.close()  # Wireshark owns the read end now

    # fail fast on the common problems (no key login, sudo wants a password)
    deadline = time.time() + 3
    while time.time() < deadline and ssh.poll() is None:
        time.sleep(0.1)
    if ssh.poll() not in (None, 0):
        err.seek(0)
        msg = err.read().decode(errors="replace").strip().splitlines()
        shark.terminate()
        hint = ""
        text = " ".join(msg).lower()
        if "password is required" in text or "a terminal is required" in text:
            hint = " tcpdump needs a passwordless sudo rule on the VM (see README)."
        elif "permission denied" in text or "host key" in text:
            hint = " SSH key login to the VM isn't working from this PC."
        raise RuntimeError(f"Capture stopped: {msg[-1] if msg else 'ssh exited'}.{hint}")
    _running.append((ssh, shark))
