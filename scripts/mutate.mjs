#!/usr/bin/env node
// mutate.mjs - H2 (guest feedback 2026-10-12, report #3): when you mutate a product file to
// prove a test bites, "I put it back" must be PROVEN, not eyeballed. Pattern:
//   sha256 -> apply mutation -> run the command -> restore -> sha256 again.
// If either hash fails to match, the run FAILS and the file stays reported.
//
// Usage:
//   node mutate.mjs <file> <old> <new> <command...>
//     <old>/<new> - exact substring replace (use distinctive anchors).
//   node mutate.mjs <file> --regex <pattern> <replacement> <command...>
//   --keep           do NOT restore (leave the mutation in place; for triage only)
//   --label <text>   tag printed alongside the result lines
// Exit codes: 0 = command exited 0 AND file restored byte-identical;
//             1 = command failed (expected for "the test bites") OR restore mismatch;
//             2 = usage / hash errors BEFORE anything ran.
//
// The restore path is a LAST-WRITE-WINS copy of the original bytes kept in this process; if
// this script is killed mid-run the file may be left mutated - re-run with `git checkout` or
// the same bytes. ponytail: no fs.watch fallback; if a mid-run kill proves common, add one.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const labelIdx = args.indexOf("--label");
const label = labelIdx !== -1 ? args.splice(labelIdx, 2)[1] : "";
const regex = args.includes("--regex") ? args.splice(args.indexOf("--regex"), 1) : null;
const [file, oldStr, newStr, ...cmd] = args;
if (!file || !oldStr || !newStr || !cmd.length) {
  console.error("usage: node mutate.mjs <file> <old> <new> <command...>   [--regex] [--keep] [--label t]");
  console.error('  example: node mutate.mjs background.js \'"Referer": pageUrl\' \'"Referer": null\' node test.mjs');
  process.exit(2);
}
const orig = readFileSync(file);
const h0 = sha(orig);
let mutated;
if (regex) {
  const re = new RegExp(oldStr, "g");
  mutated = orig.toString("utf8").replace(re, newStr);
} else {
  if (!orig.toString("utf8").includes(oldStr)) { console.error(`mutate: pattern not found in ${file}: ${JSON.stringify(oldStr)}`); process.exit(2); }
  mutated = orig.toString("utf8").replace(oldStr, newStr);
}
writeFileSync(file, mutated);
console.log(`mutated ${file} (${label || "no label"}) - running: ${cmd.join(" ")}`);
const r = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit", shell: true });
const rc = r.status ?? 1;
if (!keep) {
  writeFileSync(file, orig);
  const restored = sha(readFileSync(file));
  if (restored !== h0) {
    console.error(`RESTORE FAILED: ${file} sha256 ${restored} != original ${h0} - THE FILE IS NOT WHAT IT WAS`);
    process.exit(1);
  }
  console.log(`RESTORED OK (sha256 identical${rc === 0 ? "" : `, command exit ${rc}`})`);
}
process.exit(rc === 0 ? 0 : 1);
