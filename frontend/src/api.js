async function call(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = data.detail;
    const msg = Array.isArray(d) ? d.map((e) => `${e.loc?.slice(-1)}: ${e.msg}`).join("; ") : d;
    throw new Error(msg || `${res.status} ${res.statusText}`);
  }
  return data;
}

export const api = {
  status: () => call("GET", "/status"),
  connection: () => call("GET", "/connection"),
  connect: (body) => call("POST", "/connection", body),
  disconnect: () => call("POST", "/connection/disconnect"),
  images: () => call("GET", "/images"),
  pull: (name) => call("POST", "/images/pull", { name }),
  templates: () => call("GET", "/images/templates"),
  build: (tag, dockerfile) => call("POST", "/images/build", { tag, dockerfile }),
  labs: () => call("GET", "/labs"),
  getLab: (n) => call("GET", `/labs/${n}`),
  saveLab: (n, topo) => call("PUT", `/labs/${n}`, topo),
  deleteLab: (n) => call("DELETE", `/labs/${n}`),
  deploy: (n) => call("POST", `/labs/${n}/deploy`),
  destroy: (n) => call("POST", `/labs/${n}/destroy`),
  state: (n) => call("GET", `/labs/${n}/state`),
  nodeAction: (n, id, a, startup) => call("POST", `/labs/${n}/nodes/${id}/${a}`, startup && { startup }),
  running: () => call("GET", "/running"),
  startAll: (n, startup) => call("POST", `/labs/${n}/start`, startup && { startup }),
  stopAll: (n) => call("POST", `/labs/${n}/stop`),
  captureCommand: (n, linkId) => call("GET", `/labs/${n}/links/${linkId}/capture`),
  capture: (n, linkId) => call("POST", `/labs/${n}/links/${linkId}/capture`),
  vmContainers: () => call("GET", "/vm/containers"),
  vmRemoveContainer: (id) => call("DELETE", `/vm/containers/${id}`),
  vmImages: () => call("GET", "/vm/images"),
  vmRemoveImage: (tag) => call("DELETE", `/vm/images/${tag.split("/").map(encodeURIComponent).join("/")}`),
  vmPrune: () => call("POST", "/vm/images/prune"),
  vmImage: (ref) => call("GET", `/vm/image?ref=${encodeURIComponent(ref)}`),
  vmInspectContainer: (id) => call("GET", `/vm/containers/${encodeURIComponent(id)}/inspect`),
  vmNetworks: () => call("GET", "/vm/networks"),
  vmNetwork: (id) => call("GET", `/vm/networks/${encodeURIComponent(id)}`),
  vmCreateNetwork: (spec) => call("POST", "/vm/networks", spec),
  vmRemoveNetwork: (id, disconnect = false) => call("DELETE", `/vm/networks/${encodeURIComponent(id)}${disconnect ? "?disconnect=true" : ""}`),
  vmPruneNetworks: (scope = "dockerlab") => call("POST", `/vm/networks/prune?scope=${scope}`),
  vmInterfaces: () => call("GET", "/vm/interfaces"),
  vmRecover: (lab) => call("POST", `/vm/labs/${encodeURIComponent(lab)}/recover`),
  composeUrl: (n) => `/api/labs/${encodeURIComponent(n)}/compose`,
  labFileUrl: (n) => `/api/labs/${encodeURIComponent(n)}/file`,
  /** Import a lab file's text. Resolves to { status, data }; 409 means the name is taken. */
  importLab: async (text, { overwrite = false, rename = "" } = {}) => {
    const q = new URLSearchParams({ overwrite: String(overwrite), ...(rename ? { rename } : {}) });
    const res = await fetch(`/api/labs/import?${q}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: text });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 409) throw new Error(data.detail || `${res.status} ${res.statusText}`);
    return { status: res.status, data };
  },
  about: () => call("GET", "/about"),
  examples: () => call("GET", "/examples"),
  copyExample: async (name, replace = false) => {
    const res = await fetch(`/api/examples/${encodeURIComponent(name)}/copy?replace=${replace}`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 409) throw new Error(data.detail || `${res.status} ${res.statusText}`);
    return { status: res.status, data };
  },
};

export function openConsole(lab, nodeId, name) {
  const q = new URLSearchParams({ lab, node: nodeId, name });
  window.open(`/console.html?${q}`, `console-${lab}-${nodeId}`, "width=860,height=540");
}

export function openVmConsole(name) {
  const q = new URLSearchParams({ vm: "1", name });
  window.open(`/console.html?${q}`, "console-vm", "width=900,height=560");
}

/** The Docker host's address from DOCKER_HOST, e.g. ssh://gns3@192.168.56.103 -> 192.168.56.103. */
export function engineHost(h = "") {
  const m = /^(?:ssh|tcp):\/\/(?:[^@/]+@)?([^:/]+)/.exec(h);
  return m ? m[1] : h === "local socket" ? "this PC" : h;
}
