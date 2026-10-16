// Console window: xterm.js <-> WebSocket <-> `docker exec -it` in the container.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "./console.css";

const q = new URLSearchParams(location.search);
const lab = q.get("lab");
const node = q.get("node");
const vm = q.get("vm") === "1";            // a shell on the Docker host itself
const name = q.get("name") || node;
document.title = `${name} console`;
document.getElementById("name").textContent = name;
const stateEl = document.getElementById("state");
const again = document.getElementById("reconnect");

const term = new Terminal({
  cursorBlink: true,
  fontFamily: 'Consolas, "Cascadia Mono", "DejaVu Sans Mono", monospace',
  fontSize: 14,
  scrollback: 5000,
  theme: { background: "#1C2A35", foreground: "#E6ECF1", cursor: "#E8B10E", selectionBackground: "#4E5E6B" },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("term"));
fit.fit();
term.focus();

const enc = new TextEncoder();
let ws = null;

let lastState = ["Connecting…", "busy"];
function setState(text, kind) {
  lastState = [text, kind];
  stateEl.textContent = text;
  stateEl.dataset.kind = kind;
  again.hidden = kind !== "closed";
}

function sendSize() {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ resize: [term.cols, term.rows] }));
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const path = vm ? "/api/vm/console"
    : `/api/labs/${encodeURIComponent(lab)}/nodes/${encodeURIComponent(node)}/console`;
  ws = new WebSocket(`${proto}://${location.host}${path}`);
  ws.binaryType = "arraybuffer";
  setState("Connecting…", "busy");
  ws.onopen = () => { setState("Connected", "ok"); sendSize(); };
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      const msg = JSON.parse(ev.data);
      if (msg.error) term.writeln(`\r\n\x1b[31m${msg.error}\x1b[0m`);
      return;
    }
    term.write(new Uint8Array(ev.data));
  };
  ws.onclose = () => {
    setState("Disconnected", "closed");
    term.writeln("\r\n\x1b[90m[session ended]\x1b[0m");
  };
}

term.onData((d) => { if (ws?.readyState === WebSocket.OPEN) ws.send(enc.encode(d)); });

// ---- copy and paste
// Ctrl+C copies when text is selected (otherwise it interrupts, as usual).
// Ctrl+V and Ctrl+Shift+V paste; Ctrl+Shift+C copies. Right-click copies the
// selection, or pastes when nothing is selected (like PuTTY and Windows Terminal).
const canClip = !!(navigator.clipboard && window.isSecureContext);

async function copySelection() {
  const text = term.getSelection();
  if (!text) return false;
  try {
    if (canClip) await navigator.clipboard.writeText(text);
    else {                                   // plain-http fallback
      const t = document.createElement("textarea");
      t.value = text; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove();
    }
    term.clearSelection();
    flash("Copied");
  } catch { flash("Couldn't copy"); }
  return true;
}

async function pasteClipboard() {
  try { const text = await navigator.clipboard.readText(); if (text) term.paste(text); }
  catch { flash("Paste blocked by the browser. Use Ctrl+V."); }
}

term.attachCustomKeyEventHandler((e) => {
  if (e.type !== "keydown" || !e.ctrlKey || e.altKey || e.metaKey) return true;
  const k = e.key.toLowerCase();
  if (k === "c" && (e.shiftKey || term.hasSelection())) { e.preventDefault(); copySelection(); return false; }
  if (k === "v") {
    if (canClip) { e.preventDefault(); pasteClipboard(); }
    return false;                            // without clipboard access, the browser's own paste still works
  }
  return true;
});

document.getElementById("term").addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (term.hasSelection()) copySelection(); else if (canClip) pasteClipboard();
  term.focus();
});

let flashTimer;
function flash(text) {
  stateEl.textContent = text;                // brief note in the status area
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => setState(...lastState), 1200);
}
term.onResize(sendSize);
new ResizeObserver(() => fit.fit()).observe(document.getElementById("term"));
again.onclick = () => { term.reset(); connect(); term.focus(); };

connect();
