import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";

const label = (r) => (r.mode === "local" ? "Docker on this computer" : `${r.user || "gns3"}@${r.host}${Number(r.port) && Number(r.port) !== 22 ? `:${r.port}` : ""}`);

/**
 * Choose the Docker host. Connecting may need one or two confirmations first:
 * trusting the host's SSH key (first connection), and the user's password once, so
 * DockerLab can install an SSH key (and a sudo rule for capture) on the host.
 */
export default function ConnectDialog({ open, conn, onClose, onConnected, onDisconnect, beforeSwitch }) {
  const saved = conn?.saved ?? {};
  const [form, setForm] = useState({ mode: "ssh", host: "", user: "gns3", port: 22, auto_connect: true });
  const [step, setStep] = useState({ name: "form" });     // form | hostkey | hostkey_changed | password
  const [password, setPassword] = useState("");
  const [sudoRule, setSudoRule] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const first = useRef(null);

  useEffect(() => {
    if (!open) return;
    setForm({ mode: saved.mode || "ssh", host: saved.host || "", user: saved.user || "gns3",
              port: saved.port || 22, auto_connect: saved.auto_connect ?? true });
    setStep({ name: "form" }); setPassword(""); setError(""); setBusy(false);
    setTimeout(() => first.current?.focus(), 0);
  }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;
  const set = (k) => (e) => { setError(""); setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value })); };
  const where = form.mode === "local" ? "this computer" : form.host.trim();

  const attempt = async (extra = {}) => {
    setError(""); setBusy(true);
    try {
      if (!extra.trust && !extra.password && !(await beforeSwitch())) { setBusy(false); return; }
      const r = await api.connect({ ...form, port: Number(form.port) || 22, sudo_rule: sudoRule, ...extra });
      if (r.need) {
        setStep({ name: r.need, ...r, password: extra.password });
        if (r.need === "password") setTimeout(() => first.current?.focus(), 0);
      } else {
        await onConnected(r, form);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e) => {
    e.preventDefault();
    if (busy) return;
    if (step.name === "form") attempt();
    else if (step.name === "hostkey" || step.name === "hostkey_changed")
      attempt({ trust: step.fingerprint, ...(step.password ? { password: step.password } : {}) });
    else if (step.name === "password" && password) attempt({ password, ...(step.trust ? { trust: step.trust } : {}) });
  };

  const back = () => { setStep({ name: "form" }); setError(""); };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
      onKeyDown={(e) => e.key === "Escape" && !busy && onClose()}>
      <form className="dialog connect" role="dialog" aria-modal="true" aria-labelledby="conn-title" onSubmit={submit}>
        {step.name === "form" && (
          <>
            <h2 id="conn-title">Connect to a Docker host</h2>
            <p>The machine that runs the lab containers, such as the GNS3 VM. DockerLab works with it over SSH.</p>
            <div className="seg" role="radiogroup" aria-label="Where Docker runs">
              <label className={form.mode === "ssh" ? "is-on" : ""}>
                <input type="radio" name="mode" value="ssh" checked={form.mode === "ssh"} onChange={set("mode")} /> Over SSH
              </label>
              <label className={form.mode === "local" ? "is-on" : ""}>
                <input type="radio" name="mode" value="local" checked={form.mode === "local"} onChange={set("mode")} /> On this computer
              </label>
            </div>
            {form.mode === "ssh" ? (
              <div className="conn-grid">
                <label className="field">Address
                  <input ref={first} value={form.host} onChange={set("host")} placeholder="192.168.56.103" spellCheck={false} />
                </label>
                <label className="field">User
                  <input value={form.user} onChange={set("user")} spellCheck={false} />
                </label>
                <label className="field">SSH port
                  <input value={form.port} onChange={set("port")} inputMode="numeric" />
                </label>
              </div>
            ) : (
              <p className="hint">Uses Docker on the computer DockerLab runs on, e.g. Docker Desktop or a Linux PC with Docker.</p>
            )}
            {(conn?.recent ?? []).length > 0 && (
              <div className="recent">
                <span>Recent:</span>
                {conn.recent.map((r) => (
                  <button type="button" key={label(r)} className="chip"
                    onClick={() => setForm((f) => ({ ...f, mode: r.mode || "ssh", host: r.host || "", user: r.user || "gns3", port: r.port || 22 }))}>
                    {label(r)}
                  </button>
                ))}
              </div>
            )}
            <label className="toggle">
              <input type="checkbox" checked={form.auto_connect} onChange={set("auto_connect")} />
              <span>Connect to it automatically when DockerLab starts</span>
            </label>
            {conn?.source === "env" && (
              <p className="hint">DOCKER_HOST is set in DockerLab's environment, so that host is used at every start.</p>
            )}
          </>
        )}

        {(step.name === "hostkey" || step.name === "hostkey_changed") && (
          <>
            <h2 id="conn-title">{step.name === "hostkey" ? `First connection to ${where}` : `${where} has a new SSH key`}</h2>
            {step.name === "hostkey"
              ? <p>Check that this is your Docker host's key, then trust it. DockerLab remembers it, so you're asked only once.</p>
              : <p className="warn-text">Its key differs from the one saved for it. That's expected after re-importing or reinstalling the VM;
                  otherwise, something may be intercepting the connection. Replace the saved key only if you know why it changed.</p>}
            <div className="fingerprint"><small>{step.key_type}</small><code>{step.fingerprint}</code></div>
            <p className="hint">To compare, run <code>ssh-keygen -lf /etc/ssh/ssh_host_{(step.key_type || "").replace("ssh-", "").replace("ecdsa-sha2-nistp256", "ecdsa")}_key.pub</code> on the host.</p>
          </>
        )}

        {step.name === "password" && (
          <>
            <h2 id="conn-title">Set up {form.user || "gns3"}@{where}</h2>
            <p>{step.reason === "docker"
              ? `${form.user} isn't allowed to use Docker there. Enter ${form.user}'s password once, and DockerLab adds it to the docker group.`
              : `DockerLab logs in with an SSH key, and ${form.user} doesn't have yours yet. Enter ${form.user}'s password once to install it; you won't be asked again.`}</p>
            <label className="field">Password for {form.user}
              <input ref={first} type="password" value={password} onChange={(e) => { setPassword(e.target.value); setError(""); }} autoComplete="off" />
            </label>
            <p className="hint">On the GNS3 VM, the password is <code>gns3</code> unless you changed it. It's used once and not stored.</p>
            <label className="toggle">
              <input type="checkbox" checked={sudoRule} onChange={(e) => setSudoRule(e.target.checked)} />
              <span>Also allow packet capture
                <small>Adds a sudo rule so tcpdump and iptables run without a password (needed for Capture).</small></span>
            </label>
          </>
        )}

        {error && <p className="conn-error" role="alert">{error}</p>}
        {busy && <p className="conn-busy"><span className="spinner" /> {step.name === "password" ? "Setting up and connecting…" : "Connecting…"}</p>}

        <div className="dialog-actions">
          {step.name === "form" && conn?.active && (
            <button type="button" className="link left" onClick={onDisconnect} disabled={busy}>Disconnect</button>
          )}
          <button type="submit" className={step.name === "hostkey_changed" ? "danger" : "primary"}
            disabled={busy || (step.name === "form" && form.mode === "ssh" && !form.host.trim()) || (step.name === "password" && !password)}>
            {step.name === "form" ? "Connect"
              : step.name === "hostkey" ? "Trust and connect"
              : step.name === "hostkey_changed" ? "Replace the key and connect" : "Set up and connect"}
          </button>
          {step.name === "form"
            ? <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
            : <button type="button" onClick={back} disabled={busy}>Back</button>}
        </div>
      </form>
    </div>
  );
}
