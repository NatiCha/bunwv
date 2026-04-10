---
name: bunwv
description: Headless browser testing via persistent Bun.WebView session. Use when testing frontend UI, verifying page content, filling forms, clicking buttons, taking screenshots, or interacting with local or staging web applications. Triggers on phrases like "test the page", "check the UI", "browse to", "fill the form", "click the button", "take a screenshot".
---

# bunwv

Headless browser automation using a persistent WebView session. The daemon keeps a single WebView instance alive so page state (DOM, modals, forms, SPA routes, scroll position) persists across commands.

## Commands

Run all commands with `bunwv <command>` (installed globally via `bun install -g @naticha/bunwv`).

All commands accept `--session <name>` to target a named session (default: "default").

```
bunwv start [--width N] [--height N] [--data-store PATH] [--idle-timeout ms]
bunwv navigate <url>
bunwv click <selector> | <x> <y>
bunwv click-text <text> [--tag <selector>]
bunwv type <text>
bunwv press <key> [--mod meta,ctrl,shift]
bunwv clear <selector>
bunwv submit [--form <selector>] [--button <text>]
bunwv scroll <dx> <dy> | <selector>
bunwv screenshot [filename]
bunwv eval <expression>
bunwv wait-for <selector> [--timeout ms]
bunwv wait-for-gone <selector> [--timeout ms]
bunwv status
bunwv resize <width> <height>
bunwv back
bunwv forward
bunwv reload
bunwv sessions
bunwv stop
```

Default viewport is 1920x1080 for readable screenshots.

## Session Management

Sessions are **named and isolated**. Each session runs its own daemon on a separate Unix socket. The default session is named "default".

```
bunwv start                          # starts "default" session
bunwv start --session cmais          # starts a separate "cmais" session
bunwv navigate http://localhost:3000 --session cmais
bunwv sessions                       # list all running sessions
bunwv stop --session cmais           # stop a specific session
```

**Auto-shutdown**: Daemons automatically exit after 30 minutes of inactivity. Override with `--idle-timeout`:

```
bunwv start --idle-timeout 3600000   # 1 hour
bunwv start --idle-timeout 0         # never auto-shutdown
```

**Reuse detection**: If you `start` a session that's already running, it reports the existing session's URL so you know its current state:

```
$ bunwv start
Reusing existing session "default" (PID: 12345)
  URL:   http://localhost:3000/dashboard
```

**Best practice**: Always run `bunwv sessions` at the start of a testing session to check for orphaned daemons from previous conversations. Stop any you don't need.

## Core Interaction Loop

Always follow this pattern: look, then act, then look again.

1. Start the daemon if not running: `bunwv start`
2. Navigate: `bunwv navigate http://localhost:3000`
3. Screenshot: `bunwv screenshot /tmp/bunwv-screenshot.png`
4. Read the screenshot with the Read tool to see the page
5. Decide what to do (click, type, etc.)
6. Act: `bunwv click "button.submit"`
7. Screenshot again to verify the result
8. Repeat steps 4-7 as needed
9. Stop when done: `bunwv stop`

## Clicking Elements by Text

When you don't know the CSS selector, use `click-text` to click by visible text:

```
bunwv click-text "Save Changes"
bunwv click-text "Sign In"
bunwv click-text "Delete" --tag "button, a, div"
```

By default searches `button, a, [role='button'], input[type='submit']`. Use `--tag` to widen the search to other elements.

## Clearing and Editing Input Fields

IMPORTANT: Do NOT use Cmd+A / Backspace to clear React inputs — it does not reliably update React state. Use the `clear` command instead, which uses the native value setter and dispatches proper React-compatible events:

```
bunwv clear "input[name='email']"
bunwv click "input[name='email']"
bunwv type "new-value@example.com"
```

Always `clear` then `click` then `type` when editing existing input values.

## Waiting for Elements

Use `wait-for` after actions that trigger page changes (navigation, form submission, modal open):

```
bunwv click-text "Save Changes"
bunwv wait-for-gone "[role='dialog']"       # wait for modal to close
bunwv screenshot /tmp/bunwv-screenshot.png     # then screenshot

bunwv click-text "Edit"
bunwv wait-for "[role='dialog']"             # wait for modal to appear
bunwv screenshot /tmp/bunwv-screenshot.png
```

Default timeout is 10 seconds. Override with `--timeout`:

```
bunwv wait-for ".results" --timeout 30000
```

## Extracting Page Data

Use `eval` to get text content, check elements, or read form values. Statements (`const`, `let`, `var`, `if`, etc.) are auto-wrapped in an IIFE — no need to manually wrap:

```
bunwv eval "document.title"
bunwv eval "document.querySelector('h1')?.textContent"
bunwv eval "document.querySelectorAll('.error').length"
bunwv eval "const rows = document.querySelectorAll('tr'); return rows.length;"
```

## Submitting Forms

IMPORTANT: Use `submit` instead of `click-text` for form submission. `click-text` uses JS `.click()` which produces `isTrusted: false` events — many React forms ignore these. The `submit` command uses `form.requestSubmit()` which properly triggers React form handlers.

```
bunwv submit                                    # submit the first form on the page
bunwv submit --button "Save Changes"            # submit via a specific button
bunwv submit --form "form.edit-quote"            # target a specific form
bunwv submit --form "form" --button "Save"       # both
```

After submitting, use `wait-for-gone` to wait for the dialog/form to close, or `wait-for` to wait for a success message:

```
bunwv submit --button "Save Changes"
bunwv wait-for-gone "[role='dialog']"
bunwv screenshot /tmp/bunwv-screenshot.png
```

## Filling Forms

Click the input first, then type. Use Tab to move between fields:

```
bunwv click "input[name='email']"
bunwv type "user@example.com"
bunwv press Tab
bunwv type "password123"
bunwv submit --button "Sign In"
```

For credentials, use environment variables in `.env` (Bun auto-loads them). The shell expands `$VAR` in CLI args:

```
bunwv type "$TEST_EMAIL"
```

## Persistent Auth

Use `--data-store` to preserve cookies and localStorage across daemon restarts:

```
bunwv start --data-store ./bunwv-session
```

Log in once, and future sessions with the same data store stay authenticated. Note: DOM state (open modals, form inputs) only persists within a single daemon session, not across restarts.

## Error Recovery

If a command fails or times out:
1. Take a screenshot to see what the page looks like
2. Use `eval` to inspect the DOM
3. If the daemon crashed, start it again (the data store preserves auth)

## Screenshot Default

Screenshots default to `/tmp/bunwv-screenshot.png`. Use the Read tool to view them. The same path is overwritten each time, keeping the project directory clean.

## Known Limitations

- **WebKit backend only on macOS** — no visible browser window, headless only
- **`click` with CSS selector auto-waits** for actionability (visible, stable, unobscured) but times out after 10s
- **`click-text` uses JS `.click()` (isTrusted: false)** — use it for navigation links and non-form buttons. For form submission, always use `submit` instead.
- **`clear` is required for React inputs** — keyboard-based clearing (Cmd+A, Backspace) doesn't update React's internal state
- **Coordinate clicks** (`click x y`) produce native `isTrusted: true` events but require knowing exact coordinates. Use `eval` with `getBoundingClientRect()` to find them when CSS selectors don't work.
