import { createContext, useContext, useEffect, useRef, useState } from "react";
import {
  BaseEdge, EdgeLabelRenderer, Handle, NodeResizer, Position, getBezierPath, useInternalNode,
} from "@xyflow/react";

/** Runtime state from the backend (container status, IPs), keyed by node id. */
export const RuntimeContext = createContext({ nodes: {}, links: {} });

const CABLE_COLORS = ["#2F6FD6", "#E8B10E", "#2E9E5B", "#E07A1F", "#7D54C9", "#1C9BA6"];

export function cableColor(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CABLE_COLORS[h % CABLE_COLORS.length];
}

const SIDES = [
  ["t", Position.Top], ["r", Position.Right], ["b", Position.Bottom], ["l", Position.Left],
];

function statusOf(rt) {
  if (!rt) return { key: "idle", text: "Not deployed" };
  if (rt.status === "running") return { key: "run", text: "Running" };
  if (rt.status === "exited") return { key: "stop", text: "Stopped" };
  return { key: "stop", text: rt.status[0].toUpperCase() + rt.status.slice(1) };
}

export function ContainerNode({ id, data, selected }) {
  const ctx = useContext(RuntimeContext);
  const rt = ctx.nodes[id];
  const labels = ctx.netLabels?.[id] ?? {};
  const st = statusOf(rt);
  const addrs = rt
    ? Object.entries(rt.networks).filter(([, v]) => v.ip).map(([net, v]) => ({
        net,
        ifname: v.ifname,
        peer: net === "bridge" ? "internet" : `to ${labels[net] ?? "?"}`,
        ip: `${v.ip}/${v.prefix}`,
      })).sort((a, b) => (a.ifname || "").localeCompare(b.ifname || "", undefined, { numeric: true }))
    : [];
  return (
    <div className={`box ${selected ? "is-selected" : ""}`} data-status={st.key}>
      {SIDES.map(([k, pos]) => (
        <Handle key={k} id={k} type="source" position={pos} className="port" />
      ))}
      <div className="box-led" title={st.text} />
      <div className="box-body">
        <div className="box-name">{data.name}</div>
        <div className="box-image">{data.image}</div>
        {addrs.length > 0 && (
          <ul className="box-addrs">
            {addrs.map((a) => (
              <li key={a.net} title={a.peer}>
                <b>{a.ifname}</b><span>{a.peer}</span><i>{a.ip}</i>
              </li>
            ))}
          </ul>
        )}
        {(ctx.pending?.changed.has(id) || (!ctx.deployedTopo && rt?.stale))
          ? <div className="box-stale" title="Its settings differ from the running container">Changed: Redeploy to apply</div>
          : ctx.pending?.added.has(id)
            ? <div className="box-stale is-new" title="This container isn't in the running lab">New: Redeploy to create</div>
            : ctx.pending?.startup.has(id)
              ? <div className="box-stale is-soft" title="Startup commands run at every start">Startup changed: applies at next start</div>
              : null}
        {(data.router || data.internet || data.ports?.length > 0 || data.interfaces > 0) && (
          <div className="box-flags">
            {data.interfaces > 0 && (
              <span className={ctx.used?.[id] >= data.interfaces ? "full" : ""} title="Cable interfaces in use">
                {ctx.used?.[id] ?? 0} of {data.interfaces} interfaces
              </span>
            )}
            {data.router && <span>router</span>}
            {data.internet && <span>internet</span>}
            {data.ports?.length > 0 && <span>{data.ports.map((p) => p.host).join(", ")}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

export function SwitchNode({ id, data, selected }) {
  const ports = useContext(RuntimeContext).ports?.[id] ?? [];
  return (
    <div className={`switch ${selected ? "is-selected" : ""}`}>
      {SIDES.map(([k, pos]) => (
        <Handle key={k} id={k} type="source" position={pos} className="port" />
      ))}
      <div className="switch-head">
        <span className="switch-name">{data.name}</span>
        <span className="switch-subnet">{data.subnet || "automatic subnet"}</span>
      </div>
      <div className="switch-ports" aria-label={`${ports.length} ports in use`}>
        {ports.length === 0 && <span className="switch-empty">no cables yet</span>}
        {ports.map((p, i) => (
          <span key={i} className={`switch-port ${p.running ? "is-up" : ""}`} title={p.name} />
        ))}
      </div>
    </div>
  );
}

/** Which side of box `a` faces box `b`, and the middle of that side.
 *  Compares the offset between centres with the boxes' own proportions, so a wide
 *  box beside another uses its left/right edge, and one above another its top/bottom. */
function sideOf(a, b) {
  const dx = (b.x + b.w / 2) - (a.x + a.w / 2), dy = (b.y + b.h / 2) - (a.y + a.h / 2);
  const horizontal = Math.abs(dx) / ((a.w + b.w) / 2) > Math.abs(dy) / ((a.h + b.h) / 2);
  return horizontal ? (dx > 0 ? Position.Right : Position.Left) : (dy > 0 ? Position.Bottom : Position.Top);
}

/** The point where a cable leaves box `a`: on the side facing `b`, at slot i of n
 *  (cables sharing a side are spread evenly over its middle 70%). */
function facingSide(a, b, slot = { i: 0, n: 1 }) {
  const pos = sideOf(a, b);
  const f = 0.15 + 0.7 * (slot.i + 1) / (slot.n + 1);
  if (pos === Position.Left || pos === Position.Right) {
    return { x: pos === Position.Right ? a.x + a.w : a.x, y: a.y + a.h * f, pos };
  }
  return { x: a.x + a.w * f, y: pos === Position.Bottom ? a.y + a.h : a.y, pos };
}

/** For every cable, which slot it takes on each end's side. Cables on one side are
 *  ordered by where their far end is, so they fan out without crossing. */
export function cableSlots(nodes, edges) {
  const boxes = {};
  for (const n of nodes) {
    const w = n.measured?.width, h = n.measured?.height;
    if (w && h) boxes[n.id] = { x: n.position.x, y: n.position.y, w, h };
  }
  const groups = {};
  for (const e of edges) {
    const a = boxes[e.source], b = boxes[e.target];
    if (!a || !b) continue;
    for (const [end, me, other] of [["source", a, b], ["target", b, a]]) {
      const id = end === "source" ? e.source : e.target;
      const side = sideOf(me, other);
      const along = side === Position.Left || side === Position.Right ? other.y + other.h / 2 : other.x + other.w / 2;
      (groups[`${id}|${side}`] ??= []).push({ edge: e.id, end, along });
    }
  }
  const slots = {};
  for (const list of Object.values(groups)) {
    list.sort((p, q) => p.along - q.along);
    list.forEach((x, i) => { (slots[x.edge] ??= {})[x.end] = { i, n: list.length }; });
  }
  return slots;
}

/** A cable's drawing: path, label position and colour. Shared by the bench and the
 *  diagram export, so both look the same. a, b: {x, y, w, h} of its two boxes. */
export function cableGeometry(id, a, b, slot) {
  const s = facingSide(a, b, slot?.source), t = facingSide(b, a, slot?.target);
  const [path, lx, ly] = getBezierPath({
    sourceX: s.x, sourceY: s.y, sourcePosition: s.pos, targetX: t.x, targetY: t.y, targetPosition: t.pos, curvature: 0.35,
  });
  return { path, lx, ly, color: cableColor(id) };
}

export const cableLabel = (data) => data?.subnet || data?.source_ip || data?.target_ip || "";

function box(node) {
  const p = node?.internals.positionAbsolute;
  const w = node?.measured?.width, h = node?.measured?.height;
  return p && w && h ? { x: p.x, y: p.y, w, h } : null;
}

export function CableEdge({
  id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected,
}) {
  // Attach each end to the side facing the other box, whichever handle the cable
  // was drawn from. Saved labs don't record handles, and boxes get moved, so this
  // keeps cables short and their labels visible.
  const a = box(useInternalNode(source));
  const b = box(useInternalNode(target));
  const ctx = useContext(RuntimeContext);
  const slot = ctx.slots?.[id];
  const isNew = ctx.pending?.newCables.has(id);   // drawn after the deploy: not in the running lab
  let g;
  if (a && b) g = cableGeometry(id, a, b, slot);
  else {
    const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.35 });
    g = { path, lx, ly, color: cableColor(id) };
  }
  const label = cableLabel(data);
  const width = ctx.appearance?.cableWidth ?? CABLE_WIDTH;
  return (
    <>
      {selected && <BaseEdge path={g.path} style={{ stroke: "var(--ink)", strokeWidth: width + 5.5, opacity: 0.18 }} />}
      <BaseEdge id={id} path={g.path} interactionWidth={16}
        style={{ stroke: g.color, strokeWidth: width, strokeLinecap: isNew ? "butt" : "round",
                 strokeDasharray: isNew ? "8 6" : undefined }} />
      {label && (
        <EdgeLabelRenderer>
          <div className="cable-tag" style={{
            transform: `translate(-50%, -50%) translate(${g.lx}px, ${g.ly}px)`, borderColor: g.color,
          }}>{label}</div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const CABLE_WIDTH = 3.5;

export const NOTE_COLORS = {
  yellow: { bg: "#FFF3B8", edge: "#E8CC4A" },
  blue: { bg: "#DCEBFF", edge: "#8DB4EC" },
  green: { bg: "#DDF3E3", edge: "#86C99C" },
  pink: { bg: "#FBE0E6", edge: "#E59AAE" },
  grey: { bg: "#ECEFF2", edge: "#B9C5CF" },
};

/** A sticky note on the bench: drag to move, drag its corner to resize,
 *  double-click to edit the text in place. */
export function NoteNode({ data, selected, id }) {
  const [editing, setEditing] = useState(false);
  const area = useRef(null);
  const c = NOTE_COLORS[data.color] ?? NOTE_COLORS.yellow;
  const update = useContext(RuntimeContext).updateNode;
  useEffect(() => { if (editing) area.current?.focus(); }, [editing]);
  return (
    <div className={`note ${selected ? "is-selected" : ""}`} style={{ background: c.bg, borderColor: c.edge }}
      onDoubleClick={() => setEditing(true)}>
      <NodeResizer isVisible={selected} minWidth={120} minHeight={50} color={c.edge}
        lineStyle={{ borderColor: "transparent" }} handleStyle={{ width: 9, height: 9, borderRadius: 2 }} />
      {editing ? (
        <textarea ref={area} className="note-edit nodrag nowheel" value={data.text}
          onChange={(e) => update?.(id, { text: e.target.value })}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => { if (e.key === "Escape") e.currentTarget.blur(); }} />
      ) : (
        <div className="note-text">{data.text || <span className="note-empty">Double-click to write</span>}</div>
      )}
    </div>
  );
}
