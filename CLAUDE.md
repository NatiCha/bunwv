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

## Design principles (agent-first)

`bunwv` is designed for AI coding agents driving it via discrete tool calls. Humans are a secondary user. When the two conflict, agent UX wins.

- **Statelessness over streams.** Every command is one request, one response, exit. No long-lived connections, no background processes for the agent to manage. "Tail" patterns use snapshot + cursor (`--since <seq>`), never streaming.
- **Token efficiency in the happy path.** Successful verbs print only what's needed to continue. `click`, `type`, `navigate`, `press`, `scroll`, `resize`, `back/forward/reload`: empty stdout, exit 0. Don't spend tokens confirming success.
- **Structure only where it earns its tokens.** JSON is ~30–50% heavier than prose for small outputs. Use plain text for simple success; use JSON for (a) errors, (b) genuinely structured data (events, console buffer, multi-field status under `--json`), (c) anywhere the agent must distinguish types — `evaluate` prints JSON-literal values so strings keep their quotes and numbers don't.
- **Reliability on the unhappy path.** Errors are always JSON on stderr with nonzero exit. Exit codes are stable and documented. Agents branch on exit code, not on stderr parsing. (0 ok, 1 generic, 2 usage, 3 timeout, 4 element-not-found, 5 daemon-unreachable.)
- **Error-level console auto-surfaces; everything else is pull.** If `console.error` or `console.warn` fires during a verb, the daemon attaches `X-Console-Errors` to the HTTP response and the CLI forwards it to process stderr as `{console:[…]}`. Normal logs, CDP events, and navigation events stay in ring buffers, fetched on demand via `bunwv console --since` / `bunwv events --since`.
- **File paths for binary outputs.** Screenshots default to a file path on disk; the agent's file-reading tools handle the image. `--encoding base64` and `--out -` (stdout) exist but are not the default.
- **`--json` for opt-in uniformity.** Agents that prefer one shape over terseness can force an envelope `{ok, data?, error?, exitCode}` on any command.
- **1:1 with Bun.WebView.** Every capability of the `Bun.WebView` type is reachable from the CLI. No JS-API-only escape hatches.

When in doubt: measure the token cost of the default output on the happy path. If it's not roughly zero, justify it.

## Key Design Decisions

- Unix socket over TCP — no port conflicts, automatic filesystem discovery
- `clear` uses React-compatible native value setter (`HTMLInputElement.prototype.value.set`) — keyboard clearing doesn't update React state
- `submit` uses `form.requestSubmit()` — JS `.click()` produces `isTrusted: false` which React forms reject
- `evaluate` auto-wraps statements (`const`, `let`, etc.) in an IIFE — WebView's `evaluate()` only accepts expressions
- `click --text` resolves text → unique `data-bunwv-click-*` attribute → selector, so the actionability wait + `isTrusted: true` path is preserved
- Events and console ring buffers: 1000 entries / 10 MB (events) and 1000 entries (console), LRU. Both use monotonic `seq` cursors; responses include `truncated`/`oldest` when the cursor pre-dates retained entries
- Socket + PID files `chmod 0600` on daemon start — other local users can't connect to this session
- Default viewport 1920x1080 for readable screenshots

## Browser Testing

See `skills/bunwv/SKILL.md` for full usage. Quick reference:

```sh
bunwv start [--session <name>] [--backend chrome] [--url <initial>]
bunwv sessions
bunwv navigate <url>
bunwv click --selector <css> | --text <text> | --at <x,y>
            [--text-match exact|contains|regex]  # default contains
            [--button right|middle] [--count 2|3] [--mod Shift] [--timeout ms]
bunwv exists <selector>            # silent; exit 0 if present, 4 if not
bunwv type <text>                  #  press <key> [--mod Shift]
bunwv scroll <dx> <dy>             #  scroll-to <selector> [--block start]
bunwv screenshot                   # /tmp/bunwv-screenshot-<session>.png
bunwv screenshot --encoding base64 | --out -   # pipeable variants
bunwv evaluate <expr>              # JSON-literal result
bunwv console [--since <ts>]       # console buffer
bunwv events [--since <seq>]       # navigation + CDP-subscribed events
bunwv cdp <method> [--params '{}'] # raw CDP
bunwv cdp-subscribe <CDP.event>    # then pull via `events`
bunwv status                       # "<url> | <title> | <idle|loading> | pending=<n>"
bunwv wait-for <sel> | --url <s> | --title <s> [--timeout ms]
bunwv wait-for-gone <sel> | --url <s> | --title <s> [--timeout ms]
bunwv console [--since <seq>]      # terse "<seq> [<level>] <msg>", cursor-based (matches events)
bunwv batch [--file <p>] [--keep-going]   # stdin NDJSON of JSON-array argvs
bunwv close [--all]                # close this session or every session
bunwv help                         # full command list
# --json wraps any command's output as {ok, data?, error?, exitCode}
# --flag=value and --flag value both work; flags may appear before or after the command
```
