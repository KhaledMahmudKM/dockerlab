"""Images for labs: building from a Dockerfile, and making labs portable.

An image built in DockerLab carries its Dockerfile as a label. When a lab is saved,
the Dockerfiles of the built images it uses are copied into the lab file, so the
file is self-contained. Before a deploy, any image the lab needs that the engine
doesn't have is built from that Dockerfile, or pulled from Docker Hub otherwise.
"""
from __future__ import annotations

import io

import docker
from docker.errors import APIError, BuildError, ImageNotFound

from models import Topology

RECIPE_LABEL = "dockerlab.dockerfile"


def full_tag(name: str) -> str:
    name = name.strip()
    return name if ":" in name.split("/")[-1] else name + ":latest"


def _err(e: Exception) -> str:
    return (getattr(e, "explanation", None) or getattr(e, "msg", None) or str(e)).strip()


def build(client: docker.DockerClient, tag: str, dockerfile: str) -> dict:
    """Build `tag` from a Dockerfile; the Dockerfile is kept as a label on the image."""
    lines: list[str] = []

    def collect(chunks):
        for ch in chunks:
            if "stream" in ch:
                lines.extend(x for x in ch["stream"].splitlines() if x.strip())
            elif "error" in ch:
                lines.append(ch["error"].strip())

    try:
        img, logs = client.images.build(fileobj=io.BytesIO(dockerfile.encode()), tag=tag, rm=True, forcerm=True,
                                        labels={"dockerlab.built": "1", RECIPE_LABEL: dockerfile})
        collect(logs)
        return {"ok": True, "tag": tag, "id": img.short_id, "log": "\n".join(lines[-200:])}
    except BuildError as e:
        collect(e.build_log)
        return {"ok": False, "tag": tag, "error": _err(e), "log": "\n".join(lines[-200:])}
    except APIError as e:
        return {"ok": False, "tag": tag, "error": _err(e), "log": "\n".join(lines[-200:])}


def recipes(client: docker.DockerClient, topo: Topology) -> dict[str, str]:
    """Dockerfiles for the built images this lab uses: from the engine's image labels,
    falling back to what the lab file already carries (e.g. an imported lab)."""
    out = {}
    for tag in sorted({full_tag(n.image) for n in topo.nodes}):
        try:
            label = (client.images.get(tag).labels or {}).get(RECIPE_LABEL)
        except ImageNotFound:
            label = None
        recipe = label or topo.images.get(tag)
        if recipe:
            out[tag] = recipe
    return out


def ensure(client: docker.DockerClient, topo: Topology) -> dict:
    """Make every image the lab needs present on the engine: build it from the lab's
    Dockerfile if it has one, otherwise pull it. Returns what was done."""
    done = {"present": [], "pulled": [], "built": [], "errors": []}
    for tag in sorted({full_tag(n.image) for n in topo.nodes}):
        try:
            client.images.get(tag)
            done["present"].append(tag)
            continue
        except ImageNotFound:
            pass
        if tag in topo.images:
            r = build(client, tag, topo.images[tag])
            if r["ok"]:
                done["built"].append(tag)
            else:
                done["errors"].append(f"{tag}: couldn't build it from the lab's Dockerfile: {r['error']}")
            continue
        repo, version = tag.rsplit(":", 1)
        try:
            client.images.pull(repo, tag=version)
            done["pulled"].append(tag)
        except APIError as e:
            msg = _err(e)
            if tag.startswith("dockerlab/"):
                msg = ("it was built in DockerLab on another machine and this lab file has no Dockerfile for it. "
                       "Build it here with Build, or ask for a lab file saved with the current DockerLab.")
            done["errors"].append(f"{tag}: couldn't pull it: {msg}")
    return done


def unshareable(client: docker.DockerClient, topo: Topology) -> list[str]:
    """Images this lab uses that another VM couldn't get, because the lab has no
    Dockerfile for them: built by an older DockerLab (labelled dockerlab.built but
    without the Dockerfile), or, on the classic image store, never pulled from a
    registry (no RepoDigests). The containerd image store gives local builds a digest
    too, so there only DockerLab's own label tells."""
    out = []
    for tag in sorted({full_tag(n.image) for n in topo.nodes}):
        if tag in topo.images:
            continue
        try:
            img = client.images.get(tag)
        except ImageNotFound:
            continue
        if (img.labels or {}).get("dockerlab.built") or not img.attrs.get("RepoDigests"):
            out.append(tag)
    return out
