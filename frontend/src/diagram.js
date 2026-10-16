// Export the bench as a real vector SVG (shapes and text, not a screenshot), and as
// a PNG rendered from that SVG. The layout mirrors the bench's CSS; cables use the
// same geometry function as the bench, so the drawing matches what's on screen.
import font400 from "@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-400-normal.woff2?url";
import font700 from "@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-700-normal.woff2?url";
import { NOTE_COLORS, cableGeometry, cableLabel } from "./canvas.jsx";
import { APPEARANCE_DEFAULTS } from "./Appearance.jsx";

const BASE = {
  ink: "#1C2A35", ink2: "#4E5E6B", ink3: "#7C8A96", rule: "#D5DDE4", field: "#F3F6F8", panel: "#FFFFFF",
  boxEdge: "#B9C5CF", run: "#2E9E5B", stop: "#9AA6B0", amberBg: "#FDF1D2", amberInk: "#6B4600",
  swPort: "#2C3E4C", swPortEdge: "#4E5E6B", swSub: "#9AA6B0", sw: "#1C2A35", label: "#FFFFFF", note: "#1C2A35",
};
let C = BASE;   // BASE with the Appearance colours, set by diagramSvg
const FONT = "'Atkinson Hyperlegible', Arial, Helvetica, sans-serif";
const PAD = 24;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let measureCtx;
function width(text, size, bold = false) {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  measureCtx.font = `${bold ? 700 : 400} ${size}px ${FONT}`;
  return measureCtx.measureText(text).width;
}

/** Shorten text with an ellipsis so it fits in maxW. */
function fit(text, size, maxW, bold = false) {
  text = String(text ?? "");
  if (width(text, size, bold) <= maxW) return text;
  while (text.length > 1 && width(text + "…", size, bold) > maxW) text = text.slice(0, -1);
  return text + "…";
}

/** Break text into lines no wider than maxW (keeps the author's line breaks). */
function wrap(text, size, maxW) {
  const out = [];
  for (const para of String(text ?? "").split("\n")) {
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      const next = line + word;
      if (line && width(next.trimEnd(), size) > maxW) { out.push(line.trimEnd()); line = word.trimStart(); }
      else line = next;
    }
    out.push(line.trimEnd());
  }
  return out;
}

const txt = (x, y, s, { size = 12, bold = false, fill = C.ink, anchor = "start" } = {}) =>
  `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size}"${bold ? ' font-weight="700"' : ""} fill="${fill}"${anchor !== "start" ? ` text-anchor="${anchor}"` : ""}>${esc(s)}</text>`;

function boxOf(n) {
  const w = n.width ?? n.measured?.width, h = n.height ?? n.measured?.height;
  return w && h ? { x: n.position.x, y: n.position.y, w, h } : null;
}

function containerSvg(n, b, ctx) {
  const rt = ctx.nodes?.[n.id];
  const d = n.data;
  const status = !rt ? C.rule : rt.status === "running" ? C.run : C.stop;
  const out = [
    `<rect x="${b.x}" y="${b.y + 1}" width="${b.w}" height="${b.h}" rx="4" fill="${C.boxEdge}"/>`,
    `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="4" fill="${C.panel}" stroke="${C.boxEdge}"/>`,
    `<path d="M${b.x + 4},${b.y + 0.5} h2 v${b.h - 1} h-2 a3.5,3.5 0 0 1 -3.5,-3.5 v${-(b.h - 8)} a3.5,3.5 0 0 1 3.5,-3.5z" fill="${status}"/>`,
  ];
  const x = b.x + 6 + 10, inner = b.w - 6 - 20;
  let y = b.y + 8;
  out.push(txt(x, y + 16, fit(d.name, 15, inner, true), { size: 15, bold: true }));
  y += 22;
  out.push(txt(x, y + 13, fit(d.image, 12, inner), { size: 12, fill: C.ink3 }));
  y += 17;
  const labels = ctx.netLabels?.[n.id] ?? {};
  const addrs = rt ? Object.entries(rt.networks).filter(([, v]) => v.ip).map(([net, v]) => ({
    ifname: v.ifname || "", peer: net === "bridge" ? "internet" : `to ${labels[net] ?? "?"}`, ip: `${v.ip}/${v.prefix}`,
  })).sort((p, q) => p.ifname.localeCompare(q.ifname, undefined, { numeric: true })) : [];
  if (addrs.length) {
    y += 6;
    out.push(`<line x1="${x}" y1="${y}" x2="${x + inner}" y2="${y}" stroke="${C.rule}"/>`);
    y += 6;
    for (const a of addrs) {
      const ifw = width(a.ifname, 12, true);
      const ipw = width(a.ip, 12);
      out.push(txt(x, y + 13, a.ifname, { size: 12, bold: true }));
      out.push(txt(x + ifw + 6, y + 13, fit(a.peer, 12, inner - ifw - ipw - 18), { size: 12, fill: C.ink3 }));
      out.push(txt(x + inner, y + 13, a.ip, { size: 12, anchor: "end" }));
      y += 17.4;
    }
  }
  const chips = [];
  if (d.interfaces > 0) chips.push({ t: `${ctx.used?.[n.id] ?? 0} of ${d.interfaces} interfaces`, warn: (ctx.used?.[n.id] ?? 0) >= d.interfaces });
  if (d.router) chips.push({ t: "router" });
  if (d.internet) chips.push({ t: "internet" });
  if (d.ports?.length) chips.push({ t: d.ports.map((p) => p.host).join(", ") });
  if (chips.length) {
    y += 6;
    let cx = x;
    for (const c of chips) {
      const w = width(c.t, 11) * 1.08 + 12;
      if (cx + w > x + inner && cx > x) { cx = x; y += 21; }
      out.push(`<rect x="${cx}" y="${y}" width="${w}" height="17" rx="3" fill="${c.warn ? C.amberBg : C.field}"/>`);
      out.push(txt(cx + 6, y + 12.5, c.t, { size: 11, fill: c.warn ? C.amberInk : C.ink2 }));
      cx += w + 4;
    }
  }
  return out.join("");
}

function switchSvg(n, b, ctx) {
  const ports = ctx.ports?.[n.id] ?? [];
  const out = [`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="4" fill="${C.sw}"/>`];
  const sub = n.data.subnet || "automatic subnet";
  const subW = width(sub, 11);
  out.push(txt(b.x + 10, b.y + 22, fit(n.data.name, 14, b.w - subW - 30, true), { size: 14, bold: true, fill: "#E6ECF1" }));
  out.push(txt(b.x + b.w - 10, b.y + 22, sub, { size: 11, fill: C.swSub, anchor: "end" }));
  let px = b.x + 10;
  const py = b.y + b.h - 8 - 11;
  if (!ports.length) out.push(txt(px, py + 9, "no cables yet", { size: 11, fill: C.ink3 }));
  for (const p of ports) {
    out.push(`<rect x="${px}" y="${py}" width="12" height="9" rx="2" fill="${p.running ? C.run : C.swPort}" stroke="${p.running ? "#5BC48A" : C.swPortEdge}"/>`);
    px += 16;
  }
  return out.join("");
}

function noteSvg(n, b, size) {
  const c = NOTE_COLORS[n.data.color] ?? NOTE_COLORS.yellow;
  const out = [`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="3" fill="${c.bg}" stroke="${c.edge}"/>`];
  // wrap a little early: viewers that ignore the embedded font (Word, PowerPoint)
  // substitute one that can be ~10% wider
  const lh = size * 1.4;
  const lines = wrap(n.data.text, size, (b.w - 22) * 0.9);
  const max = Math.max(0, Math.floor((b.h - 16) / lh));
  lines.slice(0, max).forEach((l, i) => out.push(txt(b.x + 11, b.y + 8 + size * 1.04 + i * lh, l, { size, fill: C.note })));
  return out.join("");
}

function cableSvg(e, a, b, ctx) {
  const g = cableGeometry(e.id, a, b, ctx.slots?.[e.id]);
  const out = [`<path d="${g.path}" fill="none" stroke="${g.color}" stroke-width="${ctx.appearance?.cableWidth ?? APPEARANCE_DEFAULTS.cableWidth}" stroke-linecap="round"/>`];
  const label = cableLabel(e.data);
  return { line: out.join(""), label: label && { x: g.lx, y: g.ly, text: label, color: g.color } };
}

function labelSvg(l, k) {
  const w = (width(l.text, 11, true) * 1.08 + 14) * k, h = 18 * k;
  return `<rect x="${(l.x - w / 2).toFixed(1)}" y="${(l.y - h / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${h / 2}" fill="${C.label}" stroke="${l.color}" stroke-width="${2 * k}"/>`
    + txt(l.x, l.y + 4 * k, l.text, { size: 11 * k, bold: true, fill: C.note, anchor: "middle" });
}

async function fontFaces() {
  const b64 = async (url) => {
    const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
    let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const [r, b] = await Promise.all([b64(font400), b64(font700)]);
  return `@font-face{font-family:'Atkinson Hyperlegible';font-weight:400;src:url(data:font/woff2;base64,${r}) format('woff2')}`
    + `@font-face{font-family:'Atkinson Hyperlegible';font-weight:700;src:url(data:font/woff2;base64,${b}) format('woff2')}`;
}

/** The whole bench as an SVG string, plus its size. ctx is the bench's runtime context
 *  (container status and addresses, cable slots, switch ports). */
export async function diagramSvg(nodes, edges, ctx, { background = true } = {}) {
  await document.fonts.ready;                  // measure text with the real font
  const a = { ...APPEARANCE_DEFAULTS, ...ctx.appearance };
  C = { ...BASE, panel: a.boxBg, boxEdge: a.boxBorder, ink: a.boxInk, sw: a.switchBg };
  const k = a.boxScale / 100;
  // containers and switches are drawn at 100% inside a scaled group, as on screen
  const scaled = (b, draw) => `<g transform="translate(${b.x} ${b.y}) scale(${k})">${draw({ x: 0, y: 0, w: b.w / k, h: b.h / k })}</g>`;
  const boxes = {};
  for (const n of nodes) { const b = boxOf(n); if (b) boxes[n.id] = b; }
  const all = Object.values(boxes);
  if (!all.length) throw new Error("The bench is empty.");
  const minX = Math.min(...all.map((b) => b.x)) - PAD, minY = Math.min(...all.map((b) => b.y)) - PAD;
  const maxX = Math.max(...all.map((b) => b.x + b.w)) + PAD, maxY = Math.max(...all.map((b) => b.y + b.h)) + PAD;
  const W = Math.ceil(maxX - minX), H = Math.ceil(maxY - minY);

  const notes = nodes.filter((n) => n.type === "note" && boxes[n.id]).map((n) => noteSvg(n, boxes[n.id], a.noteSize));
  const cables = edges.filter((e) => boxes[e.source] && boxes[e.target]).map((e) => cableSvg(e, boxes[e.source], boxes[e.target], ctx));
  const things = nodes.filter((n) => n.type !== "note" && boxes[n.id]).map((n) =>
    scaled(boxes[n.id], (b) => (n.type === "switch" ? switchSvg(n, b, ctx) : containerSvg(n, b, ctx))));

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${minX} ${minY} ${W} ${H}">`
    + `<style>${await fontFaces()} text{font-family:${FONT}}</style>`
    + (background ? `<rect x="${minX}" y="${minY}" width="${W}" height="${H}" fill="#FFFFFF"/>` : "")
    + `<g>${notes.join("")}</g><g>${cables.map((c) => c.line).join("")}</g>`
    + `<g>${things.join("")}</g><g>${cables.filter((c) => c.label).map((c) => labelSvg(c.label, a.labelScale / 100)).join("")}</g></svg>`;
  return { svg, width: W, height: H };
}

/** Render the SVG to a PNG blob at `scale` times its size (2 = sharp on slides). */
export async function diagramPng(svgText, w, h, scale = 2) {
  const url = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
    const g = canvas.getContext("2d");
    g.scale(scale, scale);
    g.drawImage(img, 0, 0, w, h);
    return await new Promise((res) => canvas.toBlob(res, "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function download(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
