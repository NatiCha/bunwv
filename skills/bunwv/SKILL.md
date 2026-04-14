---
name: bunwv
description: Headless browser testing via persistent Bun.WebView session. Use when testing frontend UI, verifying page content, filling forms, clicking buttons, taking screenshots, or interacting with local or staging web applications. Triggers on phrases like "test the page", "check the UI", "browse to", "fill the form", "click the button", "take a screenshot".
---

# bunwv

Headless browser automation using a persistent WebView session. The daemon keeps a single WebView instance alive so page state (DOM, modals, forms, SPA routes, scroll position) persists across commands.

## Agent-first usage patterns

bunwv is designed for AI agents driving it via discrete tool calls. A few contracts to rely on:

- **Successful verbs print nothing on stdout and exit 0.** `click`, `type`, `navigate`, `press`, `scroll`, `scroll-to`, `clear`, `submit`, `resize`, `back`/`forward`/`reload`, `close`, `exists`, `wait-for`, `wait-for-gone`, `cdp-subscribe`, `cdp-unsubscribe` all follow this. Read verbs (`status`, `evaluate`, `events`, `console`, `cdp`, `cdp-subscriptions`, `screenshot`, `sessions`) print their result.
- **Errors are JSON on stderr with a stable exit code.** Branch on exit code, not stderr text:
  - `0` ok, `1` generic, `2` usage, `3` timeout, `4` element-not-found, `5` daemon-unreachable, `6` batch-partial (only in `batch --keep-going`).
- **`console.error`/`console.warn` auto-surface during verbs.** If the page logs an error while a verb runs, bunwv prints `{"console":[…]}` to stderr. You see the failure without a second call.
- **Cursor-pull for events.** `events --since <seq>` returns entries newer than the cursor plus a new cursor. Keep the cursor across turns; refetch after actions. If the buffer evicted older entries, the response includes `"truncated":true,"oldest":<seq>`.
- **File paths for binary output.** `bunwv screenshot` writes bytes to `/tmp/bunwv-screenshot-<session>.png` by default and prints the path on stdout. Use the Read tool on that path to see the image.
- **`--json` for uniform envelopes.** Any command with `--json` returns `{ok, data?, error?, exitCode}` as a single JSON line. Use it when you prefer one shape over terse output.
- **Flexible flag syntax.** `--flag value`, `--flag=value`, and repeated flags (e.g. `--mod Shift --mod Control`) all work. Flags may appear before or after the command: `bunwv --json status` and `bunwv status --json` are equivalent.
- **`BUNWV_SESSION` env var** — set it once and `--session` becomes optional.

## Commands

Run all commands with `bunwv <command>` (installed globally via `bun install -g @naticha/bunwv`).

```
bunwv start [--width N] [--height N] [--data-store PATH] [--idle-timeout ms]
      [--backend webkit|chrome] [--chrome-path PATH] [--chrome-argv '[json]']
      [--chrome-url <ws-url>] [--url <initial-url>]
bunwv navigate <url>
bunwv click --selector <css> | --text <text> | --at <x,y>
      [--text-match exact|contains|regex]   # default: contains (trimmed)
      [--button left|right|middle] [--count 1|2|3]
      [--mod Shift] [--mod Control] [--mod Alt] [--mod Meta]
      [--timeout ms]
bunwv exists <selector>                     # silent; exit 0 if present, 4 if not
bunwv type <text>
bunwv press <key> [--mod Shift] [--mod Control] ...
bunwv clear <selector>
bunwv submit [--form <selector>] [--button <text>]
bunwv scroll <dx> <dy>
bunwv scroll-to <selector> [--block start|center|end|nearest] [--timeout ms]
bunwv screenshot [--format png|jpeg|webp] [--quality 0-100]
      [--encoding blob|buffer|base64|shmem] [--out <path>|-]
bunwv evaluate <expression>
bunwv console [--clear] [--since <seq>]       # terse "<seq> [<level>] <message>", cursor-based
bunwv events [--since <seq>]
bunwv cdp <method> [--params '{}']
bunwv cdp-subscribe <CDP.event> [<CDP.event> ...]
bunwv cdp-unsubscribe <CDP.event> [<CDP.event> ...]
bunwv cdp-subscriptions
bunwv wait-for <selector> | --url <substring> | --title <substring>
      [--timeout ms]
bunwv wait-for-gone <selector> | --url <substring> | --title <substring>
      [--timeout ms]
bunwv batch [--file <path>] [--keep-going]  # stdin NDJSON of JSON arrays
bunwv status [--json]
bunwv resize <width> <height>
bunwv back / forward / reload
bunwv sessions
bunwv close [--all]
bunwv help
```

All commands accept `--json` (opt-in envelope), `--session <name>` (or `BUNWV_SESSION` env var), and the flexible flag syntax described above.

Default viewport is 1920x1080 for readable screenshots.

## Session Management

Sessions are **named and isolated**. Each session runs its own daemon on a separate Unix socket. The default session is named `default`; override with `--session <name>` or the `BUNWV_SESSION` env var.

```
bunwv start                          # starts "default" session
bunwv start --session cmais          # separate "cmais" session
BUNWV_SESSION=cmais bunwv navigate http://localhost:3000
bunwv sessions                       # list all running sessions
bunwv close --session cmais          # stop a specific session
bunwv close --all                    # stop every running session
```

**Auto-shutdown**: Daemons exit after 30 minutes of inactivity. Override with `--idle-timeout`:

```
bunwv start --idle-timeout 3600000   # 1 hour
bunwv start --idle-timeout 0         # never auto-shutdown
```

**Reuse detection**: `bunwv start` on an existing session prints the current URL and exits 0.

**Best practice**: Run `bunwv sessions` at the start of a conversation to check for orphaned daemons. Close any you don't need with `bunwv close --all`.

## Core Interaction Loop

Look, then act, then look again. A canonical single-turn loop:

1. Start the daemon: `bunwv start` (no-op if already running)
2. Navigate: `bunwv navigate http://localhost:3000`
3. Screenshot: `bunwv screenshot` — prints `/tmp/bunwv-screenshot-<session>.png` to stdout
4. Read the screenshot with the Read tool
5. Act: `bunwv click --selector "button.submit"` (or `--text`)
6. `bunwv wait-for --url "/next"` (or `wait-for "<selector>"`) before the next screenshot
7. Screenshot again to verify
8. `bunwv close` when the task is done

For multi-step flows, prefer `bunwv batch` (see below) — it runs the whole sequence in one process and returns an NDJSON transcript you can inspect.

## Clicking Elements

`click` is polymorphic — use exactly one of `--selector`, `--text`, or `--at`:

```
bunwv click --selector "button.submit"
bunwv click --text "Sign In"                             # default: trimmed contains match
bunwv click --text "Sign In" --text-match exact
bunwv click --text "^Sign.+In$" --text-match regex
bunwv click --at 100,200
```

Modifiers, button, and click count are orthogonal:

```
bunwv click --selector "#ctx" --button right                # context menu
bunwv click --selector ".item" --count 2                    # double-click
bunwv click --selector "a" --mod Shift                      # shift+click
bunwv click --selector "a" --mod Meta --mod Shift           # cmd+shift+click
bunwv click --selector "button" --timeout 60000             # longer actionability wait
```

`--text` defaults to **trimmed substring match** (case-sensitive). Use `--text-match exact` for strict equality or `--text-match regex` for a regex pattern. `--selector` and `--text` both produce native `isTrusted: true` events with the actionability wait; `--at` skips the wait.

## Clearing and Editing Input Fields

Do NOT use Cmd+A / Backspace to clear React inputs — it doesn't update React state. Use `clear`:

```
bunwv clear "input[name='email']"
bunwv click --selector "input[name='email']"
bunwv type "new-value@example.com"
```

Always `clear` then `click` then `type` when editing existing input values.

## Waiting for Elements, URLs, or Titles

Use `wait-for` after actions that trigger page changes:

```
bunwv click --text "Save Changes"
bunwv wait-for-gone "[role='dialog']"                # wait for modal to close
bunwv screenshot

bunwv click --text "Edit"
bunwv wait-for "[role='dialog']"                     # wait for modal to appear
bunwv wait-for --url "/dashboard"                    # wait until URL contains substring
bunwv wait-for --title "Home"                        # wait until <title> contains substring
```

`--url` polls `location.href` and `--title` polls `document.title`. Exactly one of `<selector>`, `--url`, `--title` is required. Default timeout 10s.

## Checking Existence

Use `exists` as a cheap probe (silent; exit 0 present, 4 missing):

```
bunwv exists "[data-loaded]"
if [ $? -eq 0 ]; then ... fi
```

Prefer `exists` over `evaluate "!!document.querySelector(...)"` — fewer tokens, clearer contract.

## Extracting Page Data

`evaluate` prints the result as a JSON literal — strings keep their quotes, numbers don't, objects arrive as structured JSON:

```
bunwv evaluate "document.title"                              # "Example"
bunwv evaluate "document.querySelectorAll('.error').length"  # 3
bunwv evaluate "[...document.querySelectorAll('h2')].map(h => h.textContent)"
```

Statements (`const`, `let`, `if`, etc.) are auto-wrapped in an IIFE.

## Submitting Forms

Use `submit` instead of clicking the submit button — it uses `form.requestSubmit()`, which React forms accept (JS `.click()` produces `isTrusted:false` which many React handlers ignore):

```
bunwv submit                                    # first form on page
bunwv submit --button "Save Changes"            # submit via a specific button
bunwv submit --form "form.edit-quote"           # target a specific form
```

After submitting, wait for the resulting DOM change:

```
bunwv submit --button "Save Changes"
bunwv wait-for-gone "[role='dialog']"
bunwv screenshot
```

## Filling Forms

Click the input first, then type. Use Tab to move between fields:

```
bunwv click --selector "input[name='email']"
bunwv type "user@example.com"
bunwv press Tab
bunwv type "password123"
bunwv submit --button "Sign In"
```

Credentials go in `.env` (Bun auto-loads it). The shell expands `$VAR` in CLI args:

```
bunwv type "$TEST_EMAIL"
```

## Persistent Auth

Use `--data-store` to preserve cookies and localStorage across daemon restarts:

```
bunwv start --data-store ./bunwv-session
```

Log in once; future sessions stay authenticated.

## Debugging with Console Capture

Page console output is captured automatically. `console.error`/`console.warn` entries that fire during a verb are printed to stderr alongside the verb's response. To pull the full buffer:

```
bunwv console                    # terse: "<seq> [<level>] <message>", one per line
bunwv console --clear            # print then clear
bunwv console --since 42         # only entries with seq > 42 (matches events cursor model)
bunwv --json console              # {messages:[…], cursor, truncated?, oldest?}
```

Terse output escapes `\n` and `\r` in the message so each entry stays on one line. Empty buffer prints nothing (exit 0). Advance `--since` by using the max `seq` you saw (first field of each line). Use `--json` when you need raw message text (e.g. multi-line stack traces) or the truncation signal.

## Navigation and CDP Events

Navigation events and subscribed CDP events land in a ring buffer. Pull them with a cursor:

```
bunwv events                          # full buffer, prints {events, cursor}
bunwv events --since 42                # only events with seq > 42
```

Subscribe to CDP events (Chrome backend only; enable the domain first). Multiple types per call:

```
bunwv cdp Network.enable
bunwv cdp-subscribe Network.responseReceived Network.requestWillBeSent
bunwv navigate https://example.com
bunwv events --since 0                 # inspect events
bunwv cdp-unsubscribe Network.responseReceived Network.requestWillBeSent
bunwv cdp-subscriptions                # list active subscriptions, one per line
```

If the buffer evicted older entries, `events` returns `"truncated":true,"oldest":<seq>`.

## Screenshot Options

Defaults write a file and print its path:

```
bunwv screenshot                                    # /tmp/bunwv-screenshot-<session>.png
bunwv screenshot --format jpeg --quality 80         # /tmp/bunwv-screenshot-<session>.jpg
bunwv screenshot --out shot.png                     # write to a specific path
bunwv screenshot --out -                            # bytes to stdout
bunwv screenshot --encoding base64                  # base64 string to stdout
```

`--encoding shmem` (Kitty terminal) prints `{name, size}` and leaves the POSIX shm segment for the caller to unlink.

## Chrome Backend & CDP

macOS defaults to WebKit; Linux/Windows auto-use Chrome. Override anywhere:

```
bunwv start --backend chrome
bunwv start --chrome-path /path/to/chromium
bunwv start --chrome-argv '["--headless=new"]'
bunwv start --chrome-url ws://127.0.0.1:9222/devtools/browser/<id>   # attach to an existing Chrome
```

Raw CDP calls (Chrome only):

```
bunwv cdp "Page.getLayoutMetrics"
bunwv cdp "Runtime.evaluate" --params '{"expression": "1+1"}'
bunwv cdp "Emulation.setDeviceMetricsOverride" --params '{"width":375,"height":812,"deviceScaleFactor":2,"mobile":true}'
```

CDP is unavailable with the WebKit backend.

## Debugging a crashing backend

Route the backend process stdio to the daemon's stdio (human-debug only; agents never need these):

```
bunwv start --backend chrome --chrome-stderr inherit
bunwv start --webkit-stderr inherit
```

## Batch mode

`bunwv batch` executes many commands in a single process — one socket round-trip per verb, no per-command Bun startup. Each stdin line is a JSON array of args; each response is an NDJSON envelope on stdout. Flags on `batch` (e.g. `--session`) inherit into every line unless that line specifies its own.

```
$ cat <<'EOF' | bunwv batch --session cmais --keep-going
["navigate","http://localhost:3000/login"]
["click","--selector","input[name='email']"]
["type","me@example.com"]
["press","Tab"]
["type","hunter2"]
["submit","--button","Sign In"]
["wait-for","--url","/dashboard"]
["screenshot"]
EOF
{"argv":[...],"ok":true,"exitCode":0}
{"argv":[...],"ok":true,"exitCode":0}
...
```

`--keep-going` runs the full list even if one line fails; the process exits 6 (batch-partial) if any failed, 0 if all succeeded, or the failing line's exit code when `--keep-going` is off. `--file <path>` reads from a file instead of stdin.

`stdout` fields contain the command's terse output (e.g. `"\"Example Domain\""` for `evaluate`); `stdoutBytes` is base64 for binary outputs like `screenshot --out -`.

## Error Recovery

If a command fails or times out:
1. Screenshot to see the page state
2. `bunwv console` to see any captured errors
3. `bunwv events --since 0` to see navigation/CDP events
4. `bunwv evaluate` to inspect the DOM
5. If the daemon is unreachable (exit 5), `bunwv start` — the data store preserves auth

## Socket permissions

Each session's Unix socket (`/tmp/bunwv-<session>.sock`) and PID file are `chmod 0600` — only the user who started the daemon can talk to it. On shared machines (containers, build boxes) this prevents other local users from driving your browser session.

## Known Limitations

- **macOS**: WebKit default (no deps). **Linux/Windows**: Chrome auto-detected. Override with `--backend`.
- **`click --selector` / `--text` auto-wait** for actionability (visible, stable, unobscured); WebView default 30s, override with `--timeout`.
- **`--text` default is trimmed substring (contains).** Use `--text-match exact|regex` to change.
- **`--at` skips the actionability wait** — requires knowing exact coordinates. Use `evaluate` + `getBoundingClientRect()` when CSS/text don't work.
- **`clear` is required for React inputs** — Cmd+A/Backspace don't update React's internal state.
- **CDP is Chrome-only.** WebKit rejects `bunwv cdp` and `bunwv cdp-subscribe`.
- **Events buffer**: 1000 entries or 10 MB, whichever first. Older entries drop silently; `events --since` reports `truncated` when you missed any.
