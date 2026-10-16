import { useEffect, useRef, useState } from "react";

/** How the topology looks: text sizes, cable width and colours. Kept in this browser. */
export const APPEARANCE_DEFAULTS = {
  boxScale: 100,          // % size of containers and switches, text included
  labelScale: 100,        // % size of cable labels
  noteSize: 13.5,         // px, note text
  cableWidth: 3.5,        // px
  boxBg: "#ffffff",
  boxBorder: "#b9c5cf",
  boxInk: "#1c2a35",
  switchBg: "#1c2a35",
  benchBg: "#e6ecf1",
  grid: true,
};
const PRESETS = {
  Default: APPEARANCE_DEFAULTS,
  "Large (projector)": { ...APPEARANCE_DEFAULTS, boxScale: 130, labelScale: 130, noteSize: 18, cableWidth: 5 },
  "High contrast": { ...APPEARANCE_DEFAULTS, boxBorder: "#1c2a35", boxInk: "#000000", benchBg: "#ffffff", cableWidth: 4.5 },
};
const KEY = "dockerlab.appearance";

export function useAppearance() {
  const [a, setA] = useState(() => {
    try { return { ...APPEARANCE_DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; }
    catch { return APPEARANCE_DEFAULTS; }
  });
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(a)); } catch { /* private mode */ } }, [a]);
  return [a, setA];
}

/** CSS custom properties for the topology (set on the app, read by styles.css). */
export function appearanceVars(a) {
  return {
    "--box-zoom": a.boxScale / 100,
    "--label-scale": a.labelScale / 100,
    "--note-size": `${a.noteSize}px`,
    "--box-bg": a.boxBg,
    "--box-border": a.boxBorder,
    "--box-ink": a.boxInk,
    "--switch-bg": a.switchBg,
    "--bench-bg": a.benchBg,
  };
}

function Slider({ label, value, min, max, step, unit, onChange }) {
  return (
    <label className="ap-row">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <output>{value}{unit}</output>
    </label>
  );
}

function Colour({ label, value, onChange }) {
  return (
    <label className="ap-row">
      <span>{label}</span>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
      <output>{value}</output>
    </label>
  );
}

/** The Appearance button and its panel. Changes apply at once, so the topology
 *  behind it is the preview. */
export function AppearanceMenu({ appearance: a, setAppearance }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return;
    const off = (e) => !box.current?.contains(e.target) && setOpen(false);
    const esc = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", off); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", off); document.removeEventListener("keydown", esc); };
  }, [open]);
  const set = (k) => (v) => setAppearance((x) => ({ ...x, [k]: v }));
  return (
    <div className="menu view-menu" ref={box}>
      <button onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="true" title="Text sizes and colours of the topology">Appearance</button>
      {open && (
        <div className="menu-pop ap-pop" role="dialog" aria-label="Appearance">
          <div className="view-title">Size</div>
          <Slider label="Containers and switches" value={a.boxScale} min={70} max={180} step={5} unit="%" onChange={set("boxScale")} />
          <Slider label="Cable labels" value={a.labelScale} min={70} max={200} step={5} unit="%" onChange={set("labelScale")} />
          <Slider label="Note text" value={a.noteSize} min={10} max={32} step={0.5} unit=" px" onChange={set("noteSize")} />
          <Slider label="Cable width" value={a.cableWidth} min={1.5} max={10} step={0.5} unit=" px" onChange={set("cableWidth")} />
          <div className="view-title">Colours</div>
          <Colour label="Container text" value={a.boxInk} onChange={set("boxInk")} />
          <Colour label="Container background" value={a.boxBg} onChange={set("boxBg")} />
          <Colour label="Container border" value={a.boxBorder} onChange={set("boxBorder")} />
          <Colour label="Switch" value={a.switchBg} onChange={set("switchBg")} />
          <Colour label="Topology background" value={a.benchBg} onChange={set("benchBg")} />
          <label className="ap-row ap-check"><input type="checkbox" checked={a.grid} onChange={(e) => set("grid")(e.target.checked)} /><span>Grid dots</span></label>
          <div className="menu-sep" role="separator" />
          <div className="ap-presets">
            {Object.entries(PRESETS).map(([name, p]) => (
              <button key={name} className="mini" onClick={() => setAppearance(p)}>{name}</button>
            ))}
          </div>
          <p className="hint ap-hint">Kept in this browser. Diagram exports use these settings too.</p>
        </div>
      )}
    </div>
  );
}
