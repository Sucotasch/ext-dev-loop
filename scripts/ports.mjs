// Read-only sweep of the lab's CDP ports. If a lab browser is orphaned, close it
// THROUGH ITS OWN ENDPOINT (endpoint-addressed => can never touch a browser that was
// started without --remote-debugging-port; the owner's own Chrome has none).
//
// The port range is a per-machine fact: read it from LOCAL.md when the agent maintains one
// (see SKILL.md "Local facts"), fall back to the defaults below. Old hardcoded list was
// 9793-9831 and silently missed harnesses added outside it.
function reservedRange() {
  try {
    const m = /^reserved-ports:\s*(\d+)-(\d+)$/m.exec(fs.readFileSync(path.join(os.homedir(), ".ext-dev-loop", "LOCAL.md"), "utf8"));
    if (m) return [Number(m[1]), Number(m[2])];
  } catch {}
  return [9793, 9831];
}
const [PORT_LO, PORT_HI] = reservedRange();
const ports = Array.from({ length: PORT_HI - PORT_LO + 1 }, (_, i) => PORT_LO + i);
let alive = 0;
for (const port of ports) {
  try {
    const v = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(700) })).json();
    alive++;
    console.log(`port ${port}: ALIVE  ${v.Browser}`);
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });
    ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    await new Promise((r) => setTimeout(r, 600));
    try { ws.close(); } catch {}
    console.log(`  -> Browser.close sent (lab browser only)`);
  } catch (_) { /* nothing on this port */ }
}
console.log(alive === 0 ? "no lab browser left running" : `${alive} lab browser(s) closed`);
