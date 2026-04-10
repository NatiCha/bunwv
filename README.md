# bunwv

[![npm](https://img.shields.io/npm/v/@naticha/bunwv)](https://www.npmjs.com/package/@naticha/bunwv)
[![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)](https://github.com/naticha/bunwv)
[![Bun](https://img.shields.io/badge/bun-%3E%3D1.3.12-orange)](https://bun.sh)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

![bunwv demo](https://github.com/user-attachments/assets/c09a565a-0031-4698-9e09-6c7c9c222da9)

Headless browser automation CLI for [Bun](https://bun.sh), powered by `Bun.WebView`. Cross-platform: WebKit on macOS (default, zero dependencies), Chrome on macOS/Linux/Windows.

A persistent daemon keeps a browser instance alive so page state — DOM, modals, forms, auth, cookies — survives across commands. Built for AI coding assistants (Claude Code, Cursor, etc.) that interact through screenshots and CLI commands.

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
bunwv start                          # start the daemon
bunwv navigate http://localhost:3000 # go to a page
bunwv screenshot                     # save screenshot to /tmp/bunwv-screenshot.png
bunwv click "button.submit"          # click an element
bunwv type "hello world"             # type into focused element
bunwv eval "document.title"          # run JS in the page
bunwv stop                           # stop the daemon
```

## Commands

### Session

| Command | Description |
|---|---|
| `start [--width N] [--height N] [--data-store PATH] [--idle-timeout ms] [--backend webkit\|chrome] [--chrome-path PATH]` | Start the daemon (default 1920x1080, 30min idle timeout) |
| `stop` | Stop the daemon and clean up |
| `status` | Show current URL, title, loading state, and session info |
| `sessions` | List all running sessions |

### Navigation

| Command | Description |
|---|---|
| `navigate <url>` | Navigate to a URL |
| `back` | Go back in history |
| `forward` | Go forward in history |
| `reload` | Reload the current page |

### Interaction

| Command | Description |
|---|---|
| `click <selector>` | Click element by CSS selector (auto-waits, `isTrusted: true`) |
| `click <x> <y>` | Click at coordinates (`isTrusted: true`) |
| `click-text <text> [--tag <sel>]` | Click element by visible text (JS click) |
| `type <text>` | Type text into the focused element |
| `press <key> [--mod meta,ctrl,shift,alt]` | Press a key with optional modifiers |
| `clear <selector>` | Clear an input/textarea (React-compatible) |
| `submit [--form <sel>] [--button <text>]` | Submit a form via `requestSubmit()` (React-compatible) |
| `scroll <dx> <dy>` | Scroll by pixel delta |
| `scroll <selector>` | Scroll element into view |

### Inspection

| Command | Description |
|---|---|
| `screenshot [file] [--format png\|jpeg\|webp] [--quality 0-100]` | Save screenshot (default: `/tmp/bunwv-screenshot.png`) |
| `eval <expr>` | Evaluate JS in the page (auto-wraps statements in IIFE) |
| `console [--clear] [--since <ts>]` | Show captured page console output |
| `cdp <method> [--params '{}']` | Raw Chrome DevTools Protocol call (Chrome backend only) |
| `resize <w> <h>` | Resize the viewport |

### Waiting

| Command | Description |
|---|---|
| `wait-for <selector> [--timeout ms]` | Wait until element appears (default 10s) |
| `wait-for-gone <selector> [--timeout ms]` | Wait until element is removed (default 10s) |

All commands accept `--session <name>` to target a named session.

## Sessions

Sessions are named and isolated. Each runs its own daemon on a separate Unix socket.

```bash
bunwv start                          # starts "default" session
bunwv start --session staging        # starts a separate "staging" session
bunwv navigate http://staging:3000 --session staging
bunwv sessions                       # list all running sessions
bunwv stop --session staging         # stop a specific session
```

**Auto-shutdown** — daemons exit after 30 minutes of inactivity. Override with `--idle-timeout`:

```bash
bunwv start --idle-timeout 3600000   # 1 hour
bunwv start --idle-timeout 0         # never
```

**Reuse detection** — starting an existing session shows its current state:

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
bunwv click "input[name='email']"
bunwv type "new-value@example.com"
```

**`submit`** — submits forms via `form.requestSubmit()` which properly triggers React form handlers. `click-text` uses JS `.click()` which produces `isTrusted: false` events that many React forms ignore.

```bash
bunwv submit --button "Save Changes"
bunwv wait-for-gone "[role='dialog']"
```

## Console Capture

Page `console.log`, `console.error`, etc. are automatically captured. Read them with:

```bash
bunwv console                # show all captured output
bunwv console --clear        # show and clear the buffer
bunwv console --since 17...  # only messages after a timestamp (ms)
```

The buffer holds the most recent 1000 messages.

## Chrome Backend & CDP

On macOS, bunwv defaults to WebKit. On Linux/Windows, it automatically uses Chrome. You can override the backend on any platform:

```bash
bunwv start --backend chrome                   # force Chrome on macOS
bunwv start --backend webkit                   # force WebKit (macOS only)
bunwv start --chrome-path /path/to/chromium    # custom Chrome path
```

With the Chrome backend, you can make raw DevTools Protocol calls:

```bash
bunwv cdp "Page.getLayoutMetrics"
bunwv cdp "Network.enable"
bunwv cdp "Runtime.evaluate" --params '{"expression": "1+1"}'
```

## How It Works

```
┌──────────┐     Unix Socket      ┌──────────────┐     WebKit     ┌─────────┐
│  bunwv   │ ──── HTTP POST ────▶ │    daemon     │ ──── API ───▶ │ WKWebView│
│   CLI    │ ◀─── JSON/PNG ────── │ (background)  │ ◀──────────── │ (macOS)  │
└──────────┘  /tmp/bunwv-*.sock   └──────────────┘               └─────────┘
```

- The daemon spawns on `bunwv start` and listens on a Unix socket
- Each CLI command sends an HTTP request to the daemon
- The daemon owns a `Bun.WebView` instance (WebKit on macOS, Chrome on Linux/Windows)
- All clicks are dispatched as OS-level events (`isTrusted: true`)
- CSS selector-based methods auto-wait for actionability (visible, stable, unobscured)
- One browser subprocess per Bun process; the daemon manages the full lifecycle

## AI Assistant Integration

bunwv is designed for AI coding assistants that can't see a browser. The typical workflow:

1. **Navigate** to a page
2. **Screenshot** — the assistant reads the PNG to "see" the page
3. **Decide** what to do based on the screenshot
4. **Act** — click, type, submit
5. **Screenshot** again to verify
6. **Repeat**

The Claude Code skill (`skills/bunwv/SKILL.md`) documents these patterns, including how to handle forms, auth, waiting, and error recovery.

## License

MIT
