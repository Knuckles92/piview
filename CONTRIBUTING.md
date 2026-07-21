# Contributing to piview

Thanks for helping improve piview. This document covers local setup, checks, and pull requests.

## Prerequisites

- [pi](https://pi.dev) (coding agent CLI)
- **Node.js** 20+ and npm
- **Go** 1.22+ (required to build the plan GUI companion)
- git

## Setup

```bash
git clone https://github.com/dtf/piview.git
cd piview
npm install
# postinstall builds the viewer when Go is available; or:
npm run build:viewer
```

Run pi with only this extension (avoids conflicting with stock plan-mode’s `--plan` flag):

```bash
pi -ne -e ./extensions/piview
```

Inside pi: `/plangui` opens the GUI; `/plan` toggles plan mode in the TUI.

Optional:

| Env | Meaning |
|-----|---------|
| `PIVIEW_BIN` | Absolute path to a `piview` binary |
| `PIVIEW_AUTO=1` | Auto-open GUI on session start |

## Scripts

| Command | Purpose |
|---------|---------|
| `npm install` | Install JS deps; postinstall tries to build the Go viewer |
| `npm run build:viewer` | Build `bin/piview` and `bin/piview-$GOOS-$GOARCH` |
| `npm run check` | TypeScript typecheck (`tsc --noEmit`) |
| `npm test` | Protocol smoke test (bridge round-trip, no GUI) |
| `npm run spike` | Fake bridge + real viewer UI (manual) |

## Project layout

```text
extensions/piview/   # pi extension (bridge, plan mode, tools)
viewer/              # Go companion + embedded web UI
protocol/            # shared schema docs
scripts/             # build, install, smoke, spike
```

Keep the TypeScript protocol types in `extensions/piview/protocol.ts` aligned with `protocol/plan.schema.json` and `viewer/internal/protocol/`.

## Pull requests

1. Branch from the default branch.
2. Keep changes focused; separate refactors from behavior changes when practical.
3. Run before opening a PR:

   ```bash
   npm run check
   npm run build:viewer
   npm test
   ```

4. Update `README.md` / `CHANGELOG.md` when user-facing behavior or install steps change.
5. Do not commit built binaries under `bin/piview*`, `node_modules/`, or local secrets.

## Publishing / tags (maintainers)

Git-first install for users:

```bash
pi install git:github.com/dtf/piview
# or pin a tag:
pi install git:github.com/dtf/piview@v0.1.0
```

After a release commit:

1. Ensure CI is green on the default branch.
2. Update `CHANGELOG.md` and bump `package.json` / `piview version` output if needed.
3. Tag annotated release: `git tag -a v0.1.0 -m "v0.1.0"` and push the tag.
4. Confirm a clean machine can `pi install git:github.com/dtf/piview@v0.1.0`, build or locate the companion, and run `/plangui`.

npm publish is optional and not required for pi git installs.

## Code of conduct

See [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
