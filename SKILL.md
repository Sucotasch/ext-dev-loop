---
name: ext-dev-loop
description: Use when developing a browser extension.
---

# ext-dev-loop

Closes the extension dev loop. Instead of the user reloading the extension, copying
SW console output and pasting errors back, the agent owns the cycle — launch, reload,
live service-worker logs, reproduce on a page — in a browser instance that cannot
touch the user's own sessions.

## Safety first: you are a guest on this machine

Three rules, all ENFORCED by `scripts/probe.mjs` rather than trusted to memory:

1. **Every launch carries `--user-data-dir` inside a `.ext-dev-loop` scratch root** —
   `./.ext-dev-loop/<ext>/profile` by default (findable, deletable, gitignored),
   `~/.ext-dev-loop/<name>/profile` when one profile should serve several projects.
   A `--profile` outside those roots is refused (exit 2) with the reason, before
   anything is spawned. Without this, a launch lands in the user's real, logged-in
   session.
2. **Never launch a browser to ask it something.** Measured 2026-09-19 on Windows:
   `msedge.exe --version` does not print a version — it *starts a browser*, with the
   default profile, i.e. the user's own Edge session. Read versions from the install
   directory instead (`versionOf()` in probe.mjs); measured: Edge `153.0.4234.32`,
   Chrome `141.0.7390.76`.
3. **Never kill by image name.** The user's own 100+ browser processes look exactly
   like the ones you started. Shutdown is CDP `Browser.close` on the instance's own
   debugging endpoint, with `taskkill /F /T /PID <spawned pid>` as fallback.

`--dry-run` prints host, version, profile and flags and exits BEFORE any spawn
(verified: no spawn on any path, refusals included) — use it as the cheap first step
and as the way to check the guards.

## Verified live

- 2026-09-19, Edge 153.0.4234.32, Windows, this project's extension: the unpacked
  extension loads with `--load-extension`, and the SW is found by evaluating
  `chrome.runtime.getManifest().name` per service_worker target ("SunoGrab - Suno
  Audio Downloader", v3.0.0) — among ~17 unrelated `msedge.exe` processes and several
  component-extension SWs.
- Chrome ≥137 is refused up front (Chrome 141 here): it ignores `--load-extension`.
  `--allow-chrome` overrides knowingly. The preferred host changed to **Chrome for Testing 137**
  after an Edge 154 update silently broke unpacked-extension loading — see fact 1.
- An idle MV3 SW produced **0 console lines in 70 s**. Nothing happens until work is
  triggered, so "I streamed the console" is not by itself evidence of anything.
- **An attached SW does not go idle.** With `Runtime.enable` attached it was still the
  same target after 70 s of silence (0 console lines, 0 exceptions), twice. This is the
  practical reason to attach first and ask questions later: the world you are watching
  is the world that stays alive.
- `/json/new?<url>` opens **both** a site page and an extension page:
  `chrome-extension://<id>/options.html` (HTTP 200, target created, and the page really
  rendered — title plus its 5 format radios). `Target.createTarget` was not needed.
- **A content script lives in an isolated world, and it is reachable.** On suno.com the
  page target exposed, next to several default contexts, one with
  `auxData.isDefault === false`, `type=isolated`, `origin=chrome-extension://<id>` and
  `name` = the extension's name. In THAT context `chrome.runtime.id` and the manifest's
  own globals exist (`typeof lamejs === "object"`, the vendored encoder); the very same
  expression in a default context answers `runtimeId: null`, `lamejs: "undefined"`.
  `--eval … --in isolated` does this from the command line.
- **Console attribution has a catch.** `Runtime.consoleAPICalled` carries
  `executionContextId` (the older `context` field is absent in this build): a log issued
  in the isolated world arrived with the isolated context's id. But a page has SEVERAL
  default contexts (top frame, about:blank iframes), so match an id against the context
  list (`isDefault`/`origin`) instead of assuming one context per page.
- **The loop can drive the product.** From the options page target,
  `chrome.runtime.sendMessage({action:"ui:queueState"})` returned the SW's real summary
  — so a page you opened is not just readable, it can be used to make the extension do
  something and then read the answer.
- **Headless loads unpacked extensions.** `--headless=new` + `--load-extension` found the
  SW (same id, v3.0.0) and rendered extension pages normally — a visible window is needed
  only for what a human must do (a login). Measured with `doctor.mjs --live`.
- **Screenshots work headless too**, at the viewport size (`--window-size=1100,820` →
  a 1076×728 PNG, ~60 KB): `--shot` on `options.html` and on a heavier page (a DOM-built
  tab) both produced valid PNGs.
- The extension id an unpacked extension gets is **stable for the same path + profile**
  (`chrome-extension://<id>/…` kept working across runs), so pages can be addressed by
  URL in scripts once you have seen the id once.
- **A scratch profile is not an empty profile.** Edge installs registry/managed
  extensions into it (measured: a third-party security extension's content script was
  running on suno.com in a profile that had never seen a human, and its stderr noise
  `external_registry_loader_win.cc` appears on every launch). Consequences: identify the
  SW by manifest name, and pick the isolated world by YOUR extension's id — "the first
  non-default context" can be somebody else's. `probe.mjs --in isolated` does that, and
  says so when it sees a foreign world.
- A single-page app may render nothing 2.5 s in. `--delay <ms>` waits longer before the
  `--eval`/`--shot` step (measured need: an SPA's own content, not the extension's).
- **A content script (or page) cannot construct a Worker from `chrome-extension://`.**
  Measured on suno.com with a WAR-declared worker: `new Worker(extUrl)` and
  `new Worker(extUrl, {type:"module"})` both throw `cannot be accessed from origin` — the
  worker same-origin rule, which no `web_accessible_resources` entry lifts. But
  `fetch(extUrl)` of the same WAR file returns **200**, and
  `new Worker(URL.createObjectURL(new Blob([fetched])))` **runs** (that page's CSP allows
  blob workers). So the working pattern is: fetch the source, build a blob worker. Any
  extension whose content script spawns a worker from its own files hits this, and a
  harness that stubs `Worker` will never see it — which is exactly why one live run is
  worth more than another unit test.
- **Context choice is per FRAME.** A page target exposes several default worlds (top
  document plus about:blank/iframe documents) and one isolated world per extension. Picking
  "the first default context" measured `location.href === "about:blank"` with an empty DOM —
  resolve the top frame (`Page.getFrameTree`) and match `auxData.frameId`. Same for
  isolated worlds: match your extension's id, because a scratch profile can contain other
  extensions' worlds.
- `tasklist` works from node (703 ms) but Git Bash mangles `/FI` into `//FI`; and
  `wmic process get CommandLine` returns BLACKBOX without elevation. So a stray
  window CANNOT be identified after the fact — prevent it, or close it through the
  debug port you own.
- **A page whose module fails to PARSE has no handlers at all — and it looks like a
  working page.** Measured 2026-09-19 on this project: an extension page whose
  `popup.js` was one `)` over showed its default-active tab and five dead buttons
  (tabs, ⚙, "Master local files" all did nothing, no visible error). Two questions
  settle it in one `--eval-file`, and neither needs a debugger:
  1. `await import(chrome.runtime.getURL("popup.js"))` — a failed module evaluation is
     remembered by the module map, so this returns the exact error the page hit
     (`SyntaxError: Unexpected token ')'`); `"ok"` means the module loads;
  2. click the control and see whether anything observable happens (patch
     `chrome.tabs.create` first, or read the class a tab click is supposed to move).
  Related trap: `node --check <file>` reported **ok** on that broken file — it does not
  parse these files under the ESM goal. Parse modules with `vm.SourceTextModule`
  (needs `--experimental-vm-modules`, so run it in a child process) and classic scripts
  with `vm.Script`. If the loop caches a page from a previous run, remember the extension
  must be reloaded for edits to take effect.
- 2026-09, Imagus Reborn MD first-install in Edge: first-install events captured
  (`onInstalled reason install`, `userScripts` warning, remote filter update,
  upstream drift warning); `chrome.runtime.reload()` from inside the SW re-attaches
  to a fresh SW with boot logs from t≈0; real pages opened via `/json/new`.

## Hard-won platform facts

1. **Pick the host by what actually loads an unpacked extension.** Measured on this box, 2026-10-07/08, Edge re-measured 2026-10-10:
   - **Chrome for Testing 137** — `~/.ext-dev-loop/browsers/cft-137/chrome-win64/chrome.exe`
     (137.0.7151.119). The automation-branded build: plain `--load-extension` works, in BOTH
     `--headless` and a visible window, and the userScripts grant is a global Developer-mode toggle.
     **This is the host `probe.mjs` prefers** (`--browser` forces another).
   - **Edge 154** — loads with `--load-extension`, but **only when the probe's own
     `--enable-unsafe-extension-debugging` flag is passed** (headless and visible both work —
     re-measured 2026-10-10 after a false "loads nothing" note from a broken 2026-10-07 run);
     its userScripts grant is a per-extension toggle (>= 138). Still selectable with `--browser edge`.
   - **Branded Google Chrome ≥ 137** refuses the flag outright (`--load-extension is not allowed in
     Google Chrome`) — the probe refuses it too unless `--allow-chrome`.
   Install a host once per machine under `~/.ext-dev-loop/browsers/<name>/`, never into the project.
   Never write a browser off without a re-run: "extension SW not found" is, twice out of three,
   a stale profile (fact 11) or a mistyped timeout — not the browser's fault.
2. Never attach by SW file name — component extensions run their own SWs. Identify by
   evaluating `chrome.runtime.getManifest().name` per SW target.
3. `/json/list` entries carry `id` + `webSocketDebuggerUrl` (no `targetId` field).
   Detecting a fresh SW after a reload = polling for a different `id`.
4. `--user-data-dir=<scratch>` is the isolation boundary; kill only the instance you
   spawned.
5. The scratch profile persists (cookies, logins). That is the only reason a
   login-gated site can be driven at all — log in ONCE by hand in the scratch window,
   reuse the profile forever. Google accounts are the flakiest (automation detection):
   manual first login.
6. SW console capture needs `Runtime.enable` (`RuntimeAPICalled`, `exceptionThrown`).
   Boot logs from before the attach are lost — reload the extension and re-attach
   rather than restarting the browser.
7. **`stdio: "ignore"` does not close a stream on Windows** — it leaves the slot with
   no handle, and a detached child (created with `bInheritHandles=TRUE`) then inherits
   the PARENT'S handle. Measured 2026-09-21: a `--keep` run piped through `| tail`
   printed its last line, wrote its state file and exited, and the shell still waited
   forever, because the surviving browser held the pipe's write end. `| tail` hung;
   `> file` exited cleanly. Fix: hand the child real `NUL` handles (`fs.openSync("NUL","w")`)
   for stdout, and only the stderr log as a file. Any tool that leaves a process alive
   must do this, or every caller that pipes gets a hang it cannot explain.
8. **Do not `process.exit()` in the tick that closes a WebSocket.** Measured: the run
   printed its result and then died with `Assertion failed: !(handle->flags &
   UV_HANDLE_CLOSING), file src/win/async.c, line 94` — which reads as "the tool
   crashed" one line after it worked. Close the sockets, let a tick pass, then exit.
9. **A detached browser cannot be our child.** We launch it through a one-shot helper
   (devnull-stdio, `detached`, exits at once) which writes `[probe] launched pid N` on
   the log's first line. That pid is only a hint: when Chromium hands the command line
   to an ALREADY RUNNING instance (same `--user-data-dir`), the spawned process exits
   and the pid is dead while the browser lives on. The authoritative pid comes from CDP
   (`SystemInfo.getProcessInfo`, type `browser`), and that is what the record holds.
10. **An instance already answering on the debug port is not ours to close.** Launching
   into a profile another browser holds does not start a second browser; the run then
   talks to a foreign instance and `--close` kills the wrong (already dead) pid —
   measured 2026-09-21, one orphan survived several "closes". probe.mjs now refuses to
   launch when the port answers (`--attach`/`--close`/`--port` are the ways forward), and
   `node scripts/instances.mjs` reports a live port with no registry record.
11. **A persistent scratch profile can serve a STALE COPY of the unpacked extension.** Measured
    2026-09-21 on Edge 153: after editing `mass-download/service-core.js`, a run on the profile of an
    earlier session answered `ReferenceError: mdHistoryGuard is not defined` in the worker and behaved
    like the code from BEFORE the edit (the exact shape of an older fix), while the very same
    `--ext` directory, launched on a fresh `--profile`, had the new function. The extension is read
    from disk at load, but the profile keeps a cached copy of its resources, and the manifest version
    had not changed. So: after an edit, either launch a NEW `--profile .ext-dev-loop/<name>/profile`,
    or make the FIRST question of the run a symbol check
    (`--target sw --eval 'typeof <functionYouJustAdded>'`). A verification that silently tests the
    previous build is worse than no verification — it reports the OLD behaviour as the new one.
12. **Firefox is a second engine, not a host.** Measured 2026-09-21 on 155.0.1: no CDP
    at all (404 on `/json/*` with `remote.active-protocols` unset, `=1` and `=3`),
    WebDriver BiDi only, extension contexts unreachable even with
    `-remote-allow-system-access`, and the extension's own JavaScript errors arrive on
    **Firefox's stderr** — a channel no CDP-based loop ever sees. Use `--browser firefox`;
    the capability table is in the Firefox section above.
13. **A brand-new page answers with an `about:blank` top context FIRST.** Measured
    2026-09-22: the first step's `wait` on a freshly created page timed out at 8 s while
    the very same selector was present a second later — the poll had been running in
    `about:blank`, which satisfies "default context of the top frame" just as well as the
    real document. The world is now accepted only once it answers with the page we asked
    for. Any tool that resolves a context by creation order has this bug on first use.

## Local facts: read and write LOCAL.md / LAB.md

This skill is portable; the machine and the project are not. What was measured about THIS
machine lives in `~/.ext-dev-loop/LOCAL.md` — installed hosts and their paths, the reserved
port range, anything this box does differently. What was measured about THIS project lives in
the project's lab file — `<repo>/.ext-dev-loop/LAB.md` by convention (a project may keep it
elsewhere, e.g. `Docs/LAB_ENVIRONMENT.md`; any path its AGENTS.md names counts).

Rules:
- Before the first launch on a machine, read `~/.ext-dev-loop/LOCAL.md` if it exists; create
  it on first use with what you found: which hosts exist and where, where the scratch roots are.
- Before launching in a project, read that project's lab file if it exists.
- When a measurement contradicts a facts file, the FILE is wrong: fix the file. Do not
  rediscover the same thing quietly next session.
- When you learn something durable (a port sub-range, a profile grant, a host quirk), append
  it. These files are private, gitignored, and never published.

## Run the loop

**Start with `scripts/doctor.mjs`** — it answers "will the loop work here, for this
extension" without opening a window if you do not ask it to:

```
node <skill-dir>/scripts/doctor.mjs --ext <dir>            # static only, no browser
node <skill-dir>/scripts/doctor.mjs --ext <dir> --live     # + one HEADLESS launch
```

Static: which browsers exist and which of them can host an unpacked extension
(versions read from the install dir), that the project scratch root is writable and
gitignored, that probe.mjs still carries its guards (scratch refusal, `--dry-run`,
`Browser.close` — a guard that silently disappears is worse than none), and that every
path the manifest names actually exists.

`--live` adds the one question static checks cannot answer — does the browser load this
extension — as a **headless** launch. Use `--headless`, NEVER `--headless=new`: measured 2026-10-07
on Edge 154, the `=new` spelling produced a VISIBLE window that stole the user's focus. The loop
needs a window only for things a human must do, like logging in. If headless fails, re-run with
`--visible` and watch.

`scripts/probe.mjs` (node >= 22, zero deps — global `fetch` + `WebSocket`).

Flags that matter and when:
- `--grant-timeout <ms>` (default 180000): the userScripts grant wait. The gate applies ONLY
  when the manifest DECLARES `userScripts` — for extensions without that permission the run
  skips the gate entirely (their content scripts come from `content_scripts`, not userScripts).
  `--grant-timeout 0` prints the gate state and CONTINUES without waiting (no details page
  opened, exit code untouched).
- `--msg` / `--target ext` need a REAL extension page as the driver. Candidates, in order:
  `options_ui.page` / `options_page` / `action.default_popup`. If the manifest names none,
  the tool fails loudly ("no extension page known") — it never invents `options.html`.
  A popup is a fully legitimate driver: `chrome.runtime.sendMessage` from it reaches the SW.
- `--script` step schema: `{ note?, target?: page|sw|ext, url?, in?, eval?, msg?, wait?,
  waitTimeout?, delay?, shot? }` — but `msg` is **page/ext-only**; in a `sw` step it is
  rejected with a message (a sendMessage from the worker loops back to other contexts, not
  to the worker's own onMessage).
- `--msg` exit semantics: no answer = run fails; an answer that is an error payload
  (`ok:false` / the product's own `status:"error"`) is DATA and exits 0. The product's answer
  protocol is not ours to demand.

```
node <skill-dir>/scripts/probe.mjs --ext <unpacked-ext-dir> [--dry-run] [--port 9793]
     [--profile <dir>] [--watch 60] [--open <url>] [--reload] [--headless]
     [--browser edge|chrome] [--allow-chrome] [--timeout <ms>] [--max-lines <n>]
     [--eval <expr> | --eval-file <path>] [--target page|sw|ext] [--in main|isolated]
     [--url <page>] [--wait-for <expr>] [--wait-timeout <ms>]
     [--msg <json>] [--await <ms>] [--shot [path]] [--delay <ms>]
     [--script <steps.json>] [--from <n>] [--ask-keep] [--ask-timeout <ms>]

node <skill-dir>/scripts/probe.mjs --browser firefox --ext <dir> [--script <steps.json>]
     # Firefox: a SECOND engine (WebDriver BiDi, scripts/firefox.mjs). Same front door,
     # its own capability set - see the Firefox section below before reaching for it.

node <skill-dir>/scripts/probe.mjs --ext <dir> --keep      # launch once, leave it running
node <skill-dir>/scripts/probe.mjs --attach <action flags> # reuse it; no relaunch, no page reload
node <skill-dir>/scripts/probe.mjs --close [--port 9793]   # end it (state entry removed)
node <skill-dir>/scripts/probe.mjs --ext <dir> --script <steps.json> --headless
```

**Which of the two to use depends on the shell.** `--keep` is for a shell that
returns immediately. A harness that waits for the whole process tree never returns
while a browser it spawned is alive — measured 2026-09-21 on Windows: even a minimal
detached `msedge.exe` spawn (`stdio: [NUL, NUL, NUL], detached, unref`) kept the
calling command from returning, with no project code involved at all. There, batch
the loop instead: `--script` runs a JSON array of steps against ONE browser in ONE
invocation, and the run ends with the browser closed, so the command always returns.
The same rule decides how a HUMAN HANDOVER has to be shaped — a window that must stay
open for a person is a browser that outlives the run; see the human-in-the-loop
section below before reaching for `--ask-keep`.

`--eval` opens `--url` (default: `--open`, else suno.com), lists the page's execution
contexts, evaluates your expression in the world you asked for and prints the value —
the only way to see what a content script sees. `--shot` takes a PNG of the same page
into `./.ext-dev-loop/shots/` (or a path you give), which is how a UI judged by eye
(a popup, a settings card, a table) gets checked without you opening anything. Both exit
right after unless `--watch` was given too.

It refuses a non-scratch profile, refuses Chrome ≥137 unless told otherwise, launches
the host with the scratch profile plus `--load-extension`, finds the SW by manifest
name, prints a state probe (`userScripts` availability, version, extension id — the id
gives you `chrome-extension://<id>/options.html` to open), optionally reloads and
re-attaches, optionally opens a URL, and streams SW console/exceptions for `--watch`
seconds. Browser stderr goes to `<profile>/browser-stderr.log` and any
extension/load-extension/crash lines are reported, so "SW not found" comes with a
reason instead of silence. On exit the instance is closed through `Browser.close` and
its PID tree.

After a crash or a ctrl+c, `node <skill-dir>/scripts/instances.mjs` reports whether any
dev instance still answers on the debug ports — read-only: it closes nothing, kills
nothing, and is the only honest way to know whether you left a browser behind.

The same flow in-session without the script is ~80 lines: spawn the host detached with
a scratch profile, poll `http://127.0.0.1:<port>/json/list` for `service_worker`
targets, attach to `webSocketDebuggerUrl`, `Runtime.enable`, read events,
`Runtime.evaluate` for probes, `chrome.runtime.reload()` after edits, poll for a new SW
id, re-attach.

## Session reuse, and driving the product (added 2026-09-21, verified live)

A browser launch plus a page load is the expensive part, and an extension question
usually needs several: load it, trigger it, read the answer, change something, ask
again. So the browser can outlive the run.

```
node probe.mjs --ext ./my-ext --keep --watch 5 --headless   # launch, keep it
node probe.mjs --attach --target sw --eval 'JSON.stringify(chrome.runtime.getManifest())'
node probe.mjs --attach --msg '{"cmd":"getDownloadLog"}'    # ask the product something
node probe.mjs --attach --wait-for 'document.querySelector(".panel")' --url <page>
node probe.mjs --close --port 9793
```

The state file (`.ext-dev-loop/instances.json` in the cwd, `--state` to move it)
holds what was launched and what `--close` may therefore kill; `--close` REFUSES a
port the file does not know, and the file is removed when the browser goes. A dead
port with a live record means the browser died on its own - `instances.mjs` says so
instead of pretending the record is an instance.

Where an expression runs is now a choice:

| `--target` | What it is | What only it can answer |
|---|---|---|
| `page` (default) | a real page's world; `--in isolated` selects YOUR extension's world by id | what a content script sees |
| `sw` | the extension's service worker | queues, counters, `chrome.userScripts`, the module-level state that exists nowhere else |
| `ext` | the extension's own page (path taken from the manifest, never guessed) | driving: `chrome.runtime.sendMessage()` from here reaches the worker |

`--msg` is the difference between watching and testing: `{cmd:"getDownloadLog"}`,
`{cmd:"downloadAll"}`, `{cmd:"getDownloadStatus"}` - measured on Imagus Reborn MD
(Edge 153, headless): the answer came back as the extension's own JSON, e.g.
`{"stats":{...},"worker":{"gen":1,...},"pending":{"filtering":0,...},"phase":"none"}`.
That is the same data a human would have copied out of a diagnostics file by hand.

Read the answer, do not assume it: a wrong extension-page URL does not fail loudly -
it opens a `chrome-error` page where `chrome.runtime` is undefined and every `--msg`
dies with `Cannot read properties of undefined (reading 'sendMessage')`. The path is
therefore read from the manifest (or asked of the worker when attaching).

`--script <file>` takes a JSON array of steps; each step is
`{ note?, target?: page|sw|ext, url?, in?: main|isolated, eval?, msg?, wait?,
waitTimeout?, delay?, shot? }` and is executed in order, printing `[step i/N]` plus
the result. A real 6-step run against Imagus Reborn MD asked the worker for its
module state, its action title and a `chrome.storage.session` key, called
`sieveUrlFor()` inside the worker, then opened the extension's own options page,
read the warning banner out of its DOM, and sent `{cmd:"getDownloadStatus"}` - all in
one invocation, ~40 s, browser closed at the end. That is the shape of a regression
hunt: one launch, many questions, one honest transcript.

Other additions: `--wait-for <expr>` polls a predicate in the chosen world instead
of sleeping a guessed `--delay`; `--timeout <ms>` is a hard ceiling on the whole run
(default: watch + 5 min) so a probe can never hang a turn; `--max-lines` caps the
streamed console; `--json` prints results for a caller that parses rather than reads;
an exception in `--eval` now sets a non-zero exit code (it used to print and exit 0,
so a script could not tell a failed probe from a working one).

Console lines are tagged by HOST - `[sw main#1] …`, `[page <host> isolated#7] …` -
because the same text arriving from the worker, the page and a content script's world
is otherwise indistinguishable. On a fresh scratch profile the stream showed the real
boot sequence, including `chrome.userScripts API not available - user scripts will not
be registered` - the failure that makes a userScripts-based extension look installed
and dead at the same time.

## Human in the loop: `ask`, challenge pages, and what a harness can really do
## (added 2026-09-22, measured on Edge 153, Windows, this project)

Some questions cannot be answered without a person: a login, a consent dialog, a
Cloudflare interstitial. A step can say so:

```json
{ "url": "https://example.org/listing",
  "ask": "clear the Cloudflare challenge in this window",
  "until": "!!document.querySelector('.listing, #content')",
  "waitTimeout": 180000 }
```

Two ways to run it, and which one you get depends on WHO called the loop:

| mode | what happens | where it works |
|---|---|---|
| default | the wait IS the handover: the run polls the predicate while the human works in the visible window, then continues by itself | everywhere, including an agent harness |
| `--ask-keep` | the run stops, the browser is KEPT, exit code 3, resume with `--attach --script <same file> --from <n>` | only a shell that returns immediately |

**Measured 2026-09-22: a harness that waits for the whole process tree cannot keep a
browser at all.** A kept browser made the caller wait forever — the run printed every
line, wrote its state file and reached `exit 3`, but the shell never saw it — and
neither output redirection (`> file`) nor real NUL handles on the launcher changed that.
The tree-wait is the cause, so the blocking default is the only harness-safe shape;
`--ask-keep` exists for a human at a terminal (its handover text and kept-browser state
were verified this way). Do not build an agent workflow on a kept browser here.

Rules that make `ask` worth having:

1. **The predicate must be satisfiable by a PERSON in that window** — the challenge is
gone, the listing is there, a login marker appeared. A predicate only the agent can
satisfy produces a pointless window (this is how an empty "waiting for a human" page
happens); use `--wait-for` for agent-side conditions instead.
2. **The `ask` text is the instruction the human reads.** Name the action, not an
internal flag.
3. **`ask` is refused with `--headless`** (exit 2 before any spawn): nobody can act in
an invisible window.
4. **Give the wait a real budget** (`waitTimeout`, or `--ask-timeout`, default 240 s):
the human is not instant, and the run continues by itself the moment the predicate holds.

`--from <n>` (1-based) resumes a batch at the n-th step, so a blocked step is re-checked
on the resume instead of being skipped.

### Is it the SITE, or is it US? — challenge detection

Whenever a `wait` gives up, the page is probed for the challenge signature (title/body
phrases, the challenge DOM, the challenge script) and the result is printed instead of a
bare timeout:

```
  wait: TIMED OUT after 2811ms
  NOTE: this looks like a CHALLENGE page (text,dom) on <url> - the site never let us in,
  so a mute timeout is expected
```

Verified against a Cloudflare-shaped page (`<title>Just a moment...</title>` plus
`#challenge-form`): the probe reported `text,dom`. This matters because "the extension
does nothing" and "the site never let us in" are otherwise indistinguishable — and our
own extension also needs the userScripts grant, so a dead-looking page has at least two
very different causes. The same probe is what an unanswered `ask` reports.

**The poll survives the reload (fixed 2026-10-08, measured).** A solved Cloudflare
interstitial reloads itself, which replaces the page's execution context. A poll pinned
to the old context id then fails on every tick, times out, and reports an ANSWERED ask
as unanswered. Two things were wrong, and the second is the one that hides:

- **A CDP failure does not reject here.** `session.send` RESOLVES with
  `{error:{code:-32000,message:"Cannot find context with specified id"}}`, so a bare
  `try/catch` around the evaluate is dead code, and the failure is indistinguishable
  from "not true yet". Detect `r.error`, do not just catch.
- `pollUntil` now re-asks in the session's **default context** when the pinned one is
  gone - after a reload, that IS the page we care about.

Verified with a self-reloading page and no human: reload 6 s in (i.e. mid-poll), the
predicate only set in the replacement context. Before: `wait: TIMED OUT after 12251ms`.
After: `wait: true after 4011ms (the context changed under the poll - continued in the
new one)`, exit 0. Scratch test: `.unlazy/poll-reload-test.mjs` + `poll-reload.json`
(gitignored). Still unmeasured: a REAL interstitial at a real site.

**Not measured:** whether a REAL Cloudflare interstitial on a cold scratch profile is
detected this way, and whether it clears for that profile after a manual solve. The
markers are the published ones and the mechanism is verified against a stand-in — a live
run has to confirm the site side before any of it is quoted as fact.

## Firefox: a second engine (added 2026-09-21, all measured on Firefox 155.0.1)

Firefox is not another host for the CDP loop — it is a separate backend reached from
the same front door: `probe.mjs --browser firefox …` (or `--browser ff`). Why it could
not be a branch in probe.mjs: Firefox **answered every CDP endpoint with 404** with
`remote.active-protocols` unset, `=1` (CDP only) and `=3` (both), and the only thing it
announces on stderr is `WebDriver BiDi listening on ws://127.0.0.1:<port>`. The transport
(`/json/list` + CDP WebSockets) therefore cannot carry it at all.

```
node <skill-dir>/scripts/probe.mjs --browser firefox --ext <dir> --dry-run
node <skill-dir>/scripts/probe.mjs --browser firefox --ext <dir> --script steps.json
node <skill-dir>/scripts/probe.mjs --browser firefox --close --port 9796
node <skill-dir>/scripts/doctor.mjs --ext <ff-ext-dir> --live      # routes to this engine
```

| Can | Cannot (and the measurement) |
|---|---|
| install the unpacked tree as a **temporary add-on** (`webExtension.install`, a PATH; returns the gecko id, e.g. `imagus-reborn-md@sucotasch`) | be evaluated from inside: `script.getRealms` on an extension context answers *"does not support browsing contexts in privileged scope"*, and without `-remote-allow-system-access` it answers *"System access is required"* — both were tried. So `--target sw\|ext`, `--msg` and `--in isolated` are refused up front with that reason |
| open/navigate real pages and evaluate in a page's realm | reach the content-script world: content scripts are not browsing contexts, and the extension's own world needs the userScripts grant — a browser UI action here |
| capture a page's console (`log.entryAdded`, verified with our own `console.log` round-trip) | keep a browser for a later run: a BiDi session belongs to this socket, so `--keep`/`--attach` are refused rather than faked (batch with `--script` instead) |
| take screenshots (`browsingContext.captureScreenshot` → PNG) |
| see **every tab**, including extension pages that opened themselves (`moz-extension://…/options/options.html` shows up as a context with its URL) |
| read **Firefox's own stderr**, where an extension page that throws lands as `JavaScript error: moz-extension://<uuid>/options/options.js, line 349: …` |

Facts worth keeping:

- **A temporary add-on is installed fresh on every run**, so a returned edit is live
  immediately — there is no reload step on this engine (`--reload` is refused, not ignored).
- **A console entry carries no URL**: `log.entryAdded.source` came back as
  `{realm, context, userContext}` — no `source.url`. The backend falls back to the page
  the run is sitting on; before that, every line printed `[page ?]`.
- **A throw inside the extension is a RUN FAILURE by default** (`--allow-js-errors`
  accepts it). That channel earned its keep on the first day: it reported
  `options/options.js:349 TypeError: can't access property "mOrig", cfg.keys is undefined`
  in 4 fresh-profile runs out of 4 — and NOT in a later run on a warm profile, i.e. a
  race at startup, which is the kind of bug a green unit-test suite never shows.
- **Do not name a local variable `URL`.** The backend did (`const URL = opt("--url")`),
  which shadowed the global constructor: `new URL(...)` threw into its own catch and
  every host lookup printed `?`. One debug run found it; the fix is a rename, but the
  lesson is that a defensive `try/catch` can hide a broken call for a whole session.
- **A scratch profile cannot always be deleted right after a run** (measured: `rm -rf`
  and `fs.rmSync` both hit EPERM on a deep Firefox profile — long paths plus handles
  Windows has not released). Do not fight it: give the next run a NEW profile dir
  (`--profile .ext-dev-loop/ff-cold-1`) when you need a cold start, and clean up later.
- Firefox needs no `--load-extension` equivalent and no special flag: the install goes
  through the protocol. Safety is unchanged — a scratch profile under `.ext-dev-loop`,
  refusal (exit 2) for anything else, shutdown by the pid tree it spawned, and
  `--close` only for an instance the registry names.

## Dev iteration recipe

1. `--dry-run`: confirm host, version, profile, extension name. Nothing opens.
2. Run with `--watch`; wait for `extension: "<name>"` — the SW boots on its own, but
   it is *silent* until work arrives.
3. Trigger work (send a message to the SW, open the site page, click the UI) — only
   then is there anything to read.
4. Edit the extension, then reload: `--reload` (or `Runtime.evaluate
   chrome.runtime.reload()`), poll for the NEW SW id, re-attach, read boot logs.
   **A reload is not optional after editing a file the worker reaches through
   `importScripts()` (measured 2026-09-21, Imagus mass-download): the browser serves those
   sub-scripts from the script cache until the extension itself is reloaded or its version
   changes, so a fresh probe run happily executes the OLD code and answers about it — the
   tell is `ReferenceError: <fn> is not defined` for a function you can see on disk, plus an
   unchanged `Version:` line. Relaunching the browser is NOT enough; neither is editing only
   the imported file while the top-level worker script stays byte-identical. Bump the
   version when a run's result has to be attributable to a build.
5. Reproduce on a real page (`--open` or `/json/new`) and drive the page target
   (`Runtime.evaluate` for clicks, `Page.captureScreenshot`). For anything a content
   script does, evaluate in its world — the page's default context will tell you it does
   not exist:
   `probe.mjs --ext <dir> --eval 'JSON.stringify({id: chrome.runtime.id})' --in isolated --url <page>`
6. Open the extension's own pages by id (`chrome-extension://<id>/options.html` — the id
   is printed at startup) and use them as a driver: `chrome.runtime.sendMessage(...)`
   from there reaches the SW, and the answer is the product's own state.
7. **Before debugging behaviour, check the page is alive.** Dynamic-import the page's
   own script(s) from the page and look for a `SyntaxError`/module error, and assert one
   observable effect of a click. A page that never evaluated is indistinguishable from a
   broken feature, and "the button does nothing" is the most expensive way to learn it.
8. Read the streamed SW console for the failure signature, fix, repeat. When the thing
   you are judging is visual, take `--shot` and look at the PNG instead of describing it.

## Not measured yet, do not write them down as facts

- **Firefox:** whether closing the BiDi socket (or `session.end`) also ends the browser
  process — every run here kills the pid tree it spawned, so the question never arose.
  Related: whether a second session can be opened against the same Firefox.
- **Firefox:** whether `script.evaluate` with `target: {sandbox}` reaches a page's
  user-script world. Worth one experiment the day the userScripts grant can be given
  without a click; today the registration never happens, so there is nothing to target.
- **Firefox:** why a temporary install with `userScripts` as a REQUIRED permission still
  left the API undefined (the startup notice kept firing). The API's state could not be
  read from inside because extension contexts are unreachable — this needs the grant,
  not more probing.

- Whether an MV3 SW without an attach still goes away on the documented ~30 s idle
  teardown. Only "it survives while attached" was measured here (70 s on 2026-09-19, 75 s
  on 2026-09-21 — both with the debugger attached, which is exactly the state that suspends
  the teardown, so the measurement can never confirm the keep-alive). A related trap: a
  call to `chrome.runtime.getPlatformInfo` that is detached from `chrome.runtime` (the
  usual `setInterval(chrome.runtime.getPlatformInfo, 25_000)` keep-alive) does NOT throw —
  measured, it returns a promise — so "the keep-alive is silently broken" must be
  disproved by reading the browser's own worker-generation record, not by this call.
- Whether a content script's console output can be filtered reliably by
  `executionContextId` in a page with several default contexts (one isolated log did map
  correctly, but the id you evaluate with is not always the id reported).
- Reload through `chrome.runtime.reload()` on a **module** service worker — the Imagus
  measurement was on a classic SW; this project's SW is `type: module`.
- Whether Chrome/Edge keeps the per-extension **Allow User Scripts** toggle ON across a
  browser restart. Measured here with a FRESH scratch profile: the API is `undefined`
  and stays `undefined` (the toggle starts off, per Chrome's documented migration), and
  CDP cannot flip it — `chrome://extensions` is not attachable. The persistence question
  needs one manual click in a visible scratch window, then a relaunch with the same
  `--profile` and the same `--target sw --eval '!!chrome.userScripts'` probe.

## A predicate that THROWS fails the wait at once (rule, 2026-10-12)

`wait`/`until`/`--wait-for` predicates that throw - a SyntaxError from top-level `await`, a
TypeError from `document.querySelector('#nope').textContent` - CANNOT become true later, so the
run fails them immediately with the exception text (instead of a mute 30 s timeout that looks
like flakiness). Consequences for how you write predicates:
- guard optional chains: `document.querySelector('#x')?.textContent === 'y'` (the element may
  legitimately not exist YET - that is what waiting means);
- a top-level `await` needs the wrapper: `(async () => …)()`;
- wrap genuinely risky probes in `try/catch` if failure is an expected intermediate state.
A thrown predicate is almost always a test bug; fail fast beats burn the budget silently.

## The artifact wins; page-side boot ladder (P2/P3, guest feedback 2026-10-13, report #4)

**P2 — the acceptance test is the FILE, not the toast.** Measured on Triangle Downloader: the
extension's UI printed «Готово» for a file whose audio track was missing a 10 s segment; only
ffprobe exposed it. A probe that measures internal state (buffer edge, `currentTime`) can
disagree with the artifact — **the artifact wins**. Inspect what landed with
`scripts/artifact.mjs`:

    node scripts/artifact.mjs <downloads-dir> [--since <min|ISO|epoch>] [--hash]
    # files newer than --since; with ffprobe: container/streams + per-stream packet timeline
    # (gaps / repeats / backward steps; a corrupt file prints "<-- LOOK HERE"), else size+hash.

Verified live: a clean 2s mp4 reads `60 packets, gaps: 0`; the gap math proven on a synthetic
timeline with a 4.1 s hole. Related: the loaded-extension version is compared with the disk
manifest every run — `extension copy: disk vA == loaded vB` or a loud warning. The stale carrier
is the RUNNING browser (it holds the copy it read at ITS startup; `--load-extension` re-reads
disk on every launch — measured), so on a mismatch close the kept instance and relaunch; and
`--contexts <sec>` re-lists execution contexts after a delay (the early snapshot cannot be
read as an injection verdict — one session printed (5) 11 times and (2) 9 times, all working).

**P3 — the page-side boot ladder for asynchronously-built players.** In a fresh profile an
immediate `document.querySelector('video')` returns `{"fatal":"no player"}` — that reads like a
host problem but is a BOOT-ORDER bug; and `wait`/`--wait-for` on `video.duration > 0` never
resolves while the player is PAUSED — the step must start playback first (both bit the same
guest session twice; after the ladder the identical commands went green). The ladder:

    1. wait for the element:          {"target":"page","wait":"!!document.querySelector('video')||!!document.querySelector('#movie_player')"}
    2. prove the page world answers:  eval the extension's own postMessage ping, or
                                      document.querySelector('#movie_player') ? 'player up' : 'no player'
    3. start playback:                (async () => { const v = document.querySelector('video');
                                        if (v) { v.muted = true; await v.play(); } })()
    4. only NOW wait on media values:  {"wait":"(()=>{const v=document.querySelector('video');return v&&v.duration>0})()"}

## Step files are GATES: `assert` (H1), mutation proof (H2), on-the-wire gates (H6) — 2026-10-12

**`assert` step (H1).** A step file used to be a protocol to read by eye: a run could print
`maxConcurrent = 5` where the gate wanted 2 and still exit 0. Now a step may carry `assert`
(+ optional `expect`), same predicate semantics as `wait` (one evalPredicate, same exception
story, `(async () => …)()` hint):

- `{"assert": "<predicate>"}` — run fails (exit 1) unless the value is truthy.
- `{"assert": "<expr>", "expect": <json>}` — run fails unless STRICTLY equal (JSON.stringify
  comparison; numbers, strings, small objects — for floats compare with a predicate instead).
- Printing: `assert ok: 3` / `ASSERT FAILED: expected 2, actual 3` / `ASSERT BROKEN (cannot
  evaluate): <exception>`. Works on `sw` and `page`/`ext` steps.
- Verified live: manifest_version expect 3 → ok, expect 2 → `ASSERT FAILED`, exit 1; page
  `document.querySelectorAll('div').length` expect 999 → FAILED, exit 1.

**Mutation proof (H2).** Doctrine "a red test must be proven to bite" now includes the OTHER
side: after you mutate a product file to redden a test, you must PROVE the file came back
byte-identical — eyes and `git diff --stat` are not proof. Use `scripts/mutate.mjs`:

    node <skill>/scripts/mutate.mjs <file> '<old exact substring>' '<new>' <command...>
    # sha256 -> mutate -> run command -> restore -> sha256; prints RESTORED OK (sha256 identical)
    # --keep leaves the mutation in; --regex for a regexp; exit 1 if command failed or restore mismatched

Verified live: mutation made a test fail (exit 1, `BROKEN referer`), restore proven by hash.
**Never leave a product file mutated**; if the run was killed mid-mutation, `git checkout` it.

**On-the-wire gates (H6).** A gate that measures the real network beats a mock: the recipe is
(1) a fixture server with per-path counters, `maxConcurrent` (in-flight), and counters that
RESET ON READ — one metric belongs to one scan; (2) `Access-Control-Allow-Origin: *` on the
stats response or a `fetch` from a step cannot read it; (3) read them from a `sw` step
(`fetch('http://127.0.0.1:9829/__stats')` works from the extension world — host permissions).
The siren song of a gate is "I checked it on mocks" — counters on the wire do not lie.

## Fresh-profile races (measured 2026-10-11, guest run)

On a brand-new profile the extension's own cold-start (onInstalled, storage seeding) RUNS
CONCURRENTLY with your first steps for ~2 s: a step that writes to chrome.storage and reads
back gets the extension's OWN values over yours. It looks like "my test did not work" - the test
was fine. Put a settle step first (`target:"sw"`, eval the extension's own ready/load call, then
`setTimeout 1500`), and the runs become deterministic. The worker console printed per-step can
also mix startup lines into a step's window - read it with that in mind (or add the settle).

## E2E with downloads, offline (recipe, measured 2026-10-11)

1. Local fixture: `python -m http.server 9811` in a dir with index.html + real images
   (>= 50x50 px - many products filter tiny icons out as a backstop, and 1x1 stubs then
   "prove" a false defect). Open with `{"target":"page","url":"http://127.0.0.1:9811/index.html","delay":2500}`.
2. A popup opened by the probe is a TAB, not a popup over a page: a product that operates on
   `chrome.tabs.query({active:true,currentWindow:true})` will see the popup tab as active and
   consider its own result stale. Activating the target tab in a SEPARATE step does NOT survive
   to the click (guest-measured 2026-10-12: separate sw-step activation -> `0 items`; the
   attach to the popup page re-activates the popup). Activate the target tab **in the SAME eval
   that clicks** - one `target:"ext"` step:
   `(async () => { const t = (await chrome.tabs.query({})).find(x => x.url.includes("127.0.0.1:9811")); await chrome.tabs.update(t.id, {active:true}); document.getElementById("chrome-download-btn").click(); })()`.
3. Click the product's real button from `target:"ext"`, then check the FILES in
   `.ext-dev-loop/downloads` - more reliable than `chrome.downloads.search` and needs no `wait`.
4. Read the product's own state (`chrome.storage.local.get(...)`) from a `target:"sw"` step -
   the same data the popup shows.

## First-install specifics (gated permissions)

- `userScripts` is not auto-granted; the SW logs `chrome.userScripts API not available`
  until the user flips *Allow user scripts* in the host's extensions page (`chrome://extensions` for
  Chrome for Testing / Chrome, `edge://extensions` for Edge). Probe it in the SW
  context with `!!(chrome.userScripts && chrome.userScripts.executeScript)`.
- CDP cannot drive `chrome://` pages, so the one-time grant is manual: the user clicks
  the toggle once in the visible window, the agent watches for the API (or reloads) and
  continues.

## Safety rails

- The dev instance is disposable: corruption means delete the scratch profile dir and
  relaunch.
- Never paste passwords into the chat — log in by hand in the scratch window.
- `chrome://` pages: read state through the extension's own APIs or rendered text; do
  not automate the settings UI.
## 2026-10-07 — measured: the grant is per-profile, and four defects this tool had

- **`--headless=new` is not a safe spelling.** On Edge 154 it produced a VISIBLE window that stole
  the user's focus (they saw it and reported it). Plain `--headless` is the supported spelling since
  Chrome 132. The probe now passes that **and proves it took effect**: it reads `screen`/`outer` from
  a page and reports `HEADLESS confirmed` (headless synthesises the screen - measured `screen
  [800,600]` with `outer [1100,820]` = `--window-size`) or warns that a real monitor is being
  reported. Never claim headless from the command line; claim it from this line.
- **The grant check cannot be a live read.** Per the docs the API stays `undefined` in an
  already-running worker until its script context reloads, so the probe polls by reloading the
  extension and re-checking in the FRESH worker. Two traps, both hit: awaiting the CDP response to
  `chrome.runtime.reload()` never returns (it kills the worker that would answer) and it left an
  ORPHAN browser behind; and the error path never called `process.exit()`, so a finished run hung
  until the 360 s hard timeout. Fixed: bounded race around the reload, and an explicit exit.
- **`show()` crashed on an undefined eval result** (`JSON.stringify(undefined).slice`), which masked
  the very state the step existed to print. Fixed.
- **The grant is per profile, not per run.** "Allow User Scripts" is stored in the scratch profile,
  so a profile that keeps the setting needs the click ONCE - the probe now opens the exact details
  page and resumes the same run when it appears. Keep the profile; do not delete it to "clean up".
- Reminder for the agent: a visible window is a real cost to the person at the machine. Prefer
  `--headless`; when a human is needed (the grant, a login, a challenge), say exactly what to click
  and wait - do not hand them a list of steps to report back.
## 2026-10-07 (2) — the worker is IDLE on later launches, and a 20s budget hid it

Two findings from the same afternoon, both about the launch handshake:

- **The service-worker wait budget was a hard 100 x 200ms = 20s.** A slow (or merely
  non-headless) start registers its worker after that, and the run died with
  `extension SW not found - extension failed to load?` although the extension was healthy.
  Now `--sw-timeout` (default 60s), and the failure prints how long it waited.
- **Leading hypothesis for the flakiness, with the evidence that makes it a hypothesis and not
  a fact:** an MV3 worker is only listed by `/json/list` while it is RUNNING, and it is
  event-driven. On this machine the extension's worker was found on the FIRST launch into a
  profile (`onInstalled reason: install` in the console stream, i.e. a real startup event) and
  then NOT found on three later launches into the SAME profile with a 90s budget - consistent
  with "nothing woke the idle worker". What would settle it: after launch, open an
  extension-owned page (which makes the extension talk to its own worker) and re-poll. Until
  that is measured, treat "extension SW not found" as "the worker is asleep", not as
  "the extension is broken".
- Consequence for the human-in-the-loop steps (the userScripts grant, a login): do not open a
  window for the owner and then fail before the run can even see the extension. Get the
  handshake solid first, then ask for the ONE click.
## 2026-10-08 — `mouse`: an extension can be dead UNTIL the pointer moves

Measured (Chrome for Testing 137, `--headless`, a clean scratch profile): an extension was written
off as broken for a whole session - `chrome.tabs.sendMessage` answering "Receiving end does not
exist" and Ctrl+Q doing nothing - while the truth was that its content script arms only
`window.addEventListener("mousemove", ...)` at load and wires its `chrome.runtime.onMessage`
listener AND its hotkeys from the FIRST pointer move. Nothing was wrong with the browser, the
userScripts grant, or the extension.

The probe now has a `mouse` step:

    { "target": "page", "url": "<page>", "mouse": true, "mouseAt": "img" }

It dispatches two real `Input.dispatchMouseEvent` `mouseMoved`s (a DELTA is what some listeners
want), centred on `mouseAt` or at explicit `x`/`y`.

Rules this buys:
- Before concluding "the extension does not respond", ask whether the page has ever SEEN the user
  act. Put a `mouse` step before any `key`/message step that expects the content script to be live.
- Do not use `cfg`/`PVI` (or any IIFE-local, or declared-but-unset binding) as an execution marker
  from an evaluate: `typeof` reads "undefined" either way. Use a top-level `const`/`function` the
  script really defines (here: `Port`), or a registered probe script that leaves a marker.
- "Receiving end does not exist" is a statement about LISTENERS, not about injection. Prove the
  pipeline separately: `userScripts.getScripts()` + `userScripts.execute()` + a registered marker
  script.
## 2026-10-08 (2) — the script runner now READS the console (page + worker)

`--watch` could stream consoles, but it cannot be combined with `--script`, and the script runner
— which is how a whole scenario is driven in ONE invocation — enabled `Runtime` on every page and
then threw away what arrived. That is exactly how a content script failing silently during its own
init reads as "the extension does nothing".

Now every PAGE step drains the page's console, attributed per world (e.g.
`[<page> isolated#3] [error] ...`), and every WORKER step drains the service worker's. Two details
that had to be got right, both found by measurement:

- `Runtime.enable` REPLAYS its console buffer to each NEW session, and every step attaches its own
  session — so the same line arrived once per later step. The runner now dedupes within a run and
  prints `(N replayed line(s) suppressed ...)` rather than hiding anything.
- an execution context id is NOT in the same place for every event: `Runtime.consoleAPICalled`
  carries it at params level, `Runtime.exceptionThrown` only inside `params.exceptionDetails`.
  Reading the wrong one printed `ctx undefined` for every exception.

Evidence that it works (`.unlazy/console-check.json`, CfT 137 headless): a step that logs is drained
in that SAME step; a following step reports only its own new line, with an uncaught async error
shown as `[about:blank main#1] [EXC] Error: MARK-UNCAUGHT`.

One more thing the same session forced: **downloads now go to the lab, not to the human.** Three probe
runs left 54 lab PNGs in the owner's real download folder (`D:\Arx`) because the lab script redirected
downloads with `Browser.setDownloadBehavior` and the reusable tool did not. The tool now does it for
every launch, into `.ext-dev-loop/downloads`. The gotcha, measured three times: the behaviour is tied
to the CDP session that set it - set it and close that session and the log still says "redirected"
while the files go to the real folder. Keep the session open for the whole run.
Also: it must be set AFTER the endpoint answers (a call right after spawn dies with `fetch failed`),
and `chrome.downloads` downloads DO honour it once those two conditions hold (18 files in the scratch
dir, 0 in the owner's, same run).

## 2026-10-09 — lab hygiene: a closed browser is not a dead process, and ports are reserved

- **CDP `Browser.close` does not reliably end the PROCESS.** Measured 2026-10-09: a lingering process
  keeps the profile's singleton, so the next launch with the same `--user-data-dir` hands its URL to
  that existing process and exits — no window of your own, and the run talks to yesterday's browser.
  Kill an orphan **through its own endpoint** (endpoint-addressed means it can never touch a browser
  that was not started with `--remote-debugging-port` — e.g. the owner's own Chrome), then relaunch.
  `scripts/ports.mjs` is the sweep — note it **CLOSES every lab port it finds**, through each port's
  own endpoint; it is not a status query. To only ASK which lab browsers are alive, fetch
  `http://127.0.0.1:<port>/json/version` on 9793-9831 and nothing else. The Imagus project learned
  this the hard way: running the sweep as a question closed the window the owner was using. Its
  `.unlazy/lab-kill.mjs` is the kill implementation to copy from.
- **Reserve a port range for the harness, sub-ranged per script.** The lab uses **9793-9831**:
  `rule34-*` 9801-9817, `scan-ab` 9821, `net-probe` 9823. Picking a port ad hoc is how a probe ends up
  attached to someone else's browser (fact 10).

## 2026-10-10 — deleting a scratch profile that refuses to die (measured, the hard way)

A test killed while a browser it spawned is still alive leaves a profile directory that then
**refuses deletion with "Access denied" for EVERYONE — including an elevated administrator, and
including Windows Recovery (OS not running)**. takeown fails, icacls fails, `rmdir /s /q` fails,
`Remove-Item -Force` fails, a SYSTEM scheduled task fails, chkdsk /f finds nothing wrong. What
actually happened in the incident: the kill orphaned the browser, the browser kept writing into its
profile, and deletion attempts ran CONCURRENTLY with those writes — leaving directory-index entries
that name files that no longer exist (`dir` lists folders that are not physically there). NTFS then
answers access-denied on the stale subtree, and that state SURVIVES a reboot (it is on-disk metadata,
not a live handle; handle.exe shows no holder).

The fix — rename first, then delete:

```
move <stale-dir> <stale-dir>.kill    (or rename in Explorer)
rmdir /s /q <stale-dir>.kill
```

Renaming forces NTFS to REWRITE the parent index entry — the exact entries that were torn — and
deletion then goes through. A rename that also fails is the true "still locked" case; retry after
closing holders, not with more permission tools.

Prevention is cheaper than the cure, and it is already the skill's rule: never let a run die holding
a live browser. `Browser.close` through the CDP endpoint, wait for it, and only then touch the
profile. A timeout-killed run with a live child must be followed by `ports.mjs` (closes every lab
port) BEFORE any cleanup of profile directories.

## Where the numbers come from

Every measurement quoted here was taken on this machine during real runs, and every browser
verdict has survived a re-run: the "Edge 154 loads nothing" note of 2026-10-07 was a false
negative from a broken run and was disproved on 2026-10-10 by the same headless+flag launch it
claimed to have tried (SW found, state read). The full log, including the Edge 154 → Chrome for
Testing migration comparison table, lives in the Imagus project's `knowledge.md` — grep it for
`Chrome for Testing`, `2026-10-07`, `singleton`, `grant is per`.

The project's `Docs/LAB_ENVIRONMENT.md` is the other half: the fixed lab constants (browser exe, the
reusable `cft-md` profile, extension id, download dir), the one launch recipe, the port map with each
harness's owner, and the host landmines (`ls` hangs in Git Bash — use a tiny `fs` script; `lab-ports`
closes ports; an occupied port means the run is talking to an orphan). Read it before launching
anything in that lab instead of re-deriving the values.

One deliberate difference between the two loops: **lab/site runs are VISIBLE windows by design** —
the profiled sites hold Cloudflare clearance and the owner logs in by hand — while the *extension
loading* checks the skill runs for you work headless. Do not "simplify" a site probe to `--headless`.

