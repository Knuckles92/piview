# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0/).

## [0.1.0] - Unreleased

### Added

- pi extension with `/plangui`, `/plan`, `/todos`, and `update_plan` tool
- Localhost HTTP plan UI (static files + SSE) served by the extension
- Localhost WebSocket bridge with per-session token auth (for protocol clients)
- Protocol v1 schema and docs under `protocol/`
- Open-source packaging: MIT license
- TypeScript project config and `npm run check`
- Protocol/UI smoke test (`npm test`) and GitHub Actions CI
- Plan view: outline nav, find-in-document, export/copy, clickable task checkboxes
- Steps view: drag reorder, multi-select bulk actions, status filters/search, progress ring, file chips, execute-from-here (`execute.fromStepId`)
- Execution dashboard step drill-down and path copy
- Dirty conflict prompt (Keep local / Take server), shortcuts help, toasts, remembered tab

### Changed

- Plan GUI no longer requires a separate Go companion binary; `/plangui` opens the browser against the extension’s local HTTP server
- Removed `postinstall` / `build:viewer` Go build step and `PIVIEW_BIN` / `PIVIEW_SKIP_VIEWER_BUILD` env vars
