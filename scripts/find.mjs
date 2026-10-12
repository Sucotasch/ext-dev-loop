#!/usr/bin/env node
// find.mjs - H5 (guest feedback 2026-10-12, report #3): the agent shell's `grep` returns 0
// matches on Cyrillic (false "not found" in Russian docs; guest-measured, positive ASCII
// control works). This is the guaranteed-working search: file + patterns -> counts, read
// as UTF-8. NEVER pass Cyrillic as command ARGUMENTS - it arrives mangled (measured:
// "по существу" -> "по\nсуществу"); pass patterns in a file (one per line) with --patterns-file.
//
// Usage:
//   node find.mjs <file> <pattern> [<pattern>...]        # literal substring, case-sensitive
//   node find.mjs <file> --regex <re> [<re>...]          # JS regex
//   node find.mjs <file> --patterns-file <f> [<f>...]     # one pattern per line, UTF-8
//   node find.mjs <file> --quiet                          # only exit code: 0 = found, 1 = none
// Exit: 0 if ANY pattern matched, 1 if none, 2 usage error. Prints per-pattern counts and
// the first matching line number. Ponytail ceiling: no context lines, no globbing - it is
// a counter, not a grep clone; add when a reader needs the surrounding text.

import { readFileSync } from "node:fs";

const a = process.argv.slice(2);
const quiet = a.includes("--quiet") ? a.splice(a.indexOf("--quiet"), 1) && true : false;
let mode = "literal";
if (a[1] === "--regex") { mode = "regex"; a.splice(1, 1); }
let pats = [];
while (a.length > 1) {
  const p = a.pop();
  if (p.startsWith("--patterns-file=")) {
    for (const line of readFileSync(p.slice(16), "utf8").split("\n")) if (line.trim()) pats.push({ s: line.trim(), file: true });
  } else if (a[a.length - 1]?.startsWith("--")) {
    const f = a.pop().slice("--patterns-file=".length);
    for (const line of readFileSync(f, "utf8").split("\n")) if (line.trim()) pats.push({ s: line.trim(), file: true });
  } else pats.push({ s: p });
}
const [file] = a;
if (!file || !pats.length) {
  console.error("usage: node find.mjs <file> [--regex] <pattern...> | --patterns-file=<f> [--quiet]");
  process.exit(2);
}
const text = readFileSync(file, "utf8");
const lines = text.split("\n");
let any = false;
for (const p of pats) {
  let count = 0, first = -1;
  if (mode === "regex") {
    const re = new RegExp(p.s, "g");
    const m = text.match(re); count = m ? m.length : 0;
    if (count) { const lm = new RegExp(p.s); first = lines.findIndex((l) => lm.test(l)) + 1; }
  } else {
    let i = 0;
    while ((i = text.indexOf(p.s, i)) !== -1) { count++; i += p.s.length; }
    if (count) first = lines.findIndex((l) => l.includes(p.s)) + 1;
  }
  if (count) any = true;
  if (!quiet) console.log(`${JSON.stringify(p.s)} -> ${count} occurrence(s)${count ? `, first at line ${first}` : ""}`);
}
process.exit(any ? 0 : 1);
