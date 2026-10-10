// READ-ONLY check: which dev-loop browsers are still alive, and what does the
// loop's own registry say about them? Nothing is closed or killed here - we only
// look, because we must know whether an instance is still running (and which one
// is ours) before deciding anything.
//
//   node instances.mjs [--state <file>]
//
// The registry is written by probe.mjs --keep and removed by probe.mjs --close, so
// a record with a dead port means a browser died on its own (crash / user closed it)
// - not something we caused.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const STATE_FILE = path.resolve(opt("--state", path.join(process.cwd(), ".ext-dev-loop", "instances.json")));
// Default ports are a per-machine fact; reserved-ports: in ~/.ext-dev-loop/LOCAL.md overrides.
// F2 (guest feedback 2026-10-11): the old code probed exactly four ports (base+0..3), so a
// --script run on any other port of the reserved range leaked unnoticed. Scan the WHOLE range
// in parallel - 39 ports x 900ms timeouts overlap, so this is no slower than four sequential
// 2.5s probes (measured: "scanned 9793-9831: 0 ALIVE of 39" in about the same wall time).
function reservedRange() {
  try {
    const m = /^reserved-ports:\s*(\d+)-(\d+)$/m.exec(fs.readFileSync(path.join(os.homedir(), ".ext-dev-loop", "LOCAL.md"), "utf8"));
    if (m) return [Number(m[1]), Number(m[2])];
  } catch {}
  return [9793, 9831];
}
const [PORT_LO, PORT_HI] = reservedRange();
const PORTS = [];
for (let p = PORT_LO; p <= PORT_HI; p++) PORTS.push(p);

let registry = {};
try { registry = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
catch { console.log(`no registry at ${STATE_FILE} (nothing was launched with --keep)`); }

const known = Object.keys(registry);
if (known.length) {
  console.log(`registry ${STATE_FILE}:`);
  for (const port of known) {
    const r = registry[port];
    console.log(`  port ${port}: ${r.extName || "?"} pid ${r.pid || "?"} started ${r.startedAt || "?"} (${r.host || "?"})`);
    console.log(`    close it with: node probe.mjs --close --port ${port}`);
  }
}

const ports = [...new Set([...PORTS, ...known.map(Number)])].sort((a, b) => a - b);
console.log(`scanning ${ports[0]}-${ports[ports.length - 1]} (${ports.length} ports, parallel)...`);
// First pass - parallel /json/version on every port (fast, short timeout).
const probe = await Promise.all(ports.map(async (port) => {
  try {
    const v = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(900) })).json();
    return { port, alive: true, v };
  } catch (e) {
    return { port, alive: false, why: e?.cause?.code || e?.cause?.message || e?.name || e?.message };
  }
}));
let aliveCount = 0;
// Second pass - details only for the ALIVE ones (this is where the time would go).
for (const r of probe) {
  const port = r.port;
  if (!r.alive) {
    if (known.includes(String(port))) console.log(`port ${port}: DEAD, but still recorded (pid ${registry[String(port)].pid || "?"}) - stale record, run --close to clear it`);
    continue;
  }
  aliveCount++;
  console.log(`port ${port}: ALIVE  ${r.v.Browser || "?"}  ->  ${String(r.v.webSocketDebuggerUrl || "").slice(0, 60)}`);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2500) })).json();
    const sws = list.filter((t) => t.type === "service_worker");
    const pages = list.filter((t) => t.type === "page");
    console.log(`  targets: ${list.length} (pages ${pages.length}, service workers ${sws.length})`);
    for (const t of sws.slice(0, 4)) console.log(`  sw: ${t.url}`);
    for (const t of pages.slice(0, 6)) console.log(`  page: ${t.url.slice(0, 110)}`);
  } catch (e) {
    console.log("  target list failed:", e.message);
  }
}
if (!aliveCount) console.log(`no live lab browser in ${ports[0]}-${ports[ports.length - 1]}`);
