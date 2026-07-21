#!/usr/bin/env node
/**
 * Phase-0 spike: start bridge, push a fake plan, spawn piview.
 * Usage: node scripts/spike-bridge.mjs
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const binCandidates = [
  process.env.PIVIEW_BIN,
  join(root, "bin/piview"),
  join(root, "bin/piview-darwin-arm64"),
].filter(Boolean);

const bin = binCandidates.find((p) => existsSync(p));
if (!bin) {
  console.error("piview binary not found — run npm run build:viewer first");
  process.exit(1);
}

const token = randomBytes(16).toString("hex");
const state = {
  v: 1,
  mode: "planning",
  title: "Spike plan",
  cwd: root,
  sessionId: "spike",
  updatedAt: Date.now(),
  markdown: `# Spike plan

Fake bridge plan so you can try the **Plan** tab editor (Edit / Split, paste screenshots, Apply).

## Approach

Drive the companion UI without pi; edits come back as plan_replace messages on this process.

1. [x] **Scaffold package**
   Repo layout and package metadata
2. [ ] **Wire WS bridge**
   Token auth on localhost
3. [ ] **Open Go companion UI**
   Embedded web UI in app-mode browser
4. [ ] **Edit steps and apply back**
   Plan-tab markdown editor + Steps checklist
`,
  steps: [
    { id: "s1", step: 1, title: "Scaffold package", status: "done" },
    { id: "s2", step: 2, title: "Wire WS bridge", status: "active" },
    { id: "s3", step: 3, title: "Open Go companion UI", status: "pending" },
    { id: "s4", step: 4, title: "Edit steps and apply back", status: "pending" },
  ],
};

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.searchParams.get("token") !== token || url.pathname !== "/v1") {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
});

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ v: 1, type: "hello", protocolVersion: 1, sessionId: "spike", cwd: root }));
  ws.send(JSON.stringify({ v: 1, type: "plan_state", state }));
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    console.log("← client", msg.type, msg.type === "plan_replace" ? `(${msg.state?.steps?.length} steps)` : "");
    if (msg.type === "ping") ws.send(JSON.stringify({ v: 1, type: "pong" }));
    if (msg.type === "plan_replace") {
      Object.assign(state, msg.state, { v: 1, updatedAt: Date.now() });
      for (const c of clients) c.send(JSON.stringify({ v: 1, type: "plan_state", state }));
      console.log("plan updated:", state.steps.map((s) => s.title).join(" | "));
    }
    if (msg.type === "execute") console.log("execute requested");
    if (msg.type === "refine") console.log("refine:", msg.text);
  });
  ws.on("close", () => clients.delete(ws));
});

await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
const { port } = httpServer.address();
const wsUrl = `ws://127.0.0.1:${port}/v1?token=${token}`;
console.log("bridge", wsUrl);

const child = spawn(bin, ["open", "--ws", wsUrl, "--title", "piview spike", "--cwd", root], {
  stdio: "inherit",
});

console.log("spawned", bin, "pid", child.pid);
console.log("Edit the plan in the UI, click Apply edits — watch this terminal.");
console.log("Ctrl+C to stop.");

process.on("SIGINT", () => {
  child.kill("SIGTERM");
  httpServer.close();
  process.exit(0);
});

child.on("exit", (code) => {
  console.log("viewer exited", code);
  httpServer.close();
  process.exit(code ?? 0);
});
