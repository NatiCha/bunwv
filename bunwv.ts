#!/usr/bin/env bun
const rawArgs = Bun.argv.slice(2);
const command = rawArgs[0];

// Parse all --flag value pairs and collect positional args
const flags: Record<string, string> = {};
const positional: string[] = [];

for (let i = 1; i < rawArgs.length; i++) {
  const arg = rawArgs[i]!;
  if (arg.startsWith("--") && i + 1 < rawArgs.length) {
    flags[arg.slice(2)] = rawArgs[i + 1]!;
    i++; // skip value
  } else {
    positional.push(arg);
  }
}

function getFlag(name: string): string | undefined {
  return flags[name];
}

// Session name determines socket/PID paths
const sessionName = flags.session || "default";
const SOCKET_PATH = `/tmp/bunwv-${sessionName}.sock`;
const PID_PATH = `/tmp/bunwv-${sessionName}.pid`;

async function send(path: string, opts?: { method?: string; body?: any }): Promise<Response> {
  return fetch(`http://localhost${path}`, {
    unix: SOCKET_PATH,
    method: opts?.method ?? "GET",
    headers: opts?.body ? { "Content-Type": "application/json" } : undefined,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  } as any);
}

async function sendJSON(path: string, body?: any): Promise<any> {
  const res = await send(path, body !== undefined ? { method: "POST", body } : undefined);
  return res.json();
}

async function checkDaemon(): Promise<boolean> {
  try {
    await send("/status");
    return true;
  } catch {
    return false;
  }
}

if (!command || command === "help") {
  console.log(`Usage: bunwv <command> [--session <name>] [args]

All commands accept --session <name> to target a named session (default: "default").

Session:
  start [--width N] [--height N] [--data-store PATH] [--idle-timeout ms]
        [--backend webkit|chrome] [--chrome-path PATH]
                            Start a bunwv daemon (default 1920x1080, 30min idle timeout)
  stop                      Stop the daemon and clean up
  status                    Show current URL, title, loading state, and session info
  sessions                  List all running WebView sessions

Navigation:
  navigate <url>            Navigate to a URL
  back                      Go back in history
  forward                   Go forward in history
  reload                    Reload the current page

Interaction:
  click <selector>          Click element by CSS selector (auto-waits, isTrusted)
  click <x> <y>             Click at coordinates (isTrusted)
  click-text <text>         Click element by visible text (JS click, not isTrusted)
        [--tag <sel>]       Element types to search (default: button, a, [role=button])
  type <text>               Type text into the focused element
  press <key>               Press a key (Enter, Tab, Escape, etc.)
        [--mod m1,m2]       Key modifiers: meta, ctrl, shift, alt
  clear <selector>          Clear an input/textarea (React-compatible)
  scroll <dx> <dy>          Scroll by pixel delta
  scroll <selector>         Scroll element into view
  submit                    Submit a form via requestSubmit() (React-compatible)
        [--form <sel>]      Target form selector (default: first form)
        [--button <text>]   Submit via a specific button by text

Inspection:
  screenshot [file]         Save screenshot (default: /tmp/bunwv-screenshot.png)
        [--format png|jpeg|webp] [--quality 0-100]
  eval <expr>               Evaluate JS in the page (auto-wraps statements)
  console [--clear]         Show captured page console output
        [--since <ts>]      Only show messages after timestamp (ms)
  cdp <method>              Raw Chrome DevTools Protocol call (Chrome backend only)
        [--params '{}']     JSON params for the CDP method
  resize <w> <h>            Resize the viewport

Waiting:
  wait-for <selector>       Wait until element appears in the DOM
  wait-for-gone <selector>  Wait until element is removed from the DOM
        [--timeout ms]      Override timeout (default: 10000ms)`);
  process.exit(0);
}

if (command === "sessions") {
  const { readdirSync } = await import("node:fs");
  const sockets = readdirSync("/tmp").filter(f => f.startsWith("bunwv-") && f.endsWith(".sock"));
  if (sockets.length === 0) {
    console.log("No running sessions.");
    process.exit(0);
  }
  for (const sock of sockets) {
    const name = sock.replace("bunwv-", "").replace(".sock", "");
    const sockPath = `/tmp/${sock}`;
    try {
      const res = await fetch("http://localhost/status", { unix: sockPath } as any);
      const data = (await res.json()) as { pid: number; url: string; title: string };
      console.log(`  ${name}  PID: ${data.pid}  URL: ${data.url || "(none)"}  Title: ${data.title || "(none)"}`);
    } catch {
      // Stale socket — daemon not responding
      const pidPath = `/tmp/bunwv-${name}.pid`;
      try {
        const pid = await Bun.file(pidPath).text();
        console.log(`  ${name}  PID: ${pid.trim()}  (not responding — stale)`);
      } catch {
        console.log(`  ${name}  (stale socket, no PID file)`);
      }
    }
  }
  process.exit(0);
}

if (command === "start") {
  if (await checkDaemon()) {
    try {
      const res = await send("/status");
      const data = (await res.json()) as { pid: number; url: string; title: string };
      console.log(`Reusing existing session "${sessionName}" (PID: ${data.pid})`);
      if (data.url) console.log(`  URL:   ${data.url}`);
      if (data.title) console.log(`  Title: ${data.title}`);
    } catch {
      console.log(`bunwv daemon "${sessionName}" already running.`);
    }
    process.exit(0);
  }

  const daemonArgs = ["bun", `${import.meta.dir}/lib/daemon.ts`, "--session", sessionName];
  const width = getFlag("width");
  const height = getFlag("height");
  const dataStore = getFlag("data-store");
  const idleTimeout = getFlag("idle-timeout");
  if (width) daemonArgs.push("--width", width);
  if (height) daemonArgs.push("--height", height);
  if (dataStore) daemonArgs.push("--data-store", dataStore);
  if (idleTimeout) daemonArgs.push("--idle-timeout", idleTimeout);
  const backendFlag = getFlag("backend");
  const chromePathFlag = getFlag("chrome-path");
  if (backendFlag) daemonArgs.push("--backend", backendFlag);
  if (chromePathFlag) daemonArgs.push("--chrome-path", chromePathFlag);

  const proc = Bun.spawn(daemonArgs, {
    stdio: ["ignore", "ignore", "ignore"],
  });
  proc.unref();

  // Poll until daemon is ready
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (await checkDaemon()) {
      const pid = await Bun.file(PID_PATH).text();
      console.log(`bunwv daemon started (session: "${sessionName}", PID: ${pid.trim()})`);
      process.exit(0);
    }
    await Bun.sleep(100);
  }
  console.error("Failed to start daemon within 5s");
  process.exit(1);
}

// All other commands require running daemon
if (!(await checkDaemon())) {
  console.error(`Daemon not running (session: "${sessionName}"). Start it with: bunwv start`);
  process.exit(1);
}

switch (command) {
  case "navigate": {
    const url = positional[0];
    if (!url) { console.error("Usage: bunwv navigate <url>"); process.exit(1); }
    const res = await sendJSON("/navigate", { url });
    if (res.ok) {
      console.log(`${res.url}\n${res.title || "(no title)"}`);
    } else {
      console.error(`Error: ${res.error}`);
      process.exit(1);
    }
    break;
  }

  case "click": {
    const x = parseFloat(positional[0] ?? "");
    const y = parseFloat(positional[1] ?? "");
    const body = !isNaN(x) && !isNaN(y) ? { x, y } : { selector: positional[0] };
    if (!positional[0]) { console.error("Usage: bunwv click <selector> | <x> <y>"); process.exit(1); }
    const res = await sendJSON("/click", body);
    if (!res.ok) { console.error(`Error: ${res.error}`); process.exit(1); }
    break;
  }

  case "click-text": {
    const text = positional.join(" ");
    if (!text) { console.error("Usage: bunwv click-text <text> [--tag <selector>]"); process.exit(1); }
    const tag = getFlag("tag");
    const res = await sendJSON("/click-text", { text, tag });
    if (!res.ok) { console.error(`Error: ${res.error}`); process.exit(1); }
    break;
  }

  case "clear": {
    const selector = positional[0];
    if (!selector) { console.error("Usage: bunwv clear <selector>"); process.exit(1); }
    const res = await sendJSON("/clear", { selector });
    if (!res.ok) { console.error(`Error: ${res.error}`); process.exit(1); }
    break;
  }

  case "type": {
    const text = positional.join(" ");
    if (!text) { console.error("Usage: bunwv type <text>"); process.exit(1); }
    const res = await sendJSON("/type", { text });
    if (!res.ok) { console.error(`Error: ${res.error}`); process.exit(1); }
    break;
  }

  case "press": {
    const key = positional[0];
    if (!key) { console.error("Usage: bunwv press <key> [--mod meta,ctrl]"); process.exit(1); }
    const modStr = getFlag("mod");
    const modifiers = modStr ? modStr.split(",") : undefined;
    const res = await sendJSON("/press", { key, modifiers });
    if (!res.ok) { console.error(`Error: ${res.error}`); process.exit(1); }
    break;
  }

  case "scroll": {
    const dx = parseFloat(positional[0] ?? "");
    const dy = parseFloat(positional[1] ?? "");
    const body = !isNaN(dx) && !isNaN(dy) ? { dx, dy } : { selector: positional[0] };
    if (!positional[0]) { console.error("Usage: bunwv scroll <selector> | <dx> <y>"); process.exit(1); }
    const res = await sendJSON("/scroll", body);
    if (!res.ok) { console.error(`Error: ${res.error}`); process.exit(1); }
    break;
  }

  case "screenshot": {
    const format = getFlag("format") || "png";
    const quality = getFlag("quality");
    const ext = format === "jpeg" ? ".jpg" : format === "webp" ? ".webp" : ".png";
    const filename = positional[0] || `/tmp/bunwv-screenshot${ext}`;
    let path = `/screenshot?format=${format}`;
    if (quality) path += `&quality=${quality}`;
    const res = await send(path);
    if (res.headers.get("content-type")?.includes("image")) {
      await Bun.write(filename, new Uint8Array(await res.arrayBuffer()));
      console.log(filename);
    } else {
      const data = (await res.json()) as { error: string };
      console.error(`Error: ${data.error}`);
      process.exit(1);
    }
    break;
  }

  case "eval": {
    const expr = positional.join(" ");
    if (!expr) { console.error("Usage: bunwv eval <expr>"); process.exit(1); }
    const res = await sendJSON("/evaluate", { expr });
    if (res.ok) {
      console.log(typeof res.result === "string" ? res.result : JSON.stringify(res.result, null, 2));
    } else {
      console.error(`Error: ${res.error}`);
      process.exit(1);
    }
    break;
  }

  case "submit": {
    const form = getFlag("form");
    const button = getFlag("button");
    const res = await sendJSON("/submit", { form, button });
    if (!res.ok) { console.error(`Error: ${res.error}`); process.exit(1); }
    break;
  }

  case "wait-for": {
    const selector = positional[0];
    if (!selector) { console.error("Usage: bunwv wait-for <selector> [--timeout ms]"); process.exit(1); }
    const timeout = getFlag("timeout") ? parseInt(getFlag("timeout")!) : undefined;
    const res = await sendJSON("/wait-for", { selector, timeout });
    if (!res.ok) { console.error(`Error: ${res.error}`); process.exit(1); }
    break;
  }

  case "wait-for-gone": {
    const selector = positional[0];
    if (!selector) { console.error("Usage: bunwv wait-for-gone <selector> [--timeout ms]"); process.exit(1); }
    const timeout = getFlag("timeout") ? parseInt(getFlag("timeout")!) : undefined;
    const res = await sendJSON("/wait-for-gone", { selector, timeout });
    if (!res.ok) { console.error(`Error: ${res.error}`); process.exit(1); }
    break;
  }

  case "status": {
    const res = await send("/status");
    const data = (await res.json()) as { session: string; pid: number; url: string; title: string; loading: boolean };
    console.log(`Session: ${data.session}\nPID:     ${data.pid}\nURL:     ${data.url || "(none)"}\nTitle:   ${data.title || "(none)"}\nLoading: ${data.loading}`);
    break;
  }

  case "resize": {
    const w = parseInt(positional[0] ?? "");
    const h = parseInt(positional[1] ?? "");
    if (isNaN(w) || isNaN(h)) { console.error("Usage: bunwv resize <width> <height>"); process.exit(1); }
    const res = await sendJSON("/resize", { width: w, height: h });
    if (!res.ok) { console.error(`Error: ${res.error}`); process.exit(1); }
    break;
  }

  case "back": {
    const res = await sendJSON("/back", {});
    if (!res.ok) { console.error(`Error: ${res.error}`); process.exit(1); }
    break;
  }

  case "forward": {
    const res = await sendJSON("/forward", {});
    if (!res.ok) { console.error(`Error: ${res.error}`); process.exit(1); }
    break;
  }

  case "reload": {
    const res = await sendJSON("/reload", {});
    if (!res.ok) { console.error(`Error: ${res.error}`); process.exit(1); }
    break;
  }

  case "stop": {
    try {
      await sendJSON("/stop", {});
    } catch {
      // Expected — daemon exits before response completes
    }
    console.log(`Daemon stopped (session: "${sessionName}").`);
    break;
  }

  case "console": {
    const clear = getFlag("clear") !== undefined;
    const since = getFlag("since");
    const params: string[] = [];
    if (clear) params.push("clear=true");
    if (since) params.push(`since=${since}`);
    const path = "/console" + (params.length ? "?" + params.join("&") : "");
    const res = await send(path);
    const data = (await res.json()) as { ok: boolean; messages: { level: string; message: string }[]; error?: string };
    if (!data.ok) { console.error(`Error: ${data.error}`); process.exit(1); }
    if (data.messages.length === 0) {
      console.log("(no console output)");
    } else {
      for (const m of data.messages) {
        console.log(`[${m.level}] ${m.message}`);
      }
    }
    break;
  }

  case "cdp": {
    const method = positional[0];
    if (!method) { console.error("Usage: bunwv cdp <method> [--params '{}']"); process.exit(1); }
    const paramsStr = getFlag("params");
    let params = {};
    if (paramsStr) {
      try { params = JSON.parse(paramsStr); }
      catch { console.error("Invalid JSON in --params"); process.exit(1); }
    }
    const res = await sendJSON("/cdp", { method, params });
    if (res.ok) {
      console.log(JSON.stringify(res.result, null, 2));
    } else {
      console.error(`Error: ${res.error}`);
      process.exit(1);
    }
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    process.exit(1);
}
