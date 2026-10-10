// Firefox backend for ext-dev-loop — WebDriver BiDi, zero deps (global WebSocket).
//
// WHY A SEPARATE MODULE, measured 2026-09-21 on Firefox 155.0.1 (Windows):
//   * Firefox answered the CDP endpoints with 404 with `remote.active-protocols`
//     unset, =1 and =3 — the only thing it announces on stderr is "WebDriver BiDi
//     listening on ws://127.0.0.1:<port>". CDP is gone from this build, so
//     probe.mjs's whole transport (http://127.0.0.1:<port>/json/list + CDP
//     WebSockets) cannot carry Firefox at all. Hence a second engine, not a branch.
//   * `webExtension.install` takes a PATH: our unpacked tree installs as a
//     TEMPORARY add-on and returns the gecko id (measured: imagus-reborn-md@sucotasch).
//     A temporary add-on does not survive the browser, which is good for a dev loop:
//     every run installs the tree as it is on disk right now, no reload step exists.
//   * `script.getRealms` refuses extension contexts: "does not support browsing
//     contexts in privileged scope", and without `-remote-allow-system-access` it
//     refuses with "System access is required" — BOTH were tried. So the extension
//     cannot be evaluated from inside (no `--target sw|ext`, no `--msg`) and the
//     content-script world is unreachable too (no `--in isolated`).
//   * What IS reachable: a real page's realm (`script.evaluate`), its console
//     (`log.entryAdded`, verified with a round-trip of our own console.log), every
//     extension tab as a browsing context with its moz-extension:// URL,
//     `browsingContext.captureScreenshot`, and — the channel that earned this module —
//     Firefox's own stderr, where an extension page that throws lands as
//     "JavaScript error: moz-extension://<uuid>/options/options.js, line 349: …".
//     That error is invisible to CDP-style testing and was the first bug this
//     backend found in our own extension, 4 runs out of 4.
//
// Everything a run does is a BATCH: launch, install, run the steps, kill the tree.
// `--keep`/`--attach` are refused with the reason instead of pretending (a BiDi
// session belongs to one socket; the runs here own the browser they started).
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXIT_OK = 0, EXIT_USAGE = 2, EXIT_FAIL = 1;
// 3 = the run stopped because a HUMAN is needed (a step with `ask` whose predicate
// never came true). It is deliberately not EXIT_FAIL: the caller must hand the
// window to a person and resume, which is a normal outcome, not a broken run.
const EXIT_ASK = 3;

// Noisy on every Windows launch, and none of it is about the extension.
const NOISE = /taskbar|window occlusion|RenderCompositor|headless mode|BiDi listening|GFX1-|shortcut|JavaScript warning|sandbox_|AUMID|WinRT/i;

// Is the page BLOCKED, or merely empty? Same markers as the CDP backend (title/body
// phrases plus the challenge DOM and its script), evaluated in a page realm. A
// challenge page has a title and a form, so "the extension does nothing" is often
// really "the site never let us in" - name it instead of guessing.
const FF_CHALLENGE_PROBE = `(() => {
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

const FF_PATHS = [
  "C:/Program Files/Mozilla Firefox/firefox.exe",
  "C:/Program Files (x86)/Mozilla Firefox/firefox.exe",
  path.join(os.homedir(), "AppData/Local/Mozilla Firefox/firefox.exe"),   // portable/dev builds
];

function findFirefox() {
  for (const p of FF_PATHS) if (fs.existsSync(p)) return p;
  return null;
}

// Version WITHOUT launching it (rule 2 of the skill: a launch is not a question).
function versionOf(exe) {
  try {
    const dir = path.dirname(exe);
    const ini = path.join(dir, "application.ini");
    if (fs.existsSync(ini)) {
      const m = fs.readFileSync(ini, "utf8").match(/^Version=(.+)$/m);
      if (m) return m[1].trim();
    }
    const dll = path.join(dir, "firefox.exe");
    const st = fs.statSync(dll);
    return "unknown (application.ini missing; exe " + st.size + " B)";
  } catch (e) {
    return "unknown (" + e.message + ")";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function main(argv) {
  const args = argv.slice();
  const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
  const flag = (name) => args.includes(name);

  const EXT = opt("--ext");
  const PORT = Number(opt("--port", "9796"));
  const HEADLESS = !flag("--visible");
  const DRY = flag("--dry-run");
  const JSON_OUT = flag("--json");
  const MAX_LINES = Number(opt("--max-lines", "0"));
  const HARD_TIMEOUT = Number(opt("--timeout", "0")) || 4 * 60 * 1000;
  // NOT `const URL`: that shadows the global URL constructor, and every host lookup
  // then threw into its own catch and printed "?" (found the hard way — one debug run).
  const PAGE_URL = opt("--url") || opt("--open");
  let EVAL = opt("--eval");
  const EVAL_FILE = opt("--eval-file");
  const SCRIPT = opt("--script");
  // --from <n>: resume a batch at the n-th step (1-based). A Firefox run cannot keep
  // its browser (--keep/--attach are refused by design), so a blocked `ask` ends the
  // run and the resume IS a new run - which re-opens the page and may therefore need
  // more than the blocked step. Pass the blocked step's number to re-check it first.
  const FROM = Number(opt("--from", "0")) || 0;
  const WAIT_FOR = opt("--wait-for");
  const WAIT_TIMEOUT = Number(opt("--wait-timeout", "15000"));
  const DELAY = Number(opt("--delay", "2500"));
  const shotIdx = args.indexOf("--shot");
  const SHOT = shotIdx < 0 ? false
    : (args[shotIdx + 1] && !args[shotIdx + 1].startsWith("--")) ? args[shotIdx + 1] : true;
  const STATE_FILE = path.resolve(opt("--state", path.join(process.cwd(), ".ext-dev-loop", "instances.json")));

  const EXT_ABS = EXT ? path.resolve(EXT) : null;
  const EXT_MANIFEST = EXT_ABS ? JSON.parse(fs.readFileSync(path.join(EXT_ABS, "manifest.json"), "utf8")) : null;
  const EXT_NAME = opt("--name") || (EXT_MANIFEST ? EXT_MANIFEST.name : null);

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

  // ── the registry: same shape as the CDP path, plus engine ────────────────────
  const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; } };
  const writeState = (all) => {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(all, null, 2));
  };

  const killTree = (pid) => {
    if (!pid) return false;
    try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); return true; }
    catch { return false; }
  };

  // ── refusals, all with the measured reason, all BEFORE any spawn ────────────
  const REFUSED = [
    ["--target sw|ext", "Firefox BiDi refuses privileged contexts: script.getRealms answers 'does not support browsing contexts in privileged scope' (with -remote-allow-system-access it answers 'System access is required'). The extension cannot be evaluated from inside, so there is no worker/page target to ask."],
    ["--msg", "asking the product a question needs an extension context, and Firefox does not expose one over BiDi (same measurement as --target ext). Drive a real page instead, or read the product's own diagnostics file."],
    ["--in isolated", "the content-script world is not reachable: content scripts are not browsing contexts, and the extension's own worlds need the userScripts grant, which is a browser UI action here."],
    ["--reload", "nothing to reload: a temporary add-on is installed fresh on every run, so the tree on disk is always what runs."],
    ["--keep", "a Firefox run owns its browser: the BiDi session belongs to this socket, so a kept browser could not be asked anything by a later run. Batch the questions with --script instead (one launch, many steps, browser closed at the end)."],
    ["--attach", "same reason as --keep: there is no second session to attach to, and the flag would look like it worked while talking to nothing."],
  ];
  for (const [name, why] of REFUSED) {
    const given = name.startsWith("--target") ? (args.includes("--target") && ["sw", "ext"].includes(opt("--target")))
      : name === "--in isolated" ? (opt("--in", "main") === "isolated")
        : flag(name);
    if (given) {
      console.error(`firefox: ${name} is not supported. ${why}`);
      return EXIT_USAGE;
    }
  }

  if (!EXT_ABS && !flag("--close")) {
    console.error("firefox: --ext <unpacked-ext-dir> is required (or --close [--port n]).");
    return EXIT_USAGE;
  }
  if (EXT_ABS && !fs.existsSync(path.join(EXT_ABS, "manifest.json"))) {
    console.error("firefox: no manifest.json under " + EXT_ABS);
    return EXIT_USAGE;
  }
  if (!SCRATCH_ROOTS.some((root) => isUnder(PROFILE, root))) {
    console.error("firefox: refusing a profile outside the scratch roots - " + PROFILE
      + "\n  allowed: " + SCRATCH_ROOTS.join("  |  "));
    return EXIT_USAGE;
  }

  const ff = findFirefox();
  const ffVersion = ff ? versionOf(ff) : null;

  // ── --close: end the instance this registry names, and only that one ────────
  if (flag("--close")) {
    const all = readState();
    const entry = all[String(PORT)];
    if (!entry) {
      console.error(`firefox --close: the registry has no instance on port ${PORT} (refusing to hunt by image name)`);
      return EXIT_USAGE;
    }
    const killed = killTree(entry.pid);
    delete all[String(PORT)];
    writeState(all);
    console.log(`firefox: closed port ${PORT} (pid ${entry.pid}) ${killed ? "" : "- pid was already gone; the record is removed either way"}`);
    return EXIT_OK;
  }

  if (DRY) {
    console.log("firefox plan (nothing is spawned):");
    console.log("  engine   : WebDriver BiDi (CDP is not available in this build)");
    console.log("  browser  : " + (ff || "(not found)") + (ffVersion ? "  v" + ffVersion : ""));
    console.log("  profile  : " + PROFILE);
    console.log("  extension: " + (EXT_ABS || "(none)")); 
    console.log("  headless : " + HEADLESS);
    console.log("  port     : " + PORT);
    return ff ? EXIT_OK : EXIT_USAGE;
  }
  if (!ff) {
    console.error("firefox: no firefox.exe found in " + FF_PATHS.join(", "));
    return EXIT_USAGE;
  }

  // ── console, stderr and the transcript ─────────────────────────────────────
  let lines = 0;
  const out = (tag, text) => {
    if (MAX_LINES && lines >= MAX_LINES) return;
    lines++;
    console.log(`[${tag}] ${text}`);
  };
  const results = [];
  const jsErrors = [];
  const contextsSeen = [];
  let failed = 0;
  let askBlocked = false;
  let ws = null, seq = 0, sessionId = null, extId = null, pageCtx = null, lastUrl = null;
  const ALLOW_JS_ERRORS = flag("--allow-js-errors");
  const pending = new Map();
  const sockets = [];

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, method });
    ws.send(JSON.stringify({ id, method, params }));
    const t = setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("timeout: " + method)); } }, 20000);
    t.unref?.();
  });

  // BiDi may hand back a RemoteValue (an object carrying `.value`) where a plain
  // string is expected — measured: our own console.log round-trip printed "page ?"
  // until this unwrapping was added, because `new URL({...})` throws.
  const asText = (v) => (v && typeof v === "object")
    ? (v.value == null ? "" : String(v.value))
    : (v == null ? "" : String(v));
  const hostOf = (u) => { try { const s = asText(u); return s ? (new URL(s).host || new URL(s).protocol.replace(":", "")) : "?"; } catch { return "?"; } };
  const flatContexts = (tree) => tree.contexts.flatMap((c) => [c, ...(c.children || [])]);

  const tick = () => new Promise((r) => setImmediate(r));

  let child = null;
  const doRun = async () => {
    fs.mkdirSync(PROFILE, { recursive: true });
    const launchArgs = ["--no-remote", "--profile", PROFILE, "--remote-debugging-port", String(PORT)];
    if (HEADLESS) launchArgs.unshift("--headless");
    launchArgs.push("about:blank");
    child = spawn(ff, launchArgs, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const spawnedPid = child.pid;
    child.stderr.on("data", (d) => {
      for (const raw of String(d).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || NOISE.test(line)) continue;
        if (/JavaScript error/i.test(line)) { jsErrors.push(line); out("ff js", line.replace(/^JavaScript error:\s*/i, "")); }
        else out("ff", line);
      }
    });

    // the BiDi endpoint: it comes up with the browser, and there is no HTTP list
    let opened = false;
    for (let i = 0; i < 60 && !opened; i++) {
      await sleep(400);
      let sock = null;
      try {
        sock = new WebSocket(`ws://127.0.0.1:${PORT}/session`);
        await new Promise((res, rej) => {
          sock.onopen = res;
          sock.onerror = () => rej(new Error("ws"));
        });
        ws = sock;
        sockets.push(sock);
        opened = true;
      } catch {
        try { sock && sock.close(); } catch {}
      }
    }
    if (!opened) throw new Error(`the BiDi socket never came up on port ${PORT} (another browser on this port? see scripts/instances.mjs)`);

    ws.onmessage = (m) => {
      let msg;
      try { msg = JSON.parse(m.data); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error} ${msg.message || ""}`));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method === "log.entryAdded") {
        const p = msg.params || {};
        const text = p.text != null ? p.text : (p.args || []).map((a) => a.value).join(" ");
        if (p.type === "javascript" && /JavaScript error/i.test(text)) jsErrors.push(text);
        // Measured: a page console entry can arrive without `source.url` (the first
        // smoke printed "page ?" for our own console.log round-trip), so fall back to
        // the page this run is sitting on, and never print a bare "?" when the page
        // was navigated by a step.
        const src = asText(p.source && p.source.url) || lastUrl;
        out("page " + (src ? hostOf(src) : "(no source)"), String(text).slice(0, 400));
      }
    };

    const sess = await send("session.new", { capabilities: { alwaysMatch: {} } });
    sessionId = sess.sessionId;
    await send("session.subscribe", { events: ["log.entryAdded"] });
    out("ff", `session ${sessionId} (BiDi) - browser v${ffVersion}`);

    if (EXT_ABS) {
      const inst = await send("webExtension.install", { extensionData: { type: "path", path: EXT_ABS.replace(/\\/g, "/") } });
      extId = inst.extension;
      out("ff", `installed ${EXT_NAME || "(unnamed)"} -> ${extId} (temporary: this run owns it)`);
      // The extension's own pages may open themselves (a first-run notice does that),
      // so give the event page a moment and report what appeared, without asking it.
      await sleep(1500);
      writeState({ ...readState(), [String(PORT)]: { engine: "firefox", pid: spawnedPid, profile: PROFILE, extName: EXT_NAME, extId, launchedAt: Date.now() } });
    }

    const showContexts = async (label) => {
      const tree = await send("browsingContext.getTree", {});
      const all = flatContexts(tree);
      for (const c of all) {
        if (!contextsSeen.some((s) => s.context === c.context)) { contextsSeen.push(c); }
      }
      out("step", `${label}: ${all.length} tab(s)`);
      for (const c of all) out("tab", `${c.url}   (${c.context})`);
      return all;
    };

    const realmFor = async (ctx) => {
      const realms = await send("script.getRealms", { context: ctx });
      const r = realms.realms.find((x) => x.type === "window") || realms.realms[0];
      if (!r) throw new Error("no window realm in this context");
      return r.realm;
    };
    const openPage = async (url) => {
      if (!pageCtx) {
        const c = await send("browsingContext.create", { type: "tab" });
        pageCtx = c.context;
      }
      lastUrl = url;   // set BEFORE navigating: a log event can arrive while we await
      await send("browsingContext.navigate", { context: pageCtx, url, wait: "complete" });
      return realmFor(pageCtx);
    };

    const evalIn = async (realm, expression, awaitPromise = true) => {
      const res = await send("script.evaluate", {
        expression, target: { realm }, awaitPromise, resultOwnership: "none",
      });
      if (res.type === "exception") {
        const d = res.exceptionDetails || {};
        throw new Error("exception: " + (d.text || "") + " " + ((d.exception && d.exception.description) || "").slice(0, 300));
      }
      return res.result;
    };
    const printable = (r) => {
      if (!r) return "";
      if (r.type === "undefined") return "undefined";
      if (r.type === "string") return r.value;
      if (r.type === "object" || r.type === "array") return JSON.stringify(r.value ?? null).slice(0, 600);
      return JSON.stringify(r.value);
    };
    const challengeInfo = async (realm) => {
      try {
        const r = await evalIn(realm, FF_CHALLENGE_PROBE, false);
        const txt = r && r.type === "string" ? r.value : (r && r.value != null ? String(r.value) : "");
        return JSON.parse(txt || '{"challenge":false}');
      } catch { return { challenge: false, probeFailed: true }; }
    };

    // ── the steps: --script wins, otherwise one --eval / --url ───────────────
    let steps = [];
    let listedAt = -1;
    if (SCRIPT) {
      steps = JSON.parse(fs.readFileSync(path.resolve(SCRIPT), "utf8"));
      if (!Array.isArray(steps)) throw new Error("--script must be a JSON array of steps");
    } else {
      const one = {};
      if (PAGE_URL) one.url = PAGE_URL;
      if (EVAL_FILE) one.evalFile = EVAL_FILE;
      else if (EVAL != null) one.eval = EVAL;
      if (WAIT_FOR) { one.wait = WAIT_FOR; one.waitTimeout = WAIT_TIMEOUT; }
      if (SHOT) one.shot = typeof SHOT === "string" ? SHOT : true;
      if (DELAY) one.delay = DELAY;
      if (Object.keys(one).length) steps = [one];
    }
    if (!steps.length) steps = [{ note: "no step given - install and report only", contexts: true }];

    for (let i = 0; i < steps.length; i++) {
      if (FROM && i + 1 < FROM) { out("step", `[step ${i + 1}/${steps.length}] skipped (--from ${FROM})`); continue; }
      const st = steps[i];
      const label = `[step ${i + 1}/${steps.length}]` + (st.note ? " " + st.note : "");
      const entry = { step: i + 1, note: st.note || null, kind: null, result: null, error: null };
      try {
        if (st.newTab && pageCtx) { pageCtx = null; }
        let realm = null;
        if (st.url) { realm = await openPage(st.url); entry.kind = "open"; entry.result = st.url; }
        else if (pageCtx) realm = await realmFor(pageCtx).catch(() => null);

        // A human handover, as in the CDP backend - with one honest difference: a
        // Firefox run owns its browser (no --keep/--attach by design), so it cannot
        // leave one behind. The run ends with exit 3 and the NEXT run re-opens the
        // page; the scratch profile keeps its cookies, so a solved challenge carries
        // over, and a temporary add-on is re-installed fresh on every run.
        if (st.ask) {
          if (!realm) realm = await openPage(PAGE_URL || "about:blank");
          if (typeof st.until !== "string") {
            out("step", `${label} a step with \`ask\` also needs \`until\``);
            failed++;
            results.push({ ...entry, error: "ask without until" });
            continue;
          }
          const untilMs = Date.now() + (st.waitTimeout || WAIT_TIMEOUT);
          let done = false;
          while (Date.now() < untilMs) {
            const r = await evalIn(realm, st.until, false);
            if (r && (r.type === "boolean" ? r.value === true : r.value != null)) { done = true; break; }
            await sleep(400);
          }
          if (!done) {
            const ch = await challengeInfo(realm);
            out("step", `${label} ASK: ${st.ask}`);
            if (ch.challenge) out("step", `  blocked by a CHALLENGE (${(ch.marks || []).join(",")}) on ${ch.href || "?"} - title "${ch.title || ""}"`);
            else if (ch.probeFailed) out("step", "  (challenge probe could not run - treating this as a plain unmet predicate)");
            else out("step", "  (no challenge markers - the predicate simply is not true yet)");
            out("ff", "  HOLD: a Firefox run cannot keep its browser, so this run ends here.");
            out("ff", "  solve it in a VISIBLE window, then re-run the SAME --script (the profile keeps the clearance cookie):");
            out("ff", `    node probe.mjs --browser firefox --ext ${EXT_ABS} --visible --script ${SCRIPT} --from ${i + 1}`);
            out("ff", "  exit 3 = needs a human, NOT a failure");
            askBlocked = true;
            break;
          }
          out("step", `${label} ask satisfied - continuing`);
        }

        if (st.evalFile) {
          const expr = fs.readFileSync(path.resolve(st.evalFile), "utf8");
          if (!realm) realm = await openPage(PAGE_URL || "about:blank");
          const r = await evalIn(realm, expr);
          entry.kind = "eval-file"; entry.result = printable(r);
          out("step", `${label} eval-file -> ${entry.result}`);
        } else if (typeof st.eval === "string") {
          if (!realm) realm = await openPage(PAGE_URL || "about:blank");
          const r = await evalIn(realm, st.eval);
          entry.kind = "eval"; entry.result = printable(r);
          out("step", `${label} -> ${entry.result}`);
        } else if (st.kind === "open" || st.url) {
          out("step", `${label} -> ${st.url}`);
        }

        if (typeof st.wait === "string") {
          if (!realm) realm = await openPage(PAGE_URL || "about:blank");
          const until = Date.now() + (st.waitTimeout || WAIT_TIMEOUT);
          let got = null;
          while (Date.now() < until) {
            const r = await evalIn(realm, st.wait, false);
            if (r && r.type === "boolean" && r.value === true) { got = true; break; }
            if (r && r.value != null && r.type !== "boolean") { got = true; break; }
            await sleep(400);
          }
          entry.kind = entry.kind || "wait";
          entry.result = got ? "satisfied" : "TIMEOUT after " + ((st.waitTimeout || WAIT_TIMEOUT) + " ms");
          out("step", `${label} wait ${st.wait} -> ${entry.result}`);
          if (!got) {
            failed++;
            const ch = await challengeInfo(realm).catch(() => ({ challenge: false }));
            if (ch.challenge) out("step", `  NOTE: this looks like a CHALLENGE page (${(ch.marks || []).join(",")}) on ${ch.href} - the site never let us in, so a mute timeout is expected`);
          }
        }

        if (st.delay && !st.wait) { await sleep(st.delay); }

        if (st.contexts) { await showContexts(label + " contexts"); listedAt = i; }

        if (st.shot) {
          const target = pageCtx || (await send("browsingContext.getTree", {})).contexts[0].context;
          const shot = await send("browsingContext.captureScreenshot", { context: target });
          const file = typeof st.shot === "string" ? path.resolve(st.shot)
            : path.join(process.cwd(), ".ext-dev-loop", "shots", `ff-${Date.now()}.png`);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
          entry.kind = entry.kind || "shot";
          entry.result = file;
          out("step", `${label} shot -> ${file}`);
        }
      } catch (e) {
        entry.error = String(e.message || e);
        failed++;
        out("step", `${label} FAILED: ${entry.error}`);
      }
      results.push(entry);
    }

    // Finish with the tab list: it is how "did our page open by itself" is answered,
    // and extension tabs are visible here even though their contents are not. Skipped
    // when the last step just listed them.
    if (listedAt !== steps.length - 1) await showContexts("final");
  };

  let killedPid = null;
  let hardTimer = null;
  try {
    // The ceiling must not keep the process alive after a good run: an un-unreffed
    // 4-minute sleep would make every probe look like it hung (the skill's rule 7/8).
    const hardStop = new Promise((resolve) => {
      hardTimer = setTimeout(() => {
        out("ff", `hard timeout after ${HARD_TIMEOUT} ms - killing the tree`);
        failed++;
        resolve("timeout");
      }, HARD_TIMEOUT);
    });
    await Promise.race([doRun(), hardStop]);
  } catch (e) {
    failed++;
    out("ff", "run failed: " + String(e.message || e));
  } finally {
    if (hardTimer) clearTimeout(hardTimer);
    await sleep(150);
    for (const s of sockets) { try { s.close(); } catch {} }
    if (child) { killedPid = child.pid; killTree(child.pid); }
    const all = readState();
    if (all[String(PORT)] && all[String(PORT)].engine === "firefox") { delete all[String(PORT)]; writeState(all); }
    await tick();
    await sleep(150);
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({
      engine: "firefox", browser: ff, version: ffVersion, profile: PROFILE,
      extension: EXT_ABS, extId, sessionId, steps: results, jsErrors,
      contexts: contextsSeen.map((c) => ({ context: c.context, url: c.url })),
      failed, killedPid,
    }, null, 2));
  } else {
    if (jsErrors.length) {
      out("ff js", `${jsErrors.length} JavaScript error(s) in this run - the class of bug CDP-style testing cannot see`);
      // An error thrown by an extension page/script is a FINDING, so it fails the run
      // by default. A scratch profile can also carry a foreign extension - which is
      // why every line is printed with its URL, and --allow-js-errors keeps the exit
      // code clean when the error is known and accepted.
      if (ALLOW_JS_ERRORS) out("ff js", "ignored (--allow-js-errors)");
      else { failed++; out("ff js", "=> the run is reported FAILED (use --allow-js-errors to accept them)"); }
    }
    out("ff", killedPid ? `browser killed (pid ${killedPid}), run finished` : "run finished");
  }
  // rule 8: never process.exit() in the tick that closed a socket - the await above did that.
  // A human handover outranks a plain failure: the caller has to act, not read a red exit.
  return askBlocked ? EXIT_ASK : failed ? EXIT_FAIL : EXIT_OK;
}
