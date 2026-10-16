import Description from "./Description.jsx";
import { useContext, useState } from "react";
import { api, engineHost } from "./api.js";
import { NOTE_COLORS, RuntimeContext, cableColor } from "./canvas.jsx";

function Rows({ rows, onChange, fields, empty, addLabel, blank }) {
  const set = (i, k, v) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <div className="rows">
      {rows.length === 0 && <p className="hint">{empty}</p>}
      {rows.map((r, i) => (
        <div className="row" key={i}>
          {fields.map((f) =>
            f.options ? (
              <select key={f.k} value={r[f.k]} aria-label={f.label}
                onChange={(e) => set(i, f.k, e.target.value)}>
                {f.options.map((o) => <option key={o}>{o}</option>)}
              </select>
            ) : (
              <input key={f.k} value={r[f.k]} placeholder={f.label} aria-label={f.label}
                type={f.num ? "number" : "text"} className={f.num ? "num" : ""}
                onChange={(e) => set(i, f.k, f.num ? Number(e.target.value) : e.target.value)} />
            )
          )}
          <button className="icon" aria-label="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button className="link" onClick={() => onChange([...rows, { ...blank }])}>{addLabel}</button>
    </div>
  );
}

function Toggle({ checked, onChange, label, help }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span><b>{label}</b><small>{help}</small></span>
    </label>
  );
}

function StartupLog({ log }) {
  if (!log) return null;
  const ok = log.exit === 0;
  return (
    <details className={`log ${ok ? "ok" : "err"}`} open={!ok}>
      <summary>{ok ? "Last run succeeded" : log.exit == null ? "Last run didn't finish" : `Last run failed (exit ${log.exit})`}</summary>
      <pre>{log.output.trim() || "(no output)"}</pre>
    </details>
  );
}

/** Deploy bakes settings in: say so wherever they're edited on a deployed lab. */
function DeployHint({ text = "Changes here apply when you Redeploy the lab." }) {
  const ctx = useContext(RuntimeContext);
  return ctx.deployed ? <p className="deploy-hint">{text}</p> : null;
}

/** Startup commands that move the default route away from nat0. */
const MOVES_DEFAULT = /(^|[\n;&|])\s*(ip\s+(-\d\s+)?route\s+(add|replace|change|append|del|delete)\s+default\b|route\s+(add|del)\s+default\b)/;

/** Where a node's published ports can be reached, and a warning when replies would get lost. */
function PublishedPorts({ node, engine }) {
  const ctx = useContext(RuntimeContext);
  const rt = ctx.nodes[node.id];
  const ports = (node.data.ports ?? []).filter((p) => Number(p.host) > 0 && Number(p.container) > 0);
  if (!ports.length) return null;
  const raw = engine?.state === "up" ? engineHost(engine.docker_host) : "";
  const host = raw === "this PC" ? "localhost" : raw;
  const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(host);
  const subnet = ipv4 ? host.split(".").slice(0, 3).join(".") + ".0/24" : "192.168.56.0/24";
  // live only if the running container has these ports: not when they changed since the deploy
  const running = rt?.status === "running" && !ctx.pending?.changed.has(node.id);
  return (
    <div className="published">
      {host && (
        <>
          <p className="hint">{running ? "Reach it from this PC at:"
            : rt && ctx.pending?.changed.has(node.id) ? "After a Redeploy, reach it from this PC at:" : "Once it's running, reach it from this PC at:"}</p>
          <ul>
            {ports.map((p, i) => {
              const addr = `${host}:${p.host}`;
              // common HTTPS ports (443, 8443, and 3001 of the webtop desktops) get an https:// link
              const scheme = [443, 8443, 3001].includes(Number(p.container)) ? "https" : "http";
              return (
                <li key={i}>
                  {(p.proto || "tcp") === "tcp" && running
                    ? <a href={`${scheme}://${addr}`} target="_blank" rel="noreferrer">{scheme}://{addr}</a>
                    : <code>{addr}{p.proto === "udp" ? " (udp)" : ""}</code>}
                  <span> → port {p.container} in {node.data.name}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {MOVES_DEFAULT.test(node.data.startup ?? "") && (
        <p className="stale-note">
          Its startup commands change the default route, so replies to visitors coming in through these ports
          would follow it into the lab and get lost. Send them back through nat0 by adding
          <code className="cmd-inline">ip route add {subnet} via 172.17.0.1 dev nat0</code>
          ({subnet} being the network of the PC you browse from; 172.17.0.1 is Docker's usual gateway on nat0,
          check with <code>ip route</code>). Or publish the port on the lab's gateway and forward it, as in the web example lab.
        </p>
      )}
    </div>
  );
}

function NodePanel({ node, update, onAction, onConsole, onDetails, images, log, plannedIfaces, cableCount, engine }) {
  const ctx = useContext(RuntimeContext);
  const rt = ctx.nodes[node.id];
  const changed = ctx.pending?.changed.has(node.id) || (!ctx.deployedTopo && rt?.stale);
  const d = node.data;
  const set = (k) => (v) => update({ [k]: v });
  return (
    <>
      <header className="insp-head">
        <h2>{d.name}</h2>
        <p>{rt ? `Container ${rt.container} is ${rt.status}.` : "Not deployed yet."}</p>
        {changed
          ? <p className="stale-note">Its settings changed since it was deployed. The running container still has the old ones: Redeploy the lab to apply them.</p>
          : ctx.pending?.added.has(node.id) && ctx.deployed
            ? <p className="stale-note">It isn't in the running lab yet. Redeploy the lab to create it.</p>
            : ctx.pending?.startup.has(node.id)
              ? <p className="stale-note soft">Its startup commands changed. They run the next time it starts: Restart it to run them now.</p>
              : rt && <DeployHint text="Changes here apply when you Redeploy the lab; startup commands, at its next start." />}
        {rt && (
          <div className="btn-row">
            {rt.status === "running"
              ? <><button className="primary" onClick={onConsole}>Console</button>
                  <button onClick={() => onAction("stop")}>Stop</button>
                  <button onClick={() => onAction("restart")}>Restart</button></>
              : <button onClick={() => onAction("start")}>Start</button>}
            <button onClick={() => onDetails(rt.container)} title="Everything Docker knows about this container">Details</button>
          </div>
        )}
      </header>

      <section>
        <label className="field">Name
          <input value={d.name} onChange={(e) => set("name")(e.target.value.replace(/[^a-zA-Z0-9_.-]/g, ""))} />
        </label>
        <label className="field">Image
          <input list="image-list" value={d.image} onChange={(e) => set("image")(e.target.value)} />
          <datalist id="image-list">{images.map((i) => <option key={i.tag} value={i.tag} />)}</datalist>
        </label>
        <label className="field">Command
          <input value={d.command} placeholder="Image default" onChange={(e) => set("command")(e.target.value)} />
        </label>
        <label className="field">Interfaces
          <input type="number" min={0} max={64} className="num" value={d.interfaces || ""} placeholder="One per cable"
            onChange={(e) => set("interfaces")(Math.max(0, Math.min(64, parseInt(e.target.value, 10) || 0)))} />
        </label>
        <p className="hint">{cableCount > (d.interfaces || Infinity)
          ? `It has ${cableCount} cables, more than ${d.interfaces}. Raise this or remove a cable before deploying.`
          : "Like a real router, it accepts only this many cables. Leave empty for no limit. Changing it needs a Redeploy."}</p>
      </section>

      <section>
        <h3>Startup commands</h3>
        <p className="hint">Run with <code>sh</code> each time the container starts. Interfaces: {plannedIfaces || "none yet"}.</p>
        <textarea rows={5} spellCheck={false} value={d.startup ?? ""} aria-label="Startup commands"
          placeholder={"ip route add default via 10.0.1.1\necho nameserver 1.1.1.1 > /etc/resolv.conf"}
          onChange={(e) => set("startup")(e.target.value)} />
        <StartupLog log={log} />
      </section>

      <section>
        <h3>Behaviour</h3>
        <Toggle checked={d.router} onChange={set("router")} label="Router"
          help="Turns on IPv4 forwarding between its cables." />
        <Toggle checked={d.internet} onChange={set("internet")} label="Internet access"
          help="Adds a NAT interface, nat0, to the Docker host's network." />
        <Toggle checked={d.privileged} onChange={set("privileged")} label="Privileged"
          help="Full access to the host kernel. Use only when an image needs it." />
      </section>

      <section>
        <h3>Port mappings</h3>
        <Rows rows={d.ports} onChange={set("ports")} addLabel="Add port"
          empty="No ports published. Adding one also gives this node internet access."
          blank={{ host: 8080, container: 80, proto: "tcp" }}
          fields={[{ k: "host", label: "Host", num: true }, { k: "container", label: "Container", num: true },
                   { k: "proto", label: "Protocol", options: ["tcp", "udp"] }]} />
        <PublishedPorts node={node} engine={engine} />
      </section>

      <section>
        <h3>Volumes</h3>
        <Rows rows={d.volumes} onChange={set("volumes")} addLabel="Add volume"
          empty="No volumes. Paths are on the Docker server, not this PC."
          blank={{ source: "", target: "", mode: "rw" }}
          fields={[{ k: "source", label: "Server path or volume" }, { k: "target", label: "Container path" },
                   { k: "mode", label: "Mode", options: ["rw", "ro"] }]} />
      </section>

      <section>
        <h3>Environment</h3>
        <Rows rows={d.env} onChange={set("env")} addLabel="Add variable" empty="No variables."
          blank={{ key: "", value: "" }}
          fields={[{ k: "key", label: "Name" }, { k: "value", label: "Value" }]} />
      </section>
      <p className="hint pad">Settings apply the next time you deploy. Startup commands also apply on the next start.</p>
    </>
  );
}


/** Capture controls for one cable. The manual command is fetched when opened,
 *  because the port it names changes every time the container restarts. */
function CaptureSection({ labName, linkId, deployed, onCapture, engine, what = "this cable" }) {
  const [cmd, setCmd] = useState("");
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const load = () => api.captureCommand(labName, linkId)
    .then((r) => { setCmd(r.command); setErr(""); })
    .catch((e) => { setCmd(""); setErr(e.message); });
  const canLaunch = engine.ssh && engine.wireshark;
  if (!deployed) return <p className="hint">Deploy the lab to capture on {what}.</p>;
  return (
    <>
      {canLaunch
        ? <button className="primary" onClick={onCapture}>Capture in Wireshark</button>
        : <p className="hint">{!engine.ssh ? "One-click capture needs DOCKER_HOST set to an ssh:// address."
                               : "Wireshark wasn't found on this PC. Install it, or set DOCKERLAB_WIRESHARK."}</p>}
      <details className="manual" onToggle={(e) => e.currentTarget.open && load()}>
        <summary>Run it yourself</summary>
        {err ? <p className="hint">{err}</p> : !cmd ? <p className="hint">Looking up the port…</p> : (
          <>
            <p className="hint">Paste into Windows <b>cmd</b> (not PowerShell). It works until the container restarts.</p>
            <pre className="cmd">{cmd}</pre>
            <button onClick={() => { navigator.clipboard?.writeText(cmd); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
              {copied ? "Copied" : "Copy command"}
            </button>
          </>
        )}
      </details>
    </>
  );
}

const endIp = (edge, nodeId) => (edge.source === nodeId ? edge.data?.source_ip : edge.data?.target_ip) ?? "";
const endKey = (edge, nodeId) => (edge.source === nodeId ? "source_ip" : "target_ip");

function LinkPanel({ edge, nodes, update, onCapture, engine, labName }) {
  const runtime = useContext(RuntimeContext);
  const rt = [edge.source, edge.target].some((id) => runtime.nodes[id]);   // a container on it exists
  const node = (id) => nodes.find((n) => n.id === id);
  const name = (id) => node(id)?.data.name ?? "?";
  const d = edge.data ?? {};
  const sw = [edge.source, edge.target].map(node).find((n) => n?.type === "switch");

  if (sw) {
    const cid = sw.id === edge.source ? edge.target : edge.source;
    const subnet = sw.data.subnet;
    return (
      <>
        <header className="insp-head">
          <h2><span className="swatch" style={{ background: cableColor(edge.id) }} />{name(cid)} to {sw.data.name}</h2>
          <p>A port on {sw.data.name}. {subnet ? `Its subnet, ${subnet}, is set on the switch.` : "The switch's subnet is automatic."}</p>
          <DeployHint />
        </header>
        <section>
          <label className="field">{name(cid)} address
            <input value={endIp(edge, cid)} disabled={!subnet}
              placeholder={subnet ? "Automatic" : "Set a subnet on the switch first"}
              onChange={(e) => update({ [endKey(edge, cid)]: e.target.value.trim() })} />
          </label>
        </section>
        <section>
          <h3>Packet capture</h3>
          <p className="hint">Shows what {name(cid)} sends and receives on this switch, like a mirror port.</p>
          <CaptureSection labName={labName} linkId={edge.id} deployed={!!rt} onCapture={onCapture} engine={engine} />
        </section>
      </>
    );
  }

  return (
    <>
      <header className="insp-head">
        <h2><span className="swatch" style={{ background: cableColor(edge.id) }} />
          {name(edge.source)} to {name(edge.target)}</h2>
        <p>Each cable is its own isolated network.</p>
        <DeployHint />
      </header>
      <section>
        <label className="field">Subnet
          <input value={d.subnet ?? ""} placeholder="Automatic, e.g. 10.0.12.0/24"
            onChange={(e) => update({ subnet: e.target.value.trim() })} />
        </label>
        <label className="field">{name(edge.source)} address
          <input value={d.source_ip ?? ""} disabled={!d.subnet} placeholder={d.subnet ? "Automatic" : "Set a subnet first"}
            onChange={(e) => update({ source_ip: e.target.value.trim() })} />
        </label>
        <label className="field">{name(edge.target)} address
          <input value={d.target_ip ?? ""} disabled={!d.subnet} placeholder={d.subnet ? "Automatic" : "Set a subnet first"}
            onChange={(e) => update({ target_ip: e.target.value.trim() })} />
        </label>
        <p className="hint">Addresses belong to this lab: other labs can use the same subnet at the same time.</p>
      </section>
      <section>
        <h3>Packet capture</h3>
        <CaptureSection labName={labName} linkId={edge.id} deployed={!!rt} onCapture={onCapture} engine={engine} />
      </section>
    </>
  );
}

function SwitchPanel({ sw, nodes, edges, update, updateEdge, onCapture, engine }) {
  const runtime = useContext(RuntimeContext);
  const net = runtime.switches?.[sw.id]?.network;
  const d = sw.data;
  const name = (id) => nodes.find((n) => n.id === id)?.data.name ?? "?";
  const cables = edges.filter((e) => e.source === sw.id || e.target === sw.id);
  const canLaunch = engine.ssh && engine.wireshark;
  return (
    <>
      <header className="insp-head">
        <h2>{d.name}</h2>
        <p>A switch: every container cabled to it shares one subnet.</p>
        <DeployHint />
      </header>
      <section>
        <label className="field">Name
          <input value={d.name} onChange={(e) => update({ name: e.target.value.replace(/[^a-zA-Z0-9_.-]/g, "") })} />
        </label>
        <label className="field">Subnet
          <input value={d.subnet ?? ""} placeholder="Automatic, e.g. 10.0.10.0/24"
            onChange={(e) => update({ subnet: e.target.value.trim() })} />
        </label>
        <p className="hint">Addresses belong to this lab: other labs can use the same subnet at the same time.</p>
      </section>
      <section>
        <h3>Ports</h3>
        {cables.length === 0 && <p className="hint">Nothing is cabled to this switch yet. Drag from a container's edge to it.</p>}
        {cables.map((e) => {
          const cid = e.source === sw.id ? e.target : e.source;
          const live = net ? runtime.nodes[cid]?.networks?.[net] : null;
          const up = runtime.nodes[cid]?.status === "running";
          return (
            <div className="port-row" key={e.id}>
              <span className="swatch" style={{ background: cableColor(e.id) }} />
              <div className="port-who">
                <b>{name(cid)}</b>
                <small>{live?.ip ? `${live.ifname || "?"} ${live.ip}/${live.prefix}` : up ? "running" : "not running"}</small>
              </div>
              <input aria-label={`${name(cid)} address`} value={endIp(e, cid)} disabled={!d.subnet}
                placeholder={d.subnet ? "Automatic" : "No subnet"}
                onChange={(ev) => updateEdge(e.id, { [endKey(e, cid)]: ev.target.value.trim() })} />
              {canLaunch && live && up &&
                <button className="mini" title={`Capture ${name(cid)}'s port`} onClick={() => onCapture(e.id)}>Capture</button>}
            </div>
          );
        })}
        {cables.length > 0 && <p className="hint pad-top">Capture shows one port's traffic, like a mirror port. Broadcasts such as ARP reach every port; unicast reaches only its destination.</p>}
      </section>
    </>
  );
}

function plannedIfaceText(node, nodes, edges) {
  const names = Object.fromEntries(nodes.map((n) => [n.id, n.data.name]));
  const list = [];
  if (node.data.internet || node.data.ports?.length) list.push("nat0 (internet)");
  let i = 0;
  for (const e of edges) {
    if (e.source === node.id || e.target === node.id) {
      list.push(`eth${i++} to ${names[e.source === node.id ? e.target : e.source]}`);
    }
  }
  for (; i < (node.data.interfaces || 0); i++) list.push(`eth${i} free`);
  return list.join(", ");
}

export default function Inspector({
  selNode, selEdge, nodes, edges, updateNode, updateEdge, onAction, onConsole, onCapture, onDetails,
  images, engine, labName, savedName, startupLogs, description, setDescription,
}) {
  if (selNode?.type === "note") return (
    <>
      <header className="insp-head"><h2>Note</h2>
        <p>Drag it to move, drag a corner to resize, double-click to edit on the bench.</p></header>
      <section>
        <label className="field">Text
          <textarea rows={7} value={selNode.data.text ?? ""} onChange={(e) => updateNode(selNode.id, { text: e.target.value })} />
        </label>
        <div className="field">Colour
          <div className="swatches" role="radiogroup" aria-label="Note colour">
            {Object.entries(NOTE_COLORS).map(([k, c]) => (
              <button key={k} role="radio" aria-checked={(selNode.data.color ?? "yellow") === k} aria-label={k} title={k}
                className={`swatch-btn ${(selNode.data.color ?? "yellow") === k ? "is-on" : ""}`}
                style={{ background: c.bg, borderColor: c.edge }} onClick={() => updateNode(selNode.id, { color: k })} />
            ))}
          </div>
        </div>
      </section>
    </>
  );
  if (selNode?.type === "switch") return <SwitchPanel key={selNode.id} sw={selNode} nodes={nodes} edges={edges}
    engine={engine} update={(p) => updateNode(selNode.id, p)} updateEdge={updateEdge} onCapture={onCapture} />;
  if (selNode) return <NodePanel key={selNode.id} node={selNode} images={images} engine={engine}
    log={startupLogs[selNode.id]}
    cableCount={edges.filter((e) => e.source === selNode.id || e.target === selNode.id).length}
    plannedIfaces={plannedIfaceText(selNode, nodes, edges) +
      (engine.state === "up" && !engine.fixed_ifnames ? ". Your Docker is older than version 28, so actual names may differ; the bench shows the real ones" : "")}
    update={(p) => updateNode(selNode.id, p)} onAction={(a) => onAction(selNode.id, a)}
    onConsole={() => onConsole(selNode)} onDetails={onDetails} />;
  if (selEdge) return <LinkPanel key={selEdge.id} edge={selEdge} nodes={nodes} engine={engine} labName={savedName}
    update={(p) => updateEdge(selEdge.id, p)} onCapture={() => onCapture(selEdge.id)} />;
  return (
    <div className="lab-panel">
      <header className="insp-head">
        <h2>{labName || "Untitled lab"}</h2>
      </header>
      <Description key={savedName || "untitled"} value={description} onChange={setDescription} title={labName || "Untitled lab"} />
    </div>
  );
}
