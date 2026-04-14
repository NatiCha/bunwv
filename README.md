# bunwv

[![npm](https://img.shields.io/npm/v/@naticha/bunwv)](https://www.npmjs.com/package/@naticha/bunwv)
[![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)](https://github.com/naticha/bunwv)
[![Bun](https://img.shields.io/badge/bun-%3E%3D1.3.12-orange)](https://bun.sh)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

![bunwv demo](https://github.com/user-attachments/assets/c09a565a-0031-4698-9e09-6c7c9c222da9)

Headless browser automation CLI for [Bun](https://bun.sh), powered by `Bun.WebView`. Cross-platform: WebKit on macOS (default, zero dependencies), Chrome on macOS/Linux/Windows.

A persistent daemon keeps a browser instance alive so page state — DOM, modals, forms, auth, cookies — survives across commands. Designed **agent-first**: every action verb is silent on success, errors are JSON on stderr with stable exit codes, and event/console buffers are cursor-pulled. Built for AI coding assistants (Claude Code, Cursor, etc.) driving the browser through discrete tool calls.

## Install

```bash
bun install -g @naticha/bunwv
```

Requires Bun v1.3.12+. On macOS, uses the native WebKit engine by default (zero dependencies). On Linux and Windows, automatically uses Chrome/Chromium (must be installed).

### AI Coding Assistant Skill

```bash
bunx skills add naticha/bunwv
# or
npx skills add naticha/bunwv
```

Or install directly in Claude Code:

```
/plugin marketplace add naticha/bunwv
/plugin install bunwv@naticha/bunwv
```

This installs the skill file that teaches AI assistants how to use bunwv for browser testing.

## Quick Start

```bash
bunwv start                                  # start the daemon
bunwv navigate http://localhost:3000         # go to a page
bunwv screenshot                             # writes /tmp/bunwv-screenshot-<session>.png, prints the path
bunwv click --selector "button.submit"       # click an element (auto-waits)
bunwv type "hello world"                     # type into focused element
bunwv evaluate "document.title"              # run JS in the page, JSON-literal result
bunwv close                                  # stop the daemon
```

## Agent-first contract

- **Successful action verbs print nothing on stdout and exit 0.** `click`, `type`, `navigate`, `press`, `scroll`, `scroll-to`, `clear`, `submit`, `resize`, `back`/`forward`/`reload`, `close`, `exists`, `wait-for`, `wait-for-gone`, `cdp-subscribe`, `cdp-unsubscribe` are all silent. Read verbs (`status`, `evaluate`, `events`, `console`, `cdp`, `cdp-subscriptions`, `screenshot`, `sessions`) print their result.
- **Stable exit codes**: `0` ok, `1` generic, `2` usage, `3` timeout, `4` element-not-found, `5` daemon-unreachable, `6` batch-partial.
- **Errors are JSON on stderr**: `{ok:false, error, exitCode}`. Branch on the exit code, not stderr text.
- **Error-level console auto-surfaces.** If the page logs `console.error`/`console.warn` while a verb runs, `{"console":[…]}` is written to stderr alongside the verb's response.
- **`--json` global flag** wraps any command's output as `{ok, data?, error?, exitCode}`.
- **Flexible flags**: `--flag value`, `--flag=value`, repeated flags (e.g. `--mod Shift --mod Control`), and flags before or after the command all work.
- **`BUNWV_SESSION` env var** replaces `--session <name>` when set.

## Commands

### Session

| Command | Description |
|---|---|
| `start [--width N] [--height N] [--data-store PATH] [--idle-timeout ms] [--backend webkit\|chrome] [--chrome-path PATH] [--chrome-argv '[json]'] [--chrome-url <ws>] [--chrome-stdout inherit\|ignore] [--chrome-stderr inherit\|ignore] [--webkit-stdout inherit\|ignore] [--webkit-stderr inherit\|ignore] [--url <initial>]` | Start the daemon (default 1920x1080, 30min idle timeout) |
| `close [--all]` | Stop this session, or every running session with `--all` |
| `status` | Terse: `<url> \| <title> \| <idle\|loading> \| pending=<n>`. `--json` for `loading`, `pendingEvents`, `cursor`, `cdpSubscriptions` |
| `sessions` | List all running sessions |

### Navigation

| Command | Description |
|---|---|
| `navigate <url>` | Navigate to a URL (silent) |
| `back` / `forward` / `reload` | History + refresh (silent) |

### Interaction

| Command | Description |
|---|---|
| `click --selector <css>` | Click an element by CSS selector (auto-waits for actionability, `isTrusted: true`) |
| `click --text <text>` | Click an element by visible text. `--text-match exact\|contains\|regex` (default: trimmed contains) |
| `click --at <x,y>` | Click at coordinates (no actionability wait) |
| `click ... [--button left\|right\|middle] [--count 1\|2\|3] [--mod Shift] [--mod Control] [--mod Alt] [--mod Meta] [--timeout ms]` | Modifiers, mouse button, click count, actionability timeout |
| `exists <selector>` | Silent probe. Exit 0 present, 4 missing |
| `type <text>` | Type text into the focused element |
| `press <key> [--mod Shift] [--mod Control] ...` | Press a key with optional modifiers (case-sensitive per Bun.WebView) |
| `clear <selector>` | Clear an input/textarea (React-compatible native setter) |
| `submit [--form <sel>] [--button <text>]` | Submit a form via `requestSubmit()` (React-compatible) |
| `scroll <dx> <dy>` | Scroll by wheel event |
| `scroll-to <selector> [--block start\|center\|end\|nearest] [--timeout ms]` | Scroll element into view |

### Inspection

| Command | Description |
|---|---|
| `screenshot [--format png\|jpeg\|webp] [--quality 0-100] [--encoding blob\|buffer\|base64\|shmem] [--out <path>\|-]` | Capture the viewport. Default: writes `/tmp/bunwv-screenshot-<session>.png` and prints the path |
| `evaluate <expr>` | Evaluate JS in the page. Always prints the JSON-literal result (auto-wraps statements in an IIFE) |
| `console [--clear] [--since <seq>]` | Captured page console output. Terse: `<seq> [<level>] <message>`. `\n`/`\r` escaped. `--json` for raw messages + cursor |
| `events [--since <seq>]` | Navigation events + subscribed CDP events since the cursor. 1000 entries / 10 MB LRU cap |
| `cdp <method> [--params '{}']` | Raw Chrome DevTools Protocol call (Chrome backend only) |
| `cdp-subscribe <CDP.event> [<CDP.event> ...]` | Subscribe one or more CDP events into the `events` buffer |
| `cdp-unsubscribe <CDP.event> [<CDP.event> ...]` | Unsubscribe |
| `cdp-subscriptions` | List active subscriptions |
| `resize <w> <h>` | Resize the viewport |

### Waiting

| Command | Description |
|---|---|
| `wait-for <selector>` | Wait until element appears (default 10s) |
| `wait-for --url <substring>` / `--title <substring>` | Wait for URL or title to contain a substring |
| `wait-for-gone <selector> \| --url <substr> \| --title <substr>` | Symmetric removal wait |
| `wait-for ... [--timeout ms]` | Override the 10s default |

### Batch

| Command | Description |
|---|---|
| `batch [--file <path>] [--keep-going]` | Read NDJSON from stdin (or a file), each line a JSON array of args. Runs all lines in one Bun process, emits one NDJSON envelope per command. Outer flags like `--session` inherit into each line |

All commands accept `--json`, `--session <name>` (or `BUNWV_SESSION` env var), and the flexible flag syntax.

## Sessions

Sessions are named and isolated. Each runs its own daemon on a separate Unix socket. Sockets and PID files are `chmod 0600`, so other local users can't drive your session.

```bash
bunwv start                          # "default" session
bunwv start --session staging        # separate "staging" session
BUNWV_SESSION=staging bunwv navigate http://staging:3000
bunwv sessions                       # list running sessions
bunwv close --session staging        # stop one session
bunwv close --all                    # stop every running session
```

**Auto-shutdown** — daemons exit after 30 minutes of inactivity. Override with `--idle-timeout`:

```bash
bunwv start --idle-timeout 3600000   # 1 hour
bunwv start --idle-timeout 0         # never
```

**Reuse detection** — starting an existing session reports its current state and exits 0:

```
$ bunwv start
Reusing existing session "default" (PID: 12345)
  URL:   http://localhost:3000/dashboard
```

**Persistent auth** — use `--data-store` to preserve cookies/localStorage across daemon restarts:

```bash
bunwv start --data-store ./bunwv-session
```

## Working with React

Two commands are specifically designed for React apps:

**`clear`** — clears input fields using the native value setter and dispatches React-compatible events. Keyboard-based clearing (`Cmd+A`, `Backspace`) does not reliably update React state.

```bash
bunwv clear "input[name='email']"
bunwv click --selector "input[name='email']"
bunwv type "new-value@example.com"
```

**`submit`** — submits forms via `form.requestSubmit()`, which properly triggers React form handlers. JS `.click()` produces `isTrusted: false` events that many React forms ignore.

```bash
bunwv submit --button "Save Changes"
bunwv wait-for-gone "[role='dialog']"
```

## Console Capture

Page `console.log`, `console.error`, etc. are captured into a cursor-based ring buffer (1000 entries). `console.error`/`console.warn` entries that fire **during a verb** are auto-surfaced to that verb's stderr as `{"console":[…]}` — the agent sees failures without a second call.

Pull the buffer explicitly:

```bash
bunwv console                        # terse: "<seq> [<level>] <message>"
bunwv console --clear                # print, then clear
bunwv console --since 42             # only entries with seq > 42
bunwv --json console                 # {messages, cursor, truncated?, oldest?}
```

Advance `--since` using the max `seq` you saw (first field of each line). Use `--json` when you need raw multi-line messages or the truncation signal.

## Events & CDP

`onNavigated`, `onNavigationFailed`, and any subscribed CDP events land in a shared ring buffer (1000 entries / 10 MB LRU):

```bash
bunwv events --since 0               # full buffer
bunwv events --since 42              # new events only
```

If the buffer evicted older entries, the response includes `"truncated":true,"oldest":<seq>`.

### Chrome backend & CDP

macOS defaults to WebKit; Linux/Windows auto-use Chrome. Override on any platform:

```bash
bunwv start --backend chrome
bunwv start --backend webkit                                # macOS only
bunwv start --chrome-path /path/to/chromium
bunwv start --chrome-argv '["--headless=new"]'              # extra flags
bunwv start --chrome-url ws://127.0.0.1:9222/devtools/...   # attach to a running Chrome
```

Raw CDP calls and subscriptions (Chrome only):

```bash
bunwv cdp "Page.getLayoutMetrics"
bunwv cdp "Runtime.evaluate" --params '{"expression": "1+1"}'

bunwv cdp "Network.enable"
bunwv cdp-subscribe Network.responseReceived Network.requestWillBeSent
bunwv navigate https://example.com
bunwv events --since 0
bunwv cdp-unsubscribe Network.responseReceived Network.requestWillBeSent
```

## Batch mode

`bunwv batch` runs many commands in a single Bun process, eliminating per-command startup cost. Each stdin line is a JSON array of args; each response is an NDJSON envelope on stdout.

```bash
cat <<'EOF' | bunwv batch --session staging --keep-going
["navigate","http://localhost:3000/login"]
["click","--selector","input[name='email']"]
["type","me@example.com"]
["press","Tab"]
["type","hunter2"]
["submit","--button","Sign In"]
["wait-for","--url","/dashboard"]
["screenshot"]
EOF
```

`--keep-going` runs the full list even if one line fails; the process exits `6` (batch-partial) on any failure, `0` on full success. Without `--keep-going`, batch stops at the first failure and returns that line's exit code.

## How It Works

```
┌──────────┐     Unix Socket      ┌───────────────┐    Bun.WebView    ┌──────────────┐
│  bunwv   │ ──── HTTP POST ────▶ │    daemon     │ ─────── API ────▶ │ WebKit macOS │
│   CLI    │ ◀─── JSON/bytes ──── │ (background)  │ ◀──────────────── │ Chrome Linux │
└──────────┘  /tmp/bunwv-*.sock   └───────────────┘                   │   / Windows  │
                                                                      └──────────────┘
```

- The daemon spawns on `bunwv start` and listens on a Unix socket (owner-only, `chmod 0600`).
- Each CLI command sends one HTTP request to the daemon and exits — no long-lived connections.
- The daemon owns a single `Bun.WebView` instance.
- All selector/coordinate input is dispatched as **native events** (`isTrusted: true`); selector-based methods auto-wait for actionability (attached, visible, stable, unobscured).
- Navigation and CDP events are buffered with monotonic `seq` cursors so agents can poll for what's new since their last turn.

## AI Assistant Integration

bunwv is designed for AI coding assistants that can't see a browser. The typical workflow:

1. **Navigate** to a page
2. **Screenshot** — the assistant Reads the PNG to "see" the page
3. **Decide** what to do based on the screenshot
4. **Act** — `click`, `type`, `submit`
5. **Wait** — `wait-for` a selector, URL, or title change
6. **Screenshot** again to verify
7. **Repeat**

The Claude Code skill (`skills/bunwv/SKILL.md`) documents these patterns end-to-end, including batch mode, React form handling, error recovery via exit codes, and cursor-based event/console polling.

## License

MIT
