import { unlinkSync, chmodSync } from "node:fs";
import type { WebView as WebViewNS } from "bun";

function getArg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1]! : fallback;
}

const sessionName = getArg("session", "default");
const SOCKET_PATH = `/tmp/bunwv-${sessionName}.sock`;
const PID_PATH = `/tmp/bunwv-${sessionName}.pid`;
const width = parseInt(getArg("width", "1920"));
const height = parseInt(getArg("height", "1080"));
const dataStorePath = getArg("data-store", "");
const idleTimeoutMs = parseInt(getArg("idle-timeout", "1800000"));
const defaultBackend = process.platform === "darwin" ? "" : "chrome";
const backend = getArg("backend", defaultBackend);
const chromePath = getArg("chrome-path", "");
const chromeArgv = getArg("chrome-argv", "");
const chromeStdout = getArg("chrome-stdout", "");
const chromeStderr = getArg("chrome-stderr", "");
const chromeUrl = getArg("chrome-url", "");
const webkitStdout = getArg("webkit-stdout", "");
const webkitStderr = getArg("webkit-stderr", "");
const initialUrl = getArg("url", "");

try { unlinkSync(SOCKET_PATH); } catch {}

let backendOpt: WebViewNS.Backend | undefined;
if (chromeUrl) {
  if (chromePath || chromeArgv || chromeStdout || chromeStderr) {
    console.error("--chrome-url is mutually exclusive with --chrome-path/--chrome-argv/--chrome-stdout/--chrome-stderr");
    process.exit(2);
  }
  backendOpt = { type: "chrome", url: chromeUrl };
} else if (backend === "chrome" || chromePath || chromeArgv || chromeStdout || chromeStderr) {
  const b: WebViewNS.Backend = { type: "chrome" };
  if (chromePath) (b as any).path = chromePath;
  if (chromeArgv) {
    try { (b as any).argv = JSON.parse(chromeArgv); }
    catch { console.error("--chrome-argv must be a JSON array"); process.exit(2); }
  }
  if (chromeStdout === "inherit" || chromeStdout === "ignore") (b as any).stdout = chromeStdout;
  if (chromeStderr === "inherit" || chromeStderr === "ignore") (b as any).stderr = chromeStderr;
  backendOpt = b;
} else if (webkitStdout || webkitStderr) {
  const b: WebViewNS.Backend = { type: "webkit" };
  if (webkitStdout === "inherit" || webkitStdout === "ignore") (b as any).stdout = webkitStdout;
  if (webkitStderr === "inherit" || webkitStderr === "ignore") (b as any).stderr = webkitStderr;
  backendOpt = b;
} else if (backend) {
  backendOpt = backend as WebViewNS.Backend;
}

const viewOpts: WebViewNS.ConstructorOptions = { width, height };
if (dataStorePath) viewOpts.dataStore = { directory: dataStorePath };
if (backendOpt) viewOpts.backend = backendOpt;
if (initialUrl) viewOpts.url = initialUrl;

const effectiveBackend: "webkit" | "chrome" =
  typeof backendOpt === "string" ? (backendOpt as "webkit" | "chrome") :
  typeof backendOpt === "object" && backendOpt ? (backendOpt as { type: "webkit" | "chrome" }).type :
  (process.platform === "darwin" ? "webkit" : "chrome");

// Console ring buffer
interface ConsoleMessage { seq: number; level: string; message: string; timestamp: number }
const consoleBuffer: ConsoleMessage[] = [];
let consoleSeq = 0;
const MAX_CONSOLE = 1000;
viewOpts.console = (level: string, ...args: unknown[]) => {
  const message = args.map(a => typeof a === "string" ? a : Bun.inspect(a)).join(" ");
  consoleBuffer.push({ seq: ++consoleSeq, level, message, timestamp: Date.now() });
  if (consoleBuffer.length > MAX_CONSOLE) consoleBuffer.shift();
};

const view = new Bun.WebView(viewOpts);

// Events ring buffer (cap: 1000 entries or 10MB, LRU-evict oldest)
interface EventEntry {
  seq: number;
  type: "navigated" | "navigationFailed" | "cdp";
  ts: number;
  url?: string;
  title?: string;
  error?: string;
  method?: string;
  params?: unknown;
}
const eventsBuffer: Array<{ entry: EventEntry; size: number }> = [];
let eventSeq = 0;
let eventsBytes = 0;
const MAX_EVENTS = 1000;
const MAX_EVENTS_BYTES = 10 * 1024 * 1024;

function pushEvent(e: Omit<EventEntry, "seq" | "ts">) {
  const entry: EventEntry = { ...e, seq: ++eventSeq, ts: Date.now() };
  const size = JSON.stringify(entry).length;
  eventsBuffer.push({ entry, size });
  eventsBytes += size;
  while (eventsBuffer.length > 0 && (eventsBuffer.length > MAX_EVENTS || eventsBytes > MAX_EVENTS_BYTES)) {
    const removed = eventsBuffer.shift()!;
    eventsBytes -= removed.size;
  }
}

view.onNavigated = (url, title) => { pushEvent({ type: "navigated", url, title }); };
view.onNavigationFailed = (err) => { pushEvent({ type: "navigationFailed", error: err.message }); };

const cdpSubscriptions = new Map<string, (e: MessageEvent) => void>();

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

function ok(data: Record<string, any> = {}) { return Response.json({ ok: true, ...data }); }
function fail(error: string, status = 500) { return Response.json({ ok: false, error }, { status }); }

let idleTimer: ReturnType<typeof setTimeout> | null = null;
function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  if (idleTimeoutMs > 0) {
    idleTimer = setTimeout(() => {
      console.log(`Idle timeout (${idleTimeoutMs / 1000}s) — shutting down.`);
      cleanup();
      process.exit(0);
    }, idleTimeoutMs);
  }
}
resetIdleTimer();

// Wrap each route: reset idle, then collect console.error/warn entries that fired during the
// handler and surface them to the CLI via X-Console-Errors header (the CLI forwards to stderr).
async function withActivity(handler: () => Promise<Response> | Response): Promise<Response> {
  resetIdleTimer();
  const startSeq = consoleSeq;
  const response = await handler();
  const errors = consoleBuffer.filter(m => m.seq > startSeq && (m.level === "error" || m.level === "warn"));
  if (errors.length === 0) return response;
  const headers = new Headers(response.headers);
  headers.set("X-Console-Errors", JSON.stringify(errors));
  return new Response(response.body, { status: response.status, headers });
}

const server = Bun.serve({
  unix: SOCKET_PATH,
  routes: {
    "/navigate": {
      POST: (req) => withActivity(async () => {
        try {
          const { url } = (await req.json()) as { url: string };
          if (!url) return fail("url is required", 400);
          await withTimeout(view.navigate(url), 30000, "navigate");
          return ok({ url: view.url, title: view.title });
        } catch (e: any) { return fail(e.message); }
      }),
    },
    "/click": {
      POST: (req) => withActivity(async () => {
        try {
          const body = (await req.json()) as {
            selector?: string;
            text?: string;
            textMatch?: "exact" | "contains" | "regex";
            x?: number;
            y?: number;
            button?: "left" | "right" | "middle";
            clickCount?: 1 | 2 | 3;
            modifiers?: WebViewNS.Modifier[];
            timeout?: number;
          };
          if (body.selector) {
            const opts: WebViewNS.ClickSelectorOptions = {};
            if (body.button) opts.button = body.button;
            if (body.clickCount) opts.clickCount = body.clickCount;
            if (body.modifiers) opts.modifiers = body.modifiers;
            if (body.timeout !== undefined) opts.timeout = body.timeout;
            await view.click(body.selector, opts);
          } else if (body.text) {
            // Resolve --text by marking the matching element and clicking via selector
            // (so the actionability wait + isTrusted path is preserved).
            const mode = (body.textMatch ?? "contains");
            if (mode !== "exact" && mode !== "contains" && mode !== "regex") {
              return fail("textMatch must be exact, contains, or regex", 400);
            }
            const txt = JSON.stringify(body.text);
            const modeLit = JSON.stringify(mode);
            const script = `(function(){
              var t = ${txt}, mode = ${modeLit};
              var re = mode === "regex" ? new RegExp(t) : null;
              function matches(s) {
                if (!s) return false;
                if (mode === "exact") return s === t;
                if (mode === "regex") return re.test(s);
                return s.indexOf(t) !== -1;
              }
              var candidates = Array.from(document.querySelectorAll("button, a, [role=button], input[type=submit]"));
              var el = candidates.find(function(e){ return matches(e.textContent && e.textContent.trim()); });
              if (!el) {
                var all = Array.from(document.querySelectorAll("*"));
                el = all.find(function(e){ return e.children.length === 0 && matches(e.textContent && e.textContent.trim()); });
              }
              if (!el) return null;
              var attr = "data-bunwv-click-" + Math.random().toString(36).slice(2, 10);
              el.setAttribute(attr, "1");
              return "[" + attr + "]";
            })()`;
            const resolved = await view.evaluate<string | null>(script);
            if (!resolved) return fail(`no element with text: ${body.text}`, 404);
            const opts: WebViewNS.ClickSelectorOptions = {};
            if (body.button) opts.button = body.button;
            if (body.clickCount) opts.clickCount = body.clickCount;
            if (body.modifiers) opts.modifiers = body.modifiers;
            if (body.timeout !== undefined) opts.timeout = body.timeout;
            await view.click(resolved, opts);
          } else if (typeof body.x === "number" && typeof body.y === "number") {
            const opts: WebViewNS.ClickOptions = {};
            if (body.button) opts.button = body.button;
            if (body.clickCount) opts.clickCount = body.clickCount;
            if (body.modifiers) opts.modifiers = body.modifiers;
            await view.click(body.x, body.y, opts);
          } else {
            return fail("selector, text, or x+y required", 400);
          }
          return ok();
        } catch (e: any) { return fail(e.message); }
      }),
    },
    "/type": {
      POST: (req) => withActivity(async () => {
        try {
          const { text } = (await req.json()) as { text: string };
          if (text === undefined) return fail("text is required", 400);
          await withTimeout(view.type(text), 10000, "type");
          return ok();
        } catch (e: any) { return fail(e.message); }
      }),
    },
    "/press": {
      POST: (req) => withActivity(async () => {
        try {
          const { key, modifiers } = (await req.json()) as { key: string; modifiers?: WebViewNS.Modifier[] };
          if (!key) return fail("key is required", 400);
          await withTimeout(view.press(key, modifiers ? { modifiers } : undefined), 10000, "press");
          return ok();
        } catch (e: any) { return fail(e.message); }
      }),
    },
    "/scroll": {
      POST: (req) => withActivity(async () => {
        try {
          const body = (await req.json()) as {
            selector?: string;
            dx?: number;
            dy?: number;
            block?: WebViewNS.ScrollToOptions["block"];
            timeout?: number;
          };
          if (body.selector) {
            const opts: WebViewNS.ScrollToOptions = {};
            if (body.block) opts.block = body.block;
            if (body.timeout !== undefined) opts.timeout = body.timeout;
            await view.scrollTo(body.selector, opts);
          } else if (typeof body.dx === "number" && typeof body.dy === "number") {
            await view.scroll(body.dx, body.dy);
          } else {
            return fail("selector or dx,dy required", 400);
          }
          return ok();
        } catch (e: any) { return fail(e.message); }
      }),
    },
    "/evaluate": {
      POST: (req) => withActivity(async () => {
        try {
          const { expr } = (await req.json()) as { expr: string };
          if (!expr) return fail("expr is required", 400);
          const needsWrap = /^\s*(const |let |var |if |for |while |switch |try |class |function )/.test(expr);
          const wrapped = needsWrap ? `(function(){${expr}})()` : expr;
          const result = await withTimeout(view.evaluate(wrapped), 10000, "evaluate");
          return ok({ result });
        } catch (e: any) { return fail(e.message); }
      }),
    },
    "/clear": {
      POST: (req) => withActivity(async () => {
        try {
          const { selector } = (await req.json()) as { selector: string };
          if (!selector) return fail("selector is required", 400);
          const sel = JSON.stringify(selector);
          const script = `(function(){
            var el = document.querySelector(${sel});
            if (!el) return 'element not found';
            var setter = Object.getOwnPropertyDescriptor(
              el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
              'value'
            ).set;
            setter.call(el, '');
            el.dispatchEvent(new Event('input', {bubbles: true}));
            el.dispatchEvent(new Event('change', {bubbles: true}));
            return 'cleared';
          })()`;
          const result = await withTimeout(view.evaluate(script), 10000, "clear");
          if (result === "element not found") return fail("element not found: " + selector, 404);
          return ok();
        } catch (e: any) { return fail(e.message); }
      }),
    },
    "/wait-for": {
      POST: (req) => withActivity(async () => {
        try {
          const body = (await req.json()) as { selector?: string; url?: string; title?: string; timeout?: number };
          const { selector, url: urlPat, title: titlePat, timeout } = body;
          const targets = [selector, urlPat, titlePat].filter(v => v !== undefined).length;
          if (targets === 0) return fail("selector, url, or title required", 400);
          if (targets > 1) return fail("specify exactly one of selector, url, title", 400);
          const ms = timeout || 10000;
          const start = Date.now();
          const sel = selector ? JSON.stringify(selector) : null;
          while (Date.now() - start < ms) {
            if (sel) {
              const found = await view.evaluate(`!!document.querySelector(${sel})`);
              if (found) return ok();
            } else if (urlPat) {
              const currentUrl = (await view.evaluate<string>("location.href")) || view.url;
              if (currentUrl.includes(urlPat)) return ok();
            } else if (titlePat) {
              const currentTitle = (await view.evaluate<string>("document.title")) || view.title;
              if (currentTitle.includes(titlePat)) return ok();
            }
            await Bun.sleep(200);
          }
          const what = selector ? selector : urlPat ? `url:${urlPat}` : `title:${titlePat}`;
          return fail(`waitFor timed out after ${ms}ms: ${what}`);
        } catch (e: any) { return fail(e.message); }
      }),
    },
    "/exists": {
      POST: (req) => withActivity(async () => {
        try {
          const { selector } = (await req.json()) as { selector: string };
          if (!selector) return fail("selector is required", 400);
          const sel = JSON.stringify(selector);
          const count = (await view.evaluate(`document.querySelectorAll(${sel}).length`)) as number;
          return ok({ exists: count > 0, count });
        } catch (e: any) { return fail(e.message); }
      }),
    },
    "/wait-for-gone": {
      POST: (req) => withActivity(async () => {
        try {
          const body = (await req.json()) as { selector?: string; url?: string; title?: string; timeout?: number };
          const { selector, url: urlPat, title: titlePat, timeout } = body;
          const targets = [selector, urlPat, titlePat].filter(v => v !== undefined).length;
          if (targets === 0) return fail("selector, url, or title required", 400);
          if (targets > 1) return fail("specify exactly one of selector, url, title", 400);
          const ms = timeout || 10000;
          const start = Date.now();
          const sel = selector ? JSON.stringify(selector) : null;
          while (Date.now() - start < ms) {
            if (sel) {
              const found = await view.evaluate(`!!document.querySelector(${sel})`);
              if (!found) return ok();
            } else if (urlPat) {
              const currentUrl = (await view.evaluate<string>("location.href")) || view.url;
              if (!currentUrl.includes(urlPat)) return ok();
            } else if (titlePat) {
              const currentTitle = (await view.evaluate<string>("document.title")) || view.title;
              if (!currentTitle.includes(titlePat)) return ok();
            }
            await Bun.sleep(200);
          }
          const what = selector ? selector : urlPat ? `url:${urlPat}` : `title:${titlePat}`;
          return fail(`waitForGone timed out after ${ms}ms: ${what}`);
        } catch (e: any) { return fail(e.message); }
      }),
    },
    "/submit": {
      POST: (req) => withActivity(async () => {
        try {
          const { form, button } = (await req.json()) as { form?: string; button?: string };
          const fSel = JSON.stringify(form || "form");
          const bTxt = JSON.stringify(button || "");
          const script = `(function(){
            var form = document.querySelector(${fSel});
            if (!form) return 'form not found';
            var btn = null;
            var btxt = ${bTxt};
            if (btxt) {
              var buttons = form.querySelectorAll('button[type="submit"], button:not([type])');
              for (var i = 0; i < buttons.length; i++) {
                if (buttons[i].textContent.trim() === btxt) { btn = buttons[i]; break; }
              }
              if (!btn) return 'button not found: ' + btxt;
            }
            form.requestSubmit(btn || undefined);
            return 'submitted';
          })()`;
          const result = await withTimeout(view.evaluate(script), 10000, "submit");
          if (result !== "submitted") return fail(result as string, 404);
          return ok();
        } catch (e: any) { return fail(e.message); }
      }),
    },
    "/screenshot": {
      GET: (req) => withActivity(async () => {
        try {
          const url = new URL(req.url, "http://localhost");
          const format = (url.searchParams.get("format") || "png") as "png" | "jpeg" | "webp";
          const qualityStr = url.searchParams.get("quality");
          const encoding = (url.searchParams.get("encoding") || "blob") as "blob" | "buffer" | "base64" | "shmem";
          if (!["png", "jpeg", "webp"].includes(format)) return fail("format must be png, jpeg, or webp", 400);
          if (!["blob", "buffer", "base64", "shmem"].includes(encoding)) return fail("encoding must be blob, buffer, base64, or shmem", 400);
          const baseOpts: any = { format };
          if (qualityStr) baseOpts.quality = parseInt(qualityStr);
          if (encoding === "base64") {
            const data = await view.screenshot({ ...baseOpts, encoding: "base64" });
            return Response.json({ ok: true, data, format });
          }
          if (encoding === "shmem") {
            const shm = await view.screenshot({ encoding: "shmem", format, ...(qualityStr ? { quality: parseInt(qualityStr) } : {}) });
            return Response.json({ ok: true, name: shm.name, size: shm.size, format });
          }
          const img = await view.screenshot(baseOpts);
          const contentType = format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
          return new Response(img, { headers: { "Content-Type": contentType } });
        } catch (e: any) { return fail(e.message); }
      }),
    },
    "/console": {
      GET: (req) => withActivity(() => {
        const url = new URL(req.url, "http://localhost");
        const clear = url.searchParams.get("clear") === "true";
        const sinceStr = url.searchParams.get("since");
        const since = sinceStr ? parseInt(sinceStr) : 0;
        const msgs = consoleBuffer.filter(m => m.seq > since);
        const cursor = consoleBuffer.length ? consoleBuffer[consoleBuffer.length - 1]!.seq : since;
        const oldest = consoleBuffer.length ? consoleBuffer[0]!.seq : null;
        const body: any = { ok: true, messages: msgs, cursor };
        if (since > 0 && oldest !== null && since + 1 < oldest) {
          body.truncated = true;
          body.oldest = oldest;
        }
        if (clear) consoleBuffer.length = 0;
        return Response.json(body);
      }),
    },
    "/cdp": {
      POST: (req) => withActivity(async () => {
        try {
          if (effectiveBackend !== "chrome") return fail("cdp requires --backend chrome (current: " + effectiveBackend + ")", 400);
          const { method, params } = (await req.json()) as { method: string; params?: Record<string, unknown> };
          if (!method) return fail("method is required", 400);
          const result = await withTimeout(view.cdp(method, params || {}), 30000, "cdp");
          return ok({ result });
        } catch (e: any) { return fail(e.message); }
      }),
    },
    "/cdp-subscribe": {
      POST: (req) => withActivity(async () => {
        try {
          if (effectiveBackend !== "chrome") return fail("cdp-subscribe requires --backend chrome (current: " + effectiveBackend + ")", 400);
          const body = (await req.json()) as { type?: string; types?: string[] };
          const types = body.types ?? (body.type ? [body.type] : []);
          if (types.length === 0) return fail("type or types is required", 400);
          for (const t of types) {
            if (!t.includes(".")) return fail(`type must be a CDP event name like Network.responseReceived: ${t}`, 400);
          }
          const results: { subscribed: string; already: boolean }[] = [];
          for (const t of types) {
            if (cdpSubscriptions.has(t)) {
              results.push({ subscribed: t, already: true });
              continue;
            }
            const listener = (e: MessageEvent) => {
              pushEvent({ type: "cdp", method: t, params: e.data });
            };
            view.addEventListener(t as `${string}.${string}`, listener);
            cdpSubscriptions.set(t, listener);
            results.push({ subscribed: t, already: false });
          }
          return ok({ results });
        } catch (e: any) { return fail(e.message); }
      }),
    },
    "/cdp-unsubscribe": {
      POST: (req) => withActivity(async () => {
        try {
          if (effectiveBackend !== "chrome") return fail("cdp-unsubscribe requires --backend chrome (current: " + effectiveBackend + ")", 400);
          const body = (await req.json()) as { type?: string; types?: string[] };
          const types = body.types ?? (body.type ? [body.type] : []);
          if (types.length === 0) return fail("type or types is required", 400);
          const results: { unsubscribed: string; wasSubscribed: boolean }[] = [];
          for (const t of types) {
            const listener = cdpSubscriptions.get(t);
            if (!listener) { results.push({ unsubscribed: t, wasSubscribed: false }); continue; }
            view.removeEventListener(t, listener as EventListener);
            cdpSubscriptions.delete(t);
            results.push({ unsubscribed: t, wasSubscribed: true });
          }
          return ok({ results });
        } catch (e: any) { return fail(e.message); }
      }),
    },
    "/cdp-subscriptions": {
      GET: () => withActivity(() => {
        if (effectiveBackend !== "chrome") {
          return Response.json({ ok: false, error: "cdp-subscriptions requires --backend chrome (current: " + effectiveBackend + ")" }, { status: 400 });
        }
        return Response.json({ ok: true, types: Array.from(cdpSubscriptions.keys()) });
      }),
    },
    "/events": {
      GET: (req) => withActivity(() => {
        const u = new URL(req.url, "http://localhost");
        const sinceStr = u.searchParams.get("since");
        const since = sinceStr ? parseInt(sinceStr) : 0;
        const entries = eventsBuffer.filter(e => e.entry.seq > since).map(e => e.entry);
        const cursor = eventsBuffer.length ? eventsBuffer[eventsBuffer.length - 1]!.entry.seq : since;
        const oldest = eventsBuffer.length ? eventsBuffer[0]!.entry.seq : null;
        const body: any = { ok: true, events: entries, cursor };
        if (since > 0 && oldest !== null && since + 1 < oldest) {
          body.truncated = true;
          body.oldest = oldest;
        }
        return Response.json(body);
      }),
    },
    "/status": {
      GET: () => withActivity(() => {
        const cursor = eventsBuffer.length ? eventsBuffer[eventsBuffer.length - 1]!.entry.seq : 0;
        return Response.json({
          ok: true,
          session: sessionName,
          url: view.url,
          title: view.title,
          loading: view.loading,
          pid: process.pid,
          pendingEvents: eventsBuffer.length,
          cursor,
          cdpSubscriptions: Array.from(cdpSubscriptions.keys()),
        });
      }),
    },
    "/resize": {
      POST: (req) => withActivity(async () => {
        try {
          const { width, height } = (await req.json()) as { width: number; height: number };
          if (!width || !height) return fail("width and height required", 400);
          await view.resize(width, height);
          return ok();
        } catch (e: any) { return fail(e.message); }
      }),
    },
    // NOTE: `@types/bun@1.3.12` renames `goBack`/`goForward` to `back`/`forward`,
    // but the actual runtime binding in Bun 1.3.12 still exposes `goBack`/`goForward`.
    // Call both and fall back on either, so whichever name ships wins.
    "/back": {
      POST: () => withActivity(async () => {
        try {
          const fn = (view as any).goBack ?? (view as any).back;
          if (typeof fn !== "function") {
            return fail(`back() not supported by this Bun/WebView build on the ${effectiveBackend} backend`, 501);
          }
          await fn.call(view);
          return ok();
        } catch (e: any) { return fail(e.message); }
      }),
    },
    "/forward": {
      POST: () => withActivity(async () => {
        try {
          const fn = (view as any).goForward ?? (view as any).forward;
          if (typeof fn !== "function") {
            return fail(`forward() not supported by this Bun/WebView build on the ${effectiveBackend} backend`, 501);
          }
          await fn.call(view);
          return ok();
        } catch (e: any) { return fail(e.message); }
      }),
    },
    "/reload": {
      POST: () => withActivity(async () => {
        try { await view.reload(); return ok(); }
        catch (e: any) { return fail(e.message); }
      }),
    },
    "/close": {
      POST: () => {
        // Remove socket + PID files synchronously so `sessions` / `close --all`
        // don't see the daemon as still running after they get the OK response.
        // The WebView and process teardown still runs on a short timer to let
        // the HTTP response flush before exit.
        try { unlinkSync(SOCKET_PATH); } catch {}
        try { unlinkSync(PID_PATH); } catch {}
        setTimeout(() => {
          if (idleTimer) clearTimeout(idleTimer);
          try { view.close(); } catch {}
          process.exit(0);
        }, 50);
        return ok();
      },
    },
  },
});

// Restrict socket + PID file to owner only (avoids other local users connecting to this session).
try { chmodSync(SOCKET_PATH, 0o600); } catch {}
await Bun.write(PID_PATH, String(process.pid));
try { chmodSync(PID_PATH, 0o600); } catch {}

function cleanup() {
  if (idleTimer) clearTimeout(idleTimer);
  try { view.close(); } catch {}
  try { unlinkSync(SOCKET_PATH); } catch {}
  try { unlinkSync(PID_PATH); } catch {}
}

process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("SIGINT", () => { cleanup(); process.exit(0); });

console.log(`bunwv daemon started (session: ${sessionName}, PID: ${process.pid})`);
