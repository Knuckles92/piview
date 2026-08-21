# piview

A plan board for [pi](https://pi.dev) — so you can see the work, not just scroll through it.

When a coding agent is planning a multi-step change, the terminal is great for the conversation and a poor place to *hold* the plan. piview keeps pi’s TUI as home base, and gives the plan its own window: readable document, editable steps, live progress.

Type **`/piview`**. A local browser window opens beside your session. The agent writes structured plans; you can reorder steps, tweak wording, kick off execute/refine, and watch files and tools move as work lands. Close the window whenever — the session never left the terminal.

```
pi TUI  ←→  extension (HTTP UI + WS bridge + piview planning)  ←→  browser (app mode)
```

## Screenshots

Plan document with outline nav, checklist, and progress — mock “Checkout API hardening” session:

![Plan view](docs/screenshots/plan.png)

Steps editor with status filters, drag reorder, file chips, and step detail:

![Steps view](docs/screenshots/steps.png)

Live execution dashboard with metrics, file edits, and tool activity:

![Execution dashboard](docs/screenshots/execution.png)

## What you get

- A real plan surface — outline, checklist, and progress in one place, not a wall of markdown in the scrollback
- Steps you can actually work with — filter, reorder, edit detail, bulk-update status, then apply back into pi
- Execution you can follow — which step is running, what got edited, what tools fired
- The same session, two views — TUI stays primary; the GUI is optional and local-only
- Agent-native planning — namespaced `piview_plan` tool + structured state
- Independent from Pi’s regular plan mode — piview does not register `/plan`, `/todos`, or `--plan`

### Commands & pieces

- `/piview` or `/piview open` — enable piview planning + open/focus the GUI
- `/piview on` — enable piview planning without opening the GUI
- `/piview off` — leave piview planning and restore the prior tool set
- `/piview close` — close only the GUI bridge
- `/piview todos` — show piview progress in the TUI
- Structured plan state (not only markdown scraping)
- `piview_plan` tool for the model
- Edit steps in the GUI → apply back into pi
- Execute / Refine from the GUI
- TUI status + checklist widget fallback
- Localhost-only HTTP UI + WebSocket bridge with token auth

## Prerequisites

- [pi](https://pi.dev)
- **Node.js** 20+

## Install (pi package)

From git (recommended):

```bash
pi install git:github.com/Knuckles92/piview
# or:
pi install https://github.com/Knuckles92/piview
# pin a release tag when available:
# pi install git:github.com/Knuckles92/piview@v0.1.0
```

`pi install` runs `npm install` for the package. No native toolchain is required — the plan UI is served from the Node extension and opened in your browser.

### Coexisting with regular plan mode

piview has its own namespace and can be installed alongside the stock `plan-mode` extension:

- `/plan` and `--plan` belong to regular plan mode
- `/piview` and `--piview` belong to this extension
- TUI indicators are labeled separately as `plan` and `piview`

Use one planning workflow at a time. If regular plan mode is already restricting tools, piview preserves that prior tool set rather than overriding it.

## Quick start (from a clone)

```bash
git clone https://github.com/Knuckles92/piview.git
cd piview
npm install

pi -e ./extensions/piview
```

Inside pi:

```text
/piview
```

### CLI flag (extension)

- `--piview` — start piview planning and open the GUI

### Environment

| Env | Meaning |
|-----|---------|
| `PIVIEW_AUTO=1` | Auto-open GUI on session start |
| `PIVIEW_BROWSER_MODE=app` | Open the GUI as a dedicated chromeless app window (default: new tab in your default browser) |

## Spike (no pi required)

```bash
npm run spike
```

Opens the UI against a fake bridge so you can verify edit/apply/execute messages.

## Protocol

See [`protocol/README.md`](./protocol/README.md) and [`protocol/plan.schema.json`](./protocol/plan.schema.json).

- Extension = HTTP server on `127.0.0.1` (static UI + SSE `/api/*` + WebSocket `/v1`)
- Browser loads the UI over HTTP and streams plan updates via EventSource
- WebSocket remains available for external protocol clients (token required)

## Layout

```text
extensions/piview/   # pi extension (bridge, piview workflow, tools, web UI)
  bridge/            # HTTP + WS server, browser opener
  web/               # piview GUI (HTML/CSS/JS)
protocol/            # shared schema
scripts/             # smoke + spike
```

## Security

- Bridge binds `127.0.0.1` only
- Random per-session token required on WS connect
- UI is localhost-only (same trust model as the terminal)

Report security issues via [GitHub Advisories](https://github.com/Knuckles92/piview/security/advisories) on this repository.

## Troubleshooting

### `/piview` could not open a browser

1. Confirm a browser is installed and available on `PATH`.
2. The notify toast includes the UI URL — open it manually if auto-launch fails.
3. Retry `/piview`. Piview planning via `/piview on` still works in the TUI without the GUI.

## Development

```bash
npm run check          # TypeScript typecheck
npm test               # bridge protocol + UI smoke test
npm run spike          # fake bridge + open UI
```

## Status

MVP: companion open/edit/execute path works. The plan UI is a local web app opened in an app-mode browser window (Chrome/Chromium when available).

## Credits

piview is built for [pi](https://pi.dev), the open-source coding agent by [earendil-works](https://github.com/earendil-works). Source: [github.com/earendil-works/pi](https://github.com/earendil-works/pi).

## License

[MIT](./LICENSE)
