import { useEffect, useRef, useState } from "react";

const KEY = "dockerlab.layout";
export const PANES = [
  { id: "host", label: "Docker Host", hint: "left, top" },
  { id: "shelf", label: "Add and Images", hint: "left, below Docker Host" },
  { id: "messages", label: "Messages", hint: "under the topology" },
  { id: "details", label: "Details", hint: "right: what you click on the topology" },
  { id: "desc", label: "Lab description", hint: "right, below Details: stays while you work" },
];
const DEFAULTS = {
  show: { shelf: true, host: true, messages: true, details: true, desc: true },
  left: 236, right: 320, desc: null,      // desc: height of the description pane; null = about half
};

const load = () => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "null");
    return v ? { ...DEFAULTS, ...v, show: { ...DEFAULTS.show, ...v.show } } : DEFAULTS;
  } catch { return DEFAULTS; }
};

/** Which panes are shown, and their sizes; remembered in this browser. */
export function useLayout() {
  const [layout, setLayout] = useState(load);
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(layout)); } catch { /* private mode */ } }, [layout]);
  const toggle = (id) => setLayout((l) => ({ ...l, show: { ...l.show, [id]: !l.show[id] } }));
  const size = (k, v) => setLayout((l) => ({ ...l, [k]: v ?? DEFAULTS[k] }));
  const reset = () => setLayout(DEFAULTS);
  return { layout, toggle, size, reset };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * A divider between two panes. Dragging it resizes the pane on the `grow` side:
 * for a vertical divider, "left" grows as it moves right, "right" as it moves left;
 * for a horizontal one, "below" grows as it moves up.
 */
export function Splitter({ dir, value, onChange, min, max, grow }) {
  const start = (e) => {
    e.preventDefault();
    const p0 = dir === "v" ? e.clientX : e.clientY, v0 = value;
    const sign = grow === "left" ? 1 : -1;
    const move = (ev) => onChange(clamp(v0 + sign * ((dir === "v" ? ev.clientX : ev.clientY) - p0), min, max()));
    const up = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing", "resizing-v", "resizing-h");
    };
    document.body.classList.add("resizing", dir === "v" ? "resizing-v" : "resizing-h");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const key = (e) => {
    const step = e.shiftKey ? 40 : 10;
    const fwd = dir === "v" ? (grow === "left" ? "ArrowRight" : "ArrowLeft") : "ArrowUp";
    const back = dir === "v" ? (grow === "left" ? "ArrowLeft" : "ArrowRight") : "ArrowDown";
    if (e.key === fwd) onChange(clamp(value + step, min, max()));
    else if (e.key === back) onChange(clamp(value - step, min, max()));
    else return;
    e.preventDefault();
  };
  return (
    <div className={`splitter splitter-${dir}`} role="separator" tabIndex={0}
      aria-orientation={dir === "v" ? "vertical" : "horizontal"} aria-valuenow={Math.round(value)}
      onPointerDown={start} onKeyDown={key} onDoubleClick={() => onChange(null)} title="Drag to resize. Double-click to reset." />
  );
}

export function ViewMenu({ layout, toggle, reset, alert }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return;
    const off = (e) => !box.current?.contains(e.target) && setOpen(false);
    const esc = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", off); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", off); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div className="menu view-menu" ref={box}>
      <button onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="true">
        View{alert && <span className="dot-alert" aria-label="New error in the hidden Messages pane" />}
      </button>
      {open && (
        <div className="menu-pop view-pop" role="menu">
          <div className="view-title">Panes</div>
          {PANES.map((p) => (
            <label key={p.id} className="view-item" role="menuitemcheckbox" aria-checked={layout.show[p.id]}>
              <input type="checkbox" checked={layout.show[p.id]} onChange={() => toggle(p.id)} />
              <span>{p.label}<small>{p.hint}</small></span>
              {p.id === "messages" && alert && <span className="dot-alert" />}
            </label>
          ))}
          <div className="menu-sep" role="separator" />
          <button role="menuitem" className="view-reset" onClick={() => { reset(); setOpen(false); }}>
            Show all panes at their default sizes
          </button>
        </div>
      )}
    </div>
  );
}
