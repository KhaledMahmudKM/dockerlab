import { useCallback, useEffect, useMemo, useState } from "react";
import ManagePanel from "./Manage.jsx";
import BuildPanel from "./Build.jsx";
import { ChoiceDialog } from "./Running.jsx";

/** Manage or Build in a browser window of its own. What it does is reported to the
 *  main DockerLab window over a BroadcastChannel: messages for its Messages pane,
 *  "refresh your lists", "open this lab". */
export default function Standalone({ tool }) {
  const q = new URLSearchParams(location.search);
  const ch = useMemo(() => (typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("dockerlab") : null), []);
  useEffect(() => () => ch?.close(), [ch]);
  const post = (m) => ch?.postMessage(m);
  const [tab, setTab] = useState(q.get("tab") || "containers");
  const [dialog, setDialog] = useState(null);
  const ask = (d) => new Promise((resolve) => setDialog({ ...d, resolve }));
  const answer = useCallback((v) => setDialog((d) => { d?.resolve(v); return null; }), []);
  useEffect(() => { document.title = tool === "build" ? "Build an image · DockerLab" : "Docker host · DockerLab"; }, [tool]);

  return (
    <div className="standalone">
      <header className="standalone-bar">
        <b>DockerLab</b><span>{tool === "build" ? "Build an image" : "Docker host"}</span>
        <small>Messages go to the main DockerLab window.</small>
      </header>
      {tool === "build"
        ? <BuildPanel standalone onBuilt={(tag) => post({ type: "built", tag })} />
        : <ManagePanel standalone tab={tab} setTab={setTab} ask={ask} currentLab={q.get("lab") || null}
            say={(kind, text, list) => post({ type: "say", kind, text, list })}
            onChanged={() => post({ type: "changed" })}
            onOpenLab={(lab) => post({ type: "open-lab", lab })} />}
      <ChoiceDialog dialog={dialog} answer={answer} />
    </div>
  );
}
