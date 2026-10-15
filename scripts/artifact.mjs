#!/usr/bin/env node
// artifact.mjs - P2 (guest feedback 2026-10-13, report #4): for any extension that produces
// a FILE (media, PDF, export), the run's real verdict is the artifact, not the UI's "done"
// toast - in that session the UI said «Готово» for a file whose audio track was missing a
// 10 s segment, and only ffprobe exposed it. This lists what landed in the download dir and,
// when ffprobe is present, dumps the stream map and a per-stream gap/repeat/backward summary.
//
//   node artifact.mjs <dir> [--since <minutes|ISO|epoch>] [--hash]
//
//   --since   list only files modified after this (minutes ago, ISO date, or epoch seconds).
//             Default 15 - say it if the assumption did the filtering.
//   --hash    also print sha256 (slow on big files - off by default).
// ffprobe is optional: without it you get name/size/mtime (+hash). Exit 0 as long as the dir
// is readable - this is an INSPECTION, not a gate; grep its output from your test.
// ponytail: packet-level gap scan is O(packets) and loads every packet into memory - fine
// for lab-sized downloads; stream-tail it for multi-GB files.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const a = process.argv.slice(2);
const dir = a[0];
const sinceRaw = (() => { const i = a.indexOf("--since"); return i >= 0 ? a[i + 1] : null; })();
const wantHash = a.includes("--hash");
if (!dir || !fs.existsSync(dir)) { console.error("usage: node artifact.mjs <dir> [--since <min|ISO|epoch>] [--hash]"); process.exit(2); }

let since;
if (sinceRaw === null) since = Date.now() - 15 * 60 * 1000;
else if (/^\d+$/.test(sinceRaw)) {
  const n = Number(sinceRaw);
  since = n < 1e11 ? Date.now() - n * 60 * 1000 : n;  // minutes-ago or epoch ms
} else since = Date.parse(sinceRaw);
console.log(`artifact dir: ${dir} (files newer than ${new Date(since).toISOString()}${sinceRaw === null ? " [default 15min]" : ""})`);

// NB: fs.Stats fields are prototype getters - a spread (`...st`) copies NOTHING on modern
// node. Pick explicitly (this exact bug crashed the first live run).
const files = fs.readdirSync(dir)
  .map((n) => { const p = path.join(dir, n); const st = fs.statSync(p); return { n, p, size: st.size, mtimeMs: st.mtimeMs, mtime: st.mtime, isFile: st.isFile() }; })
  .filter((f) => f.isFile && f.mtimeMs > since)
  .sort((x, y) => x.mtimeMs - y.mtimeMs);
if (!files.length) { console.log("  (no files in that window)"); process.exit(0); }

const hasFfprobe = (() => { try { execFileSync("ffprobe", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();
if (!hasFfprobe) console.log("  note: ffprobe not on PATH - sizes/mtimes only, no stream inspection (a broken artifact can hide behind a good size)");

const MEDIA = /\.(mp4|webm|mkv|mov|m4a|mp3|wav|ogg|flac)$/i;
for (const f of files) {
  const MB = f.size / 1048576;
  const sizeStr = f.size < 1048576 ? `${f.size} B` : `${MB.toFixed(2)} MB`;   // P8: sub-MB files print exact bytes, "0.00 MB" reads as "empty"
  console.log(`  ${f.n}  ${sizeStr}  ${f.mtime.toISOString()}${wantHash ? "  sha256 " + createHash("sha256").update(fs.readFileSync(f.p)).digest("hex").slice(0, 16) + "…" : ""}`);
  if (!hasFfprobe || !MEDIA.test(f.n)) continue;
  try {
    const fmt = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", f.p], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
    const dur = fmt.format?.duration ? ` duration ${Number(fmt.format.duration).toFixed(2)}s` : "";
    console.log(`    container ${fmt.format.format_name}${dur}; streams:`);
    for (const s of fmt.streams) console.log(`      #${s.index} ${s.codec_type} ${s.codec_name} ${s.width ? s.width + "x" + s.height + " " : ""}${s.duration ? Number(s.duration).toFixed(2) + "s" : ""}`);
    // per-stream packet timeline: gaps (delta >> median), repeats, backward steps
    const pk = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_packets", "-of", "json", f.p], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }));
    const byStream = {};
    for (const p of pk.packets || []) (byStream[p.stream_index] ??= []).push(Number(p.pts_time ?? p.dts_time ?? NaN)).valueOf();
    for (const [si, pts] of Object.entries(byStream)) {
      const t = pts.filter(Number.isFinite).sort((x, y) => x - y);
      if (t.length < 4) continue;
      const deltas = t.slice(1).map((v, i) => v - t[i]).sort((x, y) => x - y);
      const med = deltas[Math.floor(deltas.length / 2)];
      const gaps = deltas.filter((d) => d > Math.max(3 * med, med + 0.5)).length;
      const repeats = t.filter((v, i) => i && v === t[i - 1]).length;
      const backwards = t.filter((v, i) => i && v < t[i - 1]).length;
      const span = (t[t.length - 1] - t[0]).toFixed(2);
      console.log(`      stream #${si} timeline: ${t.length} packets, span ${span}s, median step ${med.toFixed(3)}s -> gaps>${(Math.max(3 * med, med + 0.5)).toFixed(2)}s: ${gaps}, repeats: ${repeats}, backward: ${backwards}${gaps || repeats || backwards ? "  <-- LOOK HERE" : ""}`);
    }
  } catch (e) { console.log(`    ffprobe failed: ${(e.message || e).toString().slice(0, 160)}`); }
}
process.exit(0);
