# ext-dev-loop

A skill + zero-dependency harness that closes the dev loop for **Chrome/Edge (MV3)
browser extensions**: the agent launches a disposable browser, loads the unpacked
extension, reads the service worker's console live, drives the extension's own pages,
sends messages to the worker, and reproduces issues on real sites — without the user
copying anything out of DevTools, and without ever touching the user's own browser
sessions.

```
you:  "the extension is broken on this gallery site again"
agent: doctor → probe --headless --script steps.json → real SW console + real answers
```

## What it does

- **`scripts/probe.mjs`** — launch/reload/watch/live-SW-console/message/screenshot in one
  invocation (`--script` batches N steps against one browser). Isolation is enforced: a
  scratch `--user-data-dir` under `.ext-dev-loop/` roots is the only profile it will ever
  start, downloads are redirected out of the user's folders, shutdown goes through
  CDP `Browser.close` then the PID tree — never by image name.
- **`scripts/doctor.mjs`** — will the loop work HERE, for THIS extension: hosts and their
  measured ability to load an unpacked extension, scratch-root hygiene, the probe's own
  safety guards, every file the manifest names. `--live` adds one headless launch.
- **`scripts/get-browser.mjs`** — find a usable host, or download Chrome for Testing
  (official Google feed) into `~/.ext-dev-loop/browsers/` when no installed browser can
  host an unpacked extension.
- **`scripts/firefox.mjs`** — a second engine (WebDriver BiDi): load the tree as a
  temporary add-on, page-level measurements. Reached as `probe.mjs --browser firefox`.
- **`scripts/ports.mjs` / `instances.mjs`** — lab hygiene: sweep/close leftover lab
  browsers through their own debug endpoints; report live ports with no registry record.

## Install (any agent harness that reads SKILL.md folders)

```
git clone https://github.com/Sucotasch/ext-dev-loop ~/.agents/skills/ext-dev-loop
```

then junction/symlink or copy `SKILL.md` + `scripts/` wherever your harness reads skills
(`~/.claude/skills/`, `~/.codex/`, `~/.hermes/skills/`, …). Node >= 22 required; **no npm
install** — the scripts use only the Node standard library.

For a project: run from the repo root of the extension you are working on. First use:

```
node scripts/doctor.mjs --ext <unpacked-extension-dir>        # static
node scripts/doctor.mjs --ext <dir> --live                    # + one headless launch
node scripts/get-browser.mjs --ensure                         # if no host was found
```

## Local facts (read before you measure)

The skill is portable; your machine is not. `~/.ext-dev-loop/LOCAL.md` holds the facts
about YOUR machine (installed hosts, reserved port range, quirks), and each project keeps
its own lab file (profile paths, extension id, port sub-ranges, site walls). The skill
teaches the agent to read them first, create them on first use, and fix the file — not
quietly re-derive — when a measurement contradicts it. See SKILL.md, "Local facts".

## Honest scope

- All measurements behind the rules were taken on **Windows 10/11** (Chromium-side CDP is
  cross-platform; POSIX kill/download paths exist but are not measured by the author).
- Host verdicts in the code (which browser can load an unpacked extension and how) are
  dated measurements, not gospel — the doctor prints them with dates, and
  `get-browser.mjs --pin` records the one that works for you.
- `references/measurements.md` is the dated diary of runs the rules came from, kept
  verbatim — read it when a rule seems arbitrary.

## License

MIT — see [LICENSE](LICENSE). Guest feedback that shaped several fixes is acknowledged
in `references/measurements.md` (2026-10-10).
