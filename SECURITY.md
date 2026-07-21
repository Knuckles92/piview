# Security Policy

## What piview does

piview is a local companion for [pi](https://pi.dev):

- The TypeScript extension runs inside your pi process with full session access.
- It opens a WebSocket **server** bound to `127.0.0.1` only.
- Clients must present a random per-session token (`ws://127.0.0.1:<port>/v1?token=…`).
- The Go companion is a local process that connects as a WebSocket client and serves an embedded HTML UI on localhost.

Treat piview like the terminal: anything that can reach your user session can influence plan state and trigger agent actions (execute / refine).

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security reports.

Prefer one of:

1. GitHub Security Advisories (“Report a vulnerability”) on this repository, if enabled
2. A private contact method listed in the repository profile or latest release notes

Include:

- Affected version or commit
- Description of the issue and impact
- Steps to reproduce or a proof of concept
- Any suggested fix

We will acknowledge reports when possible and coordinate disclosure after a fix is available.

## Non-goals / expected trust model

- piview is **not** a multi-user or network service. Do not expose the bridge or UI port beyond localhost.
- Installing third-party pi packages runs arbitrary code. Review source before `pi install`.
- The companion binary is local malware surface equivalent to any other user-installed tool; prefer building from source or verifying release checksums when prebuilt binaries are offered.
