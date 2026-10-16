"""Where DockerLab's files are, and its version.

App files (the built UI, the example labs, VERSION) come with DockerLab: next to this
backend in a source checkout, or inside the bundle of a packaged build (PyInstaller's
sys._MEIPASS). The user's own files live outside the app folder, so updating or
reinstalling DockerLab never touches them:

  labs      <Documents>/DockerLab/labs      (DOCKERLAB_LABS overrides)
  settings  ~/.dockerlab/settings.json      (see connection.py)
"""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))


def resource(*parts: str) -> Path:
    return ROOT.joinpath(*parts)


try:
    VERSION = resource("VERSION").read_text(encoding="utf-8").strip()
except OSError:
    VERSION = "dev"

STATIC_DIR = resource("backend", "static")
EXAMPLES_DIR = resource("examples")


def documents_dir() -> Path:
    """The user's Documents folder. On Windows it may have been moved (e.g. into
    OneDrive), so ask Windows rather than assume C:\\Users\\<name>\\Documents."""
    if sys.platform == "win32":
        try:
            import ctypes
            import uuid
            from ctypes import wintypes
            guid = (ctypes.c_char * 16).from_buffer_copy(uuid.UUID("FDD39AD0-238F-46AF-ADB4-6C85480369C7").bytes_le)
            path = wintypes.LPWSTR()
            if ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(guid), 0, None, ctypes.byref(path)) == 0:
                try:
                    return Path(path.value)
                finally:
                    ctypes.windll.ole32.CoTaskMemFree(path)
        except Exception:  # noqa: BLE001 — fall back below
            pass
    docs = Path.home() / "Documents"
    return docs if docs.is_dir() else Path.home()


LABS_DIR = Path(os.environ.get("DOCKERLAB_LABS") or documents_dir() / "DockerLab" / "labs")


def migrate_old_labs() -> list[str]:
    """Labs used to be kept in backend/labs, inside the app folder. Copy any found
    there that the new folder doesn't have yet (the originals stay where they are)."""
    old = Path(__file__).resolve().parent / "labs"
    copied = []
    if old.is_dir() and old.resolve() != LABS_DIR.resolve():
        for f in sorted(old.glob("*.json")):
            target = LABS_DIR / f.name
            if not target.exists():
                shutil.copy2(f, target)
                copied.append(f.stem)
    return copied
