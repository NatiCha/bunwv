import { unlinkSync } from "node:fs";

// Bun.WebView types not yet in @types/bun@1.3.11 — augment the module
declare module "bun" {
  class WebView {
    constructor(opts: Record<string, any>);
    navigate(url: string): Promise<void>;
    click(selector: string): Promise<void>;
    click(x: number, y: number): Promise<void>;
    type(text: string): Promise<void>;
    press(key: string, opts?: { modifiers: string[] }): Promise<void>;
    scroll(dx: number, dy: number): Promise<void>;
    scrollTo(selector: string): Promise<void>;
    evaluate(expr: string): Promise<any>;
    screenshot(): Promise<Uint8Array>;
    resize(width: number, height: number): void;
    goBack(): Promise<void>;
    goForward(): Promise<void>;
    reload(): Promise<void>;
    close(): void;
    get url(): string;
    get title(): string;
    get loading(): boolean;
  }
}

// Parse args
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
const idleTimeoutMs = parseInt(getArg("idle-timeout", "1800000")); // 30 min default

// Remove stale socket
try { unlinkSync(SOCKET_PATH); } catch {}

// Create WebView
const viewOpts: Record<string, any> = { width, height };
if (dataStorePath) {
  viewOpts.dataStore = { directory: dataStorePath };
}
const view = new Bun.WebView(viewOpts);

// Timeout helper
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

// JSON response helpers
function ok(data: Record<string, any> = {}) {
  return Response.json({ ok: true, ...data });
}

function fail(error: string, status = 500) {
  return Response.json({ ok: false, error }, { status });
}

// Idle timeout — auto-shutdown after inactivity
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

// Reset on every request
function withActivity<T>(handler: () => T): T {
  resetIdleTimer();
  return handler();
}

// Start idle timer
resetIdleTimer();

// Start server
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
        } catch (e: any) {
          return fail(e.message);
        }
      }),
    },
    "/click": {
      POST: (req) => withActivity(async () => {
        try {
          const body = (await req.json()) as { selector?: string; x?: number; y?: number };
          if (body.selector) {
            await withTimeout(view.click(body.selector), 10000, "click");
          } else if (typeof body.x === "number" && typeof body.y === "number") {
            await withTimeout(view.click(body.x, body.y), 10000, "click");
          } else {
            return fail("selector or x,y required", 400);
          }
          return ok();
        } catch (e: any) {
          return fail(e.message);
        }
      }),
    },
    "/type": {
      POST: (req) => withActivity(async () => {
        try {
          const { text } = (await req.json()) as { text: string };
          if (text === undefined) return fail("text is required", 400);
          await withTimeout(view.type(text), 10000, "type");
          return ok();
        } catch (e: any) {
          return fail(e.message);
        }
      }),
    },
    "/press": {
      POST: (req) => withActivity(async () => {
        try {
          const { key, modifiers } = (await req.json()) as { key: string; modifiers?: string[] };
          if (!key) return fail("key is required", 400);
          await withTimeout(
            view.press(key, modifiers ? { modifiers } : undefined),
            10000,
            "press"
          );
          return ok();
        } catch (e: any) {
          return fail(e.message);
        }
      }),
    },
    "/scroll": {
      POST: (req) => withActivity(async () => {
        try {
          const body = (await req.json()) as { selector?: string; dx?: number; dy?: number };
          if (body.selector) {
            await withTimeout(view.scrollTo(body.selector), 10000, "scrollTo");
          } else if (typeof body.dx === "number" && typeof body.dy === "number") {
            await view.scroll(body.dx, body.dy);
          } else {
            return fail("selector or dx,dy required", 400);
          }
          return ok();
        } catch (e: any) {
          return fail(e.message);
        }
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
        } catch (e: any) {
          return fail(e.message);
        }
      }),
    },
    "/clear": {
      POST: (req) => withActivity(async () => {
        try {
          const { selector } = (await req.json()) as { selector: string };
          if (!selector) return fail("selector is required", 400);
          const script = `(function(){
            var el = document.querySelector('${selector.replace(/'/g, "\\'")}');
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
        } catch (e: any) {
          return fail(e.message);
        }
      }),
    },
    "/click-text": {
      POST: (req) => withActivity(async () => {
        try {
          const { text, tag } = (await req.json()) as { text: string; tag?: string };
          if (!text) return fail("text is required", 400);
          const tagFilter = tag || "button, a, [role='button'], input[type='submit']";
          const script = `(function(){
            var els = document.querySelectorAll('${tagFilter.replace(/'/g, "\\'")}');
            for (var i = 0; i < els.length; i++) {
              if (els[i].textContent.trim() === '${text.replace(/'/g, "\\'")}') {
                els[i].click();
                return 'clicked';
              }
            }
            return 'not found';
          })()`;
          const result = await withTimeout(view.evaluate(script), 10000, "click-text");
          if (result === "not found") return fail("no element with text: " + text, 404);
          return ok();
        } catch (e: any) {
          return fail(e.message);
        }
      }),
    },
    "/wait-for": {
      POST: (req) => withActivity(async () => {
        try {
          const { selector, timeout } = (await req.json()) as { selector: string; timeout?: number };
          if (!selector) return fail("selector is required", 400);
          const ms = timeout || 10000;
          const interval = 200;
          const start = Date.now();
          while (Date.now() - start < ms) {
            const found = await view.evaluate(
              `!!document.querySelector('${selector.replace(/'/g, "\\'")}')`
            );
            if (found) return ok();
            await Bun.sleep(interval);
          }
          return fail(`waitFor timed out after ${ms}ms: ${selector}`);
        } catch (e: any) {
          return fail(e.message);
        }
      }),
    },
    "/wait-for-gone": {
      POST: (req) => withActivity(async () => {
        try {
          const { selector, timeout } = (await req.json()) as { selector: string; timeout?: number };
          if (!selector) return fail("selector is required", 400);
          const ms = timeout || 10000;
          const interval = 200;
          const start = Date.now();
          while (Date.now() - start < ms) {
            const found = await view.evaluate(
              `!!document.querySelector('${selector.replace(/'/g, "\\'")}')`
            );
            if (!found) return ok();
            await Bun.sleep(interval);
          }
          return fail(`waitForGone timed out after ${ms}ms: ${selector}`);
        } catch (e: any) {
          return fail(e.message);
        }
      }),
    },
    "/submit": {
      POST: (req) => withActivity(async () => {
        try {
          const { form: formSelector, button: buttonText } = (await req.json()) as { form?: string; button?: string };
          const script = `(function(){
            var form = document.querySelector('${(formSelector || "form").replace(/'/g, "\\'")}');
            if (!form) return 'form not found';
            var btn = null;
            if ('${(buttonText || "").replace(/'/g, "\\'")}') {
              var buttons = form.querySelectorAll('button[type="submit"], button:not([type])');
              for (var i = 0; i < buttons.length; i++) {
                if (buttons[i].textContent.trim() === '${(buttonText || "").replace(/'/g, "\\'")}') { btn = buttons[i]; break; }
              }
              if (!btn) return 'button not found: ${(buttonText || "").replace(/'/g, "\\'")}';
            }
            form.requestSubmit(btn || undefined);
            return 'submitted';
          })()`;
          const result = await withTimeout(view.evaluate(script), 10000, "submit");
          if (result !== "submitted") return fail(result as string, 404);
          return ok();
        } catch (e: any) {
          return fail(e.message);
        }
      }),
    },
    "/screenshot": {
      GET: () => withActivity(async () => {
        try {
          const png = await view.screenshot();
          return new Response(png, {
            headers: { "Content-Type": "image/png" },
          });
        } catch (e: any) {
          return fail(e.message);
        }
      }),
    },
    "/status": {
      GET: () => withActivity(() => {
        return Response.json({
          session: sessionName,
          url: view.url,
          title: view.title,
          loading: view.loading,
          pid: process.pid,
        });
      }),
    },
    "/resize": {
      POST: (req) => withActivity(async () => {
        try {
          const { width, height } = (await req.json()) as { width: number; height: number };
          if (!width || !height) return fail("width and height required", 400);
          view.resize(width, height);
          return ok();
        } catch (e: any) {
          return fail(e.message);
        }
      }),
    },
    "/back": {
      POST: () => withActivity(async () => {
        try {
          await view.goBack();
          return ok();
        } catch (e: any) {
          return fail(e.message);
        }
      }),
    },
    "/forward": {
      POST: () => withActivity(async () => {
        try {
          await view.goForward();
          return ok();
        } catch (e: any) {
          return fail(e.message);
        }
      }),
    },
    "/reload": {
      POST: () => withActivity(async () => {
        try {
          await view.reload();
          return ok();
        } catch (e: any) {
          return fail(e.message);
        }
      }),
    },
    "/stop": {
      POST: () => {
        setTimeout(() => {
          cleanup();
          process.exit(0);
        }, 100);
        return ok();
      },
    },
  },
});

// Write PID file
await Bun.write(PID_PATH, String(process.pid));

// Cleanup on exit
function cleanup() {
  if (idleTimer) clearTimeout(idleTimer);
  try { view.close(); } catch {}
  try { unlinkSync(SOCKET_PATH); } catch {}
  try { unlinkSync(PID_PATH); } catch {}
}

process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("SIGINT", () => { cleanup(); process.exit(0); });

console.log(`bunwv daemon started (session: ${sessionName}, PID: ${process.pid})`);
