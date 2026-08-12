#!/usr/bin/env node
/**
 * Automated smoke: extension bridge module + ws client round-trip.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridgeServer } from "../extensions/piview/bridge/server.ts";
import { ChangeStore } from "../extensions/piview/changes.ts";
import {
  applyOps,
  beginExecutionTelemetry,
  createStepsFromTitles,
  emptyPlanState,
  recordExecutionToolEnd,
  recordExecutionToolStart,
} from "../extensions/piview/state.ts";
import { executionDashboardModel, formatDuration } from "../extensions/piview/web/execution-dashboard.js";
import { ensurePlanMarkdown, parseOutline, renderMarkdown } from "../extensions/piview/web/markdown.js";
import WebSocket from "ws";

const bridge = createBridgeServer({ sessionId: "smoke", cwd: process.cwd() });
let gotOps = false;

const authoredMarkdown = "# Release plan\n\nKeep this context and rationale.\n";
const editedPlan = { markdown: authoredMarkdown, steps: [{ step: 1, title: "Edited step", status: "pending" }] };
if (ensurePlanMarkdown(editedPlan) !== authoredMarkdown) {
  throw new Error("applying step edits must preserve authored plan markdown");
}
if (!ensurePlanMarkdown({ title: "Step-only plan", steps: editedPlan.steps }).startsWith("# Step-only plan")) {
  throw new Error("step-only plans must receive synthesized markdown");
}

const outlineMd = "# Title\n\n## Section\n\n```\n# ignored\n```\n\n### Detail\n\n## Dup\n\n## Dup\n";
const outline = parseOutline(outlineMd);
if (
  outline.length !== 5 ||
  outline[0].id !== "title" ||
  outline[1].id !== "section" ||
  outline[2].level !== 3 ||
  outline[4].id !== "dup-2"
) {
  throw new Error("parseOutline must collect unique H1–H3 ids and skip code fences");
}
const outlineHtml = renderMarkdown(outlineMd);
for (const item of outline) {
  if (!outlineHtml.includes(`id="${item.id}"`)) {
    throw new Error(`renderMarkdown must emit outline id ${item.id}`);
  }
}

let telemetryState = beginExecutionTelemetry(
  emptyPlanState({
    mode: "executing",
    steps: [
      { id: "done", step: 1, title: "Scaffold", status: "done" },
      { id: "skip", step: 2, title: "No longer needed", status: "skipped" },
      { id: "active", step: 3, title: "Build dashboard", status: "active" },
      { id: "failed", step: 4, title: "Check edge case", status: "failed" },
    ],
    activeStepId: "active",
  }),
  1_000,
);
telemetryState = recordExecutionToolStart(telemetryState, { toolCallId: "edit-1", toolName: "edit", path: "extensions/piview/web/app.js" }, 1_100);
telemetryState = recordExecutionToolEnd(
  telemetryState,
  { toolCallId: "edit-1", toolName: "edit", diff: { additions: 3, deletions: 1, hasDiff: true } },
  1_200,
);
telemetryState = recordExecutionToolStart(telemetryState, { toolCallId: "write-1", toolName: "write", path: "extensions/piview/web/app.js" }, 1_300);
telemetryState = recordExecutionToolEnd(telemetryState, { toolCallId: "write-1", toolName: "write", isError: true }, 1_400);
if (telemetryState.execution?.toolCallsCompleted !== 2 || telemetryState.execution.toolCallsFailed !== 1) {
  throw new Error("execution telemetry must count completed and failed tools");
}
if (telemetryState.execution.files.length !== 1 || telemetryState.execution.files[0].count !== 1) {
  throw new Error("only successful edit/write calls should become changed-file metrics");
}
if (
  telemetryState.execution.files[0].additions !== 3 ||
  telemetryState.execution.files[0].deletions !== 1 ||
  telemetryState.execution.files[0].hasDiff !== true
) {
  throw new Error("execution file metrics must retain diff stats");
}
const dashboard = executionDashboardModel(telemetryState, 61_000);
if (dashboard.percent !== 50 || dashboard.changedFiles !== 1 || dashboard.counts.failed !== 1 || dashboard.activeStep?.id !== "active") {
  throw new Error("dashboard metrics must include skipped progress and failed-step visibility");
}
if (formatDuration(dashboard.elapsedMs) !== "1m 0s" || !dashboard.summary.includes("Working on step 3")) {
  throw new Error("dashboard summary and duration must describe active execution");
}
const legacyDashboard = executionDashboardModel({ v: 1, mode: "executing", steps: [], updatedAt: 0 });
if (legacyDashboard.toolCallsStarted !== 0 || legacyDashboard.elapsedMs !== null) {
  throw new Error("older plans without telemetry must render safe dashboard defaults");
}

const changeDir = mkdtempSync(join(tmpdir(), "piview-changes-"));
const changeFile = join(changeDir, "sample.txt");
writeFileSync(changeFile, "one\ntwo\n", "utf8");
const store = new ChangeStore();
store.configure(changeDir, "smoke-session");
store.captureBefore("t1", "sample.txt");
writeFileSync(changeFile, "one\ntwo\nthree\n", "utf8");
const diffStats = store.commitAfter("t1", "edit");
if (!diffStats?.hasDiff || diffStats.additions < 1) {
  throw new Error("change store must capture cumulative line additions");
}
const listed = store.list();
if (listed.length !== 1 || listed[0].path !== "sample.txt" || !listed[0].hunks.length) {
  throw new Error("change store must expose hunks for captured edits");
}
store.clear();
rmSync(changeDir, { recursive: true, force: true });

bridge.onClientMessage((msg) => {
  if (msg.type === "plan_ops") {
    gotOps = true;
    const next = applyOps(
      {
        ...emptyPlanState({ mode: "planning", sessionId: "smoke", cwd: process.cwd() }),
        steps: createStepsFromTitles(["A", "B"]),
      },
      msg.ops,
    );
    bridge.broadcast({ v: 1, type: "plan_state", state: next });
  }
  if (msg.type === "execute") {
    console.log("execute ok");
  }
});

await bridge.start();
const url = bridge.getConnectUrl();
const uiUrl = bridge.getUiUrl();
console.log("bridge", url);
console.log("ui", uiUrl);

// HTTP UI probes
const health = await fetch(new URL("/health", uiUrl));
if (!health.ok) throw new Error("health check failed");
bridge.setPlan(emptyPlanState({ mode: "planning", sessionId: "smoke", cwd: process.cwd() }));
const stateRes = await fetch(new URL("/api/state", uiUrl));
if (!stateRes.ok) throw new Error("/api/state failed");
const stateJson = await stateRes.json();
if (stateJson.mode !== "planning") throw new Error("/api/state returned unexpected mode");

const indexRes = await fetch(uiUrl);
if (!indexRes.ok || !(await indexRes.text()).includes("piview")) {
  throw new Error("UI index.html not served");
}

const changesRes = await fetch(new URL("/api/changes", uiUrl));
if (!changesRes.ok) throw new Error("/api/changes failed");
const changesJson = await changesRes.json();
if (!Array.isArray(changesJson.changes)) {
  throw new Error("/api/changes must return a changes array");
}

const ws = new WebSocket(url);
const events = [];

await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("timeout")), 5000);
  ws.on("open", () => {
    ws.send(JSON.stringify({ v: 1, type: "hello_ack", protocolVersion: 1, client: "smoke" }));
  });
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    events.push(msg.type);
    if (msg.type === "hello") {
      ws.send(
        JSON.stringify({
          v: 1,
          type: "plan_ops",
          ops: [{ op: "add", title: "From smoke" }],
        }),
      );
      ws.send(JSON.stringify({ v: 1, type: "execute" }));
    }
    if (msg.type === "plan_state" && gotOps) {
      clearTimeout(t);
      resolve();
    }
  });
  ws.on("error", reject);
});

ws.close();
await bridge.stop("smoke done");

if (!events.includes("hello")) throw new Error("missing hello");
if (!gotOps) throw new Error("missing plan_ops handling");
console.log("smoke ok:", events.join(" → "));
