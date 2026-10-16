import { useEffect, useRef, useState } from "react";

/** A small modal with a question and a row of buttons. `dialog` is
 *  { title, body, options: [{ label, value, kind }] }; answer(value) closes it. */
export function ChoiceDialog({ dialog, answer }) {
  const first = useRef(null);
  useEffect(() => {
    if (!dialog) return;
    first.current?.focus();
    const onKey = (e) => e.key === "Escape" && answer(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog, answer]);
  if (!dialog) return null;
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && answer(null)}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
        <h2 id="dlg-title">{dialog.title}</h2>
        <p>{dialog.body}</p>
        <div className="dialog-actions">
          {dialog.options.map((o, i) => (
            <button key={o.value} ref={i === 0 ? first : undefined}
              className={o.kind ?? ""} onClick={() => answer(o.value)}>{o.label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Toolbar button + dropdown listing every running container on the engine. */
export function RunningPanel({ running, open, setOpen, currentLab, onStop, onOpenLab, onManage, busy }) {
  const box = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => box.current && !box.current.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [open, setOpen]);

  const labs = running?.labs ?? [];
  const other = running?.other ?? [];
  const label = labs.length === 0 ? "No labs running"
    : labs.length === 1 ? `${labs[0].lab} running` : `${labs.length} labs running`;

  return (
    <div className="running" ref={box}>
      <button className={`running-btn ${labs.length ? "is-on" : ""}`} aria-expanded={open}
        onClick={() => setOpen(!open)} disabled={!running}>
        {label}{other.length > 0 && <span className="running-other">+{other.length} other</span>}
      </button>
      {open && running && (
        <div className="running-panel" role="region" aria-label="Running containers">
          <h2>Running in the VM</h2>
          {labs.length === 0 && <p className="hint">No DockerLab containers are running.</p>}
          {labs.map((l) => (
            <section key={l.lab}>
              <div className="running-lab">
                <b>{l.lab}</b>
                {l.lab === currentLab && <span className="tag">open</span>}
                <span className="spacer" />
                {l.lab !== currentLab && <button onClick={() => onOpenLab(l.lab)} disabled={!!busy}>Open</button>}
                <button onClick={() => onStop(l.lab)} disabled={!!busy}>Stop</button>
              </div>
              <ul>{l.containers.map((c) => <li key={c.name}>{c.name}</li>)}</ul>
            </section>
          ))}
          <button className="link manage-link" onClick={onManage}>All containers and images, including stopped ones…</button>
          {other.length > 0 && (
            <section>
              <div className="running-lab"><b>Outside DockerLab</b></div>
              <p className="hint">Not managed by DockerLab, so it won't stop these. They may belong to GNS3.</p>
              <ul>{other.map((c) => <li key={c.name}>{c.name} <span className="dim">{c.image}</span></li>)}</ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

const cleanName = (s) => s.replace(/[^a-zA-Z0-9_.-]/g, "");
/** Lab names are file names; on Windows, lab1 and Lab1 are the same file. */
export const sameLab = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Asks for a lab name before the first save, or when the name is taken.
 *  `req` is { initial, labs, savedName, resolve }; resolves with the name or null. */
export function NameDialog({ req, close }) {
  const [name, setName] = useState("");
  const input = useRef(null);
  useEffect(() => {
    if (!req) return;
    setName(req.initial ?? "");
    setTimeout(() => { input.current?.focus(); input.current?.select(); }, 0);
  }, [req]);
  if (!req) return null;
  const taken = req.labs.find((l) => sameLab(l, name) && !sameLab(l, req.savedName));
  const ok = name.length > 0;
  const submit = (e) => { e.preventDefault(); if (ok) close(taken ?? name); };
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close(null)}
      onKeyDown={(e) => e.key === "Escape" && close(null)}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="name-title" onSubmit={submit}>
        <h2 id="name-title">{req.title ?? "Name this lab"}</h2>
        <p>{req.body ?? "The lab is saved under this name, and its containers are named after it."}</p>
        <label className="field">
          Lab name
          <input ref={input} value={name} onChange={(e) => setName(cleanName(e.target.value))}
            placeholder="e.g. nat-lab" spellCheck={false} />
        </label>
        <p className={`name-check ${taken ? "warn" : ""}`}>
          {taken ? `A lab called ${taken} already exists. Saving replaces it.`
                 : "Letters, digits, dot, dash and underscore."}
        </p>
        <div className="dialog-actions">
          <button type="submit" className={taken ? "danger" : "primary"} disabled={!ok}>
            {taken ? `Replace ${taken}` : "Save"}
          </button>
          <button type="button" onClick={() => close(null)}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
