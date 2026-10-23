import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";

const GB = 1024 ** 3, MB = 1024 ** 2;
const size = (b) => (b >= GB ? `${(b / GB).toFixed(1)} GB` : `${Math.round(b / MB)} MB`);
const level = (pct) => (pct >= 90 ? "high" : pct >= 70 ? "mid" : "ok");

/** Repeat fn every `ms` while the page is visible and `on` is true. */
function usePoll(fn, ms, on) {
  const f = useRef(fn);
  f.current = fn;
  useEffect(() => {
    if (!on) return;
    let live = true;
    const tick = () => { if (live && document.visibilityState === "visible") f.current(); };
    tick();
    const t = setInterval(tick, ms);
    return () => { live = false; clearInterval(t); };
  }, [ms, on]);
}

function Bar({ label, pct, text, title }) {
  return (
    <div className="load-row" title={title}>
      <span className="load-label">{label}</span>
      <span className="load-bar" role="meter" aria-label={label} aria-valuenow={pct ?? 0} aria-valuemin={0} aria-valuemax={100}>
        <span className={`load-fill load-${level(pct ?? 0)}`} style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
      </span>
      <span className="load-text">{text}</span>
    </div>
  );
}

/** CPU and memory of the Docker host, and on request what each container uses. */
export default function HostLoad({ on }) {
  const [load, setLoad] = useState(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(null);

  usePoll(() => api.vmLoad().then((l) => { setLoad(l); setErr(""); }).catch((e) => setErr(e.message)), 5000, on);
  usePoll(() => api.vmLoadContainers().then((r) => setRows(r.containers)).catch(() => {}), 10000, on && open);
  useEffect(() => { if (!on) { setLoad(null); setRows(null); } }, [on]);

  if (!on) return null;
  if (err) return <p className="load-note">Load: {err}</p>;
  if (!load) return <p className="load-note">Reading the host's load…</p>;
  if (!load.available) return <p className="load-note">{load.reason}</p>;

  const memPct = (100 * load.mem_used) / load.mem_total;
  const cpu = load.cpu_pct;
  return (
    <div className="host-load">
      <Bar label="CPU" pct={cpu}
        text={cpu == null ? "…" : `${Math.round(cpu)}% · ${load.ncpu} CPU${load.ncpu === 1 ? "" : "s"}`}
        title={`All ${load.ncpu} CPUs of the Docker host together. Load average ${load.load1} / ${load.load5} / ${load.load15} (1, 5, 15 min): `
          + `above ${load.ncpu}, processes are waiting for a CPU.`} />
      <Bar label="RAM" pct={memPct} text={`${size(load.mem_used)} / ${size(load.mem_total)}`}
        title="Memory in use on the Docker host (not counting what Linux would free from its caches)." />
      {load.swap_used > 32 * MB && (
        <p className="load-warn" title="Swapping makes everything slow: stop a lab, or give the VM more memory.">
          Out of memory: {size(load.swap_used)} swapped to disk</p>
      )}
      <button className="link load-toggle" aria-expanded={open} onClick={() => { setOpen(!open); if (open) setRows(null); }}>
        {open ? "▾" : "▸"} Per container</button>
      {open && (
        rows == null ? <p className="load-note">Measuring…</p>
        : rows.length === 0 ? <p className="load-note">No containers running.</p>
        : <table className="load-table">
            <thead><tr><th>Container</th><th title="100% = one full CPU">CPU</th><th>RAM</th></tr></thead>
            <tbody>
              {rows.slice(0, 12).map((r) => (
                <tr key={r.name} title={r.lab ? `${r.node} in lab ${r.lab}` : `${r.name} (not a DockerLab container)`}>
                  <td>{r.lab ? <>{r.node} <small>{r.lab}</small></> : <i>{r.name}</i>}</td>
                  <td>{r.cpu_pct.toFixed(r.cpu_pct < 10 ? 1 : 0)}%</td>
                  <td>{size(r.mem)}</td>
                </tr>
              ))}
            </tbody>
          </table>
      )}
    </div>
  );
}
