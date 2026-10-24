import { useEffect, useState } from "react";
import { api, openContainerConsole } from "./api.js";

// ---------------------------------------------------------------- helpers
const when = (s) => {
  if (!s || s.startsWith("0001-")) return "";
  const d = new Date(s);
  return isNaN(d) ? s : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};
const ago = (s) => {
  const d = new Date(s); if (!s || isNaN(d) || s.startsWith("0001-")) return "";
  const m = Math.round((Date.now() - d) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
const mb = (n) => (n ? (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : `${Math.round(n / (1 << 20))} MB`) : "");
const short = (id) => (id || "").replace("sha256:", "").slice(0, 12);
const yes = (b) => (b ? "yes" : "no");

/** Rows of [label, value]; rows whose value is empty are left out. */
function KV({ rows }) {
  const shown = rows.filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length));
  if (!shown.length) return <p className="hint">None.</p>;
  return (
    <dl className="kv">
      {shown.map(([k, v]) => (
        <div key={k}><dt>{k}</dt><dd>{Array.isArray(v) ? v.join(", ") : v}</dd></div>
      ))}
    </dl>
  );
}

function Table({ head, rows, empty = "None." }) {
  if (!rows.length) return <p className="hint">{empty}</p>;
  return (
    <div className="dt-wrap">
      <table className="dt">
        <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function Section({ title, children }) {
  return <section className="d-sec"><h3>{title}</h3>{children}</section>;
}

function Raw({ data }) {
  const [copied, setCopied] = useState(false);
  const text = JSON.stringify(data, null, 2);
  return (
    <details className="raw">
      <summary>Raw JSON (as <code>docker inspect</code> shows it)</summary>
      <button className="mini" onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { /* blocked */ } }}>
        {copied ? "Copied" : "Copy"}</button>
      <pre>{text}</pre>
    </details>
  );
}

function useLoad(fn, deps) {
  const [state, setState] = useState({ data: null, error: "" });
  useEffect(() => {
    let live = true;
    setState({ data: null, error: "" });
    fn().then((data) => live && setState({ data, error: "" })).catch((e) => live && setState({ data: null, error: e.message }));
    return () => { live = false; };
  }, deps);   // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

// ---------------------------------------------------------------- container
export function ContainerDetails({ id, onBack, onNetwork, onImage, onVolume, onAction, rev = 0, busy }) {
  const { data: full, error } = useLoad(() => api.vmInspectContainer(id), [id, rev]);
  if (error) return <div className="details"><button className="link" onClick={onBack}>← Back</button><p className="conn-error">{error}</p></div>;
  if (!full) return <div className="details"><p className="hint">Loading…</p></div>;
  const { DockerLabInside, ...a } = full;     // raw JSON shows exactly what docker inspect does
  a.DockerLabInside = DockerLabInside;
  const st = a.State || {}, cfg = a.Config || {}, hc = a.HostConfig || {}, ns = a.NetworkSettings || {};
  const name = (a.Name || "").replace(/^\//, "");
  const status = st.Running ? `Running since ${when(st.StartedAt)} (${ago(st.StartedAt)})`
    : st.Status === "exited" ? `Exited with code ${st.ExitCode}${st.FinishedAt ? ` at ${when(st.FinishedAt)}` : ""}`
    : st.Status;
  const labels = cfg.Labels || {};
  const dl = Object.entries(labels).filter(([k]) => k.startsWith("dockerlab."));
  const other = Object.entries(labels).filter(([k]) => !k.startsWith("dockerlab."));
  const ports = Object.entries(ns.Ports || {}).flatMap(([cport, binds]) =>
    (binds || []).map((b) => [`${b.HostIp || "0.0.0.0"}:${b.HostPort}`, cport]));
  const env = (cfg.Env || []).map((e) => { const i = e.indexOf("="); return [e.slice(0, i), e.slice(i + 1)]; });
  const nets = Object.entries(ns.Networks || {});
  const isLab = !!labels["dockerlab.lab"];

  return (
    <div className="details">
      <button className="link" onClick={onBack}>← Back</button>
      <header className="d-head">
        <h2><span className={`dot ${st.Running ? "on" : ""}`} /> {name}
          <span className="d-actions">
            {st.Running && <button className="mini" onClick={() => openContainerConsole(a.Id, name)}
              title="Open a shell in this container">Console</button>}
            {onAction && (st.Running ? <>
              <button className="mini" disabled={busy} onClick={() => onAction({ id: a.Id, name }, "restart")}>Restart</button>
              <button className="mini" disabled={busy} onClick={() => onAction({ id: a.Id, name }, "stop")}>Stop</button>
            </> : <button className="mini" disabled={busy} onClick={() => onAction({ id: a.Id, name }, "start")}>Start</button>)}
          </span></h2>
        <p><button className="link inline" onClick={() => onImage?.(a.Image || cfg.Image)}>{cfg.Image}</button> · {short(a.Id)}{isLab ? ` · lab ${labels["dockerlab.lab"]}, node ${labels["dockerlab.node"] ?? "?"}` : ""}</p>
      </header>

      <Section title="State">
        <KV rows={[
          ["Status", status],
          ["Created", when(a.Created)],
          ["Restarts", a.RestartCount || ""],
          ["Process ID", st.Pid || ""],
          ["Health", st.Health?.Status],
          ["Error", st.Error],
          ["OOM killed", st.OOMKilled ? "yes" : ""],
        ]} />
      </Section>

      <Section title="Command">
        <KV rows={[
          ["Runs", [a.Path, ...(a.Args || [])].filter(Boolean).join(" ")],
          ["Entrypoint", (cfg.Entrypoint || []).join(" ")],
          ["Command", (cfg.Cmd || []).join(" ")],
          ["Working directory", cfg.WorkingDir],
          ["User", cfg.User],
          ["Hostname", cfg.Hostname],
          ["Terminal (TTY)", yes(cfg.Tty)],
        ]} />
      </Section>

      <Section title="Networks">
        <KV rows={[["Network mode", hc.NetworkMode]]} />
        <Table head={["Network", "Interface", "IPv4", "Gateway", "MAC"]}
          rows={nets.map(([n, e]) => [
            <button className="link" onClick={() => onNetwork(e.NetworkID || n)}>{n}</button>,
            e.DriverOpts?.["com.docker.network.endpoint.ifname"] || "",
            e.IPAddress ? `${e.IPAddress}/${e.IPPrefixLen}` : "",
            e.Gateway || "",
            e.MacAddress || "",
          ])} empty="Not on any network." />
        {isLab && nets.some(([n]) => n.startsWith("dl-")) && (
          <p className="hint">On lab networks, these are Docker's carrier addresses (100.64.0.0/10). DockerLab replaces them inside the container with the lab's own{(a.DockerLabInside || []).length ? ":" : <>; see them with <code>ip addr</code> in its console.</>}</p>
        )}
        {(a.DockerLabInside || []).length > 0 && (
          <Table head={["Interface", "Address inside the container"]} rows={a.DockerLabInside.map((i) => [i.ifname, i.cidr])} />
        )}
        {ports.length > 0 && <Table head={["Published on the host", "Container port"]} rows={ports} />}
      </Section>

      <Section title="Storage">
        <Table head={["Type", "Source (Docker host)", "In the container", "Access"]}
          rows={(a.Mounts || []).map((m) => [m.Type,
            m.Type === "volume" && onVolume ? <button className="link" onClick={() => onVolume(m.Name)}>{m.Name.length === 64 ? short(m.Name) : m.Name}</button> : (m.Name || m.Source),
            m.Destination, m.RW ? "read-write" : "read-only"])}
          empty="No volumes or bind mounts." />
      </Section>

      <Section title="Environment">
        <Table head={["Variable", "Value"]} rows={env.map(([k, v]) => [<code>{k}</code>, <span className="wrap">{v}</span>])} empty="No variables." />
      </Section>

      <Section title="Security and resources">
        <KV rows={[
          ["Privileged", yes(hc.Privileged)],
          ["Added capabilities", hc.CapAdd || []],
          ["Dropped capabilities", hc.CapDrop || []],
          ["Kernel settings (sysctls)", Object.entries(hc.Sysctls || {}).map(([k, v]) => `${k}=${v}`)],
          ["Devices", (hc.Devices || []).map((d) => d.PathOnHost)],
          ["Security options", hc.SecurityOpt || []],
          ["Memory limit", mb(hc.Memory) || "none"],
          ["CPU limit", hc.NanoCpus ? `${hc.NanoCpus / 1e9} CPUs` : "none"],
          ["Shared memory (/dev/shm)", mb(hc.ShmSize)],
          ["Restart policy", hc.RestartPolicy?.Name || "no"],
        ]} />
      </Section>

      <Section title="Labels">
        {dl.length > 0 && <KV rows={dl.map(([k, v]) => [k, v])} />}
        {other.length > 0 ? <KV rows={other.map(([k, v]) => [k, v])} /> : !dl.length && <p className="hint">None.</p>}
      </Section>

      <Raw data={(({ DockerLabInside: _, ...rest }) => rest)(a)} />
    </div>
  );
}

// ---------------------------------------------------------------- image
export function ImageDetails({ ref_, onBack, onContainer }) {
  const { data, error } = useLoad(() => api.vmImage(ref_), [ref_]);
  if (error) return <div className="details"><button className="link" onClick={onBack}>← Back</button><p className="conn-error">{error}</p></div>;
  if (!data) return <div className="details"><p className="hint">Loading…</p></div>;
  const a = data.attrs, cfg = a.Config || {};
  const labels = { ...(cfg.Labels || {}) };
  const dockerfile = labels["dockerlab.dockerfile"];
  delete labels["dockerlab.dockerfile"];
  const env = (cfg.Env || []).map((e) => { const i = e.indexOf("="); return [e.slice(0, i), e.slice(i + 1)]; });
  // newest layer first, as `docker history` shows; Docker's own notes on the step are trimmed
  const layers = (data.history || []).map((h) => [
    <code className="wrap">{(h.CreatedBy || "").replace(/^\/bin\/sh -c #\(nop\)\s*/, "").replace(/^\/bin\/sh -c /, "RUN ").replace(/\s*# buildkit$/, "").replace(/^LABEL dockerlab\.dockerfile=[\s\S]*/, "LABEL dockerlab.dockerfile=… (the Dockerfile above)")}</code>,
    h.Size ? (mb(h.Size) || `${Math.max(1, Math.round(h.Size / 1024))} KB`) : "0 B", when(new Date(h.Created * 1000).toISOString())]);
  return (
    <div className="details">
      <button className="link" onClick={onBack}>← Back</button>
      <header className="d-head">
        <h2>{(a.RepoTags || [])[0] || short(a.Id)}</h2>
        <p>{short(a.Id)} · {mb(a.Size)}{dockerfile ? " · built in DockerLab" : ""}</p>
      </header>

      <Section title="Overview">
        <KV rows={[
          ["Tags", a.RepoTags || []],
          ["Digests", (a.RepoDigests || []).map((d) => d.split("@")[1]?.slice(0, 19) + "…")],
          ["Created", when(a.Created)],
          ["Size", mb(a.Size)],
          ["Platform", [a.Os, a.Architecture, a.Variant].filter(Boolean).join("/")],
          ["Author", a.Author],
          ["Filesystem layers", String((a.RootFS?.Layers || []).length)],
        ]} />
      </Section>

      <Section title="How containers start">
        <KV rows={[
          ["Entrypoint", (cfg.Entrypoint || []).join(" ")],
          ["Command", (cfg.Cmd || []).join(" ")],
          ["Working directory", cfg.WorkingDir],
          ["User", cfg.User],
          ["Exposed ports", Object.keys(cfg.ExposedPorts || {})],
          ["Volumes", Object.keys(cfg.Volumes || {})],
          ["Stop signal", cfg.StopSignal],
        ]} />
        {env.length > 0 && <Table head={["Variable", "Value"]} rows={env.map(([k, v]) => [<code>{k}</code>, <span className="wrap">{v}</span>])} />}
      </Section>

      {dockerfile && (
        <Section title="Dockerfile (built in DockerLab)">
          <pre className="dockerfile">{dockerfile}</pre>
        </Section>
      )}

      <Section title={`Build steps (${layers.length}, newest first)`}>
        <Table head={["Step", "Adds", "Created"]} rows={layers} empty="No history." />
      </Section>

      <Section title="Used by">
        <Table head={["Container", "State"]}
          rows={data.containers.map((c) => [<button className="link" onClick={() => onContainer(c.id)}>{c.name}</button>, c.state])}
          empty="No containers." />
        <KV rows={[["Saved labs", data.labs]]} />
      </Section>

      <Section title="Labels">
        <KV rows={Object.entries(labels).map(([k, v]) => [k, v])} />
      </Section>

      <Raw data={a} />
    </div>
  );
}

// ---------------------------------------------------------------- network
export function NetworkDetails({ id, onBack, onContainer }) {
  const { data, error } = useLoad(() => api.vmNetwork(id), [id]);
  if (error) return <div className="details"><button className="link" onClick={onBack}>← Back</button><p className="conn-error">{error}</p></div>;
  if (!data) return <div className="details"><p className="hint">Loading…</p></div>;
  const a = data.attrs, ipam = a.IPAM || {}, opts = a.Options || {}, labels = a.Labels || {};
  const lab = labels["dockerlab.lab"];
  return (
    <div className="details">
      <button className="link" onClick={onBack}>← Back</button>
      <header className="d-head">
        <h2>{a.Name}</h2>
        <p>{a.Driver} network · {short(a.Id)}{lab ? ` · lab ${lab}` : ""}</p>
      </header>

      <Section title="Overview">
        <KV rows={[
          ["Driver", a.Driver],
          ["Scope", a.Scope],
          ["Created", when(a.Created)],
          ["Internal", `${yes(a.Internal)}${a.Internal ? " (no route to the outside)" : ""}`],
          ["Attachable", yes(a.Attachable)],
          ["IPv4", a.EnableIPv4 === false ? "off" : "on"],
          ["IPv6", a.EnableIPv6 ? "on" : "off"],
          ["Host bridge", opts["com.docker.network.bridge.name"]],
          ["Parent interface", opts.parent],
          ["Mode", opts.macvlan_mode || opts.ipvlan_mode],
        ]} />
        {lab && <p className="hint">Created by DockerLab for lab {lab}. Its subnet is a carrier subnet only Docker uses; the lab's own addresses are set inside the containers.</p>}
      </Section>

      <Section title="Addresses (IPAM)">
        <Table head={["Subnet", "Gateway", "Range for containers"]}
          rows={(ipam.Config || []).map((c) => [c.Subnet, c.Gateway || "", c.IPRange || ""])}
          empty="No subnets." />
        {ipam.Driver && ipam.Driver !== "default" && <KV rows={[["IPAM driver", ipam.Driver]]} />}
      </Section>

      <Section title={`Containers (${data.containers.length})`}>
        <Table head={["Container", "State", "IPv4", "MAC"]}
          rows={data.containers.map((c) => [
            <button className="link" onClick={() => onContainer(c.id)}>{c.name}</button>,
            c.state, c.ip ? `${c.ip}/${c.prefix}` : "", c.mac])}
          empty="No containers use it." />
      </Section>

      <Section title="Options">
        <KV rows={Object.entries(opts).map(([k, v]) => [k, v])} />
      </Section>

      <Section title="Labels">
        <KV rows={Object.entries(labels).map(([k, v]) => [k, v])} />
      </Section>

      <Raw data={a} />
    </div>
  );
}

// ---------------------------------------------------------------- new network
const DRIVER_HELP = {
  bridge: "A virtual switch on the Docker host. Containers on it reach each other; unless it's internal, Docker also NATs them to the outside through the host.",
  macvlan: "Puts containers straight onto a real network through one of the host's interfaces, each with its own MAC address, like separate machines. The host itself can't reach them this way. In VirtualBox, set that adapter's Promiscuous Mode to Allow All.",
  ipvlan: "Like macvlan, but containers share the parent interface's MAC address. Works where extra MAC addresses are blocked, such as Wi-Fi.",
};

export function NetworkForm({ onBack, onCreated }) {
  const [f, setF] = useState({ name: "", driver: "bridge", subnet: "", gateway: "", ip_range: "", internal: false,
                               ipv6: false, subnet6: "", bridge_name: "", mtu: "", parent: "", mode: "" });
  const [ifaces, setIfaces] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { api.vmInterfaces().then(setIfaces).catch(() => {}); }, []);
  const set = (k) => (e) => { setError(""); setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }); };
  const real = f.driver !== "bridge";
  const modes = f.driver === "macvlan" ? ["bridge", "private", "vepa", "passthru"] : ["l2", "l3", "l3s"];

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const r = await api.vmCreateNetwork({ ...f, mtu: f.mtu ? Number(f.mtu) : undefined, mode: f.mode || modes[0] });
      onCreated(r);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  return (
    <form className="details net-form" onSubmit={submit}>
      <button type="button" className="link" onClick={onBack}>← Back</button>
      <header className="d-head"><h2>New network</h2></header>
      <div className="form-grid">
        <label className="field">Name<input value={f.name} onChange={set("name")} placeholder="e.g. office-lan" autoFocus spellCheck={false} /></label>
        <label className="field">Driver
          <select value={f.driver} onChange={(e) => { setError(""); setF({ ...f, driver: e.target.value, mode: "" }); }}>
            <option value="bridge">bridge</option><option value="macvlan">macvlan</option><option value="ipvlan">ipvlan</option>
          </select>
        </label>
      </div>
      <p className="hint">{DRIVER_HELP[f.driver]}</p>
      <div className="form-grid three">
        <label className="field">Subnet<input value={f.subnet} onChange={set("subnet")} placeholder={real ? "the real network's, e.g. 192.168.56.0/24" : "Automatic, e.g. 10.20.0.0/24"} /></label>
        <label className="field">Gateway<input value={f.gateway} onChange={set("gateway")} placeholder={real ? "its router, e.g. 192.168.56.1" : "Automatic (first address)"} disabled={!f.subnet} /></label>
        <label className="field">Range for containers<input value={f.ip_range} onChange={set("ip_range")} placeholder="Whole subnet, e.g. 10.20.0.128/25" disabled={!f.subnet} /></label>
      </div>
      {real ? (
        <div className="form-grid">
          <label className="field">Parent interface (on the Docker host)
            <input value={f.parent} onChange={set("parent")} list="host-ifaces" placeholder={ifaces[0] || "e.g. eth0"} spellCheck={false} />
            <datalist id="host-ifaces">{ifaces.map((i) => <option key={i} value={i} />)}</datalist>
          </label>
          <label className="field">Mode
            <select value={f.mode || modes[0]} onChange={set("mode")}>{modes.map((m) => <option key={m}>{m}</option>)}</select>
          </label>
        </div>
      ) : (
        <div className="form-grid">
          <label className="field">Host bridge name<input value={f.bridge_name} onChange={set("bridge_name")} placeholder="Automatic (br-…)" spellCheck={false} /></label>
          <label className="field">MTU<input value={f.mtu} onChange={set("mtu")} placeholder="1500" inputMode="numeric" /></label>
        </div>
      )}
      <label className="toggle"><input type="checkbox" checked={f.internal} onChange={set("internal")} />
        <span>Internal<small>No route to the outside: containers reach only each other.</small></span></label>
      <label className="toggle"><input type="checkbox" checked={f.ipv6} onChange={set("ipv6")} />
        <span>IPv6<small>Also give containers IPv6 addresses.</small></span></label>
      {f.ipv6 && <label className="field">IPv6 subnet<input value={f.subnet6} onChange={set("subnet6")} placeholder="e.g. fd00:20::/64" /></label>}
      {error && <p className="conn-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="submit" className="primary" disabled={busy || !f.name.trim()}>{busy ? "Creating…" : "Create network"}</button>
        <button type="button" onClick={onBack} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- volumes
const bytes = (n) => (n == null || n < 0 ? "" : n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB`
  : n < 1 << 30 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / (1 << 30)).toFixed(2)} GB`);
export const volumeSize = bytes;

/** The folders and files in a volume, read through a helper container. */
function VolumeFiles({ name }) {
  const [path, setPath] = useState("");
  const { data, error } = useLoad(() => api.vmVolumeFiles(name, path), [name, path]);
  const parts = path.split("/").filter(Boolean);
  const go = (p) => setPath(p);
  return (
    <div className="vol-files">
      <p className="crumbs">
        <button className="link" onClick={() => go("")}>{name}</button>
        {parts.map((p, i) => <span key={i}> / <button className="link" onClick={() => go(parts.slice(0, i + 1).join("/"))}>{p}</button></span>)}
      </p>
      {error ? <p className="conn-error">{error}</p>
        : !data ? <p className="hint">Reading…</p>
        : <Table head={["Name", "Size", "Modified"]} empty="Empty."
            rows={data.entries.map((e) => [
              e.type === "d" ? <button className="link" onClick={() => go([...parts, e.name].join("/"))}>{e.name}/</button>
                : e.type === "l" ? <span title="symbolic link">{e.name} ↗</span> : e.name,
              e.type === "d" ? "" : bytes(e.size),
              when(new Date(e.mtime * 1000).toISOString()),
            ])} />}
      {data?.truncated && <p className="hint">Showing the first 500 entries.</p>}
    </div>
  );
}

export function VolumeDetails({ name, onBack, onContainer }) {
  const { data, error } = useLoad(() => api.vmVolume(name), [name]);
  if (error) return <div className="details"><button className="link" onClick={onBack}>← Back</button><p className="conn-error">{error}</p></div>;
  if (!data) return <div className="details"><p className="hint">Loading…</p></div>;
  const a = data.attrs, opts = a.Options || {}, labels = a.Labels || {};
  return (
    <div className="details">
      <button className="link" onClick={onBack}>← Back</button>
      <header className="d-head">
        <h2>{data.anonymous ? short(a.Name) : a.Name}</h2>
        <p>{a.Driver} volume{data.anonymous ? " · anonymous (Docker made up its name)" : ""}{data.device ? ` · a folder of the host: ${data.device}` : ""}</p>
      </header>

      <Section title="Overview">
        <KV rows={[
          ["Name", data.anonymous ? a.Name : ""],
          ["Driver", a.Driver],
          ["Created", when(a.CreatedAt)],
          ["Files are in", data.device || a.Mountpoint],
          ["Docker's mount point", data.device ? a.Mountpoint : ""],
          ["Saved labs that use it", data.labs],
        ]} />
        <p className="hint">{data.device
          ? "The files live in that folder of the Docker host; deleting the volume leaves the folder and its files."
          : "The files live in Docker's data folder on the host, readable by root (sudo). Deleting the volume deletes them."}</p>
      </Section>

      <Section title={`Containers (${data.containers.length})`}>
        <Table head={["Container", "State", "Mounted at", "Access"]}
          rows={data.containers.map((c) => [
            <button className="link" onClick={() => onContainer(c.id)}>{c.name}</button>,
            c.state, <code>{c.target}</code>, c.rw ? "read-write" : "read-only"])}
          empty="No container uses it." />
      </Section>

      <Section title="Files">
        <VolumeFiles name={a.Name} />
      </Section>

      {Object.keys(opts).length > 0 && <Section title="Options"><KV rows={Object.entries(opts).map(([k, v]) => [k, v])} /></Section>}
      <Section title="Labels"><KV rows={Object.entries(labels).map(([k, v]) => [k, v])} /></Section>
      <Raw data={a} />
    </div>
  );
}

export function VolumeForm({ onBack, onCreated }) {
  const [f, setF] = useState({ name: "", where: "docker", device: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k) => (e) => { setError(""); setF({ ...f, [k]: e.target.value }); };
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError("");
    try { onCreated(await api.vmCreateVolume({ name: f.name, device: f.where === "folder" ? f.device : "" })); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  return (
    <form className="details net-form" onSubmit={submit}>
      <button type="button" className="link" onClick={onBack}>← Back</button>
      <header className="d-head"><h2>New volume</h2></header>
      <label className="field">Name<input value={f.name} onChange={set("name")} placeholder="e.g. web-site" autoFocus spellCheck={false} /></label>
      <div className="seg" role="radiogroup" aria-label="Where the files live">
        <label className={f.where === "docker" ? "is-on" : ""}><input type="radio" name="where" value="docker" checked={f.where === "docker"} onChange={set("where")} /> In Docker's storage</label>
        <label className={f.where === "folder" ? "is-on" : ""}><input type="radio" name="where" value="folder" checked={f.where === "folder"} onChange={set("where")} /> In a folder of the host</label>
      </div>
      {f.where === "docker"
        ? <p className="hint">The usual kind: Docker keeps the files in its data folder on the host, and deletes them with the volume.</p>
        : <>
            <label className="field">Folder on the Docker host<input value={f.device} onChange={set("device")} placeholder="/srv/labs/site" spellCheck={false} /></label>
            <p className="hint">The folder must already exist. Containers then see its files, and they stay there when the volume is deleted. In a lab, a container's Volumes can also name a host folder directly; a volume gives it a name you can share between labs.</p>
          </>}
      {error && <p className="conn-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="submit" className="primary" disabled={busy || !f.name.trim() || (f.where === "folder" && !f.device.trim())}>
          {busy ? "Creating…" : "Create volume"}</button>
        <button type="button" onClick={onBack} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}
