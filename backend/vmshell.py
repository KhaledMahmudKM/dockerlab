"""Interactive shell on the Docker host (the GNS3 VM) over SSH.

Connects exactly the way docker-py's SSH transport does: DOCKER_HOST=ssh://user@host,
~/.ssh/config, your SSH keys or agent, and known_hosts (unknown host keys are
rejected). So if DockerLab can reach Docker, it can open this shell too.
"""
from __future__ import annotations

import logging
import os
from urllib.parse import urlparse

import paramiko


class VMShellError(Exception):
    pass


def target() -> str | None:
    """'user@host' for display, or None when DOCKER_HOST isn't ssh://."""
    url = os.environ.get("DOCKER_HOST", "")
    if not url.startswith("ssh://"):
        return None
    u = urlparse(url)
    return f"{u.username}@{u.hostname}" if u.username else u.hostname


def _connect() -> paramiko.SSHClient:
    url = os.environ.get("DOCKER_HOST", "")
    if not url.startswith("ssh://"):
        raise VMShellError("The Docker host console needs DockerLab connected to the Docker host over SSH.")
    logging.getLogger("paramiko").setLevel(logging.WARNING)
    u = urlparse(url)
    params = {"hostname": u.hostname, "port": u.port or 22, "username": u.username, "timeout": 15}
    cfg_file = os.path.expanduser("~/.ssh/config")
    if os.path.exists(cfg_file):
        conf = paramiko.SSHConfig()
        with open(cfg_file, encoding="utf-8", errors="replace") as f:
            conf.parse(f)
        host = conf.lookup(u.hostname)
        if "proxycommand" in host:
            params["sock"] = paramiko.ProxyCommand(host["proxycommand"])
        if "hostname" in host:
            params["hostname"] = host["hostname"]
        if u.port is None and "port" in host:
            params["port"] = int(host["port"])
        if u.username is None and "user" in host:
            params["username"] = host["user"]
        if "identityfile" in host:
            params["key_filename"] = host["identityfile"]

    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    try:
        client.connect(**params)
    except paramiko.AuthenticationException:
        client.close()
        raise VMShellError("SSH login to the VM was refused. Key login must work for DockerLab's user (see README).")
    except paramiko.SSHException as e:
        client.close()
        hint = " Run 'ssh %s' once in a terminal to accept the VM's host key." % target() if "known_hosts" in str(e) else ""
        raise VMShellError(f"SSH to the VM failed: {e}.{hint}")
    except OSError as e:
        client.close()
        raise VMShellError(f"Couldn't reach the VM: {e}.")
    return client


def open_shell(cols: int = 80, rows: int = 24) -> tuple[paramiko.SSHClient, paramiko.Channel]:
    client = _connect()
    try:
        chan = client.invoke_shell(term="xterm-256color", width=cols, height=rows)
    except paramiko.SSHException as e:
        client.close()
        raise VMShellError(f"SSH to the VM failed: {e}.")
    return client, chan


def run(command: str, timeout: float = 20) -> tuple[int, str]:
    """Run one command on the Docker host; returns (exit status, stdout + stderr)."""
    client = _connect()
    try:
        _, out, err = client.exec_command(command, timeout=timeout)
        text = out.read().decode(errors="replace") + err.read().decode(errors="replace")
        return out.channel.recv_exit_status(), text
    finally:
        client.close()
