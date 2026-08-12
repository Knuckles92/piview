# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0/).

## [0.1.0] - Unreleased

### Added

- pi extension with namespaced `/piview` command, `--piview` flag, and `piview_plan` tool
- Localhost HTTP plan UI (static files + SSE) served by the extension
- Localhost WebSocket bridge with per-session token auth (for protocol clients)
- Protocol v1 schema and docs under `protocol/`
- Open-source packaging: MIT license
- TypeScript project config and `npm run check`
- Protocol/UI smoke test (`npm test`) and GitHub Actions CI
- Plan view: outline nav, find-in-document, export/copy, clickable task checkboxes, and persistent font-size/text-width controls
- Steps view: drag reorder, multi-select bulk actions, status filters/search, progress ring, file chips, execute-from-here (`execute.fromStepId`)
- Execution dashboard step drill-down and path copy
- Execution file diff viewer: capture agent edit/write before/after, unified or side-by-side layout, open one file or all changes
- Dirty conflict prompt (Keep local / Take server), shortcuts help, toasts, remembered tab

### Changed

- Plan GUI no longer requires a separate Go companion binary; `/piview` opens the browser against the extension’s local HTTP server
- Removed `postinstall` / `build:viewer` Go build step and `PIVIEW_BIN` / `PIVIEW_SKIP_VIEWER_BUILD` env vars
- Plan-ready prompt: **Open plan GUI** is the default action; opening the GUI no longer risks starting execution. Execute requires an explicit TUI confirm or the GUI Execute button
- piview is now independent from regular plan mode: it no longer registers `/plan`, `/todos`, or `--plan`, uses namespaced context/tool identifiers, and preserves the pre-piview tool set

### Fixed

- Choosing “Open plan GUI” after a plan is proposed no longer starts execution; the agent stays in piview planning until Execute is chosen deliberately
- Active browser SSE/WebSocket connections no longer block Pi session commands such as `/new`, `/resume`, and `/reload` during extension shutdown
