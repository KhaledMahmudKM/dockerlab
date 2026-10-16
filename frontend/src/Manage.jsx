import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import { ContainerDetails, ImageDetails, NetworkDetails, NetworkForm } from "./Details.jsx";

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Housekeeping for the Docker host: every container, image and network, with
 *  details, delete, and lab recovery. Shown as a panel over the topology, or in a
 *  window of its own (standalone). `request` = { view, nonce } opens a details page. */
export default function ManagePanel({ tab, setTab, ask, currentLab, onChanged, onOpenLab, say, request, standalone }) {
  const [data, setData] = useState(null);
  const [imgs, setImgs] = useState(null);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState(null);           // { kind, text }
  const [pullName, setPullName] = useState("");
  const [nets, setNets] = useState(null);
  const [view, setView] = useState(null);          // a details page: { kind: "container"|"network"|"new-network", id }
  const [trail, setTrail] = useState([]);          // pages to go Back to
  const show = (v) => { setTrail((t) => (view ? [...t, view] : t)); setView(v); };
  const back = () => { setView(trail.at(-1) ?? null); setTrail((t) => t.slice(0, -1)); };

  const load = useCallback(async () => {
    // independent: one failing must not leave the other list stale
    const [c, i, n] = await Promise.allSettled([api.vmContainers(), api.vmImages(), api.vmNetworks()]);
    if (c.status === "fulfilled") setData(c.value);
    if (i.status === "fulfilled") setImgs(i.value);
    if (n.status === "fulfilled") setNets(n.value);
    const failed = [c, i, n].find((x) => x.status === "rejected");
    if (failed) setNote({ kind: "err", text: failed.reason.message });
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {                                   // e.g. Details on a node of the topology
    if (request?.view) { setView(request.view); setTrail([]); }
  }, [request?.nonce]);   // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (label, fn) => {
    setBusy(label); setNote(null);
    let text = "";
    try { text = await fn(); }
    catch (e) { setBusy(""); setNote({ kind: "err", text: e.message }); say?.("err", e.message); return; }
    setBusy("");
    if (text) { setNote({ kind: "ok", text }); say?.("ok", text); }
    await load(); onChanged?.();
  };

  const confirm = (title, body, yes) =>
    ask({ title, body, options: [{ label: yes, value: "yes", kind: "danger" }, { label: "Cancel", value: "no" }] })
      .then((v) => v === "yes");

  const deleteContainer = (c, g) => act("Deleting", async () => {
    const lab = g?.lab;
    const body = !g
      ? `${c.name} isn't managed by DockerLab${c.state === "running" ? " and is running" : ""}. It may belong to GNS3 or another program. Delete it anyway?`
      : g.has_file
        ? `${c.name} belongs to lab ${lab}. The lab file is kept; Redeploy the lab to bring it back.`
        : `${c.name} belongs to lab ${lab}, which has no lab file. Recover the lab file first if you may want it again.`;
    if (!(await confirm(`Delete ${c.name}?`, body, "Delete container"))) return "";
    await api.vmRemoveContainer(c.id);
    return `Deleted ${c.name}.`;
  });

  const removeLab = (g) => act("Removing", async () => {
    const body = g.has_file
      ? `Deletes ${plural(g.containers.length, "container")} and ${plural(g.networks, "network")} in the VM. The lab file is kept, so Deploy recreates them.`
      : `Deletes ${plural(g.containers.length, "container")} and ${plural(g.networks, "network")} in the VM. This lab has no lab file, so it will be gone for good unless you recover it first.`;
    if (!(await confirm(`Remove lab ${g.lab} from the VM?`, body, "Remove"))) return "";
    const r = await api.destroy(g.lab);
    return `Removed ${plural(r.containers.length, "container")} and ${plural(r.networks.length, "network")} of ${g.lab}.`;
  });

  const recover = (g) => act("Recovering", async () => {
    const r = await api.vmRecover(g.lab);
    return r.exact
      ? `Recovered lab ${g.lab} exactly: ${plural(r.nodes, "container")}, ${plural(r.switches, "switch").replace("switchs", "switches")}, ${plural(r.cables, "cable")}.`
      : `Recovered lab ${g.lab}: ${plural(r.nodes, "container")}, ${plural(r.switches, "switch").replace("switchs", "switches")}, ${plural(r.cables, "cable")} with their subnets and addresses. Bench positions and startup commands weren't stored by the version that deployed it; open the lab to check them.`;
  });

  const deleteImage = (img) => act("Deleting", async () => {
    const used = img.labs.length ? ` Labs ${img.labs.join(", ")} use it; their next Deploy will ${img.built_here ? "rebuild" : "pull"} it.` : "";
    if (!(await confirm(`Delete ${img.tag}?`, `Removes the image from the VM.${used}`, "Delete image"))) return "";
    await api.vmRemoveImage(img.tag);
    return `Deleted ${img.tag}.`;
  });

  const pull = (e) => {
    e.preventDefault();
    const name = pullName.trim();
    if (!name) return;
    act(`Pulling ${name}`, async () => {
      let r;
      try { r = await api.pull(name); } catch (err) { throw new Error(`Couldn't pull ${name}: ${err.message}`); }
      setPullName("");
      return `Pulled ${r.pulled.join(", ")}.`;
    });
  };

  const removeNetwork = (n) => act("Deleting", async () => {
    const lab = n.lab ? ` It belongs to lab ${n.lab}${n.containers.length ? "; that lab needs a Redeploy afterwards" : ""}.` : "";
    const users = n.containers.length ? ` ${plural(n.containers.length, "container")} use${n.containers.length === 1 ? "s" : ""} it (${n.containers.map((c) => c.name).join(", ")}): they'll be disconnected first, and a stopped one won't start again until it's reattached or redeployed.` : "";
    if (!(await confirm(`Delete network ${n.name}?`, `Removes it from the Docker host.${users}${lab}`, n.containers.length ? "Disconnect and delete" : "Delete network"))) return "";
    await api.vmRemoveNetwork(n.id, n.containers.length > 0);
    return `Deleted network ${n.name}.`;
  });

  const pruneNetworks = (scope) => act("Cleaning up", async () => {
    if (scope === "all" && !(await confirm("Delete every unused network?",
      "Also removes unused networks DockerLab didn't create, e.g. from GNS3 or Docker Compose projects that are down. Docker's built-in networks are kept.", "Delete them"))) return "";
    const r = await api.vmPruneNetworks(scope);
    return r.removed.length ? `Removed ${plural(r.removed.length, "network")}.${r.errors.length ? ` Couldn't remove: ${r.errors.join("; ")}` : ""}` : "Nothing to clean up.";
  });

  const prune = () => act("Cleaning up", async () => {
    const r = await api.vmPrune();
    return r.removed ? `Removed ${plural(r.removed, "unused image")}${r.freed_mb > 0 ? `, freeing ${r.freed_mb} MB` : ""}.` : "Nothing to clean up.";
  });

  const labs = data?.labs ?? [];
  const other = data?.other ?? [];
  const total = labs.reduce((n, g) => n + g.containers.length, 0) + other.length;

  return (
    <div className={`tool manage ${standalone ? "is-page" : ""}`} aria-labelledby="manage-title">
        <div className="manage-head">
          <h2 id="manage-title">On the Docker host</h2>
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === "containers"} className={tab === "containers" ? "is-on" : ""}
              onClick={() => { setView(null); setTrail([]); setTab("containers"); }}>Containers{data ? ` (${total})` : ""}</button>
            <button role="tab" aria-selected={tab === "images"} className={tab === "images" ? "is-on" : ""}
              onClick={() => { setView(null); setTrail([]); setTab("images"); }}>Images{imgs ? ` (${imgs.images.length})` : ""}</button>
            <button role="tab" aria-selected={tab === "networks"} className={tab === "networks" ? "is-on" : ""}
              onClick={() => { setView(null); setTrail([]); setTab("networks"); }}>Networks{nets ? ` (${nets.networks.length})` : ""}</button>
          </div>
          <button className="mini refresh" onClick={() => { setNote(null); load(); }} disabled={!!busy} title="Read the lists again">Refresh</button>
        </div>

        {note && <div className={`manage-note ${note.kind}`}>{note.text}</div>}
        {busy && <div className="manage-note busy">{busy}…</div>}

        <div className="manage-body">
          {view?.kind === "container" && <ContainerDetails id={view.id} onBack={back}
            onImage={(ref) => show({ kind: "image", id: ref })}
            onNetwork={(id) => show({ kind: "network", id })} />}
          {view?.kind === "image" && <ImageDetails ref_={view.id} onBack={back}
            onContainer={(id) => show({ kind: "container", id })} />}
          {view?.kind === "network" && <NetworkDetails id={view.id} onBack={back}
            onContainer={(id) => show({ kind: "container", id })} />}
          {view?.kind === "new-network" && <NetworkForm onBack={back}
            onCreated={async (r) => { say?.("ok", `Created network ${r.created}.`); setNote({ kind: "ok", text: `Created network ${r.created}.` }); back(); await load(); }} />}

          {!view && !data && !note && <p className="hint">Loading…</p>}

          {!view && nets && tab === "networks" && (
            <>
              <div className="m-net-tools">
                <button className="primary" onClick={() => show({ kind: "new-network" })} disabled={!!busy}>New network…</button>
              </div>
              {nets.leftovers > 0 && (
                <div className="m-cleanup">
                  <span>{plural(nets.leftovers, "network")} left over from DockerLab labs, used by no container.</span>
                  <button onClick={() => pruneNetworks("dockerlab")} disabled={!!busy}>Clean up</button>
                </div>
              )}
              <ul className="m-rows nets-list">
                {nets.networks.map((n) => {
                  const running = n.containers.filter((c) => c.state === "running").length;
                  return (
                    <li key={n.id} className={n.builtin ? "is-builtin" : ""}>
                      <span className="m-name">
                        <button className="link" onClick={() => show({ kind: "network", id: n.id })}>{n.name}</button>
                        {n.builtin && <span className="tag">built-in</span>}
                        {n.lab && <span className="tag">lab {n.lab}</span>}
                        {n.lab && !n.containers.length && <span className="tag warn">left over</span>}
                        {!n.lab && !n.builtin && !n.containers.length && <span className="tag">unused</span>}
                        {n.internal && <span className="tag">internal</span>}
                      </span>
                      <span className="m-meta">
                        {n.driver}
                        {n.subnets.length > 0 && ` · ${n.subnets.map((s) => s.subnet).join(", ")}`}
                        {` · ${n.containers.length ? `${plural(n.containers.length, "container")}${running < n.containers.length ? `, ${running} running` : ""}` : "no containers"}`}
                      </span>
                      <span className="m-actions-row">
                        <button className="mini" onClick={() => show({ kind: "network", id: n.id })}>Details</button>
                        {!n.builtin && <button className="mini danger" onClick={() => removeNetwork(n)} disabled={!!busy}>Delete</button>}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {nets.unused_other > 0 && (
                <p className="hint pad-top">{plural(nets.unused_other, "unused network")} not created by DockerLab (GNS3, Compose and so on).{" "}
                  <button className="link danger" onClick={() => pruneNetworks("all")} disabled={!!busy}>Delete every unused network…</button></p>
              )}
            </>
          )}

          {!view && data && tab === "containers" && (
            <>
              {labs.length === 0 && other.length === 0 && <p className="hint">There are no containers in the VM.</p>}
              {labs.map((g) => (
                <section key={g.lab} className="m-group">
                  <div className="m-group-head">
                    <div>
                      <b>{g.lab}</b>
                      {g.lab === currentLab && <span className="tag">open</span>}
                      {!g.has_file && <span className="tag warn">no lab file</span>}
                      <small>{plural(g.containers.length, "container")}, {g.running} running · {plural(g.networks, "network")}</small>
                    </div>
                    <div className="m-actions">
                      {!g.has_file && g.containers.length > 0 &&
                        <button className="primary" onClick={() => recover(g)} disabled={!!busy}>Recover lab file</button>}
                      {g.has_file && g.lab !== currentLab &&
                        <button onClick={() => onOpenLab(g.lab)} disabled={!!busy}>Open</button>}
                      <button className="danger" onClick={() => removeLab(g)} disabled={!!busy}>Remove</button>
                    </div>
                  </div>
                  {!g.has_file && g.containers.length > 0 && (
                    <p className="hint">Its lab file is missing. Recover it from these containers, or remove them.</p>
                  )}
                  <ul className="m-rows">
                    {g.containers.map((c) => (
                      <li key={c.id}>
                        <span className={`dot ${c.state === "running" ? "on" : ""}`} />
                        <span className="m-name"><button className="link" onClick={() => show({ kind: "container", id: c.id })}>{c.name}</button></span>
                        <span className="m-meta">{c.image} · {c.status}</span>
                        <button className="mini danger" onClick={() => deleteContainer(c, g)} disabled={!!busy}>Delete</button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              {other.length > 0 && (
                <section className="m-group">
                  <div className="m-group-head"><div><b>Outside DockerLab</b>
                    <small>Not created by DockerLab. They may belong to GNS3.</small></div></div>
                  <ul className="m-rows">
                    {other.map((c) => (
                      <li key={c.id}>
                        <span className={`dot ${c.state === "running" ? "on" : ""}`} />
                        <span className="m-name"><button className="link" onClick={() => show({ kind: "container", id: c.id })}>{c.name}</button></span>
                        <span className="m-meta">{c.image} · {c.status}</span>
                        <button className="mini danger" onClick={() => deleteContainer(c, null)} disabled={!!busy}>Delete</button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}

          {!view && tab === "images" && (
            <form className="m-pull" onSubmit={pull}>
              <label htmlFor="pull">Pull an image</label>
              <div className="row">
                <input id="pull" placeholder="alpine:3.20" value={pullName} spellCheck={false} autoFocus
                  onChange={(e) => setPullName(e.target.value)} />
                <button className="primary" disabled={!!busy || !pullName.trim()}>Pull</button>
              </div>
              <small>From Docker Hub by default, e.g. <code>alpine:3.20</code> or <code>nicolaka/netshoot</code>;
                or from another registry with its address, e.g. <code>ghcr.io/owner/image:tag</code>. Needs the Docker host's internet access.</small>
            </form>
          )}

          {!view && imgs && tab === "images" && (
            <>
              {imgs.dangling.count > 0 && (
                <div className="m-cleanup">
                  <span>{plural(imgs.dangling.count, "unnamed image")} ({imgs.dangling.size_mb} MB) left over from rebuilds and pulls.</span>
                  <button onClick={prune} disabled={!!busy}>Clean up</button>
                </div>
              )}
              <ul className="m-rows images-list">
                {imgs.images.map((i) => (
                  <li key={i.tag}>
                    <span className="m-name"><button className="link" onClick={() => show({ kind: "image", id: i.tag })}>{i.tag}</button></span>
                    <span className="m-meta">
                      {i.size_mb} MB
                      {i.built_here && " · built in DockerLab"}
                      {i.containers.length > 0 && ` · used by ${plural(i.containers.length, "container")}`}
                      {i.labs.length > 0 && ` · in ${i.labs.join(", ")}`}
                    </span>
                    <span className="m-actions-row">
                      <button className="mini" onClick={() => show({ kind: "image", id: i.tag })}>Details</button>
                      <button className="mini danger" onClick={() => deleteImage(i)} disabled={!!busy || i.containers.length > 0}
                        title={i.containers.length ? `Used by ${i.containers.join(", ")}. Delete those containers first.` : ""}>
                        Delete
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
              {imgs.images.some((i) => i.containers.length) &&
                <p className="hint pad-top">An image used by a container, even a stopped one, can't be deleted until the container is.</p>}
            </>
          )}
        </div>
    </div>
  );
}
