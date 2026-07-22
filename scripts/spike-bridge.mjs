#!/usr/bin/env node
/**
 * Phase-0 spike: start the extension bridge+UI server with a fake plan, open the browser.
 * Usage: node scripts/spike-bridge.mjs
 */
import { createBridgeServer } from "../extensions/piview/bridge/server.ts";
import { openBrowser } from "../extensions/piview/bridge/open.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const executionStartedAt = Date.now() - 92_000;
const state = {
  v: 1,
  mode: "executing",
  title: "Execution dashboard spike",
  cwd: root,
  sessionId: "spike",
  updatedAt: Date.now(),
  markdown: `# Execution dashboard spike

Fake bridge plan so you can inspect the live **Steps** execution dashboard, then try the Plan tab editor after switching back to planning mode.

## Approach

Drive the companion UI without pi; edits come back as plan_replace messages on this process.

1. [x] **Scaffold package**
   Repo layout and package metadata
2. [ ] **Wire HTTP UI bridge**
   Token auth on localhost WS + SSE UI
3. [ ] **Open plan UI in browser**
   App-mode browser window
4. [ ] **Edit steps and apply back**
   Plan-tab markdown editor + Steps checklist
`,
  activeStepId: "s2",
  steps: [
    { id: "s1", step: 1, title: "Scaffold package", status: "done" },
    { id: "s2", step: 2, title: "Wire execution telemetry", status: "active" },
    { id: "s3", step: 3, title: "Render dashboard cards", status: "pending" },
    { id: "s4", step: 4, title: "Verify responsive layout", status: "pending" },
  ],
  execution: {
    startedAt: executionStartedAt,
    updatedAt: Date.now(),
    toolCallsStarted: 3,
    toolCallsCompleted: 2,
    toolCallsFailed: 0,
    activities: [
      { toolCallId: "read-app", toolName: "read", summary: "read extensions/piview/web/app.js", path: "extensions/piview/web/app.js", status: "completed", startedAt: executionStartedAt + 1_000, endedAt: executionStartedAt + 1_300 },
      { toolCallId: "edit-html", toolName: "edit", summary: "edit extensions/piview/web/index.html", path: "extensions/piview/web/index.html", status: "completed", startedAt: executionStartedAt + 1_500, endedAt: executionStartedAt + 1_900 },
      { toolCallId: "edit-css", toolName: "edit", summary: "edit extensions/piview/web/styles.css", path: "extensions/piview/web/styles.css", status: "running", startedAt: executionStartedAt + 2_300 },
    ],
    files: [{ path: "extensions/piview/web/index.html", operation: "edit", count: 1, updatedAt: executionStartedAt + 1_900 }],
  },
};

const bridge = createBridgeServer({ sessionId: "spike", cwd: root });

bridge.onClientMessage((msg) => {
  console.log("← client", msg.type, msg.type === "plan_replace" ? `(${msg.state?.steps?.length} steps)` : "");
  if (msg.type === "plan_replace") {
    Object.assign(state, msg.state, { v: 1, updatedAt: Date.now() });
    bridge.broadcast({ v: 1, type: "plan_state", state });
    console.log("plan updated:", state.steps.map((s) => s.title).join(" | "));
  }
  if (msg.type === "execute") console.log("execute requested", msg.fromStepId ?? "(from start)");
  if (msg.type === "refine") console.log("refine:", msg.text);
});

await bridge.start();
bridge.setPlan(state);

const uiUrl = bridge.getUiUrl();
console.log("UI", uiUrl);
console.log("WS", bridge.getConnectUrl());

const opened = await openBrowser(uiUrl, "piview spike");
if (!opened) {
  console.warn("Could not auto-open a browser — open the UI URL manually.");
} else {
  console.log("Opened browser.");
}

// Fake a tool completion shortly after open so the dashboard updates live.
setTimeout(() => {
  const now = Date.now();
  const activity = state.execution.activities.find((item) => item.toolCallId === "edit-css");
  if (activity) Object.assign(activity, { status: "completed", endedAt: now });
  state.execution.toolCallsCompleted += 1;
  state.execution.updatedAt = now;
  state.execution.files.push({ path: "extensions/piview/web/styles.css", operation: "edit", count: 1, updatedAt: now });
  bridge.broadcast({ v: 1, type: "activity", toolCallId: "edit-css", toolName: "edit", phase: "end" });
  bridge.broadcast({ v: 1, type: "plan_state", state });
}, 1_500);

console.log("Edit the plan in the UI, click Apply edits — watch this terminal.");
console.log("Ctrl+C to stop.");

process.on("SIGINT", async () => {
  await bridge.stop("spike interrupt");
  process.exit(0);
});
