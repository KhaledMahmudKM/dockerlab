import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background, BackgroundVariant, ConnectionMode, Controls, ReactFlow,
  addEdge, useEdgesState, useNodesInitialized, useNodesState, useReactFlow,
} from "@xyflow/react";
import { api, engineHost, openConsole, openVmConsole } from "./api.js";
import { CableEdge, ContainerNode, NoteNode, RuntimeContext, SwitchNode, cableSlots } from "./canvas.jsx";
import Inspector from "./Inspector.jsx";
import { ChoiceDialog, NameDialog, RunningPanel, sameLab } from "./Running.jsx";
import BuildPanel from "./Build.jsx";
import ManagePanel from "./Manage.jsx";
import { diagramPng, diagramSvg, download } from "./diagram.js";
import { MessagePane, useMessages } from "./Messages.jsx";
import { Splitter, ViewMenu, useLayout } from "./Layout.jsx";
import { AppearanceMenu, appearanceVars, useAppearance } from "./Appearance.jsx";
import { pendingChanges } from "./pending.js";
import ConnectDialog from "./Connect.jsx";

const nodeTypes = { container: ContainerNode, switch: SwitchNode, note: NoteNode };
const edgeTypes = { cable: CableEdge };
const uid = (p) => p + Math.random().toString(36).slice(2, 8);
const DND = "application/dockerlab-image";
const DND_SWITCH = "application/dockerlab-switch";
const DND_NOTE = "application/dockerlab-note";
const UNTITLED = "untitled";
class Cancelled extends Error {}
const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;


function baseName(tag) {
  return tag.split("/").pop().split(":")[0].replace(/[^a-zA-Z0-9_.-]/g, "") || "node";
}

function toTopology(name, nodes, edges, description = "") {
  const containers = nodes.filter((n) => n.type === "container");
  const switches = nodes.filter((n) => n.type === "switch");
  const notes = nodes.filter((n) => n.type === "note");
  return {
    name,
    description,
    notes: notes.map(({ id, position, width, height, measured, data }) => ({
      id, x: Math.round(position.x), y: Math.round(position.y),
      w: Math.round(width ?? measured?.width ?? 200), h: Math.round(height ?? measured?.height ?? 100),
      text: data.text ?? "", color: data.color ?? "yellow",
    })),
    switches: switches.map(({ id, position, data }) => ({
      id, x: Math.round(position.x), y: Math.round(position.y), name: data.name, subnet: data.subnet ?? "",
    })),
    nodes: containers.map(({ id, position, data }) => ({
      id, x: Math.round(position.x), y: Math.round(position.y),
      name: data.name, image: data.image, command: data.command,
      ports: data.ports, volumes: data.volumes, env: data.env,
      internet: data.internet, router: data.router, privileged: data.privileged,
      startup: data.startup ?? "", interfaces: data.interfaces || 0,
      ifname_first: data.ifname_first ?? "", nat_ifname: data.nat_ifname ?? "",
      set_addresses: data.set_addresses !== false, sysctls: data.sysctls ?? [],
    })),
    links: edges.map((e) => ({
      id: e.id, source: e.source, target: e.target, subnet: e.data?.subnet ?? "",
      source_ip: e.data?.source_ip ?? "", target_ip: e.data?.target_ip ?? "",
    })),
  };
}

function fromTopology(t) {
  return {
    nodes: [
      ...(t.notes ?? []).map(({ id, x, y, w, h, ...data }) => ({ id, type: "note", position: { x, y }, width: w, height: h, data })),
      ...t.nodes.map(({ id, x, y, ...data }) => ({ id, type: "container", position: { x, y }, data })),
      ...(t.switches ?? []).map(({ id, x, y, ...data }) => ({ id, type: "switch", position: { x, y }, data })),
    ],
    edges: t.links.map(({ id, source, target, ...data }) => ({ id, source, target, type: "cable", data })),
  };
}

export default function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [labName, setLabName] = useState("");          // "" = untitled, not saved yet
  const [description, setDescription] = useState("");
  const labImages = useRef({});                            // Dockerfiles carried by the lab file
  const [savedName, setSavedName] = useState(null);   // name the canvas was last saved/loaded as
  const [labs, setLabs] = useState([]);
  const [examples, setExamples] = useState([]);       // example labs that come with DockerLab
  const [about, setAbout] = useState(null);           // { version, labs_dir, migrated }
  const [images, setImages] = useState([]);
  const [engine, setEngine] = useState({ state: "checking" });
  const [runtime, setRuntime] = useState({ nodes: {}, links: {} });
  const [busy, setBusy] = useState("");
  const { log, say, clear: clearLog } = useMessages();  // the message pane under the bench
  const { layout, toggle: togglePane, size: setPaneSize, reset: resetLayout } = useLayout();
  const [appearance, setAppearance] = useAppearance();
  const show = layout.show;
  // an error logged while the Messages pane is hidden marks the View button
  const [hiddenErr, setHiddenErr] = useState(false);
  const lastMsg = log.at(-1);
  const mountedAt = useRef(Date.now());
  useEffect(() => {
    if (lastMsg?.kind === "err" && lastMsg.t > mountedAt.current && !show.messages) setHiddenErr(true);
  }, [lastMsg?.id]);
  useEffect(() => { if (show.messages) setHiddenErr(false); }, [show.messages]);
  const [appliedStartup, setAppliedStartup] = useState({});  // node id -> startup commands run since the deploy
  const [startupLogs, setStartupLogs] = useState({});   // node id -> { exit, output }
  const [running, setRunning] = useState(null);         // { labs: [...], other: [...] } on the engine
  const [runningOpen, setRunningOpen] = useState(false);
  const [dialog, setDialog] = useState(null);
  const ask = (d) => new Promise((resolve) => setDialog({ ...d, resolve }));
  const [nameReq, setNameReq] = useState(null);
  const askName = (d) => new Promise((resolve) => setNameReq({ ...d, resolve }));
  const closeName = useCallback((v) => setNameReq((d) => { d?.resolve(v); return null; }), []);
  const answer = useCallback((v) => setDialog((d) => { d?.resolve(v); return null; }), []);
  const [filter, setFilter] = useState("");
  const [buildOpen, setBuildOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [manageTab, setManageTab] = useState(null);       // null = closed, else "containers" | "images" | "networks"
  const [manageRequest, setManageRequest] = useState(null);   // { view, nonce }: open Manage at a details page
  const [activeTool, setActiveTool] = useState("topology");   // what the centre shows: topology | manage | build
  const openManage = (tab, view) => {
    setManageTab(tab); setActiveTool("manage");
    if (view) setManageRequest({ view, nonce: Date.now() });
  };
  const openBuild = () => { setBuildOpen(true); setActiveTool("build"); };
  const closeTool = (id) => {
    if (id === "manage") setManageTab(null); else setBuildOpen(false);
    setActiveTool("topology");
  };
  /** A tool in a browser window of its own; it reports back over a BroadcastChannel. */
  const popOut = (id) => {
    const q = new URLSearchParams({ tool: id, tab: manageTab ?? "containers", lab: savedName ?? "" });
    window.open(`${location.pathname}?${q}`, `dockerlab-${id}`, "width=1180,height=820");
    closeTool(id);
  };
  const importInput = useRef(null);
  const savedSnap = useRef(JSON.stringify(toTopology("", [], [], "")));  // last saved/loaded state
  const { screenToFlowPosition, fitView } = useReactFlow();
  // fit an opened lab in the view, once its boxes have been measured
  const nodesReady = useNodesInitialized();
  const fitPending = useRef(false);
  useEffect(() => {
    if (nodesReady && fitPending.current) { fitPending.current = false; fitView({ maxZoom: 1, padding: 0.06 }); }
  }, [nodesReady, fitView]);


  // ---- engine + images
  const lastEngine = useRef("");             // log connection changes once, not on every poll
  const [conn, setConn] = useState(null);     // which Docker host: GET /api/connection
  const [connectOpen, setConnectOpen] = useState(false);
  const refreshEngine = useCallback(async () => {
    try {
      const s = await api.status();
      setEngine({ state: "up", ...s });
      if (lastEngine.current !== "up") say("info", `Connected to Docker ${s.server_version} on ${engineHost(s.docker_host)}.`);
      lastEngine.current = "up";
      setImages(await api.images());
    } catch (e) {
      if (e.message.startsWith("Not connected")) {          // no Docker host chosen yet
        setEngine({ state: "none" }); setImages([]); lastEngine.current = "none";
        return;
      }
      setEngine({ state: "down", error: e.message });
      if (lastEngine.current !== e.message) say("err", `Can't reach the Docker engine: ${e.message}`);
      lastEngine.current = e.message;
    }
  }, []);
  useEffect(() => {
    api.connection().then(setConn).catch(() => {});   // the user presses Connect…; nothing connects or opens by itself
    refreshEngine(); api.labs().then(setLabs).catch(() => {});
    api.examples().then(setExamples).catch(() => {});
    api.about().then((a) => {
      setAbout(a);
      if (a.migrated?.length) say("info", `Your labs are now kept in ${a.labs_dir}. Copied ${a.migrated.length === 1 ? "one lab" : `${a.migrated.length} labs`} from the old place (backend\\labs): ${a.migrated.join(", ")}.`);
    }).catch(() => {});
  }, [refreshEngine]);

  /** Before switching Docker hosts: labs running on the current one keep running unless stopped. */
  const beforeSwitch = async () => {
    const runningLabs = engine.state === "up" ? (running?.labs ?? []).map((l) => l.lab) : [];
    if (!runningLabs.length) return true;
    const choice = await ask({
      title: `${runningLabs.length === 1 ? runningLabs[0] + " is" : runningLabs.length + " labs are"} running on ${engineHost(engine.docker_host)}`,
      body: "Their containers keep running there after you switch to another Docker host. Stop them first?",
      options: [
        { label: "Stop and switch", value: "stop", kind: "primary" },
        { label: "Keep running", value: "keep" },
        { label: "Cancel", value: "cancel" },
      ],
    });
    if (!choice || choice === "cancel") return false;
    if (choice === "stop") for (const l of runningLabs) await api.stopAll(l).catch(() => {});
    return true;
  };

  /** A new Docker host: everything shown about the old one is stale. */
  const afterSwitch = async (announced = false) => {
    setConn(await api.connection().catch(() => conn));
    resetRuntime(); setRunning(null); lastEngine.current = announced ? "up" : "";
    await refreshEngine();
    refreshRunning();
    if (savedName) setRuntime(await api.state(savedName).catch(() => ({ nodes: {}, links: {} })));
  };
  const onConnected = async (r, form) => {
    say("ok", `Connected to Docker ${r.version} on ${form.mode === "local" ? "this computer" : form.host}.`, r.notes?.length ? r.notes : undefined);
    await afterSwitch(true);                                 // announced here, with the notes: not again by refreshEngine
    setConnectOpen(false);                                   // close once the panes show the new host
  };
  const onDisconnect = async () => {
    if (!(await beforeSwitch())) return;
    await api.disconnect();
    setConnectOpen(false);
    say("info", "Disconnected from the Docker host.");
    await afterSwitch();
  };

  // ---- keep the Docker Host status current (VM shut down, network lost, back again)
  useEffect(() => {
    if (engine.state === "none") return;
    const t = setInterval(() => { if (document.visibilityState === "visible") refreshEngine(); }, 15000);
    return () => clearInterval(t);
  }, [engine.state, refreshEngine]);

  // ---- poll runtime state for the saved lab
  useEffect(() => {
    if (!savedName || engine.state !== "up") return;
    let live = true;
    const tick = () => api.state(savedName).then((s) => live && setRuntime(s)).catch(() => {});
    tick();
    const t = setInterval(tick, 3000);
    return () => { live = false; clearInterval(t); };
  }, [savedName, engine.state]);

  // ---- everything running on the engine (all labs, plus containers outside DockerLab)
  const refreshRunning = useCallback(() => api.running().then(setRunning).catch(() => {}), []);
  useEffect(() => {
    if (engine.state !== "up") return;
    refreshRunning();
    const t = setInterval(refreshRunning, 4000);
    return () => clearInterval(t);
  }, [engine.state, refreshRunning]);

  // ---- canvas editing
  const snap = (ns, es, d) => JSON.stringify(toTopology("", ns, es, d));
  const isDirty = () => snap(nodes, edges, description) !== savedSnap.current;
  const isSwitch = (id) => nodes.find((n) => n.id === id)?.type === "switch";
  const onConnect = (c) => {
    if (c.source === c.target) return;
    for (const id of [c.source, c.target]) {             // a container with a fixed number of interfaces
      const n = nodes.find((x) => x.id === id);
      const limit = n?.type === "container" ? n?.data.interfaces : 0;
      const used = edges.filter((e) => e.source === id || e.target === id).length;
      if (limit && used >= limit) {
        say("err", `${n.data.name} has no free interface (${used} of ${limit} used). Raise its Interfaces setting, then Redeploy.`);
        return;
      }
    }
    if (isSwitch(c.source) && isSwitch(c.target)) {
      say("err", "Switches can't be cabled to each other yet. Put all the containers of a segment on one switch.");
      return;
    }
    const sw = isSwitch(c.source) ? c.source : isSwitch(c.target) ? c.target : null;
    if (sw) {
      const other = sw === c.source ? c.target : c.source;
      if (edges.some((e) => (e.source === sw && e.target === other) || (e.target === sw && e.source === other))) {
        say("err", "That container is already plugged into this switch.");
        return;
      }
    }
    setEdges((es) => addEdge({ ...c, id: uid("l"), type: "cable", data: { subnet: "", source_ip: "", target_ip: "" } }, es));
  };

  const onDrop = useCallback((ev) => {
    ev.preventDefault();
    const pos = screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
    if (ev.dataTransfer.getData(DND_NOTE)) {
      // put it first in the list, so it sits underneath containers and switches
      setNodes((ns) => [{ id: uid("t"), type: "note", position: { x: pos.x - 110, y: pos.y - 45 },
        width: 220, height: 90, data: { text: "", color: "yellow" } }, ...ns]);
      return;
    }
    if (ev.dataTransfer.getData(DND_SWITCH)) {
      setNodes((ns) => {
        let i = 1;
        while (ns.some((n) => n.data.name === `switch${i}`)) i++;
        return [...ns, { id: uid("s"), type: "switch", position: { x: pos.x - 90, y: pos.y - 22 },
                         data: { name: `switch${i}`, subnet: "" } }];
      });
      return;
    }
    const image = ev.dataTransfer.getData(DND);
    if (!image) return;
    setNodes((ns) => {
      const base = baseName(image);
      let i = 1;
      while (ns.some((n) => n.data.name === `${base}-${i}`)) i++;
      return [...ns, {
        id: uid("n"), type: "container", position: { x: pos.x - 80, y: pos.y - 30 },
        data: { name: `${base}-${i}`, image, command: "", ports: [], volumes: [], env: [],
                internet: false, router: false, privileged: false, startup: "", interfaces: 0,
                ifname_first: "", nat_ifname: "", set_addresses: true, sysctls: [] },
      }];
    });
  }, [screenToFlowPosition, setNodes]);

  const updateNode = (id, patch) => { setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n))); };
  const updateEdge = (id, patch) => { setEdges((es) => es.map((e) => (e.id === id ? { ...e, data: { ...e.data, ...patch } } : e))); };

  const selNode = nodes.find((n) => n.selected);
  const selEdge = !selNode && edges.find((e) => e.selected);

  // ---- lab actions
  const run = async (label, fn) => {
    setBusy(label);
    try { await fn(); } catch (e) { if (!(e instanceof Cancelled)) say("err", e.message); } finally { setBusy(""); refreshRunning(); }
  };

  /** The name to save under: asks for one if the lab is untitled, or if the name
   *  belongs to another saved lab (so a new lab never silently overwrites one). */
  const nameToSave = async () => {
    const name = labName.trim();
    const fresh = await api.labs().catch(() => labs);
    const taken = fresh.find((l) => sameLab(l, name) && !sameLab(l, savedName));
    if (name && !taken) return name;
    const chosen = await askName({
      initial: name, labs: fresh, savedName,
      ...(taken ? { title: `${taken} already exists`, body: `Another lab is saved as ${taken}. Save this one under a new name, or replace ${taken}.` } : {}),
    });
    if (!chosen) throw new Cancelled();
    setLabName(chosen);
    return chosen;
  };

  /** Saves the bench; returns the save result and the name it was saved under. */
  const save = async () => {
    const name = await nameToSave();
    const r = await api.saveLab(name, { ...toTopology(name, nodes, edges, description), images: labImages.current });
    savedSnap.current = snap(nodes, edges, description);
    setSavedName(name);
    setLabs(await api.labs());
    return { ...r, name };
  };

  const onSave = () => run("Saving", async () => {
    const r = await save(), labName = r.name;
    if (r.warnings.length) say("err", "Saved, but this lab won't deploy yet:", r.warnings);
    else if (r.local_only?.length) say("ok", `Saved ${labName}. To share it, rebuild ${r.local_only.join(", ")} with Build first: `
      + "it exists only on this VM, without a Dockerfile.");
    else say("ok", `Saved ${labName}.`);
  });

  const keepLogs = (logs) => logs && setStartupLogs((l) => ({ ...l, ...logs }));
  const resetRuntime = () => { setRuntime({ nodes: {}, links: {} }); setStartupLogs({}); setAppliedStartup({}); };
  // startup commands run at every start, so a start uses the bench's, saved or not
  const benchStartup = () => Object.fromEntries(nodes.filter((n) => n.type === "container").map((n) => [n.id, n.data.startup ?? ""]));
  const markApplied = (ids) => {
    const now = benchStartup();
    setAppliedStartup((a) => ({ ...a, ...Object.fromEntries(ids.filter((id) => id in now).map((id) => [id, now[id]])) }));
  };

  const onDeploy = () => run("Deploying", async () => {
    const { name: labName } = await save();
    setStartupLogs({}); setAppliedStartup({});
    const r = await api.deploy(labName);
    keepLogs(r.startup);
    setRuntime(await api.state(labName));
    const nSw = nodes.filter((n) => n.type === "switch").length;
    const nCables = Object.keys(r.networks ?? {}).length - nSw;
    const parts = [count(Object.keys(r.containers ?? {}).length, "container"),
                   ...(nSw ? [count(nSw, "switch").replace("switchs", "switches")] : []),
                   ...(nCables > 0 ? [count(nCables, "cable")] : [])];
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
    const fetched = [...(r.images?.pulled ?? []).map((t) => `pulled ${t}`), ...(r.images?.built ?? []).map((t) => `built ${t}`)];
    if (fetched.length) setImages(await api.images());
    r.ok ? say("ok", `Deployed ${list}.` + (fetched.length ? ` First ${fetched.join(", ")}.` : ""))
         : say("err", "Deploy finished with errors:", r.errors);
    if (r.warnings?.length) say("err", "Deployed, but check this:", r.warnings);
  });

  const onStartAll = () => run("Starting", async () => {
    const stopped = Object.entries(runtime.nodes).filter(([, n]) => n.status !== "running").map(([id]) => id);
    const r = await api.startAll(savedName, benchStartup());
    markApplied(stopped);
    keepLogs(r.startup);
    setRuntime(await api.state(savedName));
    r.errors.length ? say("err", `Started ${count(r.started, "container")}, with errors:`, r.errors)
                    : say("ok", `Started ${count(r.started, "container")}.`);
  });

  const onStopAll = () => run("Stopping", async () => {
    const r = await api.stopAll(savedName);
    setRuntime(await api.state(savedName));
    r.errors.length ? say("err", "Some containers didn't stop:", r.errors) : say("ok", `Stopped ${count(r.stopped, "container")}.`);
  });

  const onDestroy = () => run("Removing", async () => {
    if (!confirm(`Delete all containers and networks of ${savedName}? The lab file is kept, and Deploy recreates them.`)) return;
    const r = await api.destroy(savedName);
    resetRuntime();
    say("ok", `Removed ${count(r.containers.length, "container")} and ${count(r.networks.length, "network")}.`);
  });

  const clearBench = () => {
    setNodes([]); setEdges([]); setSavedName(null); setDescription(""); labImages.current = {};
    resetRuntime(); savedSnap.current = snap([], [], "");
  };

  const onClose = () => run("Closing", async () => {
    if (isDirty() && !confirm("Close without saving your changes?")) return;
    let stopped = 0;
    if (savedName && anyRunning) stopped = (await api.stopAll(savedName)).stopped;
    const closed = labName || UNTITLED;
    clearBench();
    say("ok", stopped ? `Stopped ${count(stopped, "container")} and closed ${closed}.` : `Closed ${closed}.`);
  });

  /** Before switching away: unsaved changes, then offer to stop the running lab. */
  const leaveCurrent = async (target) => {
    if (isDirty() && !confirm("Discard unsaved changes on the bench?")) return false;
    if (savedName && anyRunning && savedName !== target) {
      const choice = await ask({
        title: `${savedName} is still running`,
        body: `Its containers keep running in the VM after you ${target ? `open ${target}` : "start a new lab"}. Stop them first?`,
        options: [
          { label: `Stop ${savedName}`, value: "stop", kind: "primary" },
          { label: "Keep running", value: "keep" },
          { label: "Cancel", value: "cancel" },
        ],
      });
      if (!choice || choice === "cancel") return false;
      if (choice === "stop") await api.stopAll(savedName);
    }
    return true;
  };

  const onOpen = (name) => run("Opening", async () => {
    if (!(await leaveCurrent(name))) return;
    await loadLab(name);
  });

  /** An example: it opens as your own copy, in your labs folder, under the example's name. */
  const onOpenExample = (name) => run("Opening the example", async () => {
    if (!(await leaveCurrent(name))) return;
    let r = await api.copyExample(name);
    if (r.status === 409) {
      const choice = await ask({
        title: `You already have ${name}`,
        body: `Your copy of this example may have your changes. Open it, or start over from the original example (your copy is replaced)?`,
        options: [
          { label: "Open my copy", value: "mine", kind: "primary" },
          { label: "Start over", value: "fresh" },
          { label: "Cancel", value: "cancel" },
        ],
      });
      if (!choice || choice === "cancel") return;
      if (choice === "fresh") r = await api.copyExample(name, true);
    }
    setLabs(await api.labs());
    await loadLab(name);
  });

  const loadLab = async (name) => {
    const t = await api.getLab(name);
    const { nodes: n, edges: e } = fromTopology(t);
    fitPending.current = true;
    setNodes(n); setEdges(e); setLabName(name); setSavedName(name); setDescription(t.description ?? ""); labImages.current = t.images ?? {};
    resetRuntime(); savedSnap.current = snap(n, e, t.description ?? "");
    say("info", `Opened ${name}.`);
    refreshRunning();
  };

  const onNew = () => run("Starting a new lab", async () => {
    if (!(await leaveCurrent(null))) return;
    clearBench(); setLabName("");
    say("info", "Started a new, untitled lab. Save asks for its name.");
    refreshRunning();
  });

  const onImportFile = (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = "";                                  // allow importing the same file again
    if (!file) return;
    run("Importing", async () => {
      const text = await file.text();
      let r = await api.importLab(text);
      if (r.status === 409) {
        const choice = await ask({
          title: `A lab called ${r.data.name} already exists`,
          body: `Import this file as ${r.data.suggest}, or replace your ${r.data.name}?`,
          options: [
            { label: `Import as ${r.data.suggest}`, value: "rename", kind: "primary" },
            { label: `Replace ${r.data.name}`, value: "replace" },
            { label: "Cancel", value: "cancel" },
          ],
        });
        if (!choice || choice === "cancel") return;
        r = await api.importLab(text, choice === "replace" ? { overwrite: true } : { rename: r.data.suggest });
      }
      const name = r.data.imported;
      setLabs(await api.labs());
      if (!(await leaveCurrent(name))) { say("ok", `Imported ${name}. Open it from Open….`); return; }
      const t = await api.getLab(name);
      const { nodes: n, edges: e } = fromTopology(t);
      fitPending.current = true;
      setNodes(n); setEdges(e); setLabName(name); setSavedName(name); setDescription(t.description ?? ""); labImages.current = t.images ?? {};
      resetRuntime(); savedSnap.current = snap(n, e, t.description ?? "");
      const missing = r.data.missing ?? [];
      say("ok", `Imported ${name}.` + (missing.length
        ? ` Deploy will first fetch ${missing.length === 1 ? "an image" : "images"} this VM doesn't have: ${missing.join(", ")}.` : ""),
        r.data.warnings.length ? r.data.warnings : undefined);
    });
  };

  const onExport = (kind) => run("Exporting", async () => {
    setExportOpen(false);
    const r = await save(), labName = r.name;              // export exactly what's on the bench
    const url = kind === "compose" ? api.composeUrl(labName) : api.labFileUrl(labName);
    const a = document.createElement("a"); a.href = url; a.download = ""; document.body.appendChild(a); a.click(); a.remove();
    if (r.local_only?.length) {
      say("err", `Exported ${labName}, but another VM won't be able to get ${r.local_only.length === 1 ? "this image" : "these images"}:`,
        r.local_only.map((t) => `${t} exists only on this VM and the lab has no Dockerfile for it (it was built before DockerLab `
          + "stored Dockerfiles, or outside DockerLab). Rebuild it with Build, then export again."));
    } else say("ok", `Exported ${labName}.`);
  });

  const onExportDiagram = (fmt) => run("Drawing the diagram", async () => {
    setExportOpen(false);
    const { svg, width, height } = await diagramSvg(nodes, edges, runtimeValue);
    const name = labName || UNTITLED;
    if (fmt === "svg") download(new Blob([svg], { type: "image/svg+xml" }), `${name}.svg`);
    else download(await diagramPng(svg, width, height, 2), `${name}.png`);
    say("ok", `Exported the diagram of ${name} as ${fmt.toUpperCase()}.`);
  });

  const onStopLab = (lab) => run(`Stopping ${lab}`, async () => {
    const r = await api.stopAll(lab);
    if (lab === savedName) setRuntime(await api.state(lab));
    await refreshRunning();
    r.errors.length ? say("err", `Some containers of ${lab} didn't stop:`, r.errors)
                    : say("ok", `Stopped ${count(r.stopped, "container")} of ${lab}.`);
  });

  const onNodeAction = (id, action) => run("Working", async () => {
    const r = await api.nodeAction(savedName, id, action, benchStartup());
    if (action !== "stop") markApplied([id]);
    keepLogs(r.startup);
    setRuntime(await api.state(savedName));
    const name = nodes.find((n) => n.id === id)?.data.name ?? id;
    const done = { start: "Started", stop: "Stopped", restart: "Restarted" }[action] ?? action;
    say("ok", `${done} ${name}.`);
  });

  const onConsole = (node) => {
    const rt = runtime.nodes[node.id];
    if (rt?.status === "running") openConsole(savedName, node.id, node.data.name);
    else say("err", rt ? `${node.data.name} is stopped. Start it to open a console.` : "Deploy the lab to open consoles.");
  };

  const onCapture = (linkId) => run("Opening Wireshark", async () => {
    const r = await api.capture(savedName, linkId);
    say("ok", `Wireshark is opening with a live capture of ${r.port_of}'s port on this cable.`);
  });

  // ---- Manage and Build, here or in windows of their own
  const onHostChanged = async () => {
    setImages(await api.images().catch(() => images)); setLabs(await api.labs().catch(() => labs)); refreshRunning();
    if (savedName) setRuntime(await api.state(savedName).catch(() => runtime));
  };
  const onBuilt = async (tag) => {
    setImages(await api.images().catch(() => images)); setFilter("");
    say("ok", `Built ${tag}. Drag it from the shelf onto the topology.`);
  };
  const fromWindows = useRef(null);
  fromWindows.current = (m) => {
    if (m.type === "say") say(m.kind, m.text, m.list);
    else if (m.type === "changed") onHostChanged();
    else if (m.type === "built") onBuilt(m.tag);
    else if (m.type === "open-lab") { window.focus(); setActiveTool("topology"); onOpen(m.lab); }
  };
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel("dockerlab");
    ch.onmessage = (e) => fromWindows.current?.(e.data);
    return () => ch.close();
  }, []);

  const shown = images.filter((i) => i.tag.toLowerCase().includes(filter.toLowerCase()));
  const deployedCount = Object.keys(runtime.nodes).length;
  const containerCount = nodes.filter((n) => n.type === "container").length;
  const anyRunning = Object.values(runtime.nodes).some((n) => n.status === "running");
  const engineUp = engine.state === "up";
  // label each container's networks by the node at the other end of the cable
  // changes on the bench that the running lab doesn't have yet
  const deployedTopo = runtime.deployed ?? null;
  const pending = useMemo(() => pendingChanges(toTopology("", nodes, edges), deployedTopo, appliedStartup),
                          [nodes, edges, deployedTopo, appliedStartup]);
  const pendingOnce = useRef(false);                    // say it once each time the bench drifts from the deploy
  useEffect(() => {
    if (pending.any && !pendingOnce.current)
      say("info", "This lab is deployed, so changes on the bench reach the running containers only when you Redeploy.");
    pendingOnce.current = pending.any;
  }, [pending.any]);

  const runtimeValue = useMemo(() => {
    const names = Object.fromEntries(nodes.map((n) => [n.id, n.data.name]));
    const netLabels = {};
    for (const e of edges) {
      const net = runtime.links[e.id]?.network;
      if (!net) continue;
      (netLabels[e.source] ??= {})[net] = names[e.target] ?? "?";
      (netLabels[e.target] ??= {})[net] = names[e.source] ?? "?";
    }
    // a switch's ports: one per cable, lit when that container is running
    const ports = {};
    for (const e of edges) {
      for (const [sw, other] of [[e.source, e.target], [e.target, e.source]]) {
        if (isSwitch(sw)) (ports[sw] ??= []).push({ name: names[other], running: runtime.nodes[other]?.status === "running" });
      }
    }
    const used = {};
    for (const e of edges) for (const id of [e.source, e.target]) used[id] = (used[id] ?? 0) + 1;
    return { ...runtime, netLabels, ports, used, slots: cableSlots(nodes, edges), updateNode,
             deployed: Object.keys(runtime.nodes).length > 0, deployedTopo, pending, appearance };
  }, [runtime, nodes, edges, pending, appearance]);

  return (
    <RuntimeContext.Provider value={runtimeValue}>
      <div className="app" style={appearanceVars(appearance)}>
        <header className="bar">
          <div className="brand" title={about ? `DockerLab ${about.version}\nYour labs: ${about.labs_dir}` : "DockerLab"}>
            DockerLab{about && <small className="version">{about.version}</small>}
          </div>
          <div className="lab-picker">
            <input aria-label="Lab name" value={labName} placeholder={UNTITLED}
              onChange={(e) => { setLabName(e.target.value.replace(/[^a-zA-Z0-9_.-]/g, "")); }} />
            <select aria-label="Open a saved lab" value=""
              onChange={(e) => { const v = e.target.value; if (v.startsWith("example:")) onOpenExample(v.slice(8)); else if (v) onOpen(v); }}>
              <option value="">Open…</option>
              {labs.length > 0 && <optgroup label="Your labs">{labs.map((l) => <option key={l} value={l}>{l}</option>)}</optgroup>}
              {examples.length > 0 && (
                <optgroup label="Examples (open as your own copy)">
                  {examples.map((x) => <option key={x.name} value={`example:${x.name}`} title={x.summary}>{x.name}</option>)}
                </optgroup>
              )}
            </select>
            <button onClick={onNew}>New</button>
            <button onClick={() => importInput.current?.click()} disabled={!!busy}
              title="Add a lab from a shared .json lab file">Import</button>
            <input ref={importInput} type="file" accept=".json,application/json" hidden onChange={onImportFile} />
            <button onClick={onClose} disabled={!!busy || (nodes.length === 0 && !savedName)}
              title="Stops this lab's containers and clears the bench">Close</button>
          </div>
          <div className="actions">
            <button onClick={onSave} disabled={!!busy}>Save</button>
            <div className="menu">
              <button onClick={() => setExportOpen(!exportOpen)} disabled={!!busy || nodes.length === 0}
                aria-expanded={exportOpen}>Export</button>
              {exportOpen && (
                <div className="menu-pop" role="menu" onMouseLeave={() => setExportOpen(false)}>
                  <button role="menuitem" onClick={() => onExport("lab")}>
                    <b>Lab file</b><small>For another DockerLab. Includes the Dockerfiles of images built here.</small>
                  </button>
                  <button role="menuitem" onClick={() => onExport("compose")}>
                    <b>Docker Compose</b><small>Runs the lab without DockerLab. No bench layout or switches view.</small>
                  </button>
                  <div className="menu-sep" role="separator" />
                  <button role="menuitem" onClick={() => onExportDiagram("svg")}>
                    <b>Diagram as SVG</b><small>Vector drawing of the bench, for documents and slides.</small>
                  </button>
                  <button role="menuitem" onClick={() => onExportDiagram("png")}>
                    <b>Diagram as PNG</b><small>Picture of the bench at double resolution.</small>
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="actions">
            <button className={`primary ${pending.any ? "attention" : ""}`} onClick={onDeploy} disabled={!!busy || !engineUp || containerCount === 0}
              title={pending.any ? "Apply your changes: recreate every container and cable" : "Create every container and cable from scratch"}>
              {deployedCount ? "Redeploy" : "Deploy"}
            </button>
            {anyRunning
              ? <button onClick={onStopAll} disabled={!!busy || !engineUp}>Stop all</button>
              : <button onClick={onStartAll} disabled={!!busy || !engineUp || !deployedCount}>Start all</button>}
            <button className="danger" onClick={onDestroy} disabled={!!busy || !engineUp || !deployedCount}>Remove containers</button>
          </div>
          <RunningPanel running={running} open={runningOpen} setOpen={setRunningOpen}
            currentLab={savedName} busy={busy}
            onStop={onStopLab} onOpenLab={(l) => { setRunningOpen(false); onOpen(l); }}
            onManage={() => { setRunningOpen(false); openManage("containers"); }} />
          {!show.messages && busy && <span className="msg-busy bar-busy" role="status"><span className="spinner" />{busy}…</span>}
          <ViewMenu layout={layout} toggle={togglePane} reset={resetLayout} alert={hiddenErr} />
          <AppearanceMenu appearance={appearance} setAppearance={setAppearance} />
        </header>

        <div className="body">

        {(show.shelf || show.host) && <>
        <aside className="left" style={{ width: layout.left }}>
          {show.host && <div className={`host-pane ${show.shelf ? "" : "is-alone"}`}>
          <h2>Docker Host</h2>
          <p className={`engine engine-${engine.state}`} role="status"
              title={engine.error || (engine.docker_host ? `DockerLab works with Docker at ${engine.docker_host}` : "")}>
              <span className="engine-text">{engine.state === "up" ? `Docker ${engine.server_version} on ${engineHost(engine.docker_host)}`
                : engine.state === "down" ? `Can't reach ${conn?.active ? engineHost(conn.active === "local" ? "local socket" : conn.active) : "the Docker host"}`
                : engine.state === "none" ? "Not connected" : "Connecting…"}</span>
            </p>
          <div className="host-actions">
            <button className={`mini ${engine.state === "none" ? "primary" : ""}`} onClick={() => setConnectOpen(true)}
              title={engine.state === "none" ? "Choose the Docker host" : "Connect to another Docker host, or disconnect"}>
              {engine.state === "none" ? "Connect…" : "Change…"}</button>
            {engine.state === "down" && (
              <button className="mini" onClick={refreshEngine} title="Try to reach the Docker host again">Retry</button>
            )}
            {engine.state === "up" && engine.vm && (
              <button className="mini vm-console" onClick={() => openVmConsole(engine.vm)}
                title={`Open a terminal on the Docker host, ${engine.vm}`}>Console</button>
            )}
          </div>
          </div>}
          {show.shelf && <div className="shelf">
          <h2>Add</h2>
          <ul className="images devices">
            <li draggable title="A shared segment: every container cabled to it is on one subnet"
              onDragStart={(e) => { e.dataTransfer.setData(DND_SWITCH, "1"); e.dataTransfer.effectAllowed = "copy"; }}>
              <span className="img-tag">Switch</span><span className="img-size">shared segment</span>
            </li>
            <li draggable title="A text note on the bench, for labels and instructions"
              onDragStart={(e) => { e.dataTransfer.setData(DND_NOTE, "1"); e.dataTransfer.effectAllowed = "copy"; }}>
              <span className="img-tag">Note</span><span className="img-size">text on the bench</span>
            </li>
          </ul>
          <div className="shelf-head">
            <h2>Images</h2>
            <div className="row">
              <button className="mini" onClick={() => openManage("images")} disabled={engine.state !== "up"}
                title="Pull, see and delete the Docker host's images and containers">Manage</button>
              <button className="mini" onClick={openBuild} disabled={engine.state !== "up"}
                title="Build an image with tools preinstalled, e.g. a router">Build</button>
            </div>
          </div>
          <input className="search" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <ul className="images">
            {shown.map((i) => (
              <li key={i.tag} draggable title="Drag onto the topology. Double-click for details."
                onDoubleClick={() => openManage("images", { kind: "image", id: i.tag })}
                onDragStart={(e) => { e.dataTransfer.setData(DND, i.tag); e.dataTransfer.effectAllowed = "copy"; }}>
                <span className="img-tag">{i.tag}</span>
                <span className="img-size">{i.size_mb} MB</span>
              </li>
            ))}
            {engine.state === "up" && shown.length === 0 && (
              <li className="empty">{images.length ? "No image matches."
                : <>No images on the Docker host yet. <button className="link" onClick={() => openManage("images")}>Pull one</button> in Manage.</>}</li>
            )}
            {engine.state === "down" && <li className="empty">{engine.error}</li>}
            {engine.state === "none" && <li className="empty">Connect to a Docker host to see its images.</li>}
          </ul>
          </div>}
        </aside>
        <Splitter dir="v" grow="left" value={layout.left} onChange={(v) => setPaneSize("left", v)}
          min={180} max={() => Math.min(520, window.innerWidth / 3)} />
        </>}

        <div className="center">
        {pending.any && (
          <div className="pending-bar" role="status">
            <div className="pending-text">
              <b>Not applied yet.</b> The running lab still has the deployed settings; Redeploy to apply your changes.
              <ul>{pending.lines.map((l) => <li key={l}>{l}</li>)}</ul>
            </div>
            <button className="primary" onClick={onDeploy} disabled={!!busy || !engineUp}>Redeploy</button>
          </div>
        )}
        {(manageTab || buildOpen) && (
          <div className="tool-tabs" role="tablist">
            <button role="tab" aria-selected={activeTool === "topology"} className={activeTool === "topology" ? "is-on" : ""}
              onClick={() => setActiveTool("topology")}>Topology</button>
            {[["manage", manageTab, "Docker host"], ["build", buildOpen, "Build an image"]].filter(([, open]) => open).map(([id, , label]) => (
              <span key={id} className={`tool-tab ${activeTool === id ? "is-on" : ""}`}>
                <button role="tab" aria-selected={activeTool === id} onClick={() => setActiveTool(id)}>{label}</button>
                <button className="icon" aria-label={`Close ${label}`} title="Close" onClick={() => closeTool(id)}>×</button>
              </span>
            ))}
            {activeTool !== "topology" && (
              <button className="link pop-out" onClick={() => popOut(activeTool)} title="Open it in a window of its own, e.g. on another screen">
                Open in a new window ↗</button>
            )}
          </div>
        )}
        <main className="bench" onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
          onDrop={(e) => activeTool === "topology" ? onDrop(e) : e.preventDefault()}>
          <ReactFlow
            nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
            onConnect={onConnect} connectionMode={ConnectionMode.Loose}
            onNodeDoubleClick={(_, n) => n.type === "container" && onConsole(n)}
            connectionLineStyle={{ stroke: "var(--ink)", strokeWidth: 3, strokeDasharray: "6 5" }}
            deleteKeyCode={["Delete", "Backspace"]} fitView fitViewOptions={{ maxZoom: 1 }}
            proOptions={{ hideAttribution: true }}
          >
            {appearance.grid && <Background variant={BackgroundVariant.Dots} gap={22} size={1.6} color="var(--grid)" />}
            <Controls showInteractive={false} position="bottom-right" />
          </ReactFlow>
          {manageTab && (
            <div className="tool-layer" hidden={activeTool !== "manage"}>
              <ManagePanel say={say} tab={manageTab} setTab={setManageTab} request={manageRequest}
                ask={ask} currentLab={savedName} onOpenLab={(lab) => { setActiveTool("topology"); onOpen(lab); }}
                onChanged={onHostChanged} />
            </div>
          )}
          {buildOpen && (
            <div className="tool-layer" hidden={activeTool !== "build"}>
              <BuildPanel onBuilt={onBuilt} />
            </div>
          )}
          {nodes.length === 0 && (
            <div className="bench-empty">
              <p>Drag an image here to add your first container.</p>
              <p className="sub">Drag from the edge of one container to another to connect them, or add a switch to put several on one subnet.</p>
            </div>
          )}
        </main>
        {show.messages && <MessagePane log={log} busy={busy} onClear={clearLog} />}
        </div>

        {show.details && <>
        <Splitter dir="v" grow="right" value={layout.right} onChange={(v) => setPaneSize("right", v)}
          min={260} max={() => Math.min(640, window.innerWidth / 2.5)} />
        <aside className="inspector" style={{ width: layout.right }}>
          <Inspector selNode={selNode} selEdge={selEdge} nodes={nodes} edges={edges} images={images}
            updateNode={updateNode} updateEdge={updateEdge} onAction={onNodeAction}
            onConsole={onConsole} onCapture={onCapture} startupLogs={startupLogs}
            onDetails={(container) => openManage("containers", { kind: "container", id: container })}
            engine={engine} labName={labName || UNTITLED} savedName={savedName} description={description} setDescription={setDescription} />
        </aside>
        </>}
        </div>
      </div>
      {/* the Connect dialog may ask a question: keep the question on top */}
      <ConnectDialog open={connectOpen} conn={conn} onClose={() => setConnectOpen(false)}
        onConnected={onConnected} onDisconnect={onDisconnect} beforeSwitch={beforeSwitch} />
      <ChoiceDialog dialog={dialog} answer={answer} />
      <NameDialog req={nameReq} close={closeName} />
    </RuntimeContext.Provider>
  );
}
