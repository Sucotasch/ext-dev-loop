#!/usr/bin/env node
// ext-dev-loop probe: a DISPOSABLE browser with the unpacked extension loaded,
// live extension console, and no way to touch the user's own browser session.
// Zero deps (node >= 22: global fetch + WebSocket).
//
// Usage (default browser: Edge, scratch profile under ./.ext-dev-loop/):
//   node probe.mjs --ext <unpacked-ext-dir> [--port 9793] [--profile <dir>]
//                  [--watch 60] [--open <url>] [--reload] [--headless]
//                  [--browser edge|chrome] [--allow-chrome] [--dry-run]
//                  [--eval <expr> | --eval-file <path>] [--target page|sw|ext]
//                  [--in main|isolated] [--url <page-url>] [--delay <ms>]
//                  [--wait-for <expr>] [--wait-timeout <ms>]
//                  [--msg <json>] [--await <ms>]
//                  [--shot [path]] [--json] [--max-lines <n>]
//                  [--script <steps.json>] [--from <n>]
//   node probe.mjs --attach [--ext <dir>] [--port 9793] [--keep] <any action flags>
//
// A step may also be a HUMAN HANDOVER:  { ask: "...", until: "<predicate>" }
// polls `until`; while it is false the run names the ask, KEEPS the browser and
// exits 3 (needs a human, not a failure). Resume the same batch from that step
// with `--attach --script <same file> --from <n>`. A blocked ask is reported as a
// challenge page when the DOM says so, so "the site never let us in" stops looking
// like "the extension does nothing".
//   node probe.mjs --close [--port 9793]
//
// Three safety rules are ENFORCED here, not merely written down:
//   1. the browser is always launched with --user-data-dir pointing into a
//      .ext-dev-loop scratch root, and a --profile outside those roots is
//      REFUSED. A launch without a scratch profile opens in the user's real,
//      logged-in session - measured, 2026-09-19: `msedge.exe --version` (a flag
//      Chromium on Windows does not answer) started a browser in the user's own
//      Edge session instead of printing a version. Read versions from the app
//      directory (versionOf below); never invoke a browser binary for information.
//   2. nothing is ever killed by image name - that would kill the user's browsers.
//      Shutdown goes through CDP Browser.close on the browser endpoint we started,
//      with a PID-tree kill as the fallback.
//   3. --keep/--attach never kill a browser the state file does not name, and the
//      state file only ever holds an instance THIS script launched under a scratch
//      root. --close refuses a port the state file does not know.

import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const flag = (name) => args.includes(name);

// ── Firefox is a SECOND ENGINE, not a host choice ─────────────────────────────
// Measured 2026-09-21 on Firefox 155.0.1: it answers /json/* with 404 whatever
// `remote.active-protocols` says and only ever announces WebDriver BiDi, so none
// of the CDP transport below can carry it. The Firefox backend lives in
// scripts/firefox.mjs and is reached from this same front door:
//   probe.mjs --browser firefox --ext <dir> --script steps.json
// It refuses --target sw|ext, --msg, --in isolated, --reload, --keep and --attach
// with the measured reason instead of pretending they work.
if ((opt("--browser") || "").toLowerCase().replace(/^ff$/, "firefox") === "firefox") {
    const { main } = await import("./firefox.mjs");
    process.exit(await main(args));
}

const EXT = opt("--ext");
const PORT = Number(opt("--port", 9793));
const WATCH = Number(opt("--watch", 60)) * 1000;
const OPEN = opt("--open");
const RELOAD = flag("--reload");
const HEADLESS = flag("--headless");
const FORCED = opt("--browser");            // "edge" | "chrome" (undefined: prefer Edge)
const ALLOW_CHROME = flag("--allow-chrome");
const DRY = flag("--dry-run");              // resolve and print the plan, launch NOTHING
const JSON_OUT = flag("--json");            // machine-readable result lines
const MAX_LINES = Number(opt("--max-lines", "0")); // 0 = unlimited console lines
// Evaluate one expression in a real page from the command line. Content scripts
// live in an ISOLATED world, which is a different execution context from the
// page's - so `--in isolated` is the only way to see a content script's own scope,
// its `chrome.runtime`, or the globals the manifest gave it.
let EVAL = opt("--eval");
// A real check is longer than a shell argument wants to be (quotes, newlines,
// `$` and backticks all get eaten before node sees them). Pass a file instead.
const EVAL_FILE = opt("--eval-file");
const OUT_JSON = opt("--out-json");   // P5: write the --eval result to a file instead of digging it out of an escaped log line
const WORLD = opt("--in", "main");          // "main" | "isolated" (page target only)
// Where --eval / --wait-for run:
//   page = a real page's world (a content script's world with --in isolated)
//   sw   = the extension's service worker - the ONLY place the product's own
//          state (queues, counters, icon badge, userScripts availability) is real
//   ext  = the extension's own page (options/popup). Doubles as a driver: from
//          there chrome.runtime.sendMessage() reaches the worker, so the loop can
//          ask the extension to DO something and read its answer.
const TARGET = opt("--target", "page");     // "page" | "sw" | "ext"
const WATCH_GIVEN = flag("--watch");
// A page target can hold MORE than one isolated world: a scratch profile is not an
// empty profile - Edge installs registry/managed extensions into it (measured: a
// third-party security extension's content script ran on suno.com in a profile that
// had never seen a human). So "the isolated world" must mean OUR extension's world,
// matched by id, and a wait is often needed before a page's UI exists at all.
const DELAY = Number(opt("--delay", "2500"));
// A blind sleep is a guess. --wait-for polls a predicate in the chosen world and
// returns the moment it holds, so an SPA that renders at 2.5s and one that renders
// at 20s cost the same wall clock as the truth.
const WAIT_FOR = opt("--wait-for");
const WAIT_TIMEOUT = Number(opt("--wait-timeout", "15000"));
// Say something to the extension and read the answer. --msg is the difference
// between "I can see the page" and "I can drive the product": from an extension
// page, chrome.runtime.sendMessage() lands in the worker's handlers.
const MSG = opt("--msg");
const MSG_AWAIT = Number(opt("--await", "10000"));
// Session reuse: launch once with --keep, then run action after action with
// --attach. Without this every question costs a browser launch plus a full page
// load, which is exactly the slow part.
const KEEP = flag("--keep");
const ATTACH = flag("--attach");
const CONTEXTS_WAIT = Number(opt("--contexts", "0")) || 0;   // P4: seconds, then re-list execution contexts
const CLOSE = flag("--close");
// --script <file>: a JSON array of steps, all run against ONE browser in ONE
// invocation. This exists because a harness that waits for the whole process tree
// (measured 2026-09-21: even a minimal detached `msedge.exe` spawn keeps the calling
// command from returning while the browser lives) cannot use --keep at all - the
// cheap-looking "launch once, ask five questions" becomes five tool calls that each
// hang. Batching is the answer: one launch, N steps, one exit.
//
// step = { note?, target?: page|sw|ext, url?, in?: main|isolated,
//          eval?, msg?, wait?, waitTimeout?, shot?, delay?,
//          key?, keyText?, mouse?, x?, y?, mouseAt? }
//
// `mouse` is NOT decoration. Measured 2026-10-08 (Chrome for Testing 137, a
// clean profile, an extension that had been written off as dead for a whole
// session): the content script of a hover-driven extension armed only a
// `mousemove` listener at load and wired everything else - its
// chrome.runtime.onMessage registration, its hotkeys - from the FIRST pointer
// move. A headless run never moves the pointer, so chrome.tabs.sendMessage
// answered "Receiving end does not exist" and the hotkey did nothing, which
// reads exactly like "the extension is broken". One real pointer move later:
// 26 items found, 18 downloaded, phase done. If a page step needs the
// extension to have BOOTED before it can be driven, give it `mouse`.
const SCRIPT = opt("--script");
let SCRIPT_STEPS = null;
if (SCRIPT) {
  try {
    SCRIPT_STEPS = JSON.parse(fs.readFileSync(path.resolve(SCRIPT), "utf8"));
    if (!Array.isArray(SCRIPT_STEPS)) throw new Error("top level must be an array");
  } catch (e) {
    console.error(`[probe] --script ${SCRIPT}: ${e.message}`);
    process.exit(2);
  }
}
// --from <n>: resume a batch at the n-th step (1-based). A step with `ask` keeps
// the browser and exits 3 when the human has not acted yet, and the resume run
// re-checks the SAME step - so pass the blocked step's own number, not the next.
const FROM = Number(opt("--from", "0")) || 0;
// How a `ask` step behaves when the predicate never comes true.
//   default       - the wait IS the handover: the human acts in the visible window
//                   while this run polls, and the run continues by itself. This is the
//                   only shape that works in a harness which waits for the whole process
//                   tree, because a browser kept alive would hang the caller forever
//                   (measured 2026-09-22 on a kept browser: printed its lines, never
//                   returned - the same signature as --keep).
//   --ask-keep    - keep the browser and exit 3, for a shell that returns at once.
//                   Resume with `--attach --script <same file> --from <n>`.
const ASK_KEEP = flag("--ask-keep");
const ASK_TIMEOUT = Number(opt("--ask-timeout", "240000"));
// Budget for the one manual click the userScripts grant needs (see the grant
// block): a human has to notice the window and click, so this is generous - but
// it is a WAIT, not a request for the caller to do anything.
const GRANT_TIMEOUT = Number(opt("--grant-timeout", "180000"));
// How long to wait for the extension's service worker to appear. See findSW.
const SW_TIMEOUT = Number(opt("--sw-timeout", "60000"));
// `ask` is the one step no machine can satisfy alone: a human must act in the
// window. Headless is therefore a contradiction, and it is refused here rather
// than discovered later as an unexplained timeout.
if (SCRIPT_STEPS && HEADLESS && SCRIPT_STEPS.some((s) => s && s.ask)) {
  console.error("[probe] a step with `ask` needs a VISIBLE window (a human acts in it) - drop --headless");
  process.exit(2);
}
const STATE_FILE = path.resolve(opt("--state", path.join(process.cwd(), ".ext-dev-loop", "instances.json")));
// A PNG of the page you asked for - the only way to check a UI that is judged by
// eye (a popup, a settings card, a rendered table). Writes into the scratch root
// by default, so a screenshot never lands in the repository.
if (EVAL_FILE) {
  try { EVAL = fs.readFileSync(path.resolve(EVAL_FILE), "utf8"); }
  catch (e) { console.error(`[probe] --eval-file: ${e.message}`); process.exit(2); }
  if (EVAL_FILE && !EVAL.trim()) { console.error("[probe] --eval-file: empty file"); process.exit(2); }
}

const SHOT_IDX = args.indexOf("--shot");
const SHOT = SHOT_IDX >= 0
  ? (args[SHOT_IDX + 1] && !args[SHOT_IDX + 1].startsWith("--") ? args[SHOT_IDX + 1] : "auto")
  : null;
if (!["page", "sw", "ext"].includes(TARGET)) {
  console.error(`[probe] --target must be page|sw|ext (got "${TARGET}")`);
  process.exit(2);
}
let MSG_JSON = null;
if (MSG) {
  try { MSG_JSON = JSON.stringify(JSON.parse(MSG)); }
  catch (e) { console.error(`[probe] --msg must be a JSON object/array: ${e.message}`); process.exit(2); }
}
if (!ATTACH && !CLOSE && (!EXT || !fs.existsSync(path.join(EXT, "manifest.json")))) {
  console.error("usage: probe.mjs --ext <unpacked-ext-dir> [--port N] [--profile dir] [--watch s] [--open url] [--reload] [--headless]");
  console.error("       probe.mjs --ext <dir> --keep          # launch, leave it running");
  console.error("       probe.mjs --attach --eval <expr> --target sw");
  console.error("       probe.mjs --close");
  process.exit(2);
}
const EXT_ABS = EXT ? path.resolve(EXT) : null;
const EXT_MANIFEST = EXT_ABS ? JSON.parse(fs.readFileSync(path.join(EXT_ABS, "manifest.json"), "utf8")) : null;
const EXT_NAME = opt("--name") || (EXT_MANIFEST ? EXT_MANIFEST.name : null);
// On --attach the extension directory is usually not passed again, so the name the
// worker is matched by comes from the kept instance's own record.
const SW_NAME = EXT_NAME || ((ATTACH || CLOSE) ? (readStateSilent()[String(PORT)]?.extName || null) : null);

// ── the scratch profile: the isolation boundary ───────────────────────────────
// Inside --ext's project by default (easy to find, easy to delete, never
// committed - see the .gitignore hint below); ~/.ext-dev-loop stays valid for a
// profile shared across projects.
const SCRATCH_ROOTS = [
  path.join(process.cwd(), ".ext-dev-loop"),
  path.join(os.homedir(), ".ext-dev-loop"),
];
const DEFAULT_PROFILE = path.join(process.cwd(), ".ext-dev-loop", path.basename(EXT_ABS || "ext"), "profile");
const PROFILE = path.resolve(opt("--profile", DEFAULT_PROFILE));
const isUnder = (child, parent) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
if (ATTACH && !fs.existsSync(STATE_FILE)) {
  console.error(`--attach: no state file at ${STATE_FILE}\nrun the loop with --keep first (or pass --state <file>)`);
  process.exit(2);
}

// ── the instance registry (--keep / --attach / --close) ──────────────────────
// Only instances this script launched under a scratch root are ever written here,
// and --close kills only what a record names - never a browser by image name.
function readStateSilent() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
const readState = readStateSilent;
const writeState = (all) => {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(all, null, 2));
  } catch (e) { console.log(`note: could not write ${STATE_FILE}: ${e.message}`); }
};
const record = (entry) => { const all = readState(); all[String(PORT)] = entry; writeState(all); };
const forget = () => { const all = readState(); delete all[String(PORT)]; writeState(all); };
const liveState = () => {
  const all = readState();
  const entry = all[String(PORT)];
  if (!entry) {
    const known = Object.keys(all);
    console.error(`[probe] no kept instance on port ${PORT}` + (known.length ? `; known ports: ${known.join(", ")}` : "; none recorded"));
    process.exit(2);
  }
  return entry;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A hard ceiling on the whole run. This is a tool an agent drives: one that can
// hang forever costs a whole turn (measured 2026-09-21 - a --keep run printed its
// last line, wrote its state file, and then kept the shell alive because a fetch
// socket to 127.0.0.1 stayed in the keep-alive pool). The timer is deliberately
// NOT unref'd: it must be able to end a run that has nothing else to do.
const HARD_TIMEOUT = Number(opt("--timeout", "0")) || (WATCH + 5 * 60 * 1000);
setTimeout(() => {
  console.log(`\n[probe] hard timeout after ${Math.round(HARD_TIMEOUT / 1000)}s - exiting (never hang an agent turn)`);
  process.exit(process.exitCode || 0);
}, HARD_TIMEOUT);
const list = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
// Every session this run opened, so a run that ends inside an action can still
// close them. A WebSocket left open at exit is not a leak in a long-lived process
// but it IS a crash in node on Windows: the run above died with
// `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` after printing its last
// line, which makes the loop look broken exactly when it worked.
const SESSIONS = new Set();
const closeAll = () => { for (const s of SESSIONS) { try { s.ws.close(); } catch {} } SESSIONS.clear(); };
function attach(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0; const pending = new Map(); const raw = []; const handlers = [];
    ws.onopen = () => { const session = {
      ws, raw, handlers,
      send: (m, p = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); }),
      on: (fn) => handlers.push(fn),
    }; SESSIONS.add(session); res(session); };
    ws.onerror = () => rej(new Error("ws error"));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m); pending.delete(m.id); return; }
      for (const h of handlers) { try { h(m); } catch {} }
      raw.push(m);
    };
  });
}
// ── downloads belong to the LAB, not to the human ────────────────────────────
// A loop that drives the product's own "save this file" paths will write real
// files. Measured 2026-10-08: three probe runs left 54 lab PNGs in the owner's real
// download folder (D:\Arx) because nothing redirected them - the lab script did,
// the reusable tool did not. Every launch now points the browser's downloads at a
// scratch dir underneath .ext-dev-loop/, which is already gitignored.
const DOWNLOAD_DIR = path.join(process.cwd(), ".ext-dev-loop", "downloads");
// The session that OWNS the download behaviour must stay OPEN for the whole run.
// Measured 2026-10-08: setting the behaviour and then closing that session silently
// reverted it - the log said "redirected", the scratch dir stayed empty, and 18 lab
// files landed in the owner's real download folder. Held in SESSIONS, so closeAll()
// still tears it down.
let downloadSession = null;
async function redirectDownloads() {
  try {
    const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(3000) })).json();
    if (!v || !v.webSocketDebuggerUrl) throw new Error("no browser endpoint");
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    downloadSession = await attach(v.webSocketDebuggerUrl);
    await downloadSession.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOAD_DIR, eventsEnabled: false });
    console.log(`  downloads redirected to ${DOWNLOAD_DIR} (the human's download folder is not used)`);
  } catch (e) {
    console.log(`  note: could not redirect downloads (${(e && e.message) || e}) - a download-writing step would land in the real folder`);
  }
}

const fmt = (m) => {
  if (m.method === "Runtime.consoleAPICalled")
    return `[${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? `<obj:${a.className}>`).join(" ");
  if (m.method === "Runtime.exceptionThrown")
    return `[EXC] ` + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  return null;
};
const drain = (s) => { const out = []; for (const m of s.raw.splice(0)) { const l = fmt(m); if (l) out.push(l); } return out; };

// ── console with host attribution ────────────────────────────────────────────
// A line without a host is a line you cannot act on: the same error text can come
// from the worker, the page, or a content script's isolated world. Each stream is
// tagged when it is printed, and each target keeps its own context map so an id
// resolves to main/isolated instead of being guessed.
const ctxLabel = (target, id) => (target.ctxById && target.ctxById.get(id)) || `ctx ${id}`;
// Where a runtime event's execution context id actually lives. It is NOT uniform:
// consoleAPICalled carries it at params level, exceptionThrown only inside
// params.exceptionDetails - so one shared reader beats guessing per call site
// (measured 2026-10-08: exceptions printed as "ctx undefined" because of this).
const evtCtxId = (m) => (m.method === "Runtime.exceptionThrown"
  ? (m.params.exceptionDetails && m.params.exceptionDetails.executionContextId)
  : m.params.executionContextId);
function taggedLines(target) {
  const out = [];
  for (const m of target.session.raw.splice(0)) {
    if (m.method === "Runtime.executionContextCreated") {
      const c = m.params.context;
      const kind = c.auxData && c.auxData.isDefault === false ? "isolated" : "main";
      target.ctxById.set(c.id, `${kind}#${c.id}`);
      continue;
    }
    const line = fmt(m);
    if (line) out.push(`[${target.label} ${ctxLabel(target, evtCtxId(m))}] ${line}`);
  }
  return out;
}
const shortUrl = (u) => String(u || "").replace(/^chrome-extension:\/\//, "ext:").replace(/^https?:\/\//, "").slice(0, 60);

// ── the host browser ─────────────────────────────────────────────────────────
// Chrome 137+ ignores --load-extension (it logs `--load-extension is not allowed
// in Google Chrome` and loads nothing), so Edge is the default host. The version
// comes from the install directory - never from invoking the binary.
const BROWSER_PATHS = {
  edge: [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ],
  chrome: [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ],
  // Chrome for Testing — the browser this tool prefers. Why (re-measured 2026-10-10,
  // all on the same tree/profile):
  //   Edge 154.0.4258.62  loads --load-extension only WITH
  //                       --enable-unsafe-extension-debugging (which this tool always
  //                       passes) — in BOTH --headless and a visible window — but its
  //                       userScripts grant is a per-extension toggle (>= 138).
  //   Chrome 137+         refuses --load-extension outright outside a test environment.
  //   CfT 137             loads with a plain --load-extension, in BOTH modes, and its
  //                       userScripts gate is the single global Developer-mode toggle.
  // "Test environment" branding is exactly why CfT is allowed to do what the branded
  // browsers refuse, so it is listed first and is never version-skipped.
  // NOTE: an earlier note here said Edge 154 "loads NOTHING, even with the flag" —
  // that was a false negative from a broken run (2026-10-07), disproved by re-measuring
  // (2026-10-10: SW found, state read, headless). Never write a browser off without a
  // re-run: the signature "SW not found after 0s" is a probe bug (sw-timeout is in
  // MILLISECONDS) or a stale profile (fact 11), not a browser verdict.
  cft: (() => {
    const list = [];
    // pinned-cft from LOCAL.md wins (agents maintain it; see SKILL.md "Local facts")
    try {
      const m = /^pinned-cft:\s*(.+)$/m.exec(fs.readFileSync(path.join(os.homedir(), ".ext-dev-loop", "LOCAL.md"), "utf8"));
      if (m) list.push(m[1].trim());
    } catch {}
    // any downloaded cft-* build (get-browser.mjs installs them), newest dir name first
    try {
      const b = path.join(os.homedir(), ".ext-dev-loop", "browsers");
      const dirs = fs.readdirSync(b).filter((d) => /^cft-/.test(d))
        .sort((a, c) => a.localeCompare(c, undefined, { numeric: true })).reverse();
      for (const d of dirs) list.push(path.join(b, d, "chrome-win64", "chrome.exe"));
    } catch {}
    list.push("C:/Program Files/Google/Chrome for Testing/chrome.exe");
    return list;
  })(),
};

function versionOf(exe) {
  try {
    const dir = path.dirname(exe);
    const versions = fs.readdirSync(dir)
      .filter((n) => /^\d+\.\d+\.\d+\.\d+$/.test(n))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (versions.length) return versions[versions.length - 1];
    // Chrome for Testing is a portable build: no version directory - the version is the
    // name of the file chrome-win64/137.0.7151.119.manifest next to the binary.
    const manifests = fs.readdirSync(dir)
      .map((n) => n.match(/^(\d+\.\d+\.\d+\.\d+)\..*manifest$/i))
      .filter(Boolean)
      .sort((a, b) => a[1].localeCompare(b[1], undefined, { numeric: true }));
    return manifests.length ? manifests[manifests.length - 1][1] : null;
  } catch { return null; }
}
let host = null;
if (!ATTACH && !CLOSE) {
  if (!SCRATCH_ROOTS.some((r) => isUnder(PROFILE, r))) {
    console.error(
      `refusing to launch: profile ${PROFILE}\n` +
      `is not a scratch profile. A browser started without --user-data-dir inside\n` +
      `${SCRATCH_ROOTS.join("\nor ")}\n` +
      `opens in a REAL, logged-in session - the user's own. Pass --profile under one of\n` +
      `those roots (default: ${DEFAULT_PROFILE}).`
    );
    process.exit(2);
  }
  for (const name of (FORCED ? [FORCED] : ["cft", "edge", "chrome"])) {
    const exe = (BROWSER_PATHS[name] || []).find((p) => fs.existsSync(p));
    if (!exe) continue;
    const version = versionOf(exe);
    const major = version ? Number(version.split(".")[0]) : 0;
    if (name === "chrome" && major >= 137 && !ALLOW_CHROME) {
      if (FORCED === "chrome") {
        console.error(`Chrome ${version} ignores --load-extension; use --browser edge, or --allow-chrome if you know what you are doing`);
        process.exit(2);
      }
      console.error(`skipping Chrome ${version}: 137+ ignores --load-extension - using Edge instead`);
      continue;
    }
    host = { name, exe, version };
    break;
  }
  if (!host) {
    console.error("no usable browser found (looked for Edge, then Chrome >= 137 not usable)");
    process.exit(2);
  }
}

if (DRY) {
  // The whole point: every guard above has run, and this exits BEFORE any spawn,
  // so `--dry-run` is safe to use as a check in a loop that must never open a
  // browser.
  const would = ATTACH || CLOSE
    ? `attach to the kept instance on port ${PORT} (state ${STATE_FILE})`
    : `launch ${host.name} ${host.version || "(version unknown)"}`;
  console.log(`dry run - would ${would}`);
  console.log(`  exe:     ${host ? host.exe : "(no launch)"}`);
  console.log(`  profile: ${PROFILE}${isUnder(PROFILE, SCRATCH_ROOTS[0]) ? " (project scratch)" : " (home scratch)"}`);
  console.log(`  ext:     "${EXT_NAME || "(from state file)"}"`);
  console.log(`  action:  ${MSG ? "--msg" : EVAL ? `--eval (--target ${TARGET})` : SHOT ? "--shot" : RELOAD ? "--reload" : WATCH_GIVEN ? "--watch" : "(state only)"}`);
  console.log(`  keep:    ${KEEP ? "browser stays up after this run" : ATTACH ? "no change (attach)" : CLOSE ? "closing" : "browser is closed at the end"}`);
  process.exit(0);
}

// ── close: end a kept instance, and only that one ────────────────────────────
if (CLOSE) {
  const entry = liveState();
  let viaCdp = false;
  try {
    const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    if (v && v.webSocketDebuggerUrl) {
      const s = await attach(v.webSocketDebuggerUrl);
      await s.send("Browser.close").catch(() => {});
      viaCdp = true;
      await sleep(400);
      try { s.ws.close(); } catch {}
    }
  } catch {}
  forget();
  console.log(`closed the kept instance on port ${PORT} (${viaCdp ? "Browser.close + PID tree" : "PID tree only"}), state entry removed`);
  process.exit(0);
}

// Kill a browser process tree. Windows: taskkill (it also kills orphans of a dead parent).
// POSIX: negative pid = the whole process group (our detached spawn makes one).
// ponytail: POSIX branch untested on this box - measured on Windows only.
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" });
    else process.kill(-pid, "SIGKILL");
  } catch {}
}

// ── launch (unless attaching) ────────────────────────────────────────────────
let child = null;          // kept for clarity: the browser's own handle is the helper's, not ours
let launchedPid = null;    // read back from the log line the helper writes
let stderrFd = null;
let STDERR_LOG = null;
const stateEntry = ATTACH ? liveState() : null;
if (!ATTACH) {
  // A browser already answering on this port is either an orphan of an earlier run
  // or another loop's instance. Launching into the same --user-data-dir does NOT
  // start a second browser: Chromium hands the command line to the running one and
  // the process we spawned exits at once, so the run silently talks to SOMEBODY
  // ELSE'S browser and `--close` kills the wrong (already dead) pid. Measured
  // 2026-09-21: an orphan accumulated this way survived every close.
  const occupied = await (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) })
    .then((r) => r.json()).catch(() => null));
  if (occupied) {
    console.error(`refusing to launch: something already answers on port ${PORT} (${occupied.Browser || "?"})`);
    console.error(`  it is not this run's to close. Use --attach to talk to it, --close to end it,\n  or --port <other> for a second instance.`);
    process.exit(2);
  }
  fs.mkdirSync(PROFILE, { recursive: true });
  if (isUnder(PROFILE, process.cwd())) {
    let ignored = false;
    try { ignored = /\.ext-dev-loop/.test(fs.readFileSync(path.join(process.cwd(), ".gitignore"), "utf8")); } catch {}
    if (!ignored) console.log("hint: add `.ext-dev-loop/` to .gitignore - a scratch profile belongs to no commit");
  }
  STDERR_LOG = path.join(PROFILE, "browser-stderr.log");
  // N4 (guest feedback 2026-10-12): a poisoned profile dir (e.g. one Firefox also wrote into)
  // fails openSync with a bare EPERM stack and no diagnosis. Say what to do instead.
  try {
    stderrFd = fs.openSync(STDERR_LOG, "w"); // per run: the report is THIS run, not a pile of history
  } catch (e) {
    console.error(`ERROR: cannot write the browser log inside ${PROFILE} (${e.code || e.message}).`);
    console.error(`  The profile directory is poisoned/not writable. Pass a FRESH --profile under the`);
    console.error(`  scratch root (e.g. .ext-dev-loop/<name>/profile) - never delete-and-retry the same dir`);
    console.error(`  while a browser may be holding it; close leftover lab browsers with ports.mjs first.`);
    process.exit(1);
  }
  const flags = [
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    `--load-extension=${EXT_ABS}`,
    // REQUIRED on current Chromium/Edge (measured 2026-10-07, Edge 154): without
    // this flag `--load-extension` is accepted and SILENTLY IGNORED - no error,
    // no extension, no service worker, and the run dies at "extension SW not found"
    // while looking perfectly healthy. Measured on one fresh profile: 0
    // service_worker targets without it, 2 with it (ours among them). It is only
    // for a throwaway scratch profile, which is the only kind this tool launches.
    "--enable-unsafe-extension-debugging",
    // MEASURED 2026-10-07, and it poisoned a whole afternoon of runs: on this box the
    // browser's sandbox cannot read its own executable -
    //   "Sandbox cannot access executable. Check filesystem permissions are valid. (0x5)"
    //   "Network service crashed, restarting service."
    // - and a crashed network service means page loads fail INTERMITTENTLY: the same
    // step says "wait: true" in one run and lands on chrome-error://chromewebdata/ in
    // the next, which then reads like "the extension's content script is dead",
    // "tabs.sendMessage has no receiving end" and "the hotkey does nothing". None of
    // that was about the extension. --no-sandbox is standard for a disposable
    // automation profile and is exactly what this tool launches.
    "--no-sandbox",
    "--disable-features=NetworkServiceSandbox",
    "--no-first-run", "--no-default-browser-check",
    "--window-size=1100,820", "--window-position=60,60",
  ];
  // `--headless=new` was the spelling for the "new" headless mode before Chrome
  // 132; from 132 on, plain `--headless` IS the new mode and the `=new` form is a
  // deprecated alias a host may ignore - an ignored flag means a REAL WINDOW on
  // the user's screen, which is the single worst thing this tool can do to them
  // (measured 2026-10-07 on Edge 154: `--headless=new` produced a visible window).
  // Use the supported spelling, and prove it below with the screen self-check.
  if (HEADLESS) flags.push("--headless");
  console.log(`launching ${host.name} ${host.version || "(version unknown)"} with the SCRATCH profile`);
  console.log(`  profile: ${PROFILE}`);
  console.log(`  (a separate window and a separate profile - your own browser sessions are not used;${HEADLESS ? "" : " the window is disposable"})`);
  // The browser is launched through a one-shot helper whose own stdio is devnull.
  // Why not spawn it directly: measured 2026-09-21 on Windows - with `--keep` the
  // browser survived the run, and the run's stdout was a PIPE (`| tail`), so the
  // pipe's write end stayed open in the surviving browser process and the invoking
  // shell waited for an EOF that never came. Redirecting to a file made it exit
  // cleanly, which is what pointed at handle inheritance rather than at the probe.
  // The helper opens the stderr log itself and passes only devnull + that file, so
  // nothing of the caller's plumbing reaches the browser; it reports the pid on the
  // log's first line, which is how we keep an explicit pid to close later.
  // `stdio: 'ignore'` is NOT "close stdin/stdout/stderr" on Windows: libuv passes
  // no handle for that slot, and a detached child created with bInheritHandles=TRUE
  // then inherits the PARENT'S handle. So the browser ends up holding the caller's
  // stdout pipe, and whoever waits on that pipe waits forever even though the probe
  // exited (which is exactly the reported hang). NUL opened as a file is a real
  // handle, so stdout is NUL and only the stderr log is a file of ours.
  const launcher = [
    "const {spawn}=require('node:child_process'); const fs=require('node:fs'); const os=require('node:os');",
    "const [exe,logPath,...f]=process.argv.slice(1);",
    // os.devNull is the DEVICE path ('\\\\.\\nul'), not the string 'NUL': opening the
    // bare name can create a real file called NUL in the cwd (measured 2026-09-21 - a
    // 0-byte `NUL` appeared in the project root).
    "const nul=fs.openSync(os.devNull,'w');",
    "const fd=fs.openSync(logPath,'w');",
    "const c=spawn(exe,f,{stdio:[nul,nul,fd],detached:true});",
    "try{fs.writeSync(fd,'[probe] launched pid '+c.pid+'\\n');}catch{}",
    "c.unref();process.exit(0);",
  ].join(" ");
  // Handle hygiene for the helper, worth keeping on its own terms: `stdio: "ignore"`
  // does NOT mean "no handles" on Windows - libuv passes no handle for the slot, and
  // with `detached: true` the child is created with bInheritHandles=TRUE, so whatever
  // the caller gave US can leak into the helper and then into the browser. Real NUL
  // handles close that path. NOTE this is NOT what makes a kept browser hang a caller:
  // measured 2026-09-22, the hang is the HARNESS waiting for the whole process tree
  // while the browser it spawned is alive (the reason --keep is unusable there), and no
  // amount of handle hygiene changes that - see the `ask` step's --ask-keep note.
  const nulFd = fs.openSync(os.devNull, "w");
  const helper = spawn(process.execPath, ["-e", launcher, host.exe, STDERR_LOG, ...flags], { stdio: [nulFd, nulFd, nulFd], detached: true });
  try { fs.closeSync(nulFd); } catch {}
  helper.unref();
  fs.closeSync(stderrFd);
  stderrFd = null;
  for (let i = 0; i < 40 && !launchedPid; i++) {
    await sleep(100);
    try {
      const m = /launched pid (\d+)/.exec(fs.readFileSync(STDERR_LOG, "utf8"));
      if (m) launchedPid = Number(m[1]);
    } catch {}
  }
  console.log(`  pid ${launchedPid || "(unknown)"}, port ${PORT}, stderr -> ${STDERR_LOG}`);
  // N7 (guest feedback 2026-10-12): a listener squatting the port WITHOUT SO_REUSEADDR makes the
  // browser fail to bind silently - the run then sat 180 s with no attach, no error, no hint,
  // and the spawned browser outlived the caller. Prove the endpoint is UP before doing anything
  // else; if it never comes, close what we started and say what to check.
  let up = false;
  const upDeadline = Date.now() + 15000;
  while (Date.now() < upDeadline) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1000) })).json();
      if (v && v.webSocketDebuggerUrl) { up = true; break; }
    } catch {}
    await sleep(500);
  }
  if (!up) {
    console.error(`ERROR: the debug endpoint never came up on port ${PORT}.`);
    console.error(`  The port may be squatted by another listener (check BOTH 127.0.0.1 and [::1]:`);
    console.error(`  netstat -ano | findstr :${PORT}), or the browser failed to start - read ${STDERR_LOG}.`);
    console.error(`  Closing what this run started...`);
    killTree(launchedPid);
    forget();
    process.exit(1);
  }
} else {
  console.log(`attaching to the kept instance on port ${PORT} (${stateEntry.extName || "?"}, pid ${stateEntry.pid || "?"})`);
}
// The browser's OWN pid, asked of the browser. The helper's printed pid is right only
// when the launch really created a browser; Chromium can also hand the command line to
// an existing instance and exit, which leaves a pid that is already gone. CDP answers
// authoritatively, so the recorded pid (and --close's PID-tree fallback) is the one
// that can actually be killed.
async function browserPid() {
  try {
    const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(2000) })).json();
    const s = await attach(v.webSocketDebuggerUrl);
    const info = await s.send("SystemInfo.getProcessInfo").catch(() => null);
    try { s.ws.close(); } catch {}
    const me = info?.processInfo?.find((p) => p.type === "browser");
    return me?.id || null;
  } catch { return null; }
}
let spawnedPid = launchedPid || (stateEntry?.pid || null);

function reportStderr() {
  if (!STDERR_LOG) {
    const known = stateEntry?.stderr;
    if (!known) return;
    try { fs.accessSync(known); STDERR_LOG = known; } catch { return; }
  }
  let text = "";
  try { text = fs.readFileSync(STDERR_LOG, "utf8"); } catch { return; }
  const lines = text.split(/\r?\n/)
    .filter((l) => /load-extension|extension|fatal|crash/i.test(l) && !/external_registry_loader|Missing value path/i.test(l))
    .filter((l, i, a) => a.indexOf(l) === i)
    .slice(-8);
  if (lines.length) {
    console.log("browser stderr (filtered):");
    for (const l of lines) console.log("  " + l.trim().slice(0, 240));
  }
}

// ── find the extension's SW ──────────────────────────────────────────────────
// Never by file name (component extensions run their own workers): evaluate the
// manifest name inside each candidate and match that.
let swFoundOnce = false;   // H-4: a worker found earlier this run later vanishing = idle, not missing
async function findSW(seenId = null, name = SW_NAME, seenBefore = swFoundOnce) {
  // The budget used to be a hard 100 x 200ms = 20s, and that is why launches were
  // flaky: a NON-headless start (and any start where the extension is already
  // installed in the profile) registers its worker well after 20s, so the run died
  // with "extension SW not found - extension failed to load?" even though the
  // extension was fine (measured 2026-10-07: two such deaths, one of them on a
  // profile whose SW had been found minutes earlier). Poll to a real deadline and
  // say how long we waited when it fails.
  const deadline = Date.now() + SW_TIMEOUT;
  for (let i = 0; Date.now() < deadline; i++) {
    await sleep(250);
    try {
      const l = await list();
      for (const t of l.filter((x) => x.type === "service_worker" && x.id !== seenId)) {
        try {
          const s = await attach(t.webSocketDebuggerUrl);
          const r = await s.send("Runtime.evaluate", { expression: "chrome.runtime.getManifest ? chrome.runtime.getManifest().name : null", returnByValue: true });
          s.ws.close();
          if (r.result?.value && name && r.result.value.toLowerCase().includes(name.toLowerCase())) { swFoundOnce = true; return { target: t, name: r.result.value }; }
        } catch {}
      }
    } catch {}
  }
  // H-4 (guest feedback 2026-10-10): printing "first suspects: a STALE profile" after the SAME
  // run had already found and used this worker sent the agent chasing the wrong cause - the
  // usual truth is the 2026-10-07 note: MV3 lists workers only while RUNNING, so a found-then-
  // lost worker is idle/suspended, not missing. "Never found" keeps the old suspects.
  // N1 (guest feedback 2026-10-12): an idle MV3 worker is not listed, and an --attach resume
  // dies on "SW not found" before the run can wake it - the message then misdirects to a stale
  // profile. Waking it ourselves is measured to work: opening ANY extension page brings the
  // worker back (guest-verified). Try that once before giving up.
  if (ATTACH) {
    try {
      const pages = (await list()).filter((t) => t.type === "page" && t.url.startsWith("chrome-extension://"));
      const wakeUrl = (pages[0] && pages[0].url)
        || (globalThis.__extId ? `chrome-extension://${globalThis.__extId}/` : null);
      if (wakeUrl) {
        console.log(`  (worker not listed - it may be idle; waking it via ${wakeUrl.slice(0, 60)})`);
        await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(wakeUrl)}`, { method: "PUT" }).catch(() => {});
        const deadline2 = Date.now() + Math.min(SW_TIMEOUT, 20000);
        while (Date.now() < deadline2) {
          await sleep(500);
          const l = await list();
          for (const target of l.filter((x) => x.type === "service_worker" && x.id !== seenId)) {
            try {
              const s2 = await attach(target.webSocketDebuggerUrl);
              const r2 = await s2.send("Runtime.evaluate", { expression: "chrome.runtime.getManifest ? chrome.runtime.getManifest().name : null", returnByValue: true });
              s2.ws.close();
              if (r2.result?.value && name && r2.result.value.toLowerCase().includes(name.toLowerCase())) { swFoundOnce = true; return { target: target, name: r2.result.value }; }
            } catch {}
          }
        }
      }
    } catch {}
  }
  if (seenBefore) {
    console.log(`  (service worker "${name}" was found earlier this run, but is not answering now -`);
    console.log(`        the usual truth: an MV3 worker SUSPENDS and stops being listed (2026-10-07 note);`);
    console.log(`        re-wake it with an eval/msg step, or reload the extension, before suspecting the profile.)`);
  } else {
    console.log(`  (no service worker for "${name}" after ${Math.round(SW_TIMEOUT / 1000)}s)`);
    console.log(`        first suspects: a STALE profile serving an older copy of the extension`);
    console.log(`        (fact 11 - launch a fresh --profile), or the profile never had it.`);
    console.log(`        This tool already passes --enable-unsafe-extension-debugging, so an`);
    console.log(`        ignored --load-extension on Edge/Chromium is NOT the explanation here.`);
  }
  return null;
}

// Shutdown: CDP Browser.close first (it is the browser we started, addressed by
// its own debugging endpoint), PID tree second. Never by image name.
let stopping = false;
// A blocked `ask` hands the window to the human: the run ends but the browser stays.
// This cannot be the --keep flag, because whether an ask blocks is only known at
// runtime, after the predicate has been polled.
let keepOnAsk = false;
async function stop(reason = "done") {
  if (stopping) return; stopping = true;
  if (ATTACH) { console.log(`browser left running [${reason}]`); return; }
  if (KEEP || keepOnAsk) {
    record({
      pid: spawnedPid, port: PORT, profile: PROFILE, ext: EXT_ABS, extName: EXT_NAME,
      extId: globalThis.__extId || null, optionsPage: globalThis.__optionsPage || null,
      host: `${host.name} ${host.version}`, startedAt: new Date().toISOString(),
      stderr: STDERR_LOG,
    });
    console.log(`browser kept running [${reason}] - pid ${spawnedPid}, port ${PORT}`);
    console.log(`  next:  node probe.mjs --attach --eval '<expr>' [--target sw|ext|page]`);
    console.log(`  close: node probe.mjs --close --port ${PORT}`);
    return;
  }
  let viaCdp = false;
  try {
    const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    if (v && v.webSocketDebuggerUrl) {
      const s = await attach(v.webSocketDebuggerUrl);
      await s.send("Browser.close").catch(() => {});
      viaCdp = true;
      await sleep(400);
      try { s.ws.close(); } catch {}
    }
  } catch {}
  killTree(spawnedPid);
  try { if (stderrFd) fs.closeSync(stderrFd); } catch {}
  forget();
  console.log(`browser stopped (${viaCdp ? "Browser.close + PID tree" : "PID tree only"}) [${reason}]`);
}
process.on("exit", () => {
  if (spawnedPid && !KEEP && !ATTACH && !keepOnAsk) killTree(spawnedPid);
});
process.on("SIGINT", async () => { await stop("ctrl+c"); process.exit(0); });

// ── resolving a page target + its execution contexts ─────────────────────────
async function resolveWorld(pageUrl, { create = true, world: wantWorld = WORLD } = {}) {
  const pages = (await list()).filter((t) => t.type === "page");
  const wanted = pageUrl.split("?")[0];
  let target = pages.find((t) => t.url.split("?")[0] === wanted)
    || pages.find((t) => t.url.split("?")[0].startsWith(wanted));
  if (!target && create) {
    const created = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(pageUrl)}`, { method: "PUT" })
      .then((r) => r.json()).catch(() => null);
    if (created && created.id) target = { id: created.id, webSocketDebuggerUrl: created.webSocketDebuggerUrl, url: pageUrl };
    for (let i = 0; i < 20 && !target; i++) {
      await sleep(300);
      target = (await list()).find((t) => t.id === created?.id) || null;
    }
  }
  if (!target) throw new Error(`no page target for ${pageUrl}`);
  const pg = await attach(target.webSocketDebuggerUrl);
  pg.targetId = target.id;
  await pg.send("Runtime.enable");
  let ctxs = [];
  let topFrameId = "";
  let world = [];
  for (let attempt = 0; attempt < 12; attempt++) {
    await sleep(attempt ? 1500 : DELAY);
    ctxs = pg.raw.filter((m) => m.method === "Runtime.executionContextCreated").map((m) => m.params.context);
    if (!topFrameId) {
      const tree = await pg.send("Page.getFrameTree").catch(() => null);
      topFrameId = (tree && tree.frameTree && tree.frameTree.frame && tree.frameTree.frame.id) || "";
    }
    // "main world" and "isolated world" are per FRAME: a page has several default
    // contexts (the top document plus about:blank/iframe documents), and picking the
    // first one measured `location.href === "about:blank"` with an empty DOM.
    const inTop = (c) => !topFrameId || (c.auxData && c.auxData.frameId === topFrameId);
    const isolated = ctxs.filter((c) => c.auxData && c.auxData.isDefault === false);
    const others = isolated.filter((c) => globalThis.__extId && c.origin !== `chrome-extension://${globalThis.__extId}`);
    if (others.length && !globalThis.__warnedForeign) {
      globalThis.__warnedForeign = true;
      console.log(`  note: ${others.length} isolated world(s) from OTHER extensions in this profile: ${others.map((c) => c.name || c.origin).join(", ")}`);
    }
    world = wantWorld === "isolated"
      ? isolated.filter((c) => inTop(c) && (!globalThis.__extId || c.origin === `chrome-extension://${globalThis.__extId}`))
        .concat(isolated.filter(inTop), isolated)
      : ctxs.filter((c) => c.auxData && c.auxData.isDefault === true && inTop(c))
        .concat(ctxs.filter((c) => c.auxData && c.auxData.isDefault === true));
    if (world.length) {
      // A freshly created tab exposes a default top context for `about:blank` BEFORE
      // its real document exists, and that context satisfies every filter above - so
      // the whole first step then evaluates in an empty DOM. Measured 2026-09-22: the
      // first step's `wait` on a brand-new page timed out at 8s while the very same
      // selector was present a second later, because the poll ran in `about:blank`.
      // Accept the world only once it answers with the page we asked for.
      if (!pageUrl || pageUrl === "about:blank") break;
      const href = await pg.send("Runtime.evaluate", { expression: "location.href", contextId: world[0].id, returnByValue: true })
        .then((r) => (r && r.result && r.result.value) || null).catch(() => null);
      if (href && href !== "about:blank") break;
    }
  }
  return { pg, ctxs, world, topFrameId, target };
}

const evalIn = async (session, expression, contextId, { label = "" } = {}) => {
  const params = { expression, returnByValue: true, awaitPromise: true };
  if (contextId) params.contextId = contextId;
  const r = await session.send("Runtime.evaluate", params);
  if (r && r.exceptionDetails) {
    const text = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
    console.error(`  exception${label ? ` (${label})` : ""}: ${text}`);
    process.exitCode = 1;
    return { ok: false, error: text };
  }
  return { ok: true, value: r?.result?.value };
};
// `JSON.stringify(undefined)` is `undefined`, so the old one-liner threw
// "Cannot read properties of undefined (reading 'slice')" on any step whose eval
// returned nothing - and it threw BEFORE the step's own result could be seen, so
// the crash masked the page state the step existed to report (measured 2026-10-07:
// a probe run died exactly there). Print undefined as itself.
const show = (v) => console.log("  result: " + (v === undefined ? "undefined" : JSON.stringify(v).slice(0, 2000)));

// ── is the page BLOCKED, or merely empty? ─────────────────────────────────────
// A challenge interstitial is a real page with a real title, and it is the most
// common reason a run reads as "the extension does nothing" when the truth is
// "the site never let us in". Name it instead of guessing: the markers below are
// the title/body phrases plus the challenge DOM and its script, matched
// case-insensitively, and a positive answer is reported wherever a wait gave up.
const CHALLENGE_PROBE = `(() => {
  try {
    const title = (document.title || "");
    const body = (document.body && document.body.innerText) || "";
    const hay = (title + " " + body).toLowerCase();
    const marks = [];
    if (/just a moment|attention required|checking your browser|verify you are human|enable javascript and cookies|ddos protection|one more step/.test(hay)) marks.push("text");
    if (document.querySelector('#challenge-form,#challenge-stage,#cf-challenge-running,#cf-please-wait,.cf-browser-verification,[data-translate="challenge-running"]')) marks.push("dom");
    if (document.querySelector('script[src*="/cdn-cgi/challenge-platform"],script[src*="challenges.cloudflare.com"]')) marks.push("script");
    return JSON.stringify({ challenge: marks.length > 0, marks, title, href: location.href });
  } catch (e) { return JSON.stringify({ challenge: false, error: String((e && e.message) || e) }); }
})()`;
// A dead context must make this probe say "I could not tell", never "no challenge".
// `send` resolves with {error} instead of throwing, so the old `r.result.value ||
// {challenge:false}` default turned a stale context id into a confident "the predicate
// simply is not true yet" - the one message that is wrong exactly when a human is
// looking at a challenge we failed to name. Fall back to the default context first.
async function challengeInfo(session, contextId) {
  const ask = async (ctx) => {
    const r = await session.send("Runtime.evaluate", {
      expression: CHALLENGE_PROBE, ...(ctx ? { contextId: ctx } : {}), returnByValue: true, awaitPromise: true,
    });
    const v = (r && !r.error && r.result && r.result.value) || null;
    return v ? JSON.parse(v) : null;
  };
  try {
    let info = await ask(contextId).catch(() => null);
    if (!info && contextId) info = await ask(null).catch(() => null);
    return info || { challenge: false, probeFailed: true };
  } catch { return { challenge: false, probeFailed: true }; }
}

try {
  const found = await findSW();
  if (!found) {
    reportStderr();
    throw new Error("extension SW not found - extension failed to load?");
  }
  console.log(`extension: "${found.name}", SW ${found.target.id}`);
  spawnedPid = (await browserPid()) || spawnedPid;
  console.log(`  browser pid ${spawnedPid || "(unknown)"}`);
  // HERE, not at launch: the CDP endpoint is provably answering by now (findSW and
  // browserPid above just used it). Calling it right after spawn raced the endpoint
  // and failed with "fetch failed", so the redirect silently did not happen and 18
  // lab files landed in the owner's real download folder (measured 2026-10-08).
  await redirectDownloads();

  // ── did `--headless` actually take effect? ────────────────────────────────
  // The flag being PRESENT in the child's command line proves nothing (a host
  // may accept and ignore it). What proves it is the screen the renderer sees:
  // headless synthesises `screen` from `--window-size`, a real window reports the
  // monitor. Measured 2026-10-07: with `--headless=new` on Edge 154 a VISIBLE
  // window appeared, so "I passed the flag" was not a claim worth making. This
  // check is what makes the claim checkable - and the run says so loudly when it
  // cannot justify it, because a visible window can steal the user's focus.
  if (HEADLESS) {
    try {
      const pages = (await list()).filter((x) => x.type === "page");
      if (!pages.length) throw new Error("no page target to measure the screen with");
      const pg = await attach(pages[0].webSocketDebuggerUrl);
      await pg.send("Runtime.enable");
      const r = await pg.send("Runtime.evaluate", {
        expression: "JSON.stringify({screen:[screen.width,screen.height],outer:[outerWidth,outerHeight]})",
        returnByValue: true,
      });
      const v = JSON.parse(r?.result?.value || "{}");
      // A windowed browser reports the REAL monitor as `screen`; headless
      // synthesises it (Chromium's default is 800x600 unless --window-size moves
      // it). So the discriminator is "does screen match a monitor", and the one
      // value that is known NOT to be a monitor here is headless' own default -
      // measured 2026-10-07 with plain --headless: screen [800,600], outer
      // [1100,820] (the requested window size), i.e. headless and no window.
      const s0 = v.screen || [0, 0];
      const headless = s0[0] === 800 && s0[1] === 600;
      console.log(`  headless self-check: screen ${JSON.stringify(v.screen)} outer ${JSON.stringify(v.outer)} -> `
        + (headless
          ? "HEADLESS confirmed (screen is Chromium's synthesised 800x600 default; no window exists)"
          : "screen reports what looks like a REAL monitor - this host may be ignoring --headless.\n        !!! If a window is on the user's screen, do not run steps that steal focus."));
      try { pg.ws.close(); } catch {}
    } catch (e) {
      console.log(`  headless self-check could not run (${(e && e.message) || e}) - headless is therefore UNPROVEN for this run`);
    }
  }

  let s = await attach(found.target.webSocketDebuggerUrl);
  await s.send("Runtime.enable");
  // The documented availability check: CALL a method inside try/catch. Merely
  // reading the property is not a probe - on Chrome/Chromium < 138 the property
  // ACCESS throws ("The 'userScripts' API is only available for users in developer
  // mode"), which made the whole expression throw, `state:` print `undefined`, and
  // the run continue with a bogus "grant missing" verdict. Measured on Chrome for
  // Testing 137, 2026-10-07. Also captures the two different gates as text, because
  // they need different words for the human: < 138 is the GLOBAL developer mode,
  // >= 138 is the per-extension "Allow User Scripts" toggle.
  const st = await s.send("Runtime.evaluate", {
    expression: `(function () {
      var us = false, err = null;
      try { chrome.userScripts.getScripts(); us = true; } catch (e) { err = String((e && e.message) || e); }
      var m = chrome.runtime.getManifest();
      return JSON.stringify({ userscriptAPI: us, userScriptsError: err, version: m.version, id: chrome.runtime.id });
    })()`,
    returnByValue: true,
  });
  console.log("state:", st.result?.value);
  let extId = null;
  try { extId = JSON.parse(st.result.value).id; } catch {}
  if (extId) {
    globalThis.__extId = extId;
    // H-2: print only what THIS manifest actually names - the old hardcoded
    // "(popup.html, options.html, ...)" promised an options page that may not exist.
    const mp = (m) => [m?.options_ui?.page, m?.options_page, m?.action?.default_popup].filter(Boolean);
    const named = mp(EXT_MANIFEST).length ? mp(EXT_MANIFEST).join(", ") : "none named by the manifest";
    console.log(`extension pages: chrome-extension://${extId}/ (${named})`);
  }
  // P1 (guest feedback 2026-10-13, report #4): the profile serves the copy it was INSTALLED
  // with, so a stale --profile makes an edit silently not take effect - and nothing could
  // tell fresh from stale (five fresh profiles were burned on exactly that). Compare the
  // on-disk manifest with the loaded copy every run; cheapest possible "did my edit load?".
  if (EXT_MANIFEST?.version && extId) {
    let loadedV = null;
    try { loadedV = JSON.parse(st.result.value).version; } catch {}
    if (loadedV && loadedV !== EXT_MANIFEST.version) {
      console.log(`  !!! extension copy: disk v${EXT_MANIFEST.version} != loaded v${loadedV}`);
      console.log(`        The RUNNING browser holds the copy it read at ITS STARTUP --load-extension re-reads disk`);
      console.log(`        on every launch (measured 2026-10-13), so this mismatch means you are attached to a browser`);
      console.log(`        launched before the edit. Close the kept instance (--close) and relaunch; "the edit did not`);
      console.log(`        take effect" here is a stale INSTANCE, not a code problem.`);
    } else if (loadedV) {
      console.log(`  extension copy: disk v${EXT_MANIFEST.version} == loaded v${loadedV}`);
    }
  }
  // The one thing only a human can do - measured 2026-09-19: on Chrome 138+ the
  // "Allow User Scripts" toggle lives on the extension's own details page and CDP
  // cannot drive chrome:// pages. Say it loudly, with the exact next step, because
  // an extension whose content scripts never registered looks perfectly alive.
  // ── the userScripts grant: the ONE thing this tool cannot click for you ─────
  // Chrome/Edge >= 138 gate the userScripts API on a PER-EXTENSION, PER-PROFILE
  // toggle on the extension's own details page. There is no flag, no policy and
  // no CDP route (the page is chrome://; the documented route is the user
  // clicking it - developer.chrome.com/docs/extensions/reference/api/userScripts).
  // Two facts make that tolerable instead of a per-run chore:
  //   1. the grant is stored in the profile, so a scratch profile that PERSISTS
  //      needs the click ONCE - every later run just works;
  //   2. per the docs the already-running worker keeps the API undefined until its
  //      script context reloads, so the grant becomes visible only after a reload.
  // Hence the loop below: open the exact page, then poll by RELOADING the worker
  // and re-reading the API, so the run resumes by itself the moment it is granted.
  try {
    // H-1 (guest feedback 2026-10-10): the grant gate applies ONLY when the extension
    // DECLARES the userScripts permission. `chrome.userScripts === undefined` when the
    // permission is absent is "API not there", not "gate closed" - treating both the same
    // burned a whole 360s run on an extension that could never be granted (measured).
    const stObj = JSON.parse(st.result.value);
    const declaresUserScripts = (EXT_MANIFEST?.permissions || []).includes("userScripts")
      || (EXT_MANIFEST?.optional_permissions || []).includes("userScripts");
    if (!stObj.userscriptAPI && !declaresUserScripts) {
      console.log("  userScripts not declared in the manifest - the grant gate does not apply;");
      console.log("        content scripts (if any) come from manifest content_scripts, not userScripts.");
    } else if (!stObj.userscriptAPI) {
      const why = (stObj.userScriptsError || "") + "";
      const globalGate = /developer mode/i.test(why);
      if (GRANT_TIMEOUT <= 0) {
        console.log(`  GRANT NEEDED: chrome.userScripts is UNAVAILABLE in this profile - the extension's`);
        console.log(`        user scripts will NOT register until the browser's own gate is open.`);
        console.log(`        --grant-timeout 0: not waiting for it, and this is NOT a failed run - the`);
        console.log(`        extension may legitimately need its human. Everything measured below is valid`);
        console.log(`        for the parts that do not depend on user scripts.`);
      } else {
      console.log(`  GRANT NEEDED: chrome.userScripts is UNAVAILABLE in this profile - the extension's`);
      console.log(`        user scripts will NOT register until the browser's own gate is open:`);
      console.log(globalGate
        ? `        this build uses the GLOBAL Developer-mode toggle (Chrome/Chromium < 138):`
        : `        this build uses the per-extension "Allow User Scripts" toggle (Chrome/Edge >= 138):`);
      console.log(globalGate
        ? `        chrome://extensions -> Developer mode ON (one toggle for the whole profile).`
        : `        chrome://extensions -> Details -> "Allow User Scripts" (per extension, per profile).`);
      if (extId) {
        const detailsUrl = `chrome://extensions/?id=${extId}`;
        // Opened through the HTTP endpoint, the same way --open does it: a
        // Target.createTarget issued on a target-scoped socket is not guaranteed
        // to be a browser-level command, and a silent failure here would be
        // indistinguishable from "the click did not happen".
        await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(detailsUrl)}`, { method: "PUT" })
          .catch((e) => console.log(`        (could not open the details page: ${e && e.message})`));
        console.log(`        opened: ${detailsUrl}`);
      }
      console.log(`        this is a ONE-TIME click for this profile (${PROFILE}); the grant is stored in it,`);
      console.log(`        so keep the profile and no later run will need it. Waiting up to ${Math.round(GRANT_TIMEOUT / 1000)}s for it...`);
      const g0 = Date.now();
      let granted = false;
      while (Date.now() - g0 < GRANT_TIMEOUT) {
        await sleep(3000);
        try {
          // Reload so the grant becomes observable (see point 2 above).
          // The response to `chrome.runtime.reload()` NEVER arrives when the
          // reload is honoured - it tears down the very worker that would answer,
          // and awaiting it hangs the run with the browser left open (measured
          // 2026-10-07: the loop stalled right here and an orphan Edge survived
          // with an empty state file). Fire it, wait a bounded moment, move on.
          await Promise.race([
            s.send("Runtime.evaluate", { expression: "chrome.runtime.reload()" }).catch(() => {}),
            sleep(2000),
          ]);
          try { s.ws.close(); } catch {}
          const f2 = await findSW(found.target.id, undefined, swFoundOnce);
          if (!f2) continue;
          const s2 = await attach(f2.target.webSocketDebuggerUrl);
          await s2.send("Runtime.enable");
          const chk = await Promise.race([
            s2.send("Runtime.evaluate", { expression: "!!(chrome.userScripts && chrome.userScripts.executeScript)", returnByValue: true }),
            sleep(5000).then(() => null),
          ]);
          if (chk?.result?.value) { granted = true; s = s2; break; }
          try { s2.ws.close(); } catch {}
        } catch (e) {
          console.log(`        (grant poll cycle failed: ${(e && e.message) || e})`);
        }
      }
      if (granted) console.log("  GRANT DETECTED: user scripts can register now - continuing the run");
      else {
        // H-1: a closed gate makes LATER user-script steps meaningless, but everything already
        // measured (SW state, extension pages, --eval in the worker) stays valid - the run
        // itself did not fail. Only a run that was ASKED to wait (GRANT_TIMEOUT > 0) and still
        // missed the gate reports it this loudly.
        console.log(`  GRANT STILL MISSING after ${Math.round((Date.now() - g0) / 1000)}s - user-script-dependent`);
        console.log(`        steps below are about a dead extension (its content scripts never registered),`);
        console.log(`        NOT about the extension's code. Worker state and extension pages remain valid.`);
      }
      } // GRANT_TIMEOUT > 0
    }
  } catch (e) { console.log(`  (grant check failed: ${(e && e.message) || e})`); }

  if (RELOAD) {
    await s.send("Runtime.evaluate", { expression: "chrome.runtime.reload()" }).catch(() => {});
    try { s.ws.close(); } catch {}
    const f2 = await findSW(found.target.id, undefined, swFoundOnce);
    if (!f2) throw new Error("no fresh SW after reload");
    console.log(`fresh SW after reload: ${f2.target.id}`);
    s = await attach(f2.target.webSocketDebuggerUrl);
    await s.send("Runtime.enable");
    // Boot logs from t=0 are the point of a reload: drain them before anything else
    // (the SW is silent until work arrives, so an empty console here is normal).
    await sleep(600);
    for (const l of drain(s)) console.log("  " + l);
  }

  if (OPEN) {
    await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(OPEN)}`, { method: "PUT" });
    console.log("opened:", OPEN);
  }

  // ── the extension's own page as a driver ────────────────────────────────────
  // The path is NEVER guessed. A wrong URL does not fail loudly - it opens a
  // chrome-error page, where `chrome.runtime` is undefined and every --msg dies
  // with "Cannot read properties of undefined (reading 'sendMessage')" (measured
  // 2026-09-21). So: the manifest when we launched, the kept record when we
  // attached, and otherwise the worker's own answer about its options page.
  // H-2 (guest feedback 2026-10-10): never invent a page the manifest does not name.
  // The old "if (!extPagePath) extPagePath = 'options.html'" silently opened a chrome-error
  // page for extensions that have none (measured: "Cannot read properties of undefined
  // (reading 'sendMessage')" and a dead --msg). Popup is a first-class driver: a
  // chrome.runtime.sendMessage from it reaches the SW (measured).
  const manifestPage = (m) => (m?.options_ui?.page || m?.options_page || m?.action?.default_popup || null);
  let extPagePath = manifestPage(EXT_MANIFEST) || stateEntry?.optionsPage || null;
  if (!extPagePath) {
    // ask the live worker itself - it knows its manifest even when --attach has none
    extPagePath = await s.send("Runtime.evaluate", {
      expression: `(function(){try{var m=chrome.runtime.getManifest();return (m.options_ui&&m.options_ui.page)||m.options_page||(m.action&&m.action.default_popup)||null}catch(e){return null}})()`,
      returnByValue: true,
    }).then((r) => r?.result?.value || null).catch(() => null);
  }
  globalThis.__optionsPage = extPagePath;
  const extPageUrl = extId ? (extPagePath ? `chrome-extension://${extId}/${extPagePath}` : null) : null;
  console.log(extPageUrl
    ? `  extension page (driver): ${extPageUrl}`
    : `  extension page (driver): NONE - the manifest names no options page and no popup;`);
  if (!extPageUrl) console.log(`        --msg / target ext will fail loudly ("no extension page known") instead of opening a chrome-error page.`);

  // ── --msg: ask the product something and print the answer ───────────────────
  if (MSG_JSON) {
    if (!extPageUrl) throw new Error("--msg needs the extension id (start with --ext, not --attach without state)");
    const { pg, world } = await resolveWorld(extPageUrl);
    const ctx = world[0];
    console.log(`\nmsg: ${MSG_JSON}  (from ${extPageUrl}${ctx ? `, context ${ctx.id}` : ""})`);
    const expression = `new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(${MSG_JSON}, (response) => {
          const err = chrome.runtime.lastError && chrome.runtime.lastError.message;
          resolve(JSON.stringify({ ok: !err, error: err || null, response: response === undefined ? null : response }));
        });
      } catch (e) { resolve(JSON.stringify({ ok: false, error: String(e && e.message || e), response: null })); }
    })`;
    const timeout = new Promise((resolve) => setTimeout(() => resolve(`{"ok":false,"error":"no response within ${MSG_AWAIT}ms","response":null}`), MSG_AWAIT));
    const r = await Promise.race([
      pg.send("Runtime.evaluate", { expression, contextId: ctx?.id, returnByValue: true, awaitPromise: true }).then((x) => x?.result?.value),
      timeout,
    ]);
    console.log("  answer: " + String(r).slice(0, 4000));
    try { pg.ws.close(); } catch {}
    // H-5 (guest feedback 2026-10-10): the old check required /"ok":true/ - a product that
    // answers {"ok":false,...} or its own protocol ({"status":"error",...}) IS answering;
    // that is data, not a failed run. Only NO answer (timeout/undefined) fails the run.
    if (r === undefined || r === null || r === "undefined") {
      console.log("  msg: NO ANSWER - the run fails (nothing came back)");
      process.exitCode = 1;
    } else if (/"ok":\s*false|"error"\s*:|"status"\s*:\s*"error"/.test(String(r))) {
      console.log("  msg: answered with an error payload - recorded as data; exit code stays 0");
    }
    if (!WATCH_GIVEN) { closeAll(); await sleep(80); reportStderr(); await stop("after --msg"); process.exit(process.exitCode || 0); }
  }

  // ── one predicate parse for every wait loop (F1 completion, guest feedback 2026-10-12) ──
  // The transport resolves Runtime.evaluate with `m.result ?? m`, so exceptionDetails sits at
  // the TOP level of the response. A predicate that cannot compile (top-level await, a typo) or
  // throws every tick can never become true - all three wait loops (pollUntil, --wait-for sw,
  // --wait-for page) must fail it at once with the reason, not burn the timeout.
  const evalPredicate = async (send, expression, contextId) => {
    const r = await send("Runtime.evaluate", {
      expression, ...(contextId ? { contextId } : {}), returnByValue: true, awaitPromise: true,
    });
    if (r && r.error) return { dead: true, why: r.error.message || String(r.error.code) };
    const ex = r?.exceptionDetails;
    if (ex) return { threw: true, why: `predicate threw: ${ex.exception?.description || ex.text}` };
    return { value: r?.result?.value };
  };

  // ── --target sw: the worker's own state ────────────────────────────────────
  if (TARGET === "sw" && (EVAL || WAIT_FOR)) {
    if (WAIT_FOR) {
      const t0 = Date.now();
      let ok = false;
      while (Date.now() - t0 < WAIT_TIMEOUT) {
        const res = await evalPredicate((m, p) => s.send(m, p), WAIT_FOR, null);
        if (res.threw) {
          console.log(`\nwait-for (sw): FAILED at once - ${res.why}`
            + (/await/.test(WAIT_FOR) && !/async/.test(WAIT_FOR) ? " (top-level await? wrap the predicate in (async () => …)())" : ""));
          process.exitCode = 1;
          break;
        }
        if (res.value) { ok = true; break; }
        await sleep(300);
      }
      if (!ok && !process.exitCode) { console.log(`\nwait-for (sw): TIMED OUT after ${Date.now() - t0}ms`); process.exitCode = 1; }
      else if (ok) console.log(`\nwait-for (sw): true after ${Date.now() - t0}ms`);
    }
    if (EVAL) {
      console.log(`\neval (service worker):`);
      const r = await evalIn(s, EVAL, null, { label: "sw" });
      if (r.ok) show(r.value);
      if (OUT_JSON) { fs.writeFileSync(OUT_JSON, JSON.stringify(r.ok ? r.value : { error: r.error || "eval failed" }, null, 2)); console.log(`  out-json: written ${OUT_JSON}`); }
    }
    // closeAll() then a tick before exit: closing the worker's WebSocket and
    // process.exit() in the same tick makes node assert on Windows
    // (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`), which looks like
    // the tool crashing right after it worked.
    if (!WATCH_GIVEN) { closeAll(); await sleep(80); reportStderr(); await stop("after --eval (sw)"); process.exit(process.exitCode || 0); }
  }

  // ── --eval / --wait-for / --shot in a page (or the extension's own page) ────
  if ((EVAL && TARGET !== "sw") || SHOT || (WAIT_FOR && TARGET !== "sw") || TARGET === "ext") {
    const pageUrl = opt("--url", TARGET === "ext" ? extPageUrl : (OPEN || "about:blank"));
    console.log(`\npage: ${pageUrl}`);
    const { pg, ctxs, world, topFrameId } = await resolveWorld(pageUrl);
    console.log(`  execution contexts (${ctxs.length}):`);
    for (const c of ctxs) {
      const frame = c.auxData && c.auxData.frameId ? c.auxData.frameId.slice(0, 8) : "?";
      const top = c.auxData && c.auxData.frameId === topFrameId ? " TOP" : "";
      console.log(`    context ${c.id}: default=${c.auxData ? c.auxData.isDefault : "?"} type=${c.auxData ? c.auxData.type : "?"} frame=${frame}${top} origin=${c.origin} name="${c.name || ""}"`);
    }
    // P4 (guest feedback 2026-10-13): the list above is ONE early snapshot - across one
    // session it read "contexts (5)" 11 times and "(2)" 9 times while every run worked,
    // so it cannot be read as an injection verdict. Name the manifest's own count and
    // offer a delayed re-scan (--contexts <sec>).
    if (EXT_MANIFEST?.content_scripts) console.log(`  manifest content_scripts: ${EXT_MANIFEST.content_scripts.length} set(s); the list above is one EARLY snapshot - isolated contexts can attach later`);
    if (CONTEXTS_WAIT > 0) {
      console.log(`  --contexts: waiting ${CONTEXTS_WAIT}s, then re-scanning...`);
      await sleep(CONTEXTS_WAIT * 1000);
      const ctxs2 = pg.raw.filter((m) => m.method === "Runtime.executionContextCreated").map((m) => m.params.context);
      console.log(`  execution contexts AFTER ${CONTEXTS_WAIT}s (${ctxs2.length}):`);
      for (const c of ctxs2) {
        const frame = c.auxData && c.auxData.frameId ? c.auxData.frameId.slice(0, 8) : "?";
        const top = c.auxData && c.auxData.frameId === topFrameId ? " TOP" : "";
        console.log(`    context ${c.id}: default=${c.auxData ? c.auxData.isDefault : "?"} type=${c.auxData ? c.auxData.type : "?"} frame=${frame}${top} origin=${c.origin} name="${c.name || ""}"`);
      }
    }
    if (WAIT_FOR) {
      if (!world || !world.length) throw new Error(`no ${WORLD} world context found on ${pageUrl}`);
      const t0 = Date.now();
      let ok = false;
      let failedAt = null;
      while (Date.now() - t0 < WAIT_TIMEOUT) {
        const res = await evalPredicate((m, p) => pg.send(m, p), WAIT_FOR, world[0].id);
        if (res.threw) {
          failedAt = res.why;
          console.log(`  wait-for: FAILED at once - ${res.why}`
            + (/await/.test(WAIT_FOR) && !/async/.test(WAIT_FOR) ? " (top-level await? wrap the predicate in (async () => …)())" : ""));
          process.exitCode = 1;
          break;
        }
        if (res.value) { ok = true; break; }
        await sleep(300);
      }
      if (!failedAt) console.log(`  wait-for: ${ok ? "true" : "TIMED OUT"} after ${Date.now() - t0}ms`);
      if (!ok) {
        process.exitCode = 1;
        const info = await challengeInfo(pg, world[0].id);
        if (info && info.challenge)
          console.log(`  NOTE: this looks like a CHALLENGE page (${(info.marks || []).join(",")}) on ${info.href} - the site never let us in, so a mute timeout is expected`);
      }
    }
    if (EVAL) {
      if (!world || !world.length) throw new Error(`no ${WORLD} world context found on ${pageUrl}`);
      const ctx = world[0];
      console.log(`  evaluating in the ${WORLD} world (context ${ctx.id}, origin ${ctx.origin})`);
      const r = await evalIn(pg, EVAL, ctx.id, { label: `${WORLD} world` });
      if (r.ok) show(r.value);
      if (OUT_JSON) { fs.writeFileSync(OUT_JSON, JSON.stringify(r.ok ? r.value : { error: r.error || "eval failed" }, null, 2)); console.log(`  out-json: written ${OUT_JSON}`); }
    }
    if (SHOT) {
      await pg.send("Page.enable");
      const shot = await pg.send("Page.captureScreenshot", { format: "png" });
      const b64 = shot && shot.data;
      if (!b64) throw new Error("Page.captureScreenshot returned no data");
      const bytes = Buffer.from(b64, "base64");
      const slug = pageUrl.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "page";
      const file = SHOT === "auto"
        ? path.join(process.cwd(), ".ext-dev-loop", "shots", `${new Date().toISOString().replace(/[:.]/g, "-")}-${slug}.png`)
        : path.resolve(SHOT);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
      console.log(`  screenshot: ${file} (${bytes.length} bytes)`);
    }
    try { pg.ws.close(); } catch {}
    if (!WATCH_GIVEN) { closeAll(); await sleep(80); reportStderr(); await stop(EVAL || WAIT_FOR ? "after --eval" : "after --shot"); process.exit(process.exitCode || 0); }
  }

  // ── --script: the whole loop in ONE invocation ──────────────────────────────
  if (SCRIPT_STEPS) {
    console.log(`\nscript: ${SCRIPT_STEPS.length} step(s) from ${SCRIPT}` + (FROM > 1 ? ` (resuming at step ${FROM})` : ""));
    // Every page step attaches its OWN session, and Chrome REPLAYS its console
    // buffer to each fresh Runtime.enable - so the same line arrives once per
    // later step. Printing it again would make a 2-line page look like a 6-line
    // one and bury the one line that is new. Dedupe within the run; say how many
    // were suppressed instead of dropping them silently.
    const emitted = new Set();
    const freshLines = (lines) => {
      const fresh = lines.filter((l) => !emitted.has(l));
      for (const l of fresh) emitted.add(l);
      if (lines.length > fresh.length) console.log(`    (${lines.length - fresh.length} replayed line(s) suppressed - Runtime.enable replays the buffer per session)`);
      return fresh;
    };
    for (let i = 0; i < SCRIPT_STEPS.length; i++) {
      if (FROM && i + 1 < FROM) { console.log(`\n[step ${i + 1}/${SCRIPT_STEPS.length}] skipped (--from ${FROM})`); continue; }
      const step = SCRIPT_STEPS[i];
      const where = step.target || "page";
      console.log(`\n[step ${i + 1}/${SCRIPT_STEPS.length}]${step.note ? " " + step.note : ""}  (${where})`);
      const world0 = step.in || "main";
      // One evaluation of the predicate. A CDP failure does NOT reject here: send()
      // RESOLVES with {error:{code,message}} (measured - a try/catch alone is dead
      // code and the failure looks exactly like "not true yet").
      const pollOnce = async (session, expr, contextId) => {
        const r = await session.send("Runtime.evaluate", {
          expression: expr, ...(contextId ? { contextId } : {}), returnByValue: true, awaitPromise: true,
        });
        if (r && r.error) return { dead: true, why: r.error.message || String(r.error.code) };
        // F1 (guest feedback 2026-10-11): an expression that does not COMPILE (top-level await,
        // a typo) arrives as exceptionDetails with value undefined. Polling treated it as
        // "not true yet" and silently burned the whole waitTimeout for a predicate that can never
        // become true (measured: 30 s + a wrong "flaky network" hypothesis). A dead predicate
        // must fail the wait at once.
        // NOTE on shape: the transport resolves Runtime.evaluate with `m.result ?? m`, so the
        // response here is {result: RemoteObject, exceptionDetails} - exceptionDetails is at the
        // TOP level, not inside .result (verified against live CDP: SyntaxError arrives as
        // {result:{subtype:"error"...}, exceptionDetails:{...}}).
        const ex = r?.exceptionDetails;
        if (ex) return { dead: true, why: `predicate threw: ${ex.exception?.description || ex.text}`, threw: true };
        return { value: r?.result?.value };
      };
      const pollUntil = async (session, contextId, expr, timeout, quiet = false) => {
        const t0 = Date.now();
        let ok = false;
        let fellBack = false;
        while (Date.now() - t0 < timeout) {
          let res = await pollOnce(session, expr, contextId)
            .catch((e) => ({ dead: true, why: String((e && e.message) || e) }));
          // The world can die under a long poll, and the human handover is the case
          // where it matters: a Cloudflare interstitial RELOADS ITSELF once solved,
          // which replaces the execution context (any tab navigation does the same).
          // Pinned to the old id every tick fails, the poll times out, and a SOLVED
          // challenge is reported as an unanswered ask. Re-ask in the session's
          // default context - after the reload that IS the page we care about.
          if (res.dead && contextId) {
            fellBack = true;
            res = await pollOnce(session, expr, null)
              .catch((e) => ({ dead: true, why: String((e && e.message) || e) }));
          }
          // F1: a predicate that THREW (does not compile / raises every tick) can never become
          // true - stop polling and fail loudly with the reason, do not burn the timeout.
          // A mere protocol `error` may be transient (context switch), so only `threw` aborts.
          if (res.threw) {
            console.log(`  wait: FAILED at once - ${res.why}`
              + (/await/.test(expr) && !/async/.test(expr) ? ` (top-level await? wrap the predicate in (async () => …)())` : ""));
            process.exitCode = 1;
            globalThis.__untilThrew = true;   // M3: ask's handover text must not blame a human for a broken predicate
            return false;
          }
          if (res.value) { ok = true; break; }
          await sleep(300);
        }
        console.log(`  wait: ${ok ? "true" : "TIMED OUT"} after ${Date.now() - t0}ms`
          + (fellBack ? (ok ? " (the context changed under the poll - continued in the new one)" : " (the context changed under the poll)") : ""));
        if (!ok && !quiet) process.exitCode = 1;
        return ok;
      };
      // The human handover. An `ask` that never comes true is NOT a failure and does
      // not close the browser: the caller gets a named ask plus a live port, hands the
      // window to the person, and resumes the same batch from this very step.
      const handover = async (session, contextId, askText) => {
        const info = await challengeInfo(session, contextId);
        console.log("");
        console.log("ASK UNANSWERED: " + askText);
        if (info && info.challenge) {
          console.log(`  blocked by a CHALLENGE (${(info.marks || []).join(",") || "?"}) on ${info.href || "?"}`);
          console.log(`  title: "${info.title || ""}"`);
          console.log("  the site never let us in, so anything measured past this point is about the challenge, not the extension");
        } else if (info && info.probeFailed) {
          console.log("  (challenge probe could not run - treating this as a plain unmet predicate)");
        } else {
          console.log("  (no challenge markers - the predicate simply is not true yet)");
        }
        if (ASK_KEEP) {
          keepOnAsk = true;
          process.exitCode = 3;
          console.log(`  HOLD (--ask-keep): browser KEPT on port ${PORT} - act in the window, then resume:`);
          console.log(`    node probe.mjs --attach --script ${SCRIPT} --from ${i + 1}`);
          console.log(`  close it later: node probe.mjs --close --port ${PORT}`);
          console.log("  exit 3 = needs a human, NOT a failure");
        } else {
          process.exitCode = 1;
          console.log(ATTACH
            ? "  the run ends here (the browser STAYS UP - it is a kept instance; resume with --attach)."
            : "  the run ends here (the browser was closed). Pass --ask-keep only if your shell returns");
          if (!ATTACH) console.log("  immediately - a kept browser hangs a caller that waits for the whole process tree.");
        }
      };
      if (where === "sw") {
        if (step.ask) { console.error("  `ask` needs a page - a human cannot act inside the service worker"); process.exitCode = 1; continue; }
        // H-3 (guest feedback 2026-10-10): `msg` in a sw step used to be silently dropped -
        // indistinguishable from "the extension did not answer". Say it loudly instead.
        if (step.msg) {
          console.error(`  msg is not supported for target sw - a runtime.sendMessage from the worker`);
          console.error(`        would loop back to OTHER contexts, not to the worker's own onMessage. Use a`);
          console.error(`        page/ext step (the driver page), or an eval step, for: ${JSON.stringify(step.msg)}`);
          process.exitCode = 1; continue;
        }
        if (step.wait) await pollUntil(s, null, step.wait, step.waitTimeout || WAIT_TIMEOUT);
        if (step.delay) await sleep(step.delay);
        // H1 (guest feedback 2026-10-12, report #3): the step file is a GATE, not an eye-protocol.
        // assert evaluates once (same evalPredicate as wait - one exception story) and fails the
        // run on a wrong VALUE; `expect` (optional JSON) demands strict equality.
        if (step.assert) {
          const res = await evalPredicate((m, p) => s.send(m, p), step.assert, null);
          if (res.dead || res.threw) { console.error(`  ASSERT BROKEN (cannot evaluate): ${res.why}`); process.exitCode = 1; }
          else if (step.expect !== undefined) {
            const same = JSON.stringify(res.value) === JSON.stringify(step.expect);
            console.log(same ? `  assert ok: ${JSON.stringify(res.value)}` : `  ASSERT FAILED: expected ${JSON.stringify(step.expect)}, actual ${JSON.stringify(res.value)}`);
            if (!same) process.exitCode = 1;
          } else if (!res.value) { console.error(`  ASSERT FAILED: value was ${JSON.stringify(res.value)}`); process.exitCode = 1; }
          else console.log(`  assert ok: ${JSON.stringify(res.value)}`);
        }
        if (step.eval) {
          const r = await evalIn(s, step.eval, null, { label: "sw" });
          if (r.ok) show(r.value);
        }
        // The worker's own console, drained after every worker step. Reading it
        // is how "the extension did nothing" becomes "it threw here": the
        // warning/error lines are already arriving (Runtime.enable ran above) and
        // were simply never printed.
        {
          const lines = freshLines(drain(s));
          if (lines.length) {
            console.log(`  worker console (${lines.length} line(s)):`);
            for (const l of lines) console.log("    " + l);
          }
        }
        continue;
      }
      // N5 (guest feedback 2026-10-12): a step without `url` used to fall back to about:blank,
      // silently reading an empty page while step 1 held a real one - a multi-step scenario
      // that declared `url` once then quietly tested the wrong document. Inherit the LAST
      // page step's url instead; "ext" keeps its own driver page.
      if (!step.url && where === "page" && globalThis.__lastPageUrl) globalThis.__curUrl = globalThis.__lastPageUrl;
      else if (step.url) globalThis.__curUrl = step.url;
      const pageUrl = step.url || (where === "ext" ? extPageUrl : (where === "page" ? (globalThis.__curUrl || "about:blank") : "about:blank"));
      if (where === "page" && pageUrl !== "about:blank") globalThis.__lastPageUrl = pageUrl;
      if (!pageUrl) { console.error("  no extension page known - start with --ext so the manifest can name it"); process.exitCode = 1; continue; }
      console.log(`  url: ${pageUrl}`);
      const { pg, ctxs, world } = await resolveWorld(pageUrl, { world: world0 });
      if (!world.length) { console.error(`  no ${world0} world context on ${pageUrl}`); process.exitCode = 1; try { pg.ws.close(); } catch {} continue; }
      const ctx = world[0];
      if (step.ask) {
        if (!step.until) {
          console.error("  a step with `ask` also needs `until` (the predicate that says the human is done)");
          process.exitCode = 1;
          try { pg.ws.close(); } catch {}
          continue;
        }
        const budget = step.waitTimeout || ASK_TIMEOUT;
        console.log(`  ASK: ${step.ask}`);
        console.log(`  waiting up to ${Math.round(budget / 1000)}s for a human in the visible window...`);
        globalThis.__untilThrew = false;
        const done = await pollUntil(pg, ctx.id, step.until, budget, true);
        if (!done) {
          if (globalThis.__untilThrew) {
            console.log(`  the predicate is BROKEN (it threw) - fix the until expression; there is nothing a human can do here.`);
            process.exitCode = 1;
            try { pg.ws.close(); } catch {}
            break;
          }
          await handover(pg, ctx.id, step.ask);
          try { pg.ws.close(); } catch {}
          break;
        }
        console.log("  ask: satisfied - continuing");
      }
      if (step.wait) {
        const ok = await pollUntil(pg, ctx.id, step.wait, step.waitTimeout || WAIT_TIMEOUT);
        if (!ok) {
          const info = await challengeInfo(pg, ctx.id);
          if (info && info.challenge)
            console.log(`  NOTE: this looks like a CHALLENGE page (${(info.marks || []).join(",")}) on ${info.href} - the site never let us in, so a mute timeout is expected`);
        }
      }
      // H1 (guest feedback 2026-10-12, report #3): the step file is a GATE, not an eye-protocol.
      // assert evaluates once (same evalPredicate as wait - one exception story) and fails the
      // run on a wrong VALUE; `expect` (optional JSON) demands strict equality.
      if (step.assert) {
        const res = await evalPredicate((m, p) => pg.send(m, p), step.assert, ctx.id);
        if (res.dead || res.threw) { console.error(`  ASSERT BROKEN (cannot evaluate): ${res.why}`); process.exitCode = 1; }
        else if (step.expect !== undefined) {
          const same = JSON.stringify(res.value) === JSON.stringify(step.expect);
          console.log(same ? `  assert ok: ${JSON.stringify(res.value)}` : `  ASSERT FAILED: expected ${JSON.stringify(step.expect)}, actual ${JSON.stringify(res.value)}`);
          if (!same) process.exitCode = 1;
        } else if (!res.value) { console.error(`  ASSERT FAILED: value was ${JSON.stringify(res.value)}`); process.exitCode = 1; }
        else console.log(`  assert ok: ${JSON.stringify(res.value)}`);
      }
      if (step.delay) await sleep(step.delay);
      if (step.eval) {
        console.log(`  world: ${world0} (context ${ctx.id})`);
        const r = await evalIn(pg, step.eval, ctx.id, { label: world0 });
        if (r.ok) show(r.value);
      }
      // A REAL pointer move in the page - see the header note on `mouse`. Two
      // positions, so a delta exists, and the pointer/mouse pair a page's own
      // listeners expect; a script that only synthesises one event can leave a
      // listener that needs movement unsatisfied.
      if (step.mouse) {
        let mx = step.x, my = step.y;
        if (step.mouseAt && (mx === undefined || my === undefined)) {
          const at = await pg.send("Runtime.evaluate", {
            expression: `(()=>{const e=document.querySelector(${JSON.stringify(step.mouseAt)});if(!e)return null;const r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)})})()`,
            contextId: ctx.id, returnByValue: true,
          }).then((x) => x?.result?.value).catch(() => null);
          try { const o = JSON.parse(at); if (o) { mx = o.x; my = o.y; } } catch {}
        }
        if (typeof mx !== "number") mx = 100;
        if (typeof my !== "number") my = 100;
        await pg.send("Page.bringToFront").catch(() => {});
        await pg.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5, button: "none", buttons: 0, pointerType: "mouse" }).catch(() => {});
        await sleep(120);
        await pg.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: mx, y: my, button: "none", buttons: 0, pointerType: "mouse" }).catch(() => {});
        console.log(`  mouse: moved to ${mx},${my}` + (step.mouseAt ? ` (center of ${step.mouseAt})` : "") + " - the page's own mousemove listeners see this");
      }
      // A REAL key press in the page. Needed because some extensions can only be
      // driven from inside the page (this one starts its scan on Ctrl+Q through its
      // own key handler, and its extension->content message channel does not reach a
      // USER_SCRIPT-world script at all). Recipe measured on this box (see the
      // repo's press-ctrlq.mjs): the tab must be brought to front, and `text` must be
      // supplied or the keydown is delivered to nobody. `keyText` overrides it.
      if (step.key) {
        const combo = String(step.key);
        const parts = combo.split("+");
        const name = parts.pop();
        const MODS = { ctrl: 2, alt: 1, shift: 8, meta: 4 };
        let modifiers = 0;
        for (const p of parts) modifiers |= (MODS[p.trim().toLowerCase()] || 0);
        const up = name.trim().toUpperCase();
        const isLetter = /^[A-Z]$/.test(up);
        const vk = isLetter ? up.charCodeAt(0) : ({ ENTER: 13, ESC: 27, TAB: 9, SPACE: 32 }[up] || 0);
        const k = {
          key: isLetter ? up.toLowerCase() : up.toLowerCase(),
          code: isLetter ? "Key" + up : up,
          windowsVirtualKeyCode: vk,
          nativeVirtualKeyCode: vk,
        };
        await pg.send("Page.bringToFront").catch(() => {});
        await sleep(400);
        const focused = await pg.send("Runtime.evaluate", { expression: "document.hasFocus()", contextId: ctx.id, returnByValue: true })
          .then((r) => r?.result?.value).catch(() => null);
        const text = step.keyText !== undefined ? step.keyText : (isLetter ? up.toLowerCase() : "");
        await pg.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers, text, unmodifiedText: up.toLowerCase(), ...k });
        await sleep(120);
        await pg.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, ...k });
        console.log(`  key: ${combo} dispatched (modifiers ${modifiers}, text ${JSON.stringify(text)}; document.hasFocus()=${focused})`);
        if (focused === false) console.log("        WARNING: the page reports no focus - a keydown may be delivered to nobody here");
        console.log("        (if nothing happens: a hotkey reaches nobody until the extension has BOOTED on the page -");
        console.log("         an extension that arms a mousemove listener at load needs a preceding `mouse` step)");
      }
      if (step.msg) {
        const json = JSON.stringify(step.msg);
        const expression = `new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage(${json}, (response) => {
              const err = chrome.runtime.lastError && chrome.runtime.lastError.message;
              resolve(JSON.stringify({ ok: !err, error: err || null, response: response === undefined ? null : response }));
            });
          } catch (e) { resolve(JSON.stringify({ ok: false, error: String(e && e.message || e), response: null })); }
        })`;
        const r = await Promise.race([
          pg.send("Runtime.evaluate", { expression, contextId: ctx.id, returnByValue: true, awaitPromise: true }).then((x) => x?.result?.value),
          new Promise((res) => setTimeout(() => res(`{"ok":false,"error":"no response within ${step.await || MSG_AWAIT}ms"}`), step.await || MSG_AWAIT)),
        ]);
        console.log(`  msg ${json} -> ${r === undefined ? "undefined (the page answered nothing)" : String(r).slice(0, 4000)}`);
        if (!/"ok":true/.test(String(r))) process.exitCode = 1;
      }
      if (step.shot) {
        await pg.send("Page.enable");
        const shot = await pg.send("Page.captureScreenshot", { format: "png" });
        const bytes = shot?.data ? Buffer.from(shot.data, "base64") : null;
        if (!bytes) { console.error("  screenshot failed"); process.exitCode = 1; }
        else {
          const file = path.resolve(step.shot === true ? path.join(process.cwd(), ".ext-dev-loop", "shots", `${new Date().toISOString().replace(/[:.]/g, "-")}-step${i + 1}.png`) : step.shot);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, bytes);
          console.log(`  screenshot: ${file} (${bytes.length} bytes)`);
        }
      }
      // ── the PAGE's own console, drained after every page step ────────────
      // Without this the script runner is blind exactly where it matters: the
      // step Runtime.enabled the page, so console lines and exceptions from the
      // page AND from the extension's isolated / USER_SCRIPT world are already
      // arriving - and were thrown away. A content script that fails during its
      // own init then looks like "nothing happened at all" (measured 2026-10-08:
      // a whole session chased a trigger that was really a silent failure nobody
      // was reading). Lines are attributed to the world they came from.
      {
        const pctx = new Map();
        for (const c of ctxs) pctx.set(c.id, ((c.auxData && c.auxData.isDefault === false) ? "isolated" : "main") + "#" + c.id);
        const lines = freshLines(taggedLines({ label: shortUrl(pageUrl), session: pg, ctxById: pctx }));
        if (lines.length) {
          console.log(`  page console (${lines.length} line(s) from ${shortUrl(pageUrl)}):`);
          for (const l of lines) console.log("    " + l);
        }
      }
      try { pg.ws.close(); } catch {}
    }
    if (!WATCH_GIVEN) { closeAll(); await sleep(80); reportStderr(); await stop("after --script"); process.exit(process.exitCode || 0); }
  }

  // ── --watch: every console, tagged by host ─────────────────────────────────
  console.log(`--- streaming console for ${WATCH / 1000}s (ctrl+c to stop) ---`);
  const targets = [{ label: "sw", session: s, ctxById: new Map() }];
  try {
    for (const t of (await list()).filter((x) => x.type === "page").slice(0, 5)) {
      try {
        const pg = await attach(t.webSocketDebuggerUrl);
        await pg.send("Runtime.enable");
        targets.push({ label: shortUrl(t.url), session: pg, ctxById: new Map() });
      } catch {}
    }
  } catch {}
  console.log(`  streaming: ${targets.map((t) => t.label).join(", ")}`);
  const t0 = Date.now(); let n = 0;
  while (Date.now() - t0 < WATCH) {
    for (const t of targets) {
      for (const l of taggedLines(t)) {
        if (MAX_LINES && n >= MAX_LINES) continue;
        console.log("  " + l); n++;
      }
    }
    await sleep(700);
  }
  console.log(`captured ${n} console lines${MAX_LINES && n >= MAX_LINES ? " (cap reached)" : ""}`);
  closeAll();
  reportStderr();
  await stop();
  process.exit(process.exitCode || 0);
} catch (e) {
  console.error("ERROR:", e.message);
  closeAll();
  await stop("error");
  process.exitCode = 1;
  // EXIT here. Setting exitCode alone leaves the loop alive (open CDP sockets,
  // the undici keep-alive pool, the browser helper's handles), so the run printed
  // its error, closed the browser and then HUNG until the internal 360s hard
  // timeout - measured 2026-10-07: two agent turns sat for 200-240s on a run that
  // was already finished. "Never hang an agent turn" is the promise; this line is
  // what keeps it. (The success paths already exit; this one did not.)
  process.exit(process.exitCode || 1);
}
