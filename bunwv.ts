#!/usr/bin/env bun

// Exit codes (see CLAUDE.md "Design principles (agent-first)")
const EXIT = {
  ok: 0,
  generic: 1,
  usage: 2,
  timeout: 3,
  notFound: 4,
  daemonUnreachable: 5,
  batchPartial: 6,
} as const;

// Boolean flags don't consume the next token. Everything else takes one value
// (via `--flag value` or `--flag=value`). Repeated flags accumulate into arrays.
const BOOLEAN_FLAGS = new Set(["json", "all", "clear", "keep-going"]);

interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | string[]>;
}

function parseArgs(rawArgs: string[]): ParsedArgs {
  const flags: Record<string, string | string[]> = {};
  const positional: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]!;
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      let name: string;
      let val: string | undefined;
      if (eq !== -1) {
        name = body.slice(0, eq);
        val = body.slice(eq + 1);
      } else {
        name = body;
        const next = rawArgs[i + 1];
        if (BOOLEAN_FLAGS.has(name) || next === undefined || next.startsWith("--")) {
          val = undefined;
        } else {
          val = next;
          i++;
        }
      }
      if (val === undefined) {
        flags[name] = "true";
      } else {
        const existing = flags[name];
        if (existing === undefined) flags[name] = val;
        else if (Array.isArray(existing)) existing.push(val);
        else flags[name] = [existing, val];
      }
    } else {
      positional.push(arg);
    }
  }
  const command = positional.shift();
  return { command, positional, flags };
}

interface RunResult {
  stdout: string;
  stdoutBytes?: Uint8Array;
  stderr: string;
  exitCode: number;
}

function stripOk<T extends Record<string, any>>(x: T): Omit<T, "ok"> {
  const { ok: _, ...rest } = x;
  return rest;
}

async function runCommand(argv: string[]): Promise<RunResult> {
  const { command, positional, flags } = parseArgs(argv);

  const getFlag = (name: string): string | undefined => {
    const v = flags[name];
    if (v === undefined) return undefined;
    return Array.isArray(v) ? v[v.length - 1] : v;
  };
  const getFlags = (name: string): string[] => {
    const v = flags[name];
    if (v === undefined) return [];
    return Array.isArray(v) ? v : [v];
  };
  const hasFlag = (name: string) => flags[name] !== undefined;

  const sessionName = getFlag("session") || Bun.env.BUNWV_SESSION || "default";
  const SOCKET_PATH = `/tmp/bunwv-${sessionName}.sock`;
  const PID_PATH = `/tmp/bunwv-${sessionName}.pid`;
  const jsonMode = hasFlag("json");

  let stdout = "";
  let stdoutBytes: Uint8Array | undefined;
  let stderr = "";

  const say = (s: string) => { stdout += s + "\n"; };
  const cry = (s: string) => { stderr += s + "\n"; };

  const usage = (msg: string, code: number = EXIT.usage): RunResult => {
    const line = JSON.stringify({ ok: false, error: msg, exitCode: code });
    if (jsonMode) say(line);
    else cry(line);
    return { stdout, stdoutBytes, stderr, exitCode: code };
  };

  const emitError = (error: string, status?: number): RunResult => {
    let code: number = EXIT.generic;
    if (status === 404 || /not found/i.test(error)) code = EXIT.notFound;
    else if (/timed out|timeout/i.test(error)) code = EXIT.timeout;
    const line = JSON.stringify({ ok: false, error, exitCode: code });
    if (jsonMode) say(line);
    else cry(line);
    return { stdout, stdoutBytes, stderr, exitCode: code };
  };

  const emitConsoleErrors = (headerValue: string | null) => {
    if (!headerValue) return;
    try {
      const errors = JSON.parse(headerValue);
      if (Array.isArray(errors) && errors.length) cry(JSON.stringify({ console: errors }));
    } catch {}
  };

  const rawSend = (path: string, opts?: { method?: string; body?: any }): Promise<Response> =>
    fetch(`http://localhost${path}`, {
      unix: SOCKET_PATH,
      method: opts?.method ?? "GET",
      headers: opts?.body ? { "Content-Type": "application/json" } : undefined,
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
    } as any);

  const send = async (path: string, opts?: { method?: string; body?: any }): Promise<Response | RunResult> => {
    try {
      return await rawSend(path, opts);
    } catch (e: any) {
      const code = EXIT.daemonUnreachable;
      const line = JSON.stringify({ ok: false, error: `daemon unreachable: ${e.message}`, exitCode: code });
      if (jsonMode) say(line);
      else cry(`Daemon not running (session: "${sessionName}"). Start it with: bunwv start`);
      return { stdout, stdoutBytes, stderr, exitCode: code };
    }
  };

  const invoke = async (path: string, body?: any): Promise<{ data: any; status: number } | RunResult> => {
    const response = await send(path, body !== undefined ? { method: "POST", body } : undefined);
    if (!(response instanceof Response)) return response;
    emitConsoleErrors(response.headers.get("X-Console-Errors"));
    const data = (await response.json()) as any;
    if (!data.ok) return emitError(data.error, response.status);
    return { data, status: response.status };
  };

  const checkDaemon = async (): Promise<boolean> => {
    try { await rawSend("/status"); return true; } catch { return false; }
  };

  const parseMods = (raw: string[]): string[] | undefined => {
    if (raw.length === 0) return undefined;
    const out: string[] = [];
    for (const r of raw) for (const m of r.split(",")) if (m) out.push(m);
    return out.length ? out : undefined;
  };

  const silentOk = (): RunResult => {
    if (jsonMode) say(JSON.stringify({ ok: true, exitCode: 0 }));
    return { stdout, stdoutBytes, stderr, exitCode: 0 };
  };

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  if (!command || command === "help") {
    say(`Usage: bunwv <command> [--session <name>] [--json] [args]

All commands accept --session <name> (or BUNWV_SESSION env var) to target a session.
Flags may appear before or after the command. --flag=value and --flag value both work.
Successful verbs print nothing on stdout (exit 0). Errors are JSON on stderr with a nonzero exit.
--json wraps every response as {ok, data?, error?, exitCode}.

Exit codes:
  0 ok            1 generic           2 usage
  3 timeout       4 element-not-found 5 daemon-unreachable
  6 batch-partial (batch ran --keep-going and ≥1 command failed)

Session:
  start [--width N] [--height N] [--data-store PATH] [--idle-timeout ms]
        [--backend webkit|chrome] [--chrome-path PATH] [--chrome-argv '[json]']
        [--chrome-stdout inherit|ignore] [--chrome-stderr inherit|ignore]
        [--chrome-url <ws-url>]
        [--webkit-stdout inherit|ignore] [--webkit-stderr inherit|ignore]
        [--url <initial-url>]       Start a bunwv daemon (default 1920x1080, 30min idle timeout)
  close [--all]                     Stop this session (or all sessions with --all)
  status                            Terse: "<url> | <title> | <idle|loading> | pending=<n>"
  sessions                          List all running WebView sessions

Navigation:
  navigate <url>                    Navigate to a URL
  back / forward / reload           History + refresh

Interaction:
  click --selector <css>            Click a CSS selector (auto-waits, isTrusted)
  click --text <text>               Click element by visible text
        [--text-match exact|contains|regex]    default: contains (trimmed)
  click --at <x,y>                  Click at coordinates
        [--button left|right|middle] [--count 1|2|3]
        [--mod Shift] [--mod Control] [--mod Alt] [--mod Meta]
        [--timeout ms]
  type <text>                       Type into the focused element
  press <key> [--mod Shift] ...     Press a key (Enter, Tab, Escape, etc.)
  clear <selector>                  Clear an input/textarea (React-compatible)
  scroll <dx> <dy>                  Scroll by wheel delta
  scroll-to <selector>              Scroll element into view
        [--block start|center|end|nearest] [--timeout ms]
  submit [--form <sel>] [--button <text>]

Inspection:
  screenshot [--format png|jpeg|webp] [--quality 0-100]
             [--encoding blob|buffer|base64|shmem] [--out <path>|-]
                                    Default: writes bytes to /tmp/bunwv-screenshot-<session>.png
  evaluate <expr>                   JS in page; prints JSON-literal result (auto-wraps statements)
  exists <selector>                 Silent. Exit 0 if present, 4 if not
  console [--clear] [--since <seq>] Captured page console output (NDJSON; cursor-based)
  events [--since <seq>]            Events since cursor (navigation + subscribed CDP)
  cdp <method> [--params '{}']      Raw CDP call (Chrome backend only)
  cdp-subscribe <type> [<type>...]  Subscribe to one or more CDP events
  cdp-unsubscribe <type> [<type>...]
  cdp-subscriptions                 Active subscriptions, one per line
  resize <w> <h>                    Resize the viewport

Waiting:
  wait-for <selector>               Wait for a selector to appear
  wait-for --url <substring>        Wait for url to contain substring
  wait-for --title <substring>      Wait for title to contain substring
        [--timeout ms]
  wait-for-gone <selector> | --url <substr> | --title <substr>
        [--timeout ms]

Batch:
  batch [--file <path>] [--keep-going]
                                    Read NDJSON-style lines from stdin (or --file).
                                    Each line is a JSON array of args, e.g.
                                      ["navigate","https://example.com"]
                                      ["evaluate","document.title"]
                                    One NDJSON envelope per command on stdout.`);
    return { stdout, stdoutBytes, stderr, exitCode: 0 };
  }

  if (command === "sessions") {
    const { readdirSync } = await import("node:fs");
    const sockets = readdirSync("/tmp").filter(f => f.startsWith("bunwv-") && f.endsWith(".sock"));
    if (sockets.length === 0) {
      if (jsonMode) say(JSON.stringify({ ok: true, data: [], exitCode: 0 }));
      else say("No running sessions.");
      return { stdout, stdoutBytes, stderr, exitCode: 0 };
    }
    const rows: any[] = [];
    for (const sock of sockets) {
      const name = sock.replace("bunwv-", "").replace(".sock", "");
      const sockPath = `/tmp/${sock}`;
      try {
        const res = await fetch("http://localhost/status", { unix: sockPath } as any);
        const data = (await res.json()) as { pid: number; url: string; title: string };
        rows.push({ session: name, pid: data.pid, url: data.url, title: data.title });
        if (!jsonMode) say(`  ${name}  PID: ${data.pid}  URL: ${data.url || "(none)"}  Title: ${data.title || "(none)"}`);
      } catch {
        const pidPath = `/tmp/bunwv-${name}.pid`;
        try {
          const pid = (await Bun.file(pidPath).text()).trim();
          rows.push({ session: name, pid, stale: true });
          if (!jsonMode) say(`  ${name}  PID: ${pid}  (not responding — stale)`);
        } catch {
          rows.push({ session: name, stale: true });
          if (!jsonMode) say(`  ${name}  (stale socket, no PID file)`);
        }
      }
    }
    if (jsonMode) say(JSON.stringify({ ok: true, data: rows, exitCode: 0 }));
    return { stdout, stdoutBytes, stderr, exitCode: 0 };
  }

  if (command === "start") {
    if (await checkDaemon()) {
      const res = await rawSend("/status");
      const daemon = (await res.json()) as { pid: number; url: string; title: string };
      if (jsonMode) say(JSON.stringify({ ok: true, data: { reused: true, ...stripOk(daemon as any) }, exitCode: 0 }));
      else {
        say(`Reusing existing session "${sessionName}" (PID: ${daemon.pid})`);
        if (daemon.url) say(`  URL:   ${daemon.url}`);
        if (daemon.title) say(`  Title: ${daemon.title}`);
      }
      return { stdout, stdoutBytes, stderr, exitCode: 0 };
    }

    const daemonArgs = ["bun", `${import.meta.dir}/lib/daemon.ts`, "--session", sessionName];
    const passthrough = [
      "width", "height", "data-store", "idle-timeout",
      "backend", "chrome-path", "chrome-argv", "chrome-stdout", "chrome-stderr", "chrome-url",
      "webkit-stdout", "webkit-stderr", "url",
    ];
    for (const name of passthrough) {
      const v = getFlag(name);
      if (v !== undefined) daemonArgs.push(`--${name}`, v);
    }
    const proc = Bun.spawn(daemonArgs, { stdio: ["ignore", "ignore", "ignore"] });
    proc.unref();
    const start = Date.now();
    while (Date.now() - start < 5000) {
      if (await checkDaemon()) {
        const pid = (await Bun.file(PID_PATH).text()).trim();
        if (jsonMode) say(JSON.stringify({ ok: true, data: { session: sessionName, pid: parseInt(pid) }, exitCode: 0 }));
        else say(`bunwv daemon started (session: "${sessionName}", PID: ${pid})`);
        return { stdout, stdoutBytes, stderr, exitCode: 0 };
      }
      await Bun.sleep(100);
    }
    return emitError("failed to start daemon within 5s");
  }

  if (command === "close" && hasFlag("all")) {
    const { readdirSync, existsSync, unlinkSync } = await import("node:fs");
    const sockets = readdirSync("/tmp").filter(f => f.startsWith("bunwv-") && f.endsWith(".sock"));
    const results: any[] = [];
    for (const sock of sockets) {
      const name = sock.replace("bunwv-", "").replace(".sock", "");
      const sockPath = `/tmp/${sock}`;
      const pidPath = `/tmp/bunwv-${name}.pid`;
      try { await fetch("http://localhost/close", { unix: sockPath, method: "POST" } as any); } catch {}
      // Wait up to 500ms for the daemon to actually exit before reporting closed.
      const deadline = Date.now() + 500;
      while (Date.now() < deadline && existsSync(sockPath)) await Bun.sleep(20);
      // If something's left behind (dead daemon that never cleaned up), unlink.
      try { if (existsSync(sockPath)) unlinkSync(sockPath); } catch {}
      try { if (existsSync(pidPath)) unlinkSync(pidPath); } catch {}
      results.push({ session: name, closed: true });
    }
    if (jsonMode) say(JSON.stringify({ ok: true, data: results, exitCode: 0 }));
    else if (results.length === 0) say("No running sessions.");
    else for (const r of results) say(`Closed: ${r.session}`);
    return { stdout, stdoutBytes, stderr, exitCode: 0 };
  }

  // Batch is handled at the top level, not here.

  // All remaining commands require a running daemon.
  if (!(await checkDaemon())) {
    const code = EXIT.daemonUnreachable;
    if (jsonMode) say(JSON.stringify({ ok: false, error: `daemon not running (session: "${sessionName}")`, exitCode: code }));
    else cry(`Daemon not running (session: "${sessionName}"). Start it with: bunwv start`);
    return { stdout, stdoutBytes, stderr, exitCode: code };
  }

  const isRunResult = (v: unknown): v is RunResult => typeof v === "object" && v !== null && "exitCode" in (v as any);

  switch (command) {
    case "navigate": {
      const url = positional[0];
      if (!url) return usage("Usage: bunwv navigate <url>");
      const r = await invoke("/navigate", { url });
      if (isRunResult(r)) return r;
      return silentOk();
    }

    case "click": {
      const selectorFlag = getFlag("selector");
      const textFlag = getFlag("text");
      const atFlag = getFlag("at");
      const textMatch = getFlag("text-match");
      const buttonFlag = getFlag("button");
      const countFlag = getFlag("count");
      const timeoutFlag = getFlag("timeout");
      const modifiers = parseMods(getFlags("mod"));

      const targets = [selectorFlag, textFlag, atFlag].filter(v => v !== undefined).length;
      if (targets === 0) return usage("Usage: bunwv click --selector <css> | --text <text> | --at <x,y>");
      if (targets > 1) return usage("bunwv click: specify exactly one of --selector, --text, --at");

      const body: any = {};
      if (selectorFlag) body.selector = selectorFlag;
      else if (textFlag) {
        body.text = textFlag;
        if (textMatch) body.textMatch = textMatch;
      } else if (atFlag) {
        const [xs, ys] = atFlag.split(",");
        const x = parseFloat(xs ?? "");
        const y = parseFloat(ys ?? "");
        if (isNaN(x) || isNaN(y)) return usage("--at requires <x,y> (e.g. --at 100,200)");
        body.x = x; body.y = y;
      }
      if (buttonFlag) body.button = buttonFlag;
      if (countFlag) body.clickCount = parseInt(countFlag);
      if (modifiers) body.modifiers = modifiers;
      if (timeoutFlag) body.timeout = parseInt(timeoutFlag);
      const r = await invoke("/click", body);
      if (isRunResult(r)) return r;
      return silentOk();
    }

    case "clear": {
      const selector = positional[0];
      if (!selector) return usage("Usage: bunwv clear <selector>");
      const r = await invoke("/clear", { selector });
      if (isRunResult(r)) return r;
      return silentOk();
    }

    case "type": {
      const text = positional.join(" ");
      if (!text) return usage("Usage: bunwv type <text>");
      const r = await invoke("/type", { text });
      if (isRunResult(r)) return r;
      return silentOk();
    }

    case "press": {
      const key = positional[0];
      if (!key) return usage("Usage: bunwv press <key> [--mod Shift] [--mod Control]");
      const modifiers = parseMods(getFlags("mod"));
      const r = await invoke("/press", { key, modifiers });
      if (isRunResult(r)) return r;
      return silentOk();
    }

    case "scroll": {
      const dx = parseFloat(positional[0] ?? "");
      const dy = parseFloat(positional[1] ?? "");
      if (isNaN(dx) || isNaN(dy)) return usage("Usage: bunwv scroll <dx> <dy>");
      const r = await invoke("/scroll", { dx, dy });
      if (isRunResult(r)) return r;
      return silentOk();
    }

    case "scroll-to": {
      const selector = positional[0];
      if (!selector) return usage("Usage: bunwv scroll-to <selector> [--block start|center|end|nearest] [--timeout ms]");
      const body: any = { selector };
      const block = getFlag("block");
      if (block) body.block = block;
      const timeout = getFlag("timeout");
      if (timeout) body.timeout = parseInt(timeout);
      const r = await invoke("/scroll", body);
      if (isRunResult(r)) return r;
      return silentOk();
    }

    case "screenshot": {
      const format = getFlag("format") || "png";
      const quality = getFlag("quality");
      const encoding = getFlag("encoding") || "blob";
      const outFlag = getFlag("out");
      const ext = format === "jpeg" ? ".jpg" : format === "webp" ? ".webp" : ".png";
      const defaultOut = `/tmp/bunwv-screenshot-${sessionName}${ext}`;
      const params = new URLSearchParams({ format, encoding });
      if (quality) params.set("quality", quality);
      const response = await send(`/screenshot?${params.toString()}`);
      if (!(response instanceof Response)) return response;
      emitConsoleErrors(response.headers.get("X-Console-Errors"));
      const ct = response.headers.get("content-type") || "";
      if (ct.includes("image")) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (outFlag === "-") {
          stdoutBytes = bytes;
        } else {
          const out = outFlag || defaultOut;
          await Bun.write(out, bytes);
          if (jsonMode) say(JSON.stringify({ ok: true, data: { path: out, bytes: bytes.length, format }, exitCode: 0 }));
          else say(out);
        }
      } else {
        const data = (await response.json()) as any;
        if (!data.ok) return emitError(data.error, response.status);
        if (encoding === "base64") {
          if (!outFlag || outFlag === "-") {
            if (jsonMode) say(JSON.stringify({ ok: true, data: stripOk(data), exitCode: 0 }));
            else say(data.data);
          } else {
            await Bun.write(outFlag, data.data);
            if (jsonMode) say(JSON.stringify({ ok: true, data: { path: outFlag, format: data.format }, exitCode: 0 }));
            else say(outFlag);
          }
        } else if (encoding === "shmem") {
          const payload = { name: data.name, size: data.size, format: data.format };
          if (jsonMode) say(JSON.stringify({ ok: true, data: payload, exitCode: 0 }));
          else say(JSON.stringify(payload));
        }
      }
      return { stdout, stdoutBytes, stderr, exitCode: 0 };
    }

    case "eval":
    case "evaluate": {
      const expr = positional.join(" ");
      if (!expr) return usage("Usage: bunwv evaluate <expr>");
      const r = await invoke("/evaluate", { expr });
      if (isRunResult(r)) return r;
      // Always JSON-literal so the agent can distinguish types.
      if (jsonMode) say(JSON.stringify({ ok: true, data: r.data.result, exitCode: 0 }));
      else say(JSON.stringify(r.data.result));
      return { stdout, stdoutBytes, stderr, exitCode: 0 };
    }

    case "exists": {
      const selector = positional[0];
      if (!selector) return usage("Usage: bunwv exists <selector>");
      const r = await invoke("/exists", { selector });
      if (isRunResult(r)) return r;
      if (!r.data.exists) {
        const code = EXIT.notFound;
        const line = JSON.stringify({ ok: false, error: `not found: ${selector}`, exitCode: code });
        if (jsonMode) say(line);
        else cry(line);
        return { stdout, stdoutBytes, stderr, exitCode: code };
      }
      if (jsonMode) say(JSON.stringify({ ok: true, data: { count: r.data.count }, exitCode: 0 }));
      return { stdout, stdoutBytes, stderr, exitCode: 0 };
    }

    case "submit": {
      const form = getFlag("form");
      const button = getFlag("button");
      const r = await invoke("/submit", { form, button });
      if (isRunResult(r)) return r;
      return silentOk();
    }

    case "wait-for": {
      const selector = positional[0];
      const urlPattern = getFlag("url");
      const titlePattern = getFlag("title");
      const targets = [selector, urlPattern, titlePattern].filter(v => v !== undefined).length;
      if (targets === 0) return usage("Usage: bunwv wait-for <selector> | --url <substr> | --title <substr>");
      if (targets > 1) return usage("bunwv wait-for: specify exactly one of <selector>, --url, --title");
      const timeout = getFlag("timeout") ? parseInt(getFlag("timeout")!) : undefined;
      const body: any = { timeout };
      if (selector) body.selector = selector;
      else if (urlPattern) body.url = urlPattern;
      else if (titlePattern) body.title = titlePattern;
      const r = await invoke("/wait-for", body);
      if (isRunResult(r)) return r;
      return silentOk();
    }

    case "wait-for-gone": {
      const selector = positional[0];
      const urlPattern = getFlag("url");
      const titlePattern = getFlag("title");
      const targets = [selector, urlPattern, titlePattern].filter(v => v !== undefined).length;
      if (targets === 0) return usage("Usage: bunwv wait-for-gone <selector> | --url <substr> | --title <substr>");
      if (targets > 1) return usage("bunwv wait-for-gone: specify exactly one of <selector>, --url, --title");
      const timeout = getFlag("timeout") ? parseInt(getFlag("timeout")!) : undefined;
      const body: any = { timeout };
      if (selector) body.selector = selector;
      else if (urlPattern) body.url = urlPattern;
      else if (titlePattern) body.title = titlePattern;
      const r = await invoke("/wait-for-gone", body);
      if (isRunResult(r)) return r;
      return silentOk();
    }

    case "status": {
      const response = await send("/status");
      if (!(response instanceof Response)) return response;
      emitConsoleErrors(response.headers.get("X-Console-Errors"));
      const data = (await response.json()) as {
        ok: boolean; session: string; pid: number; url: string; title: string; loading: boolean;
        pendingEvents: number; cursor: number; cdpSubscriptions: string[];
      };
      if (jsonMode) say(JSON.stringify({ ok: true, data: stripOk(data), exitCode: 0 }));
      else {
        const state = data.loading ? "loading" : "idle";
        const url = data.url || "(none)";
        const title = data.title || "(no title)";
        say(`${url} | ${title} | ${state} | pending=${data.pendingEvents}`);
      }
      return { stdout, stdoutBytes, stderr, exitCode: 0 };
    }

    case "events": {
      const since = getFlag("since") || "0";
      const response = await send(`/events?since=${encodeURIComponent(since)}`);
      if (!(response instanceof Response)) return response;
      emitConsoleErrors(response.headers.get("X-Console-Errors"));
      const data = (await response.json()) as any;
      if (!data.ok) return emitError(data.error, response.status);
      const payload: any = { events: data.events, cursor: data.cursor };
      if (data.truncated) { payload.truncated = true; payload.oldest = data.oldest; }
      if (jsonMode) say(JSON.stringify({ ok: true, data: payload, exitCode: 0 }));
      else say(JSON.stringify(payload));
      return { stdout, stdoutBytes, stderr, exitCode: 0 };
    }

    case "resize": {
      const w = parseInt(positional[0] ?? "");
      const h = parseInt(positional[1] ?? "");
      if (isNaN(w) || isNaN(h)) return usage("Usage: bunwv resize <width> <height>");
      const r = await invoke("/resize", { width: w, height: h });
      if (isRunResult(r)) return r;
      return silentOk();
    }

    case "back":    { const r = await invoke("/back", {});    if (isRunResult(r)) return r; return silentOk(); }
    case "forward": { const r = await invoke("/forward", {}); if (isRunResult(r)) return r; return silentOk(); }
    case "reload":  { const r = await invoke("/reload", {});  if (isRunResult(r)) return r; return silentOk(); }

    case "close": {
      const { existsSync, unlinkSync } = await import("node:fs");
      try { await rawSend("/close", { method: "POST" }); } catch {}
      const deadline = Date.now() + 500;
      while (Date.now() < deadline && existsSync(SOCKET_PATH)) await Bun.sleep(20);
      try { if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH); } catch {}
      try { if (existsSync(PID_PATH)) unlinkSync(PID_PATH); } catch {}
      if (jsonMode) say(JSON.stringify({ ok: true, data: { session: sessionName, closed: true }, exitCode: 0 }));
      return { stdout, stdoutBytes, stderr, exitCode: 0 };
    }

    case "console": {
      const clear = hasFlag("clear");
      const since = getFlag("since") || "0";
      const params: string[] = [];
      if (clear) params.push("clear=true");
      params.push(`since=${encodeURIComponent(since)}`);
      const path = "/console?" + params.join("&");
      const response = await send(path);
      if (!(response instanceof Response)) return response;
      emitConsoleErrors(response.headers.get("X-Console-Errors"));
      const data = (await response.json()) as { ok: boolean; messages: any[]; cursor: number; truncated?: boolean; oldest?: number; error?: string };
      if (!data.ok) return emitError(data.error!, response.status);
      if (jsonMode) {
        const payload: any = { messages: data.messages, cursor: data.cursor };
        if (data.truncated) { payload.truncated = true; payload.oldest = data.oldest; }
        say(JSON.stringify({ ok: true, data: payload, exitCode: 0 }));
      } else {
        // Terse: "<seq> [<level>] <message>", one entry per line, empty buffer = no output.
        // Escape CR/LF in message so line-splitting stays unambiguous; use --json for raw text.
        for (const m of data.messages) {
          const msg = String(m.message).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
          say(`${m.seq} [${m.level}] ${msg}`);
        }
      }
      return { stdout, stdoutBytes, stderr, exitCode: 0 };
    }

    case "cdp": {
      const method = positional[0];
      if (!method) return usage("Usage: bunwv cdp <method> [--params '{}']");
      const paramsStr = getFlag("params");
      let params: Record<string, unknown> = {};
      if (paramsStr) {
        try { params = JSON.parse(paramsStr); }
        catch { return usage("Invalid JSON in --params"); }
      }
      const r = await invoke("/cdp", { method, params });
      if (isRunResult(r)) return r;
      if (jsonMode) say(JSON.stringify({ ok: true, data: r.data.result, exitCode: 0 }));
      else say(JSON.stringify(r.data.result));
      return { stdout, stdoutBytes, stderr, exitCode: 0 };
    }

    case "cdp-subscribe": {
      if (positional.length === 0) return usage("Usage: bunwv cdp-subscribe <CDP.event> [<CDP.event> ...]");
      const r = await invoke("/cdp-subscribe", { types: positional });
      if (isRunResult(r)) return r;
      return silentOk();
    }

    case "cdp-unsubscribe": {
      if (positional.length === 0) return usage("Usage: bunwv cdp-unsubscribe <CDP.event> [<CDP.event> ...]");
      const r = await invoke("/cdp-unsubscribe", { types: positional });
      if (isRunResult(r)) return r;
      return silentOk();
    }

    case "cdp-subscriptions": {
      const response = await send("/cdp-subscriptions");
      if (!(response instanceof Response)) return response;
      emitConsoleErrors(response.headers.get("X-Console-Errors"));
      const data = (await response.json()) as any;
      if (!data.ok) return emitError(data.error, response.status);
      if (jsonMode) say(JSON.stringify({ ok: true, data: data.types, exitCode: 0 }));
      else for (const t of data.types) say(t);
      return { stdout, stdoutBytes, stderr, exitCode: 0 };
    }

    default:
      return usage(`Unknown command: ${command}`);
  }
}

async function runBatch(outerArgs: string[]): Promise<number> {
  const { flags } = parseArgs(outerArgs);
  const keepGoing = flags["keep-going"] !== undefined;
  const filePath = Array.isArray(flags["file"]) ? flags["file"][0] : (flags["file"] as string | undefined);

  // Forward selected outer flags (session, data-store, etc.) into each batched argv,
  // unless the line already specifies that flag. Never forward batch-specific or
  // output-shape flags (json is handled by batch's own envelope).
  const BATCH_LOCAL = new Set(["file", "keep-going", "json"]);
  const inherited: [string, string][] = [];
  for (const [k, v] of Object.entries(flags)) {
    if (BATCH_LOCAL.has(k)) continue;
    const vals = Array.isArray(v) ? v : [v as string];
    for (const val of vals) inherited.push([k, val]);
  }

  const input = filePath
    ? await Bun.file(filePath).text()
    : await new Response(Bun.stdin.stream()).text();
  const lines = input.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  let failed = false;
  for (const line of lines) {
    let argv: string[];
    try {
      const parsed = JSON.parse(line);
      if (!Array.isArray(parsed) || !parsed.every(x => typeof x === "string")) {
        throw new Error("must be a JSON array of strings");
      }
      argv = parsed;
      // Prepend inherited flags that the line didn't already specify.
      for (const [k, val] of inherited) {
        const already = argv.some(a => a === `--${k}` || a.startsWith(`--${k}=`));
        if (!already) argv.unshift(`--${k}`, val);
      }
    } catch (e: any) {
      process.stdout.write(JSON.stringify({ ok: false, error: `batch line invalid: ${e.message}`, line, exitCode: EXIT.usage }) + "\n");
      failed = true;
      if (!keepGoing) return EXIT.usage;
      continue;
    }
    const res = await runCommand(argv);
    const envelope: any = { argv, ok: res.exitCode === 0, exitCode: res.exitCode };
    if (res.stdoutBytes) envelope.stdoutBytes = Buffer.from(res.stdoutBytes).toString("base64");
    else if (res.stdout.trim()) envelope.stdout = res.stdout.trimEnd();
    if (res.stderr.trim()) envelope.stderr = res.stderr.trimEnd();
    process.stdout.write(JSON.stringify(envelope) + "\n");
    if (res.exitCode !== 0) {
      failed = true;
      if (!keepGoing) return res.exitCode;
    }
  }
  return failed ? EXIT.batchPartial : 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const rawArgs = Bun.argv.slice(2);
const firstPositional = rawArgs.find(a => !a.startsWith("--") && !BOOLEAN_FLAGS.has(a.replace(/^--/, "")));

if (firstPositional === "batch") {
  const code = await runBatch(rawArgs);
  process.exit(code);
}

const result = await runCommand(rawArgs);
if (result.stdoutBytes) process.stdout.write(result.stdoutBytes);
else if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.exitCode);
