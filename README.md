# piview

Plan-mode GUI companion for [pi](https://pi.dev).

Use **pi’s TUI normally**. Run **`/plangui`** to open a long-lived plan viewer window with formatting and editing tools. The same session stays in the terminal.

```
pi TUI  ←→  extension (WS bridge + plan mode)  ←→  piview (Go companion)
```

## Features

- `/plangui` — enable plan mode + open/focus the Go companion
- `/plan` — toggle plan mode without the GUI
- `/todos` — show plan progress in the TUI
- Structured plan state (not only markdown scraping)
- `update_plan` tool for the model
- Edit steps in the GUI → apply back into pi
- Execute / Refine from the GUI
- TUI status + checklist widget fallback
- Localhost-only WebSocket + token auth

## Prerequisites

- [pi](https://pi.dev)
- **Node.js** 20+
- **Go** 1.22+ to build the plan GUI companion (TUI plan mode works without it; `/plangui` needs the binary)

## Install (pi package)

From git (recommended):

```bash
pi install git:github.com/dtf/piview
# or:
pi install https://github.com/dtf/piview
# pin a release tag when available:
# pi install git:github.com/dtf/piview@v0.1.0
```

`pi install` runs `npm install` for the package. A **postinstall** script builds the Go companion when `go` is on your `PATH`. If Go is missing, install it and run:

```bash
# from the installed package directory, or from a clone:
npm run build:viewer
```

Or point at a binary you already built:

```bash
export PIVIEW_BIN=/absolute/path/to/piview
```

### Conflict with stock plan-mode

piview is a plan-mode replacement and registers the same `--plan` flag. If you already installed `plan-mode` under `~/.pi/agent/extensions/` (or as another package), either:

- run with `--no-extensions` / `-ne` and load only piview, or
- remove/disable the other plan-mode extension

Otherwise pi fails with `Flag "--plan" conflicts`.

## Quick start (from a clone)

```bash
git clone https://github.com/dtf/piview.git
cd piview
npm install
npm run build:viewer   # if postinstall skipped (no Go at install time)

# Use -ne so stock plan-mode is not also loaded.
pi -ne -e ./extensions/piview
```

Inside pi:

```text
/plangui
```

### CLI flags (extension)

- `--plan` — start in plan mode
- `--plangui` — start in plan mode and open the GUI

### Environment

| Env | Meaning |
|-----|---------|
| `PIVIEW_BIN` | Absolute path to the `piview` binary |
| `PIVIEW_AUTO=1` | Auto-open GUI on session start |
| `PIVIEW_SKIP_VIEWER_BUILD=1` | Skip postinstall / install-viewer build |

## Spike (no pi required)

```bash
npm run build:viewer
npm run spike
```

Opens the UI against a fake bridge so you can verify edit/apply/execute messages.

## Protocol

See [`protocol/README.md`](./protocol/README.md) and [`protocol/plan.schema.json`](./protocol/plan.schema.json).

- Extension = WebSocket **server** on `127.0.0.1`
- Go companion = WebSocket **client**
- Go also serves an embedded HTML UI on a local port and opens it (Chrome app mode when available)

## Commands in the viewer binary

```text
piview open  --ws <url> [--title t] [--cwd dir]
piview focus [--ws <url>]
piview quit
piview version
piview protocol-version
```

## Layout

```text
extensions/piview/   # pi extension (bridge, plan mode, tools)
viewer/              # Go companion + embedded web UI
protocol/            # shared schema
bin/                 # built binaries (gitignored)
scripts/             # build, install, smoke, spike
```

## Security

- Bridge binds `127.0.0.1` only
- Random per-session token required on WS connect
- Companion is a local process; treat it like the terminal

Details and vulnerability reporting: [SECURITY.md](./SECURITY.md).

## Troubleshooting

### `/plangui` says it could not open piview

1. Confirm Go is installed: `go version` (1.22+).
2. From the package/clone root: `npm run build:viewer`.
3. Check that `bin/piview` (or `bin/piview-$GOOS-$GOARCH`) exists.
4. Or set `PIVIEW_BIN` to the absolute path of a working binary.
5. Retry `/plangui`. Plan mode via `/plan` still works in the TUI without the GUI.

### Flag `"--plan" conflicts`

Another extension already registered `--plan`. Use `pi -ne -e …/piview` or disable the other plan-mode package. See [Install](#install-pi-package).

### postinstall skipped the viewer build

Expected when Go is not installed or `PIVIEW_SKIP_VIEWER_BUILD=1`. Build manually with `npm run build:viewer`.

## Development

```bash
npm run check          # TypeScript typecheck
npm test               # bridge protocol smoke test
npm run build:viewer   # Go companion
```

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Status

MVP: companion open/edit/execute path works. Full Wails native shell is deferred — current UI is embedded web in an app-mode browser window driven by the Go process (single-instance, focus, quit).

## License

[MIT](./LICENSE)
