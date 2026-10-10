#!/usr/bin/env node
// get-browser.mjs — find a host browser for ext-dev-loop, or download the preferred one.
//
//   node get-browser.mjs                    # print the best installed host (probe order: cft, edge, chrome)
//   node get-browser.mjs --json             # machine-readable: {name, exe, version}
//   node get-browser.mjs --ensure           # download Chrome for Testing (stable) if NO host can load
//                                          # an unpacked extension, then print it
//   node get-browser.mjs --pin              # write the chosen exe into ~/.ext-dev-loop/LOCAL.md
//                                          # as `pinned-cft:` so probe/doctor lock to it (see below)
//
// LOCAL.md honoured keys (the file agents maintain; see SKILL.md "Local facts"):
//   pinned-cft: <abs path to a chrome.exe>     -> probe/doctor use exactly this build
//   reserved-ports: 9793-9831                  -> ports.mjs/instances.mjs read the range from here
//
// The download comes from Google's official CfT feed (last-known-good-versions-with-downloads.json).
// It lands in ~/.ext-dev-loop/browsers/cft-<version>/ — never inside a project. No API key, no deps
// (global fetch + node's zip via PowerShell Expand-Archive on Windows / unzip elsewhere).
// ponytail: platform matrix is Windows-first; POSIX paths tested only for the download flow.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const ENSURE = args.includes("--ensure");
const PIN = args.includes("--pin");
const JSON_OUT = args.includes("--json");

const ROOT = path.join(os.homedir(), ".ext-dev-loop");
const LOCAL_MD = path.join(ROOT, "LOCAL.md");
const BROWSERS = path.join(ROOT, "browsers");
const FEED = "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";

const localKey = (k) => {
  try {
    const m = new RegExp(`^${k}:\\s*(.+)$`, "m").exec(fs.readFileSync(LOCAL_MD, "utf8"));
    return m ? m[1].trim() : null;
  } catch { return null; }
};

const versionOf = (exe) => {
  try {
    const dir = path.dirname(exe);
    const versions = fs.readdirSync(dir).filter((n) => /^\d+\.\d+\.\d+\.\d+$/.test(n));
    if (versions.length) return versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
    const m = fs.readdirSync(dir).map((n) => n.match(/^(\d+\.\d+\.\d+\.\d+)\..*manifest$/i)).filter(Boolean);
    return m.length ? m.sort((a, b) => a[1].localeCompare(b[1], undefined, { numeric: true })).pop()[1] : null;
  } catch { return null; }
};

const platform = () => ({ win32: "win64", darwin: "mac-x64", linux: "linux64" }[process.platform] || process.platform);

const candidates = () => {
  const pinned = localKey("pinned-cft");
  const cft = [];
  // any cft-* dir under browsers/ — version comes from the manifest, so upgrades are found
  try { for (const d of fs.readdirSync(BROWSERS)) if (/^cft-/.test(d)) cft.push(path.join(BROWSERS, d)); } catch {}
  if (pinned) cft.unshift(path.dirname(path.dirname(pinned)));
  const list = {
    cft: cft.map((dir) => path.join(dir, "chrome-win64", "chrome.exe")),
    edge: ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"],
    chrome: ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"],
  };
  if (pinned) list.cft.unshift(pinned);
  return list;
};

async function download() {
  const ver = await (await fetch(FEED)).json();
  const stable = ver.channels.Stable;
  const plat = platform();
  const entry = stable.downloads.chrome.find((d) => d.platform === plat);
  if (!entry) throw new Error(`no CfT build for ${plat}`);
  const dest = path.join(BROWSERS, `cft-${stable.version}`);
  const exe = path.join(dest, "chrome-win64", "chrome.exe");
  if (fs.existsSync(exe)) return { exe, version: stable.version, downloaded: false };
  const zip = path.join(BROWSERS, `cft-${stable.version}.zip`);
  console.error(`downloading Chrome for Testing ${stable.version} (${plat}) ...`);
  const res = await fetch(entry.url);
  if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(zip, buf);
  fs.mkdirSync(dest, { recursive: true });
  if (process.platform === "win32") {
    // Expand-Archive needs the parent dir to exist and handles the zip's inner structure
    execFileSync("powershell", ["-NoProfile", "-Command",
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`], { stdio: "inherit" });
  } else {
    execFileSync("unzip", ["-o", zip, "-d", dest], { stdio: "inherit" });
  }
  fs.rmSync(zip, { force: true });
  if (!fs.existsSync(exe)) throw new Error(`unpacked but ${exe} missing`);
  if (process.platform === "win32" || process.platform === "darwin") {
    try { fs.chmodSync(exe, 0o755); } catch {}
  }
  console.error(`installed: ${exe}`);
  return { exe, version: stable.version, downloaded: true };
}

(async () => {
  let name = null, exe = null;
  for (const [n, paths] of Object.entries(candidates())) {
    for (const p of paths) {
      if (fs.existsSync(p)) { name = n; exe = p; break; }
    }
    if (exe) break;
  }
  // --ensure: download CfT when nothing that can HOST an unpacked extension is present.
  // Branded chrome>=137 cannot (probe refuses it); cft/edge can.
  if (ENSURE && (!exe || name === "chrome")) {
    const got = await download();
    name = "cft"; exe = got.exe;
  }
  if (!exe) {
    console.error("no usable host found - run with --ensure to download Chrome for Testing");
    process.exit(2);
  }
  const version = versionOf(exe);
  if (PIN) {
    const line = `pinned-cft: ${exe}`;
    let txt = "";
    try { txt = fs.readFileSync(LOCAL_MD, "utf8"); } catch {}
    txt = /^pinned-cft:/m.test(txt) ? txt.replace(/^pinned-cft:.*$/m, line) : txt.trimEnd() + `\n\n${line}\n`;
    fs.mkdirSync(ROOT, { recursive: true });
    fs.writeFileSync(LOCAL_MD, txt);
    console.error(`pinned into LOCAL.md: ${line}`);
  }
  if (JSON_OUT) console.log(JSON.stringify({ name, exe, version }));
  else console.log(`${name} ${version || "?"} -> ${exe}`);
})();
