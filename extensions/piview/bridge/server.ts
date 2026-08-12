import { createServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import { randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { ChangeStore } from "../changes.ts";
import { PROTOCOL_VERSION, isClientMessage, type ClientMessage, type ServerMessage } from "../protocol.ts";
import { createUiHub, type UiHub } from "./ui.ts";

export type ClientHandler = (msg: ClientMessage, client?: WebSocket) => void;

export interface BridgeServer {
	readonly port: number;
	readonly token: string;
	start(): Promise<void>;
	stop(reason?: string): Promise<void>;
	broadcast(msg: ServerMessage): void;
	hasClients(): boolean;
	getConnectUrl(): string;
	/** Local HTTP URL for the plan UI (same port as the bridge). */
	getUiUrl(): string;
	onClientMessage(handler: ClientHandler): void;
	onClientConnect(handler: (send: (msg: ServerMessage) => void) => void): void;
	setSessionMeta(meta: { sessionId: string; cwd: string }): void;
	/** Seed / refresh the UI's plan snapshot without requiring a WS client. */
	setPlan(state: import("../protocol.ts").PlanState): void;
	setChangeStore(store: ChangeStore | null): void;
}

interface BridgeOptions {
	sessionId?: string;
	cwd?: string;
}

export function createBridgeServer(options: BridgeOptions = {}): BridgeServer {
	let httpServer: HttpServer | undefined;
	let wss: WebSocketServer | undefined;
	let port = 0;
	const token = randomBytes(16).toString("hex");
	const clients = new Set<WebSocket>();
	let handler: ClientHandler | undefined;
	let connectHandler: ((send: (msg: ServerMessage) => void) => void) | undefined;
	let sessionId = options.sessionId ?? "unknown";
	let cwd = options.cwd ?? process.cwd();
	let started = false;
	let ui: UiHub | undefined;

	function send(ws: WebSocket, msg: ServerMessage): void {
		if (ws.readyState === ws.OPEN) {
			ws.send(JSON.stringify(msg));
		}
	}

	function ensureUi(): UiHub {
		if (!ui) {
			ui = createUiHub({
				cwd,
				onMessage: (msg) => {
					handler?.(msg);
				},
			});
		}
		return ui;
	}

	const api: BridgeServer = {
		get port() {
			return port;
		},
		get token() {
			return token;
		},

		async start() {
			if (started) return;

			ensureUi();

			httpServer = createServer((req, res) => {
				if (req.url === "/health" || req.url?.startsWith("/health?")) {
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ ok: true, clients: clients.size }));
					return;
				}
				if (ui?.handle(req, res)) return;
				res.writeHead(404);
				res.end("piview bridge");
			});

			wss = new WebSocketServer({ noServer: true });

			httpServer.on("upgrade", (req, socket, head) => {
				if (!authorize(req, token)) {
					socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
					socket.destroy();
					return;
				}
				const url = new URL(req.url ?? "/", "http://127.0.0.1");
				if (url.pathname !== "/v1") {
					socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
					socket.destroy();
					return;
				}
				wss!.handleUpgrade(req, socket, head, (ws) => {
					wss!.emit("connection", ws, req);
				});
			});

			wss.on("connection", (ws) => {
				clients.add(ws);
				send(ws, {
					v: 1,
					type: "hello",
					protocolVersion: PROTOCOL_VERSION,
					sessionId,
					cwd,
				});
				connectHandler?.((msg) => send(ws, msg));

				ws.on("message", (data) => {
					let parsed: unknown;
					try {
						parsed = JSON.parse(String(data));
					} catch {
						send(ws, { v: 1, type: "error", message: "invalid JSON" });
						return;
					}
					if (!isClientMessage(parsed)) {
						send(ws, { v: 1, type: "error", message: "invalid message" });
						return;
					}
					if (parsed.type === "ping") {
						send(ws, { v: 1, type: "pong" });
						return;
					}
					if (parsed.type === "hello_ack") {
						if (parsed.protocolVersion !== PROTOCOL_VERSION) {
							send(ws, {
								v: 1,
								type: "error",
								message: `protocol mismatch: server=${PROTOCOL_VERSION} client=${parsed.protocolVersion}`,
							});
							ws.close();
						}
						return;
					}
					handler?.(parsed, ws);
				});

				ws.on("close", () => {
					clients.delete(ws);
				});
			});

			await new Promise<void>((resolve, reject) => {
				httpServer!.listen(0, "127.0.0.1", () => resolve());
				httpServer!.once("error", reject);
			});

			const addr = httpServer.address();
			if (!addr || typeof addr === "string") {
				throw new Error("failed to bind piview bridge");
			}
			port = addr.port;
			started = true;
			ui?.setConnected(true);
			ui?.setCwd(cwd);
		},

		async stop(reason = "shutdown") {
			if (!started) return;
			api.broadcast({ v: 1, type: "goodbye", reason });
			for (const ws of clients) {
				try {
					ws.close();
				} catch {
					/* ignore */
				}
			}
			clients.clear();
			ui?.close();
			ui = undefined;

			await new Promise<void>((resolve) => {
				wss?.close(() => resolve());
				if (!wss) resolve();
			});
			await new Promise<void>((resolve) => {
				httpServer?.close(() => resolve());
				if (!httpServer) resolve();
			});
			wss = undefined;
			httpServer = undefined;
			started = false;
			port = 0;
		},

		broadcast(msg) {
			const raw = JSON.stringify(msg);
			for (const ws of clients) {
				if (ws.readyState === ws.OPEN) ws.send(raw);
			}
			ui?.onBroadcast(msg);
		},

		hasClients() {
			if (ui?.hasSubscribers()) return true;
			for (const ws of clients) {
				if (ws.readyState === ws.OPEN) return true;
			}
			return false;
		},

		getConnectUrl() {
			if (!started || !port) throw new Error("bridge not started");
			return `ws://127.0.0.1:${port}/v1?token=${token}`;
		},

		getUiUrl() {
			if (!started || !port) throw new Error("bridge not started");
			return `http://127.0.0.1:${port}/`;
		},

		onClientMessage(h) {
			handler = h;
		},

		onClientConnect(h) {
			connectHandler = h;
		},

		setSessionMeta(meta) {
			sessionId = meta.sessionId;
			cwd = meta.cwd;
			ui?.setCwd(cwd);
		},

		setPlan(state) {
			ensureUi().setPlan(state);
		},

		setChangeStore(store) {
			ensureUi().setChangeStore(store);
		},
	};

	return api;
}

function authorize(req: IncomingMessage, token: string): boolean {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	const q = url.searchParams.get("token");
	if (q && q === token) return true;
	const auth = req.headers.authorization;
	if (auth?.startsWith("Bearer ") && auth.slice(7) === token) return true;
	return false;
}
