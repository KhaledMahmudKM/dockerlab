"""How busy the Docker host is: CPU, memory, and what each container uses.

Read from the host's own /proc counters (the VM's view, which is what matters when
labs make it slow), over one SSH connection kept open for the purpose, so watching
the load doesn't cost an SSH login every few seconds. With Docker on this computer
(Linux), the same files are read directly. Docker Desktop on Windows or macOS runs
Docker in a hidden VM whose /proc we can't read: there, only containers are shown.

CPU use is a rate, so it's computed from two readings: the first call after
connecting returns no CPU figure yet.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading

import paramiko

import connection
import vmshell

PROBE = "head -n1 /proc/stat; grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo; cat /proc/loadavg; nproc"
STATS = "docker stats --no-stream --format '{{json .}}'"

_lock = threading.Lock()
_ssh: paramiko.SSHClient | None = None
_ssh_for: str | None = None          # the DOCKER_HOST that _ssh is connected to
_prev: dict[str, tuple[int, int]] = {}  # host -> (total jiffies, idle jiffies) at the last reading


def _remote(cmd: str, timeout: float) -> str:
    """Run cmd on the Docker host over the kept-open connection (reconnecting if needed)."""
    global _ssh, _ssh_for
    host = os.environ.get("DOCKER_HOST", "")
    with _lock:
        if _ssh is not None and (_ssh_for != host or not (_ssh.get_transport() and _ssh.get_transport().is_active())):
            _close()
        if _ssh is None:
            if not connection.reachable(3):
                raise ConnectionError("the Docker host doesn't answer")
            _ssh = vmshell._connect()
            _ssh.get_transport().set_keepalive(15)
            _ssh_for = host
        client = _ssh
    try:
        _, out, err = client.exec_command(cmd, timeout=timeout)
        text = out.read().decode(errors="replace")
        out.channel.recv_exit_status()
        return text
    except Exception:
        with _lock:
            _close()
        raise


def _close() -> None:
    global _ssh, _ssh_for
    if _ssh is not None:
        try:
            _ssh.close()
        except Exception:  # noqa: BLE001
            pass
    _ssh, _ssh_for = None, None


def _local(cmd: str, timeout: float) -> str:
    return subprocess.run(["sh", "-c", cmd], capture_output=True, text=True, timeout=timeout).stdout


def _where():
    """How to run commands on the Docker host, or None if we can't (Docker Desktop)."""
    host = os.environ.get("DOCKER_HOST", "")
    if host.startswith("ssh://"):
        return _remote
    if not host and sys.platform.startswith("linux"):
        return _local
    return None


def load() -> dict:
    """{cpu_pct, ncpu, load1, load5, load15, mem_total, mem_used, swap_total, swap_used} (bytes),
    or {"available": False} where the host can't be read."""
    run = _where()
    if run is None:
        return {"available": False, "reason": "Docker runs in a VM this app can't look into (Docker Desktop)."}
    text = run(PROBE, 10)
    lines = text.strip().splitlines()
    cpu = [int(x) for x in lines[0].split()[1:]]
    total, idle = sum(cpu[:8]), cpu[3] + (cpu[4] if len(cpu) > 4 else 0)     # idle + iowait
    mem = {}
    for ln in lines[1:5]:
        k, v = ln.split(":", 1)
        mem[k] = int(v.split()[0]) * 1024
    l1, l5, l15 = (float(x) for x in lines[5].split()[:3])
    ncpu = int(lines[6])

    key = os.environ.get("DOCKER_HOST", "local")
    pct = None
    prev = _prev.get(key)
    if prev and total > prev[0]:
        pct = round(100 * (1 - (idle - prev[1]) / (total - prev[0])), 1)
    _prev[key] = (total, idle)
    return {"available": True, "cpu_pct": pct, "ncpu": ncpu, "load1": l1, "load5": l5, "load15": l15,
            "mem_total": mem["MemTotal"], "mem_used": mem["MemTotal"] - mem["MemAvailable"],
            "swap_total": mem["SwapTotal"], "swap_used": mem["SwapTotal"] - mem["SwapFree"]}


def _bytes(s: str) -> int:
    """'12.5MiB' -> bytes."""
    s = s.strip()
    units = {"B": 1, "KiB": 1024, "MiB": 1024**2, "GiB": 1024**3, "TiB": 1024**4,
             "kB": 1000, "KB": 1000, "MB": 1000**2, "GB": 1000**3, "TB": 1000**4}
    for u in sorted(units, key=len, reverse=True):
        if s.endswith(u):
            try:
                return int(float(s[: -len(u)]) * units[u])
            except ValueError:
                return 0
    return 0


def containers() -> list[dict]:
    """What each running container uses: [{name, lab, node, cpu_pct, mem}], busiest first.
    `docker stats` measures for about a second, so this takes a moment."""
    run = _where()
    if run is None:
        return []
    rows = []
    for ln in run(STATS, 30).splitlines():
        try:
            d = json.loads(ln)
        except ValueError:
            continue
        name = d.get("Name", "")
        rows.append({"name": name, "cpu_pct": float(d.get("CPUPerc", "0%").rstrip("%") or 0),
                     "mem": _bytes(d.get("MemUsage", "0B").split("/")[0])})
    rows.sort(key=lambda r: (-r["cpu_pct"], -r["mem"]))
    return rows
