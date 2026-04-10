# Changelog

All notable changes to this project will be documented in this file.

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
