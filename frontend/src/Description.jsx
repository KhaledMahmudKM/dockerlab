import { useEffect, useRef, useState } from "react";
import Markdown, { MARKDOWN_HELP } from "./Markdown.jsx";

const PLACEHOLDER = "What this lab is for, and what to do in it. Markdown works: ## headings, **bold**, `commands`, lists, > [!TIP] callouts.\n\n"
  + "Example:\n## Try it\n1. Open a console on pc2 and run `curl http://10.0.10.10`";

function Help() {
  return (
    <details className="md-help">
      <summary>Markdown</summary>
      <table><tbody>
        {MARKDOWN_HELP.map(([code, what]) => (
          <tr key={code}><td><code>{code.replace(/\\n/g, "⏎")}</code></td><td>{what}</td></tr>
        ))}
      </tbody></table>
    </details>
  );
}

/** Editor with formatting shortcuts: Ctrl+B bold, Ctrl+I italic, Ctrl+E code; Tab indents. */
function Editor({ value, onChange, autoFocus, className }) {
  const ref = useRef(null);
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);
  const wrap = (before, after = before) => {
    const t = ref.current, s = t.selectionStart, e = t.selectionEnd;
    const next = value.slice(0, s) + before + value.slice(s, e) + after + value.slice(e);
    onChange(next);
    requestAnimationFrame(() => { t.selectionStart = s + before.length; t.selectionEnd = e + before.length; });
  };
  const onKeyDown = (ev) => {
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && ev.key.toLowerCase() === "b") { ev.preventDefault(); wrap("**"); }
    else if (mod && ev.key.toLowerCase() === "i") { ev.preventDefault(); wrap("*"); }
    else if (mod && ev.key.toLowerCase() === "e") { ev.preventDefault(); wrap("`"); }
    else if (ev.key === "Tab" && !mod && !ev.shiftKey) { ev.preventDefault(); wrap("  ", ""); }
  };
  return <textarea ref={ref} className={`desc ${className ?? ""}`} value={value} spellCheck
    onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} placeholder={PLACEHOLDER} aria-label="Description (Markdown)" />;
}

/** Large editor: Markdown on the left, how it looks on the right. */
function Expanded({ value, onChange, title, onClose }) {
  useEffect(() => {
    const esc = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog desc-big" role="dialog" aria-modal="true" aria-label={`Description of ${title}`}>
        <header><h2>{title}: description</h2><Help /><button className="primary" onClick={onClose}>Done</button></header>
        <div className="desc-big-body">
          <Editor value={value} onChange={onChange} autoFocus />
          <div className="desc-big-preview">{value.trim() ? <Markdown text={value} /> : <p className="hint">The preview shows here.</p>}</div>
        </div>
      </div>
    </div>
  );
}

/** The lab's description in the Details pane: read it, or edit it as Markdown. */
export default function Description({ value, onChange, title }) {
  const [mode, setMode] = useState(() => (value.trim() ? "read" : "edit"));
  const [big, setBig] = useState(false);
  const empty = !value.trim();

  return (
    <section className="desc-section">
      <div className="desc-head">
        <span className="desc-label">Description</span>
        <div className="seg seg-small" role="tablist" aria-label="Description view">
          <button role="tab" aria-selected={mode === "read"} className={mode === "read" ? "is-on" : ""} onClick={() => setMode("read")}>Read</button>
          <button role="tab" aria-selected={mode === "edit"} className={mode === "edit" ? "is-on" : ""} onClick={() => setMode("edit")}>Edit</button>
        </div>
        <button className="mini" onClick={() => setBig(true)} title="Edit in a large window, with a preview">Expand</button>
      </div>
      {mode === "edit" ? (
        <>
          <Editor value={value} onChange={onChange} autoFocus={!empty} />
          <Help />
        </>
      ) : empty ? (
        <p className="hint desc-empty">No description yet. <button className="link" onClick={() => setMode("edit")}>Write one</button></p>
      ) : (
        <div className="desc-read" onDoubleClick={() => setMode("edit")} title="Double-click to edit">
          <Markdown text={value} />
        </div>
      )}
      {big && <Expanded value={value} onChange={onChange} title={title} onClose={() => setBig(false)} />}
    </section>
  );
}
