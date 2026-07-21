#!/usr/bin/env node
/**
 * Automated smoke: extension bridge module + ws client round-trip.
 */
import { createBridgeServer } from "../extensions/piview/bridge/server.ts";
import { emptyPlanState, applyOps, createStepsFromTitles } from "../extensions/piview/state.ts";
import { ensurePlanMarkdown } from "../viewer/web/markdown.js";
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
console.log("bridge", url);

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
