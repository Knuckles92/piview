/**
 * Local plan UI: static files, SSE event stream, and /api/* handlers.
 * Ported from the former Go companion (viewer/internal/ui).
 */

import { randomBytes } from "node:crypto";
import {
	createReadStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChangeStore } from "../changes.ts";
import type { ClientMessage, PlanState, ServerMessage } from "../protocol.ts";

const MAX_ASSET_BYTES = 5 << 20; // 5 MiB
const WEB_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "web");

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".json": "application/json",
};

const ALLOWED_IMAGE: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/jpg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
};

export type UiMessageHandler = (msg: ClientMessage) => void | Promise<void>;

export interface UiHub {
	setCwd(cwd: string): void;
	setPlan(state: PlanState): void;
	setConnected(ok: boolean): void;
	setChangeStore(store: ChangeStore | null): void;
	/** Fan out a bridge ServerMessage to SSE subscribers. */
	onBroadcast(msg: ServerMessage): void;
	/** True when at least one browser EventSource is connected. */
	hasSubscribers(): boolean;
	/** Handle an HTTP request. Returns true if handled. */
	handle(req: IncomingMessage, res: ServerResponse): boolean;
	close(): void;
}

export function createUiHub(opts: {
	onMessage: UiMessageHandler;
	cwd?: string;
}): UiHub {
	let cwd = opts.cwd ?? "";
	let plan: PlanState = {
		v: 1,
		mode: "off",
		steps: [],
		updatedAt: Date.now(),
	};
	let connected = true;
	let tempAssetDir = "";
	let changeStore: ChangeStore | null = null;
	const subs = new Set<(chunk: string) => void>();
	const eventStreams = new Map<ServerResponse, () => void>();

	function emit(event: string, payload: unknown): void {
		const data = JSON.stringify(payload);
		const msg = `event: ${event}\ndata: ${data}\n\n`;
		for (const send of subs) {
			try {
				send(msg);
			} catch {
				/* ignore broken subscriber */
			}
		}
	}

	function assetDir(): { dir: string; workspaceRelative: boolean } {
		const trimmed = cwd.trim();
		if (trimmed) {
			const dir = join(trimmed, ".piview", "assets");
			mkdirSync(dir, { recursive: true });
			return { dir, workspaceRelative: true };
		}
		if (!tempAssetDir) {
			tempAssetDir = mkdtempSync(join(tmpdir(), "piview-assets-"));
		}
		return { dir: tempAssetDir, workspaceRelative: false };
	}

	async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
		const chunks: Buffer[] = [];
		let total = 0;
		for await (const chunk of req) {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			total += buf.length;
			if (total > limit) {
				throw new Error("body too large");
			}
			chunks.push(buf);
		}
		return Buffer.concat(chunks);
	}

	function writeJson(res: ServerResponse, status: number, body: unknown): void {
		const raw = JSON.stringify(body);
		res.writeHead(status, {
			"content-type": "application/json",
			"content-length": Buffer.byteLength(raw),
		});
		res.end(raw);
	}

	function serveStatic(req: IncomingMessage, res: ServerResponse, urlPath: string): void {
		let rel = decodeURIComponent(urlPath.split("?")[0] || "/");
		if (rel === "/") rel = "/index.html";
		// Prevent path traversal
		const clean = resolve(WEB_ROOT, "." + rel);
		if (!clean.startsWith(WEB_ROOT + sep) && clean !== WEB_ROOT) {
			res.writeHead(404);
			res.end("not found");
			return;
		}
		if (!existsSync(clean) || !statSync(clean).isFile()) {
			res.writeHead(404);
			res.end("not found");
			return;
		}
		const ext = extname(clean).toLowerCase();
		const ct = MIME[ext] ?? "application/octet-stream";
		res.writeHead(200, { "content-type": ct });
		if (req.method === "HEAD") {
			res.end();
			return;
		}
		createReadStream(clean).pipe(res);
	}

	function handleEvents(req: IncomingMessage, res: ServerResponse): void {
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});

		const send = (chunk: string) => {
			res.write(chunk);
		};
		subs.add(send);

		// Initial snapshot
		send(`event: state\ndata: ${JSON.stringify(plan)}\n\n`);
		send(`event: conn\ndata: ${JSON.stringify({ connected, cwd })}\n\n`);

		const ping = setInterval(() => {
			try {
				res.write(": ping\n\n");
			} catch {
				/* closed */
			}
		}, 15_000);

		let cleanedUp = false;
		const cleanup = () => {
			if (cleanedUp) return;
			cleanedUp = true;
			clearInterval(ping);
			subs.delete(send);
			eventStreams.delete(res);
		};
		eventStreams.set(res, cleanup);
		req.once("close", cleanup);
		res.once("close", cleanup);
	}

	async function handleReplace(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			const raw = await readBody(req, 8 << 20);
			const body = JSON.parse(raw.toString("utf8")) as { state?: PlanState };
			if (!body.state || typeof body.state !== "object") {
				writeJson(res, 400, { error: "missing state" });
				return;
			}
			const state: PlanState = { ...body.state, v: 1 };
			// Handler publish() broadcasts the canonical plan_state back to SSE.
			await opts.onMessage({ v: 1, type: "plan_replace", state });
			writeJson(res, 200, { ok: true });
		} catch (err) {
			writeJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
		}
	}

	async function handleExecute(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			let fromStepId: string | undefined;
			try {
				const raw = await readBody(req, 64 << 10);
				if (raw.length) {
					const body = JSON.parse(raw.toString("utf8")) as { fromStepId?: string };
					fromStepId = body.fromStepId;
				}
			} catch {
				/* empty body ok */
			}
			await opts.onMessage({ v: 1, type: "execute", fromStepId });
			writeJson(res, 200, { ok: true });
		} catch (err) {
			writeJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
		}
	}

	async function handleRefine(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			const raw = await readBody(req, 1 << 20);
			const body = JSON.parse(raw.toString("utf8")) as { text?: string };
			if (typeof body.text !== "string") {
				writeJson(res, 400, { error: "missing text" });
				return;
			}
			await opts.onMessage({ v: 1, type: "refine", text: body.text });
			writeJson(res, 200, { ok: true });
		} catch (err) {
			writeJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
		}
	}

	async function handleDismissResponse(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			const raw = await readBody(req, 64 << 10);
			const body = JSON.parse(raw.toString("utf8")) as { id?: string };
			if (typeof body.id !== "string" || !body.id) {
				writeJson(res, 400, { error: "missing id" });
				return;
			}
			await opts.onMessage({ v: 1, type: "dismiss_response", id: body.id });
			writeJson(res, 200, { ok: true });
		} catch (err) {
			writeJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
		}
	}

	async function handleUploadAsset(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			const data = await readBody(req, MAX_ASSET_BYTES + 512);
			if (data.length === 0) {
				writeJson(res, 400, { error: "empty body" });
				return;
			}
			if (data.length > MAX_ASSET_BYTES) {
				writeJson(res, 413, { error: "file too large (max 5MB)" });
				return;
			}
			const ct = (req.headers["content-type"] ?? "").toString();
			const ext = sniffImageExt(ct, data.subarray(0, 512));
			if (!ext) {
				writeJson(res, 415, { error: "only png/jpeg/gif/webp images are allowed" });
				return;
			}
			const { dir, workspaceRelative } = assetDir();
			const name = randomBytes(16).toString("hex") + ext;
			const path = join(dir, name);
			writeFileSync(path, data);
			const urlPath = `/assets/${name}`;
			writeJson(res, 200, {
				ok: true,
				url: urlPath,
				path: workspaceRelative ? `.piview/assets/${name}` : urlPath,
				name,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			writeJson(res, msg.includes("too large") ? 413 : 400, { error: msg });
		}
	}

	function handleGetAsset(req: IncomingMessage, res: ServerResponse, urlPath: string): void {
		const name = basename(urlPath.replace(/^\/assets\//, ""));
		if (!safeAssetName(name)) {
			res.writeHead(404);
			res.end("not found");
			return;
		}
		const { dir } = assetDir();
		const full = resolve(dir, name);
		const cleanDir = resolve(dir);
		if (!full.startsWith(cleanDir + sep)) {
			res.writeHead(404);
			res.end("not found");
			return;
		}
		if (!existsSync(full) || !statSync(full).isFile()) {
			res.writeHead(404);
			res.end("not found");
			return;
		}
		const ext = extname(name).toLowerCase();
		const ct = MIME[ext] ?? "application/octet-stream";
		res.writeHead(200, {
			"content-type": ct,
			"cache-control": "private, max-age=86400",
		});
		if (req.method === "HEAD") {
			res.end();
			return;
		}
		createReadStream(full).pipe(res);
	}

	function handleChanges(_req: IncomingMessage, res: ServerResponse, url: URL): void {
		if (!changeStore) {
			writeJson(res, 200, { changes: [] });
			return;
		}
		const pathParam = url.searchParams.get("path");
		if (pathParam != null && pathParam !== "") {
			const change = changeStore.get(pathParam);
			if (!change) {
				writeJson(res, 404, { error: "change not found" });
				return;
			}
			writeJson(res, 200, { change });
			return;
		}
		writeJson(res, 200, { changes: changeStore.list() });
	}

	const api: UiHub = {
		setCwd(next) {
			cwd = next;
			emit("conn", { connected, cwd });
		},

		setPlan(state) {
			plan = state;
			if (state.cwd && !cwd) cwd = state.cwd;
			emit("state", plan);
		},

		setConnected(ok) {
			connected = ok;
			emit("conn", { connected, cwd });
		},

		setChangeStore(store) {
			changeStore = store;
		},

		onBroadcast(msg) {
			switch (msg.type) {
				case "plan_state":
					plan = msg.state;
					if (msg.state.cwd && !cwd) cwd = msg.state.cwd;
					emit("state", msg.state);
					break;
				case "activity":
					emit("activity", msg);
					break;
				case "status":
					emit("status", msg);
					break;
				case "hello":
					cwd = msg.cwd;
					connected = true;
					emit("conn", { connected: true, cwd });
					break;
				case "goodbye":
					connected = false;
					emit("conn", { connected: false, cwd });
					emit("status", { v: 1, type: "status", message: `bridge closed: ${msg.reason ?? ""}` });
					break;
				default:
					break;
			}
		},

		hasSubscribers() {
			return subs.size > 0;
		},

		handle(req, res) {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			const path = url.pathname;
			const method = req.method ?? "GET";

			if (path === "/api/events" && method === "GET") {
				handleEvents(req, res);
				return true;
			}
			if (path === "/api/state" && method === "GET") {
				writeJson(res, 200, plan);
				return true;
			}
			if (path === "/api/replace" && method === "POST") {
				void handleReplace(req, res);
				return true;
			}
			if (path === "/api/execute" && method === "POST") {
				void handleExecute(req, res);
				return true;
			}
			if (path === "/api/refine" && method === "POST") {
				void handleRefine(req, res);
				return true;
			}
			if (path === "/api/dismiss-response" && method === "POST") {
				void handleDismissResponse(req, res);
				return true;
			}
			if (path === "/api/assets" && method === "POST") {
				void handleUploadAsset(req, res);
				return true;
			}
			if (path === "/api/changes" && method === "GET") {
				handleChanges(req, res, url);
				return true;
			}
			if (path.startsWith("/assets/") && (method === "GET" || method === "HEAD")) {
				handleGetAsset(req, res, path);
				return true;
			}
			if (method === "GET" || method === "HEAD") {
				// Don't steal WS upgrade paths or health
				if (path === "/health" || path === "/v1") return false;
				serveStatic(req, res, path);
				return true;
			}
			return false;
		},

		close() {
			// SSE responses are intentionally long-lived. Merely dropping their send
			// callbacks leaves the HTTP requests open, which makes httpServer.close()
			// (and therefore Pi's session_shutdown) wait forever.
			for (const [res, cleanup] of [...eventStreams]) {
				cleanup();
				if (!res.writableEnded) {
					try {
						res.end();
					} catch {
						res.destroy();
					}
				}
			}
			eventStreams.clear();
			subs.clear();
			if (tempAssetDir) {
				try {
					rmSync(tempAssetDir, { recursive: true, force: true });
				} catch {
					/* ignore */
				}
				tempAssetDir = "";
			}
		},
	};

	return api;
}

function sniffImageExt(ct: string, head: Buffer): string | undefined {
	const base = ct.toLowerCase().split(";")[0]?.trim() ?? "";
	if (ALLOWED_IMAGE[base]) return ALLOWED_IMAGE[base];
	const detected = detectImageType(head);
	return detected ? ALLOWED_IMAGE[detected] : undefined;
}

function detectImageType(head: Buffer): string | undefined {
	if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
		return "image/png";
	}
	if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
		return "image/jpeg";
	}
	if (head.length >= 6) {
		const sig = head.subarray(0, 6).toString("ascii");
		if (sig === "GIF87a" || sig === "GIF89a") return "image/gif";
	}
	if (
		head.length >= 12 &&
		head.subarray(0, 4).toString("ascii") === "RIFF" &&
		head.subarray(8, 12).toString("ascii") === "WEBP"
	) {
		return "image/webp";
	}
	return undefined;
}

function safeAssetName(name: string): boolean {
	if (name.length < 5 || name.length > 80) return false;
	if (!/^[A-Za-z0-9._-]+$/.test(name)) return false;
	const ext = extname(name).toLowerCase();
	return [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext);
}
