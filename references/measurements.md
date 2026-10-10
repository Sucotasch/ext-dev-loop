# Measurements diary

Dated notes from real runs, kept verbatim: every entry is a measurement or a bug this
harness hit on a real box (hostnames and project names left in deliberately - they are the
provenance of the numbers). The core SKILL.md carries the distilled rules; this file carries
the evidence. Read when a rule seems arbitrary, or before changing harness behaviour.

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

