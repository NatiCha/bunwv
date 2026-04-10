# CLAUDE.md

This is `bunwv` — a headless browser automation CLI built on Bun.WebView (Bun v1.3.12+). Cross-platform: WebKit on macOS (default), Chrome on Linux/Windows (auto-detected).

## Project Structure

```
bunwv.ts          # CLI entry point (shebang, arg parsing, commands)
lib/daemon.ts     # WebView daemon (Bun.serve on Unix socket, all routes)
skills/bunwv/     # Claude Code skill file (SKILL.md)
.claude-plugin/   # Marketplace plugin config
docs/             # Bun.WebView API reference notes
```

## Development

```bash
bun bunwv.ts help                    # run locally during dev
bun bunwv.ts start                   # test the daemon
bun bunwv.ts stop                    # stop it
```

Default to Bun for everything — no Node, no npm scripts, no external dependencies.

## Architecture

- **CLI** (`bunwv.ts`) parses args into flags/positional, sends HTTP requests to the daemon via Unix socket
- **Daemon** (`lib/daemon.ts`) owns a `Bun.WebView` instance, exposes all WebView methods as HTTP routes on `/tmp/bunwv-<session>.sock`
- **Sessions** are isolated by name — each gets its own socket, PID file, and WebView instance
- **Auto-shutdown** after 30min idle (configurable via `--idle-timeout`)

## Key Design Decisions

- Unix socket over TCP — no port conflicts, automatic filesystem discovery
- `clear` uses React-compatible native value setter (`HTMLInputElement.prototype.value.set`) — keyboard clearing doesn't update React state
- `submit` uses `form.requestSubmit()` — JS `.click()` produces `isTrusted: false` which React forms reject
- `eval` auto-wraps statements (`const`, `let`, etc.) in an IIFE — WebView's `evaluate()` only accepts expressions
- Default viewport 1920x1080 for readable screenshots

## Browser Testing

See `skills/bunwv/SKILL.md` for full usage documentation. Quick reference:

```sh
bunwv start                        # start the daemon (auto-stops after 30min idle)
bunwv start --session <name>       # start a named session (isolated from others)
bunwv start --backend chrome       # use Chrome instead of WebKit
bunwv start --chrome-path <path>   # use a custom Chrome/Chromium binary
bunwv sessions                     # list all running sessions
bunwv navigate <url>               # go to a page
bunwv screenshot                   # capture to /tmp/bunwv-screenshot.png
bunwv screenshot --format jpeg --quality 80  # JPEG with quality control
bunwv click <selector>             # click an element
bunwv clear <selector>             # clear a React input field
bunwv type <text>                  # type text
bunwv submit --button <text>       # submit a form
bunwv eval <expr>                  # run JS in the page
bunwv console                      # show captured page console output
bunwv console --clear              # show and clear the buffer
bunwv cdp <method> [--params '{}'] # raw Chrome DevTools Protocol call
bunwv stop                         # stop the daemon
bunwv help                         # full command list
```
