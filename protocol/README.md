# piview protocol v1

Language-agnostic JSON protocol between the pi extension (server) and the Go companion (client).

## Transport

- WebSocket on `127.0.0.1` only
- URL: `ws://127.0.0.1:<port>/v1?token=<token>`
- Token required on connect (query param)
- One logical session per bridge; multiple clients allowed (broadcast)

## Version negotiation

1. Server sends `hello` with `protocolVersion: 1`
2. Client replies `hello_ack` with its `protocolVersion`
3. On mismatch: client exits; server notifies TUI

## Canonical state

The extension owns canonical `PlanState`. The GUI may edit locally and commit via `plan_ops` or `plan_replace`.

During execution, the optional `PlanState.execution` object carries a bounded activity and successful-file-edit history so reconnecting viewers can render live metrics. Progress remains `(done + skipped) / total`; failed steps are reported separately and do not count as complete.

`execute` may include optional `fromStepId` so the GUI can start a run at a selected step. Earlier unfinished steps are marked `skipped`; the target becomes `active`.

Dirty policy (v1):

- GUI applies local edits immediately in the UI
- GUI sends `plan_ops` (debounced) or `plan_replace`
- Server applies, persists, broadcasts fresh `plan_state`
- If a server `plan_state` arrives while GUI is dirty, GUI prompts: Keep local / Take server

## Message envelope

All messages are a single JSON object with at least:

```json
{ "v": 1, "type": "<message type>" }
```

## Types

See `plan.schema.json` for full definitions.
