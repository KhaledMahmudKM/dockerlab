/**
 * What changed on the bench since the lab was deployed. Deploy bakes settings into
 * containers and networks, so changes only reach the running lab on Redeploy;
 * startup commands are the exception: they run at every container start.
 *
 * `applied` holds startup commands already run by a later start, by node id.
 * `current` is the bench as a topology (toTopology); `deployed` is the topology the
 * running containers were made from (from the backend's state). Both are normalised
 * the same way, so defaults filled in by the backend don't count as changes.
 */
const num = (v) => (v === "" || v == null ? null : Number(v));

function nodeView(n) {
  return {
    name: n.name, image: (n.image ?? "").trim(), command: n.command ?? "",
    ports: (n.ports ?? []).map((p) => ({ host: num(p.host), container: num(p.container), proto: p.proto || "tcp" })),
    volumes: (n.volumes ?? []).map((v) => ({ source: v.source ?? "", target: v.target ?? "", mode: v.mode || "rw" })),
    env: (n.env ?? []).map((e) => ({ key: e.key ?? "", value: e.value ?? "" })),
    internet: !!n.internet, router: !!n.router, privileged: !!n.privileged,
    interfaces: Number(n.interfaces) || 0,
    ifname_first: (n.ifname_first ?? "").trim(), nat_ifname: (n.nat_ifname ?? "").trim(),
    set_addresses: n.set_addresses !== false,
    sysctls: (n.sysctls ?? []).map((e) => ({ key: e.key ?? "", value: e.value ?? "" })),
  };
}

/** A node's cables, in the order its interfaces are numbered, with what sets their addressing. */
function cablesOf(t, id) {
  const sw = Object.fromEntries((t.switches ?? []).map((s) => [s.id, s]));
  return (t.links ?? []).filter((l) => l.source === id || l.target === id).map((l) => {
    const mine = l.source === id, peer = mine ? l.target : l.source;
    return {
      link: l.id, peer, ip: (mine ? l.source_ip : l.target_ip) ?? "",
      subnet: sw[peer] ? sw[peer].subnet ?? "" : l.subnet ?? "",
    };
  });
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const byId = (xs) => Object.fromEntries((xs ?? []).map((x) => [x.id, x]));

export function pendingChanges(current, deployed, applied = {}) {
  const out = { changed: new Set(), startup: new Set(), added: new Set(), newCables: new Set(), lines: [], any: false };
  if (!deployed) return out;
  const cur = byId(current.nodes), dep = byId(deployed.nodes);
  const curSw = byId(current.switches), depSw = byId(deployed.switches);
  const curLk = byId(current.links), depLk = byId(deployed.links);
  const name = (id) => cur[id]?.name ?? curSw[id]?.name ?? dep[id]?.name ?? depSw[id]?.name ?? "?";

  const changedNames = [], addedNames = [], removedNames = [], startupNames = [];
  for (const n of current.nodes) {
    const d = dep[n.id];
    if (!d) { out.added.add(n.id); addedNames.push(n.name); continue; }
    if (!same(nodeView(n), nodeView(d)) || !same(cablesOf(current, n.id), cablesOf(deployed, n.id))) {
      out.changed.add(n.id); changedNames.push(n.name);
    } else if ((n.startup ?? "") !== (d.startup ?? "") && applied[n.id] !== (n.startup ?? "")) {
      out.startup.add(n.id); startupNames.push(n.name);
    }
  }
  for (const d of deployed.nodes) if (!cur[d.id]) removedNames.push(d.name);

  const swAdded = [], swRemoved = [], swChanged = [];
  for (const s of current.switches ?? []) {
    const d = depSw[s.id];
    if (!d) swAdded.push(s.name);
    else if ((s.subnet ?? "") !== (d.subnet ?? "") || s.name !== d.name) swChanged.push(s.name);
  }
  for (const d of deployed.switches ?? []) if (!curSw[d.id]) swRemoved.push(d.name);

  const cablesAdded = [], cablesRemoved = [];
  for (const l of current.links) if (!depLk[l.id]) { out.newCables.add(l.id); cablesAdded.push(`${name(l.source)}–${name(l.target)}`); }
  for (const l of deployed.links) if (!curLk[l.id]) cablesRemoved.push(`${name(l.source)}–${name(l.target)}`);

  const list = (xs) => xs.length > 3 ? `${xs.slice(0, 3).join(", ")} and ${xs.length - 3} more` : xs.join(", ");
  const add = (xs, one, many) => xs.length && out.lines.push(`${xs.length === 1 ? one : many}: ${list(xs)}`);
  add(changedNames, "Changed container", "Changed containers");
  add(addedNames, "New container", "New containers");
  add(removedNames, "Removed container", "Removed containers");
  add(swChanged, "Changed switch", "Changed switches");
  add(swAdded, "New switch", "New switches");
  add(swRemoved, "Removed switch", "Removed switches");
  add(cablesAdded, "New cable", "New cables");
  add(cablesRemoved, "Removed cable", "Removed cables");
  out.any = out.lines.length > 0;
  out.startupNames = startupNames;
  return out;
}
