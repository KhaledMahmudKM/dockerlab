"""Write THIRD-PARTY-NOTICES.md: every package DockerLab ships, with its license.

Run from the repository root after `pip install -r backend/requirements.txt` and
`npm ci` in frontend/ (the release build does this), so it lists what's actually
bundled:  python tools/notices.py
"""
from __future__ import annotations

import json
import re
from importlib import metadata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LICENSE_NAMES = re.compile(r"^(LICEN[CS]E|COPYING|NOTICE|AUTHORS)(\.|$|-)", re.I)


# ---------------------------------------------------------------- Python
def _req_names(dist) -> list[str]:
    out = []
    for r in dist.requires or []:
        if "extra ==" in r and "extra == \"standard\"" not in r and "extra == 'standard'" not in r:
            continue
        name = re.split(r"[\s;<>=!~\[(]", r, maxsplit=1)[0]
        out.append(name)
    return out


def python_packages() -> list[dict]:
    roots = []
    for line in (ROOT / "backend" / "requirements.txt").read_text().splitlines():
        line = line.split("#")[0].strip()
        if line:
            roots.append(re.split(r"[\s<>=!~\[]", line, maxsplit=1)[0])
    seen, todo, out = set(), list(roots), []
    while todo:
        name = todo.pop()
        key = name.lower().replace("_", "-")
        if key in seen:
            continue
        seen.add(key)
        try:
            d = metadata.distribution(name)
        except metadata.PackageNotFoundError:
            continue
        m = d.metadata
        lic = m.get("License-Expression") or (m.get("License") or "").splitlines()[0][:80] if (m.get("License-Expression") or m.get("License")) else ""
        if not lic or lic.upper() == "UNKNOWN":
            lic = ", ".join(c.split("::")[-1].strip() for c in m.get_all("Classifier") or [] if c.startswith("License ::")) or "see text"
        texts = []
        for f in d.files or []:
            if LICENSE_NAMES.match(Path(str(f)).name):
                try:
                    texts.append(Path(d.locate_file(f)).read_text(encoding="utf-8", errors="replace"))
                except OSError:
                    pass
        out.append({"name": m["Name"], "version": d.version, "license": lic,
                    "url": m.get("Home-page") or next((u.split(",", 1)[1].strip() for u in m.get_all("Project-URL") or []), ""),
                    "texts": texts})
        todo += _req_names(d)
    return sorted(out, key=lambda p: p["name"].lower())


# ---------------------------------------------------------------- JavaScript (bundled into the UI)
def js_packages() -> list[dict]:
    nm = ROOT / "frontend" / "node_modules"
    root = json.loads((ROOT / "frontend" / "package.json").read_text())
    seen, todo, out = set(), list(root.get("dependencies", {})), []
    while todo:
        name = todo.pop()
        if name in seen:
            continue
        seen.add(name)
        pdir = nm / name
        try:
            pj = json.loads((pdir / "package.json").read_text())
        except OSError:
            continue
        texts = [p.read_text(encoding="utf-8", errors="replace") for p in sorted(pdir.iterdir())
                 if p.is_file() and LICENSE_NAMES.match(p.name)]
        lic = pj.get("license") or (pj.get("licenses") or [{}])[0].get("type", "see text")
        repo = pj.get("repository")
        out.append({"name": name, "version": pj.get("version", ""), "license": lic,
                    "url": pj.get("homepage") or (repo.get("url") if isinstance(repo, dict) else repo) or "",
                    "texts": texts})
        todo += list((pj.get("dependencies") or {}).keys())
    return sorted(out, key=lambda p: p["name"])


def main() -> None:
    py, js = python_packages(), js_packages()
    lines = ["# Third-party notices", "",
             "DockerLab includes the following open-source software. Each is used under its own license, reproduced below.", ""]
    for title, pkgs in (("Python packages (the DockerLab server)", py), ("JavaScript packages (the DockerLab interface)", js)):
        lines += [f"## {title}", "", "| Package | Version | License |", "|---|---|---|"]
        lines += [f"| {p['name']} | {p['version']} | {p['license']} |" for p in pkgs]
        lines.append("")
    lines += ["## License texts", ""]
    for p in py + js:
        lines += [f"### {p['name']} {p['version']} ({p['license']})", ""]
        if p["url"]:
            lines += [p["url"], ""]
        for t in p["texts"] or ["(No license file is included in the package; see the project's page.)"]:
            lines += ["```", t.strip(), "```", ""]
    (ROOT / "THIRD-PARTY-NOTICES.md").write_text("\n".join(lines), encoding="utf-8")
    print(f"THIRD-PARTY-NOTICES.md: {len(py)} Python and {len(js)} JavaScript packages; "
          f"{sum(not p['texts'] for p in py + js)} without a license file.")


if __name__ == "__main__":
    main()
