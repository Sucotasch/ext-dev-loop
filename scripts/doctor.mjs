#!/usr/bin/env node
// ext-dev-loop doctor: will the loop work on THIS machine, for THIS extension?
//
// Everything static runs with no browser at all (hosts and their versions, scratch
// writability, whether probe.mjs still carries its safety guards, and whether the
// manifest's own references resolve). --live adds ONE short launch (headless by
// default, so no window appears) that asks the only question static checks cannot:
// does the browser actually load this unpacked extension.
//
// Usage: node doctor.mjs --ext <unpacked-ext-dir> [--live] [--visible] [--port 9795]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const EXT = opt("--ext");
const LIVE = args.includes("--live");
const VISIBLE = args.includes("--visible");
const PORT = opt("--port", "9795");
const SKILL = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // .../ext-dev-loop
const PROBE = path.join(SKILL, "scripts", "probe.mjs");

const rows = [];
const ok = (name, detail = "") => rows.push({ pass: true, name, detail });
const bad = (name, detail = "") => rows.push({ pass: false, name, detail });
const check = (name, fn) => { try { ok(name, fn() || ""); } catch (e) { bad(name, e.message); } };

// ── hosts, and the version that must NOT come from launching them ─────────────
// Firefox is NOT a third host for the same loop: it has no --load-extension and no
// CDP in the tested build (155.0.1 answered /json/* with 404 whatever
// remote.active-protocols said). It is a second ENGINE - scripts/firefox.mjs, reached
// as `probe.mjs --browser firefox` - and its own capabilities are checked below.
// Keep this list identical to probe.mjs BROWSER_PATHS - a doctor that judges a different
// set of hosts than the tool it clears the way for is worse than no doctor.
// cft: pinned-cft from LOCAL.md first, then any downloaded cft-* build (get-browser.mjs).
const cftCandidates = (() => {
  const list = [];
  try {
    const m = /^pinned-cft:\s*(.+)$/m.exec(fs.readFileSync(path.join(os.homedir(), ".ext-dev-loop", "LOCAL.md"), "utf8"));
    if (m) list.push(m[1].trim());
  } catch {}
  try {
    const b = path.join(os.homedir(), ".ext-dev-loop", "browsers");
    const dirs = fs.readdirSync(b).filter((d) => /^cft-/.test(d))
      .sort((a, c) => a.localeCompare(c, undefined, { numeric: true })).reverse();
    for (const d of dirs) list.push(path.join(b, d, "chrome-win64", "chrome.exe"));
  } catch {}
  list.push("C:/Program Files/Google/Chrome for Testing/chrome.exe");
  return list;
})();
const HOSTS = {
  cft: cftCandidates,
  edge: ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"],
  chrome: ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"],
  firefox: ["C:/Program Files/Mozilla Firefox/firefox.exe", "C:/Program Files (x86)/Mozilla Firefox/firefox.exe"],
};
const versionOfFirefox = (exe) => {
  try {
    const ini = path.join(path.dirname(exe), "application.ini");
    const m = fs.readFileSync(ini, "utf8").match(/^Version=(.+)$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
};
const versionOf = (exe) => {
  const dir = path.dirname(exe);
  const versions = fs.readdirSync(dir).filter((n) => /^\d+\.\d+\.\d+\.\d+$/.test(n))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (versions.length) return versions[versions.length - 1];
  // Chrome for Testing is a portable build: no version directory - the version is the
  // name of the file chrome-win64/137.0.7151.119.manifest next to the binary.
  const manifests = fs.readdirSync(dir).map((n) => n.match(/^(\d+\.\d+\.\d+\.\d+)\..*manifest$/i)).filter(Boolean)
    .sort((a, b) => a[1].localeCompare(b[1], undefined, { numeric: true }));
  return manifests.length ? manifests[manifests.length - 1][1] : null;
};
const found = {};      // usable hosts only
for (const [name, paths] of Object.entries(HOSTS)) {
  const exe = paths.find((p) => fs.existsSync(p));
  if (!exe) { ok(`host: ${name}`, `not installed (looked in ${paths[0].replace(/\/[^/]+$/, "")})`); continue; }
  let version = null;
  try { version = name === "firefox" ? versionOfFirefox(exe) : versionOf(exe); }
  catch (e) { ok(`host: ${name}`, `installed, version unreadable (${e.code})`); continue; }
  const major = version ? Number(version.split(".")[0]) : 0;
  if (name === "firefox") {
    ok(`host: ${name}`, `${version || "version unreadable"} - second engine: WebDriver BiDi only (probe.mjs --browser firefox), loads the tree as a temporary add-on, cannot evaluate extension contexts`);
    continue;
  }
  if (name === "chrome" && major >= 137) {
    ok(`host: ${name}`, `${version} - ignores --load-extension, so it cannot host an unpacked extension (Chrome for Testing / Chromium / Edge can)`);
  } else if (name === "edge" && major >= 154) {
    found[name] = { exe, version };
    ok(`host: ${name}`, `${version} - loads only WITH --enable-unsafe-extension-debugging (re-measured 2026-10-10: headless + flag loads fine); userScripts grant is a per-extension toggle - CfT is the preferred host`);
  } else {
    found[name] = { exe, version };
    ok(`host: ${name}`, `${version} - usable with --load-extension${name === "cft" ? " (the host probe.mjs prefers)" : ""}`);
  }
}
if (!Object.keys(found).length) {
  bad("host: at least one usable browser", "install Chrome for Testing (the preferred host, see fact 1 in SKILL.md); branded Chrome >= 137 refuses --load-extension, and Edge 154+ needs --enable-unsafe-extension-debugging");
}
if (!fs.existsSync(PROBE)) bad("skill: probe.mjs", `missing at ${PROBE}`);

// ── local facts: the habit this skill runs on ────────────────────────────────
check("local facts: ~/.ext-dev-loop/LOCAL.md", () => {
  const p = path.join(os.homedir(), ".ext-dev-loop", "LOCAL.md");
  if (!fs.existsSync(p)) return "absent - create it on first use (installed hosts, paths, reserved ports) and read it before launching";
  return `present - read it before launching`;
});

// ── the skill's own guards: they are the safety, so they must still be there ──
check("skill: probe.mjs still refuses a non-scratch profile", () => {
  const src = fs.readFileSync(PROBE, "utf8");
  for (const [label, re] of [
    ["scratch roots", /SCRATCH_ROOTS/],
    ["refusal", /refusing to launch/],
    ["dry-run", /--dry-run/],
    ["CDP shutdown", /Browser\.close/],
  ]) if (!re.test(src)) throw new Error(`probe.mjs no longer contains the ${label} guard`);
  if (/--version/.test(src.replace(/^\/\/.*$/gm, ""))) throw new Error("probe.mjs mentions --version in code: that flag opens a browser");
  return "scratch guard, refusal, --dry-run, Browser.close all present";
});
check("skill: firefox.mjs is the second engine and keeps its guards", () => {
  const p = path.join(SKILL, "scripts", "firefox.mjs");
  const src = fs.readFileSync(p, "utf8");
  for (const [label, re] of [
    ["scratch roots", /SCRATCH_ROOTS/],
    ["scratch refusal", /refusing a profile outside the scratch roots/],
    ["dry-run", /--dry-run/],
    ["pid-tree shutdown (never by image name)", /taskkill/],
    ["the honest refusals", /--target sw\|ext/],
  ]) if (!re.test(src)) throw new Error(`firefox.mjs no longer contains the ${label} guard`);
  const probe = fs.readFileSync(PROBE, "utf8");
  if (!/import\("\.\/firefox\.mjs"\)/.test(probe)) throw new Error("probe.mjs no longer delegates --browser firefox to firefox.mjs");
  return "delegation + scratch guard, refusal, --dry-run, tasklist-by-pid all present";
});
check("skill: instances.mjs is available", () => {
  const p = path.join(SKILL, "scripts", "instances.mjs");
  if (!fs.existsSync(p)) throw new Error("instances.mjs missing");
  return "read-only orphan check present";
});

// ── scratch root: writable, and it is the one the probe will use ──────────────
let scratch = path.join(process.cwd(), ".ext-dev-loop");
check("scratch: the project scratch root is writable", () => {
  fs.mkdirSync(scratch, { recursive: true });
  const probeFile = path.join(scratch, ".doctor-write-test");
  fs.writeFileSync(probeFile, "ok");
  fs.unlinkSync(probeFile);
  const ignored = (() => { try { return /\.ext-dev-loop/.test(fs.readFileSync(path.join(process.cwd(), ".gitignore"), "utf8")); } catch { return false; } })();
  return `${scratch}${ignored ? " (gitignored)" : " - WARNING: not in .gitignore"}`;
});

// ── the extension itself: the manifest, and every path it names ───────────────
if (!EXT) {
  bad("extension: --ext", "not given - manifest checks skipped (usage: doctor.mjs --ext <dir>)");
} else if (!fs.existsSync(path.join(EXT, "manifest.json"))) {
  bad("extension: manifest.json", `not found in ${path.resolve(EXT)}`);
} else {
  const mf = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  ok("extension: manifest.json", `${mf.name} v${mf.version} (MV${mf.manifest_version})`);
  const refs = [];
  if (mf.background && mf.background.service_worker) refs.push([`background.service_worker`, mf.background.service_worker]);
  for (const cs of mf.content_scripts || []) for (const js of cs.js || []) refs.push(["content_scripts.js", js]);
  for (const cs of mf.content_scripts || []) for (const css of cs.css || []) refs.push(["content_scripts.css", css]);
  for (const w of mf.web_accessible_resources || []) for (const r of w.resources || []) if (!r.includes("*")) refs.push(["web_accessible_resources", r]);
  if (mf.options_ui && mf.options_ui.page) refs.push(["options_ui.page", mf.options_ui.page]);
  if (mf.action && mf.action.default_popup) refs.push(["action.default_popup", mf.action.default_popup]);
  const missing = refs.filter(([, rel]) => !fs.existsSync(path.join(EXT, rel)));
  if (missing.length) bad("extension: files the manifest names", missing.map(([k, r]) => `${k} -> ${r}`).join(", "));
  else ok("extension: files the manifest names", `${refs.length} references resolve`);
  if (mf.manifest_version !== 3) bad("extension: manifest_version", `${mf.manifest_version} - this loop is measured on MV3`);
}

// ── the only question static checks cannot answer ────────────────────────────
if (LIVE) {
  const isFF = EXT && (() => {
    try { return !!JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8")).browser_specific_settings?.gecko; }
    catch { return false; }
  })();
  if (!fs.existsSync(PROBE)) {
    bad("live: extension loads", "cannot run: probe.mjs missing");
  } else if (isFF) {
    // The Firefox path is its own live question: does the tree INSTALL, does it stay
    // silent (no extension JavaScript error), and which tabs does it open by itself.
    let out = "", err = "";
    try {
      out = execFileSync(process.execPath, [PROBE, "--browser", "firefox", "--ext", EXT, "--port", PORT, "--timeout", "120000"],
        { encoding: "utf8", timeout: 150000, windowsHide: true });
    } catch (e) { out = String(e.stdout || ""); err = String(e.stderr || e.message || ""); }
    const installed = /installed (.+?) -> (\S+)/.exec(out);
    const jsErr = (out.match(/\[ff js\] (.+)/g) || []).map((l) => l.replace(/^\[ff js\] /, ""));
    const tabs = (out.match(/\[tab\] (\S+)/g) || []).map((l) => l.replace(/^\[tab\] /, ""));
    if (installed) ok("live: firefox installs the tree and stays silent", `${installed[1]} -> ${installed[2]}` + (tabs.length ? `; tabs: ${tabs.join(", ")}` : ""));
    else bad("live: firefox installs the tree", err.split(/\r?\n/)[0] || "no install line - run the probe by hand to see why");
    if (jsErr.length) bad("live: no JavaScript error from the extension", jsErr.slice(0, 2).join(" | "));
    else if (installed) ok("live: no JavaScript error from the extension", "Firefox stderr was clean for this run");
  } else {
    const flags = ["--ext", EXT, "--port", PORT, "--watch", "1"];
    if (!VISIBLE) flags.push("--headless");
    let out = "", err = "";
    try {
      out = execFileSync(process.execPath, [PROBE, ...flags], { encoding: "utf8", timeout: 120000, windowsHide: true });
    } catch (e) {
      out = String(e.stdout || "");
      err = String(e.stderr || e.message || "");
    }
    const name = /^extension: "(.+)", SW /m.exec(out);
    const id = /chrome-extension:\/\/([a-p]{32})/.exec(out);
    const state = /^state: (.+)$/m.exec(out);
    if (name) {
      ok(`live: ${VISIBLE ? "visible window" : "headless"} launch loads the extension`,
        `${name[1]}, id ${id ? id[1] : "?"}, ${state ? state[1] : ""}`);
    } else {
      bad(`live: ${VISIBLE ? "visible window" : "headless"} launch loads the extension`,
        (err.split(/\r?\n/).filter((l) => /ERROR|refus|not found/i.test(l))[0] || "no SW found - run with --visible to watch it, or check the extension's manifest"));
    }
  }
} else {
  ok("live: extension loads", "skipped (pass --live for one headless launch)");
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(`ext-dev-loop doctor\n  skill: ${SKILL}\n  ext:   ${EXT ? path.resolve(EXT) : "(none given)"}\n`);
for (const r of rows) console.log(`${r.pass ? "ok  " : "FAIL"}  ${r.name}${r.detail ? ` - ${r.detail}` : ""}`);
const failed = rows.filter((r) => !r.pass).length;
console.log(`\n${failed ? `${failed} check(s) FAILED` : "all checks passed"}`);
process.exit(failed ? 1 : 0);
