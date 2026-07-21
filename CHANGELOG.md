# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

### Added

- pi extension with `/plangui`, `/plan`, `/todos`, and `update_plan` tool
- Localhost WebSocket bridge with per-session token auth
- Go companion (`piview`) serving embedded plan UI (open / focus / quit)
- Protocol v1 schema and docs under `protocol/`
- Open-source packaging: MIT license, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT
- `postinstall` viewer build when Go is available (`scripts/install-viewer.sh`)
- TypeScript project config and `npm run check`
- Protocol smoke test (`npm test`) and GitHub Actions CI
