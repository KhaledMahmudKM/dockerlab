import { useEffect, useLayoutEffect, useRef, useState } from "react";

const KEY = "dockerlab.messages";
const HEIGHT_KEY = "dockerlab.messagesHeight";
const MAX = 500;
const MIN_H = 72;

const load = (key, fallback) => {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
};
const store = (key, v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ } };

const pad = (n) => String(n).padStart(2, "0");
const clock = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const day = (t) => new Date(t).toDateString();

/** The message log: kept across reloads (in this browser), capped at MAX entries. */
export function useMessages() {
  const [log, setLog] = useState(() => load(KEY, []));
  useEffect(() => store(KEY, log.slice(-MAX)), [log]);
  const say = (kind, text, list) =>
    setLog((l) => [...l.slice(-(MAX - 1)), { id: Date.now() + Math.random(), t: Date.now(), kind, text, list }]);
  const clear = () => setLog([]);
  return { log, say, clear };
}

const MARK = { ok: "✓", err: "!", info: "i" };

export function MessagePane({ log, busy, onClear }) {
  const [height, setHeight] = useState(() => load(HEIGHT_KEY, 150));
  const [open, setOpen] = useState(() => load(HEIGHT_KEY + ".open", true));
  const [seen, setSeen] = useState(log.length);
  const body = useRef(null);
  const stick = useRef(true);                 // follow new messages unless the user scrolled up

  useEffect(() => store(HEIGHT_KEY, height), [height]);
  useEffect(() => store(HEIGHT_KEY + ".open", open), [open]);

  // an error opens the pane, so it can't go unnoticed
  const last = log.at(-1);
  useEffect(() => { if (last?.kind === "err") setOpen(true); }, [last?.id]);
  useEffect(() => { if (open) setSeen(log.length); }, [open, log.length]);

  useLayoutEffect(() => {
    const el = body.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [log.length, open, busy]);

  const onScroll = () => {
    const el = body.current;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const startDrag = (e) => {
    e.preventDefault();
    const y0 = e.clientY, h0 = open ? height : MIN_H;
    setOpen(true);
    const max = () => Math.round(window.innerHeight * 0.7);
    const move = (ev) => setHeight(Math.max(MIN_H, Math.min(max(), h0 + y0 - ev.clientY)));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
                       document.body.classList.remove("resizing"); };
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const copyAll = async () => {
    const text = log.map((m) => `${clock(m.t)}  ${m.kind === "err" ? "ERROR " : ""}${m.text}`
      + (m.list ? "\n" + m.list.map((x) => `           - ${x}`).join("\n") : "")).join("\n");
    try { await navigator.clipboard.writeText(text); } catch { /* blocked */ }
  };

  const unread = log.slice(seen);
  const unreadErr = unread.some((m) => m.kind === "err");

  return (
    <section className={`messages ${open ? "" : "is-closed"}`} style={open ? { height } : undefined} aria-label="Messages">
      <div className="msg-grip" onPointerDown={startDrag} title="Drag to resize" />
      <header className="msg-head">
        <button className="msg-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="chev">{open ? "▾" : "▸"}</span> Messages
          {!open && unread.length > 0 && <span className={`msg-badge ${unreadErr ? "err" : ""}`}>{unread.length} new</span>}
        </button>
        {busy && <span className="msg-busy" role="status"><span className="spinner" />{busy}…</span>}
        <span className="msg-tools">
          <button className="link" onClick={copyAll} disabled={!log.length}>Copy</button>
          <button className="link" onClick={onClear} disabled={!log.length}>Clear</button>
        </span>
      </header>
      {open && (
        <ol className="msg-body" ref={body} onScroll={onScroll}>
          {log.length === 0 && !busy && <li className="msg-empty">Messages from Save, Deploy and other actions appear here.</li>}
          {log.flatMap((m, i) => [
            ...((i === 0 || day(log[i - 1].t) !== day(m.t))
              ? [<li key={`d${m.id}`} className="msg-day">{new Date(m.t).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</li>]
              : []),
            <li key={m.id} className={`msg ${m.kind}`}>
              <time>{clock(m.t)}</time>
              <span className="msg-mark" aria-label={m.kind === "err" ? "Error" : m.kind === "ok" ? "Done" : "Info"}>{MARK[m.kind] ?? "i"}</span>
              <div className="msg-text">
                {m.text}
                {m.list && <ul>{m.list.map((x, j) => <li key={j}>{x}</li>)}</ul>}
              </div>
            </li>,
          ])}
          {busy && <li className="msg busy"><time>{clock(Date.now())}</time><span className="msg-mark"><span className="spinner" /></span><div className="msg-text">{busy}…</div></li>}
        </ol>
      )}
    </section>
  );
}
