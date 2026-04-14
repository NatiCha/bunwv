# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-04-14

A one-shot breaking reshape toward an **agent-first** CLI: every capability of `Bun.WebView` 1.3.12 is now reachable from the shell, and defaults favor agents making discrete tool calls (silent on success, stable exit codes, cursor-pull buffers, token-efficient terse output). See `CLAUDE.md` for the full design principles.

### Breaking changes

- **Renamed verb**: `stop` → `close`. Daemon `/stop` HTTP route renamed to `/close`; start a fresh daemon after upgrading. `eval` is kept as a deprecated alias for `evaluate`.
- **`navigate` output removed**: was `<url>\n<title>`, now silent (exit 0) like every other action verb. Scripts parsing navigate output must switch to exit codes or `--json`.
- **`scroll` split**: `bunwv scroll <dx> <dy>` now only dispatches a wheel event. Element-into-view moved to new verb `bunwv scroll-to <selector> [--block start|center|end|nearest] [--timeout ms]`.
- **`click` unified**: one verb, exactly one of `--selector <css>`, `--text <text>`, `--at <x,y>`. The separate `click-text` command is removed. New options: `--button left|right|middle`, `--count 1|2|3`, `--mod <Modifier>` (repeatable), `--timeout ms`, `--text-match exact|contains|regex` (default **contains**, trimmed, case-sensitive).
- **`--mod` is repeatable**: `--mod Shift --mod Control` (comma form still accepted).
- **Silent on success**: `click`, `type`, `navigate`, `press`, `scroll`, `scroll-to`, `clear`, `submit`, `resize`, `back`/`forward`/`reload`, `close`, `exists`, `wait-for`, `wait-for-gone`, `cdp-subscribe`, `cdp-unsubscribe` print nothing on stdout and exit 0. Previous versions printed confirmation lines.
- **Stable exit codes**: 0 ok, 1 generic, 2 usage, 3 timeout, 4 element-not-found, 5 daemon-unreachable, 6 batch-partial. Errors are JSON on stderr (`{ok:false, error, exitCode}`) — branch on exit code, not stderr text.
- **`status` terse default** is one line: `<url> | <title> | <idle|loading> | pending=<n>`. Multi-field JSON behind `--json`.
- **`evaluate` always prints JSON-literal** (`"Example"`, `42`, `[1,2]`) so agents can distinguish types without a format flag.
- **`console --since` uses seq cursors** (not ms timestamps). Response carries `cursor` and `truncated`/`oldest` on eviction, matching `events`. Terse output: `<seq> [<level>] <message>`, one line per entry, `\n`/`\r` escaped; empty buffer prints nothing.
- **Screenshot default path is session-scoped**: `/tmp/bunwv-screenshot-<session>.png` (was `/tmp/bunwv-screenshot.png`). New `--out <path>`, `--out -` (stdout bytes), `--encoding blob|buffer|base64|shmem`.
- **Socket + PID file are `chmod 0600`** on daemon start. Other local users on shared machines can no longer connect to your session.

### Added

- **Events ring buffer** — `bunwv events [--since <seq>]`. Captures `onNavigated`, `onNavigationFailed`, and any subscribed CDP events. 1000 entries / 10 MB LRU cap. Responses include `cursor` and `truncated`/`oldest` when the cursor pre-dates retained entries.
- **CDP event subscriptions** — `bunwv cdp-subscribe <CDP.event> [<CDP.event> ...]`, `cdp-unsubscribe`, `cdp-subscriptions`. Multiple types per call; subscribed events land in the events buffer.
- **`exists <selector>`** — silent probe. Exit 0 present, 4 missing. Cheaper than `evaluate "!!document.querySelector(...)"`.
- **`wait-for --url <substr>` / `--title <substr>`** — wait for URL or title to contain a substring (polls `location.href` / `document.title`).
- **`wait-for-gone --url / --title`** — symmetric with `wait-for`.
- **`batch [--file <path>] [--keep-going]`** — read NDJSON-style stdin (each line a JSON array of args), run each in one Bun process (no per-command startup), emit one NDJSON envelope per command on stdout. Outer flags like `--session` inherit into each line. Exit 0 on full success, failing code on first error, 6 under `--keep-going` with ≥1 failure.
- **`close --all`** — enumerate `/tmp/bunwv-*.sock` and close every session.
- **Error-level console auto-surfaces** — `console.error` / `console.warn` fired during a verb returns as `{console:[…]}` on the verb's stderr, so the agent sees page errors without a second call. (HTTP contract: `X-Console-Errors` response header.)
- **`BUNWV_SESSION` env var** — set once; `--session` becomes optional.
- **`--json` global flag** — any command emits `{ok, data?, error?, exitCode}` as a single envelope line when set.
- **Flexible flag parser** — `--flag value`, `--flag=value`, repeated flags, and flags before or after the command all work.
- **Initial URL** — `bunwv start --url <url>` navigates before serving.
- **Chrome backend options** — `--chrome-argv '[json]'`, `--chrome-stdout inherit|ignore`, `--chrome-stderr inherit|ignore`, `--chrome-url <ws-url>` (attach to a running Chrome via DevTools WebSocket), plus `--webkit-stdout` / `--webkit-stderr`.
- **`status` extras** — includes `loading`, `pendingEvents`, `cursor`, `cdpSubscriptions` in the `--json` envelope.

### Changed

- **Bumped `@types/bun` to 1.3.12**; dropped the local `declare module "bun"` augmentation. Daemon uses `WebView.ClickOptions`, `WebView.ScrollToOptions`, `WebView.Modifier`, etc. directly.
- **Removed dead `/click-text` daemon route** (superseded by unified `/click`).
- **Console ring buffer entries carry a monotonic `seq`** (used for cursor semantics and error auto-surface).
- **Agent-first docs** — `CLAUDE.md` gained a "Design principles (agent-first)" section; `SKILL.md` gained an "Agent-first usage patterns" lead and updated examples throughout.

### Migration

- `bunwv stop` → `bunwv close`. (`bunwv eval` still works as an alias for `bunwv evaluate`; same semantics, always JSON-literal now.)
- `bunwv scroll <selector>` → `bunwv scroll-to <selector>`.
- `bunwv click <selector>` → `bunwv click --selector <selector>`.
- `bunwv click <x> <y>` → `bunwv click --at <x,y>`.
- `bunwv click-text <text>` → `bunwv click --text <text>` (default match mode is now `contains` — add `--text-match exact` if you need the old strict behavior).
- `bunwv press foo --mod shift,ctrl` → `bunwv press foo --mod Shift --mod Control` (comma form still works; modifier names are case-sensitive per Bun.WebView).
- Scripts that parse `bunwv navigate` confirmation output: removed. Check exit code.
- Scripts that parse `bunwv status` format: new terse shape is `<url> | <title> | <idle|loading> | pending=<n>`; use `--json` for structured access.
- Scripts using `bunwv console --since <timestamp-ms>`: switch to `--since <seq>` (seq comes from a prior call or `status --json`).

## [0.0.5] - 2026-04-10

### Added

- Console capture improvements, CDP pass-through, cross-platform backend support, screenshot options. (See commit `4ebc9d7`.)
- README demo GIF and npm repository metadata.

## [0.0.4] - 2026-04-10

### Added

- Console capture — page `console.log`/`console.error`/etc. buffered and readable via `bunwv console`
- Screenshot format/quality — `--format png|jpeg|webp` and `--quality 0-100` options
- Cross-platform support — WebKit on macOS (default), Chrome auto-detected on Linux/Windows
- Backend selection — `--backend webkit|chrome` and `--chrome-path` on `bunwv start`
- CDP pass-through — `bunwv cdp <method>` for raw Chrome DevTools Protocol calls

## [0.0.1] - 2026-04-10

### Added

- Initial release
- Persistent WebView daemon with Unix socket IPC
- Named sessions (`--session`) with isolation
- Auto-shutdown after 30 min idle (`--idle-timeout`)
- Session listing (`sessions`) and reuse detection
- Core commands: `navigate`, `click`, `type`, `press`, `scroll`, `screenshot`, `eval`
- React-compatible `clear` (native value setter) and `submit` (`requestSubmit()`)
- Text-based clicking (`click-text`)
- Element waiting (`wait-for`, `wait-for-gone`)
- Persistent auth via `--data-store`
- Claude Code skill file for AI assistant integration
