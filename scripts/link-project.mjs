#!/usr/bin/env node
// link-project.mjs - P3 (guest feedback 2026-10-17, Antigravity): sandboxed IDE agents
// (Antigravity, Cursor, sometimes Claude Code) cannot read outside the project dir, so the
// user-level farm (~/.agents/skills/ext-dev-loop) is INVISIBLE to them. This links the skill
// INTO the project so capability scanners find it. Run from the project (or pass its dir):
//
//   node ~/.agents/skills/ext-dev-loop/scripts/link-project.mjs [projectDir]
//
// Creates (junction on Windows, symlink elsewhere), never overwrites:
//   <project>/.agents/skills/ext-dev-loop  ->  ~/.agents/skills/ext-dev-loop
//   <project>/.claude/skills/ext-dev-loop ->  same target (Claude Code's project-skill path)
//
// Safety notes (the freebuff lesson): project-level .agents IS scanned by agent loaders, but
// they SKIP `skills/` dirs - the skill contains only .md/.mjs under skills/, no loose scripts,
// so it is import-safe. The junctions themselves must never be committed: add `.agents/` and
// `.claude/` to the project's .gitignore (warned below, not auto-written - the project's
// gitignore is yours). Windows junctions need no admin rights; POSIX symlinks may.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const project = path.resolve(process.argv[2] || process.cwd());
const target = path.join(os.homedir(), ".agents", "skills", "ext-dev-loop");
if (!fs.existsSync(path.join(target, "SKILL.md"))) { console.error(`[link-project] no skill at ${target} - the farm is not installed?`); process.exit(2); }

const links = [
  [path.join(project, ".agents", "skills", "ext-dev-loop"), "capability scanners (.agents/skills)"],
  [path.join(project, ".claude", "skills", "ext-dev-loop"), "Claude Code project skills (.claude/skills)"],
];
let made = 0;
for (const [link, why] of links) {
  if (fs.existsSync(link)) { console.log(`  exists: ${link}`); continue; }
  fs.mkdirSync(path.dirname(link), { recursive: true });
  try {
    fs.symlinkSync(target, link, "junction");
  } catch {
    try { fs.symlinkSync(target, link, "dir"); } catch (e) { console.error(`  FAIL ${link}: ${e.message}`); continue; }
  }
  console.log(`  linked: ${link} -> ${target}  (${why})`);
  made++;
}
if (!made) { console.log("nothing to do"); }

// gitignore check - a junction committed by accident is an opaque directory in the repo
try {
  const gi = fs.readFileSync(path.join(project, ".gitignore"), "utf8");
  const missing = [];
  if (!/^\.agents(\/|\s|$)/m.test(gi)) missing.push(".agents/");
  if (!/^\.claude(\/|\s|$)/m.test(gi)) missing.push(".claude/");
  if (missing.length) console.log(`  !! add to .gitignore (a committed junction is an opaque dir): ${missing.join("  ")}`);
  else console.log("  gitignore: .agents/ and .claude/ covered");
} catch {
  console.log("  (no .gitignore in the project - if this IS a git repo, add .agents/ and .claude/ before committing)");
}
