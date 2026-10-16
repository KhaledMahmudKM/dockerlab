import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";

/** "Build an image": pick a template, adjust the Dockerfile, build on the engine.
 *  Shown as a panel over the topology, or in a window of its own (standalone). */
export default function BuildPanel({ onBuilt, standalone }) {
  const [templates, setTemplates] = useState([]);
  const [chosen, setChosen] = useState("router");
  const [tag, setTag] = useState("");
  const [dockerfile, setDockerfile] = useState("");
  const [building, setBuilding] = useState(false);
  const [result, setResult] = useState(null);          // { ok, error, log, tag }
  const nameRef = useRef(null);

  useEffect(() => {
    api.templates().then((ts) => {
      setTemplates(ts);
      const t = ts.find((x) => x.id === chosen) ?? ts[0];
      if (t && !dockerfile) { setChosen(t.id); setTag(t.tag); setDockerfile(t.dockerfile); }
    }).catch((e) => setResult({ ok: false, error: e.message, log: "" }));
    setTimeout(() => nameRef.current?.focus(), 0);
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (t) => { setChosen(t.id); setTag(t.tag); setDockerfile(t.dockerfile); setResult(null); };
  const build = async () => {
    setBuilding(true); setResult(null);
    try {
      const r = await api.build(tag, dockerfile);
      setResult(r);
      if (r.ok) onBuilt(r.tag);
    } catch (e) {
      setResult({ ok: false, error: e.message, log: "" });
    } finally {
      setBuilding(false);
    }
  };

  return (
    <div className={`tool build ${standalone ? "is-page" : ""}`} aria-labelledby="build-title">
      <div className="build-inner">
        <h2 id="build-title">Build an image</h2>
        <p>Packages are installed once, when the image is built, so containers made from it start ready, with no download.</p>

        <div className="tpl-row" role="radiogroup" aria-label="Start from">
          {templates.map((t) => (
            <button key={t.id} role="radio" aria-checked={chosen === t.id}
              className={`tpl ${chosen === t.id ? "is-on" : ""}`} onClick={() => pick(t)} disabled={building}>
              <b>{t.name}</b><small>{t.description}</small>
            </button>
          ))}
        </div>

        <label className="field">Image name
          <input ref={nameRef} value={tag} onChange={(e) => setTag(e.target.value.trim())} disabled={building}
            placeholder="dockerlab/router:latest" spellCheck={false} />
        </label>
        <label className="field">Dockerfile
          <textarea rows={11} wrap="off" value={dockerfile} onChange={(e) => setDockerfile(e.target.value)}
            disabled={building} spellCheck={false} />
        </label>

        {building && <p className="hint">Building in the VM. Downloading packages can take a minute.</p>}
        {result?.ok && (
          <div className="log ok">
            <b>Built {result.tag}.</b> It's on the shelf: drag it onto the topology. Rebuilding with the same name replaces it; Redeploy labs to use the new version.
            {result.log && <details><summary>Build log</summary><pre>{result.log}</pre></details>}
          </div>
        )}
        {result && !result.ok && (
          <div className="log err">
            <b>Build failed: {result.error}</b>
            {result.log && <pre>{result.log}</pre>}
          </div>
        )}

        <div className="dialog-actions">
          <button className="primary" onClick={build} disabled={building || !tag || !dockerfile.trim()}>
            {building ? "Building…" : "Build"}
          </button>
        </div>
      </div>
    </div>
  );
}
