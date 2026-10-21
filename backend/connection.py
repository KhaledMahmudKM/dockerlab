"""Which Docker host DockerLab works with, chosen in the app.

The user enters the host's address (and SSH user) in the Connect dialog. DockerLab
then talks to Docker over SSH, the way `DOCKER_HOST=ssh://user@host` does, so the
rest of the backend keeps reading DOCKER_HOST; this module sets it.

Connecting also gets a fresh host ready, so nobody has to open a terminal:
- an unknown SSH host key is shown to the user, and saved to known_hosts once they trust it;
- with no key login yet, the user gives the password once: DockerLab installs an SSH
  key (creating one if needed), and, optionally, a sudo rule for packet capture and
  the firewall rule (tcpdump, iptables), and adds the user to the docker group.

The choice is saved in ~/.dockerlab/settings.json. DockerLab reconnects to it at the
next start only if "Connect to it automatically" was ticked; otherwise the user connects.
A DOCKER_HOST set in the environment still wins at startup, for scripted setups.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import shlex
import socket
import threading
from pathlib import Path

import paramiko

SETTINGS = Path(os.environ.get("DOCKERLAB_SETTINGS", Path.home() / ".dockerlab" / "settings.json"))
SSH_DIR = Path.home() / ".ssh"
KNOWN_HOSTS = SSH_DIR / "known_hosts"
LOCAL = "local"

_lock = threading.Lock()
_active: str | None = None          # "ssh://user@host[:port]", "local", or None (not connected)
_source: str | None = None          # "env", "settings" or "app"


class ConnectError(Exception):
    """A problem the user can act on; the message says what to do."""


# ---------------------------------------------------------------- settings
def load_settings() -> dict:
    try:
        return json.loads(SETTINGS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save_settings(data: dict) -> None:
    SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS.write_text(json.dumps(data, indent=2), encoding="utf-8")


def url_of(mode: str, host: str = "", user: str = "", port: int = 22) -> str:
    if mode == LOCAL:
        return LOCAL
    return f"ssh://{user + '@' if user else ''}{host}{'' if int(port) == 22 else f':{port}'}"


# ---------------------------------------------------------------- active host
def _apply(url: str | None) -> None:
    if url and url != LOCAL:
        os.environ["DOCKER_HOST"] = url
    else:
        os.environ.pop("DOCKER_HOST", None)


def init() -> None:
    """At startup: DOCKER_HOST from the environment, else the saved host if the user
    asked to reconnect automatically (off unless ticked), else not connected."""
    global _active, _source
    env = os.environ.get("DOCKER_HOST")
    if env:
        _active, _source = env, "env"
        return
    s = load_settings()
    if s.get("auto_connect", False) and s.get("url"):
        _active, _source = s["url"], "settings"
        _apply(_active)


def active() -> str | None:
    return _active


def describe() -> dict:
    s = load_settings()
    return {"active": _active, "source": _source, "saved": {k: s.get(k) for k in ("mode", "host", "user", "port", "auto_connect")},
            "recent": s.get("recent", [])}


def activate(url: str | None, remember: dict | None = None) -> None:
    """Switch to `url` (None = disconnect). `remember` is saved as the new default."""
    global _active, _source
    with _lock:
        _active, _source = url, ("app" if url else None)
        _apply(url)
        if remember is not None:
            s = load_settings()
            s.update(remember, url=url)
            entry = {k: remember.get(k) for k in ("mode", "host", "user", "port")}
            s["recent"] = [entry] + [r for r in s.get("recent", []) if r != entry][:4]
            _save_settings(s)


# ---------------------------------------------------------------- host keys
def fingerprint(key: paramiko.PKey) -> str:
    return "SHA256:" + base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip("=")


def _host_id(host: str, port: int) -> str:
    return host if int(port) == 22 else f"[{host}]:{port}"


def _known(host: str, port: int) -> list[paramiko.PKey]:
    keys = paramiko.HostKeys()
    for f in (KNOWN_HOSTS, Path("/etc/ssh/ssh_known_hosts")):
        try:
            keys.load(str(f))
        except (OSError, paramiko.SSHException):
            pass
    found = keys.lookup(_host_id(host, port)) or {}
    return list(found.values())


def _trust(host: str, port: int, key: paramiko.PKey, replace: bool) -> None:
    SSH_DIR.mkdir(mode=0o700, exist_ok=True)
    hid = _host_id(host, port)
    lines = KNOWN_HOSTS.read_text(encoding="utf-8", errors="replace").splitlines() if KNOWN_HOSTS.exists() else []
    if replace:   # drop this host's old (plain-text) entries, keep everything else as is
        lines = [ln for ln in lines if hid not in ln.split(" ", 1)[0].split(",")]
    lines.append(f"{hid} {key.get_name()} {key.get_base64()}")
    KNOWN_HOSTS.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _server_key(host: str, port: int) -> paramiko.PKey:
    try:
        sock = socket.create_connection((host, int(port)), timeout=8)
    except OSError as e:
        raise ConnectError(f"Can't reach {host} on port {port} ({e.strerror or e}). Check that the VM is running "
                           "and that this is its address (for the GNS3 VM, the Host-only one shown on its screen).")
    t = paramiko.Transport(sock)
    try:
        t.start_client(timeout=10)
        return t.get_remote_server_key()
    except paramiko.SSHException as e:
        raise ConnectError(f"{host}:{port} answered, but not as an SSH server ({e}).")
    finally:
        t.close()


# ---------------------------------------------------------------- SSH key
def ensure_key() -> str:
    """Your public key (OpenSSH line), creating ~/.ssh/id_ed25519 if you have no key yet."""
    for name in ("id_ed25519", "id_ecdsa", "id_rsa"):
        pub = SSH_DIR / f"{name}.pub"
        if (SSH_DIR / name).exists() and pub.exists():
            return pub.read_text(encoding="utf-8").strip()
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    key = Ed25519PrivateKey.generate()
    private = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.OpenSSH,
                                serialization.NoEncryption())
    public = key.public_key().public_bytes(serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH)
    SSH_DIR.mkdir(mode=0o700, exist_ok=True)
    path = SSH_DIR / "id_ed25519"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(private)
    line = f"{public.decode()} dockerlab@{socket.gethostname()}"
    (SSH_DIR / "id_ed25519.pub").write_text(line + "\n", encoding="utf-8")
    return line


def _client(host, port, user, password=None) -> paramiko.SSHClient:
    c = paramiko.SSHClient()
    c.load_system_host_keys()
    try:
        c.load_host_keys(str(KNOWN_HOSTS))
    except (OSError, paramiko.SSHException):
        pass
    c.set_missing_host_key_policy(paramiko.RejectPolicy())
    kw = {"password": password, "look_for_keys": password is None, "allow_agent": password is None}
    c.connect(host, port=int(port), username=user, timeout=10, banner_timeout=10, auth_timeout=10, **kw)
    return c


def _run(c: paramiko.SSHClient, cmd: str, stdin: str | None = None, timeout: int = 60) -> tuple[int, str]:
    i, o, e = c.exec_command(cmd, timeout=timeout)
    if stdin is not None:
        i.write(stdin)
        i.flush()
        i.channel.shutdown_write()
    out = o.read().decode(errors="replace") + e.read().decode(errors="replace")
    return o.channel.recv_exit_status(), out.strip()


SUDO_SETUP = r"""
U={user}
L=""
for c in tcpdump iptables; do for d in /usr/sbin /usr/bin /sbin /bin; do
  [ -x "$d/$c" ] && L="$L${{L:+, }}$d/$c"
done; done
if [ -n "$L" ] && [ "{sudo}" = 1 ]; then
  printf '%s\n' "$U ALL=(root) NOPASSWD: $L" > /tmp/dockerlab.sudoers
  visudo -cf /tmp/dockerlab.sudoers >/dev/null && install -m 0440 /tmp/dockerlab.sudoers /etc/sudoers.d/dockerlab
  rm -f /tmp/dockerlab.sudoers
fi
if getent group docker >/dev/null && ! id -nG "$U" | grep -qw docker; then usermod -aG docker "$U"; fi
"""


def _prepare(host, port, user, password, sudo_rule: bool) -> list[str]:
    """Log in with the password once: install your key, and (with sudo) the capture
    rule and docker group. Returns notes on what couldn't be done."""
    try:
        c = _client(host, port, user, password)
    except paramiko.AuthenticationException:
        raise ConnectError(f"{host} didn't accept that password for {user} (or password logins are turned off there).")
    notes = []
    try:
        key = ensure_key()
        q = shlex.quote(key)
        code, out = _run(c, "umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && "
                            f"(grep -qxF {q} ~/.ssh/authorized_keys || printf '%s\\n' {q} >> ~/.ssh/authorized_keys)")
        if code:
            raise ConnectError(f"Couldn't add your SSH key on {host}: {out}")
        script = SUDO_SETUP.format(user=shlex.quote(user), sudo=1 if sudo_rule else 0)
        code, out = _run(c, "sudo -S -p '' sh -c " + shlex.quote(script), stdin=password + "\n")
        if code:
            notes.append("sudo didn't accept the password, so packet capture may ask for one "
                         f"(see the README's setup step 5). {out.splitlines()[-1] if out else ''}".strip())
    finally:
        c.close()
    return notes


# ---------------------------------------------------------------- connect
def check(mode: str, host: str = "", user: str = "", port: int = 22, *, trust: str | None = None,
          password: str | None = None, sudo_rule: bool = True) -> dict:
    """Get a host ready and check that Docker answers over SSH. Returns
    {"ok": True, "notes": [...]} or {"need": "hostkey" | "hostkey_changed" | "password", ...}.
    Raises ConnectError for problems the user has to fix."""
    if mode == LOCAL:
        return {"ok": True, "notes": []}
    host, user = host.strip(), (user.strip() or "gns3")
    if not host:
        raise ConnectError("Enter the Docker host's address, e.g. 192.168.56.103.")

    key = _server_key(host, port)
    fp = fingerprint(key)
    known = _known(host, port)
    if not any(k.get_name() == key.get_name() and k.asbytes() == key.asbytes() for k in known):
        changed = bool(known)
        if trust != fp:
            return {"need": "hostkey_changed" if changed else "hostkey", "fingerprint": fp, "key_type": key.get_name()}
        _trust(host, port, key, replace=changed)

    notes = []
    if password is not None:
        notes = _prepare(host, port, user, password, sudo_rule)
    try:
        c = _client(host, port, user)
    except paramiko.AuthenticationException:
        if password is not None:
            raise ConnectError(f"Your key was added on {host}, but key login still fails. Is your private key "
                               "protected by a passphrase? DockerLab needs a key without one, or an SSH agent.")
        return {"need": "password", "reason": "key"}
    except (paramiko.SSHException, OSError) as e:
        raise ConnectError(f"SSH to {host} failed: {e}")
    try:
        code, out = _run(c, "docker version --format '{{.Server.Version}}'", timeout=20)
    finally:
        c.close()
    if code:
        if "permission denied" in out.lower():
            if password is None:
                return {"need": "password", "reason": "docker"}
            raise ConnectError(f"{user} still can't use Docker on {host} ({out.splitlines()[-1]}). "
                               f"Run: sudo usermod -aG docker {user}")
        if "not found" in out:
            raise ConnectError(f"Docker isn't installed on {host}, or not on {user}'s PATH.")
        raise ConnectError(f"Docker on {host} didn't answer: {out.splitlines()[-1] if out else 'no output'}")
    return {"ok": True, "version": out.splitlines()[-1], "notes": notes}
