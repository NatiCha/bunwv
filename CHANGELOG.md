# Changelog

All notable changes to this project will be documented in this file.

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
