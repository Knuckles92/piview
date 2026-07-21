import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// extensions/piview/bridge -> package root
const PACKAGE_ROOT = join(__dirname, "..", "..", "..");

let child: ChildProcess | undefined;
let lastWsUrl: string | undefined;
let lastUiUrl: string | undefined;

export function resolvePiviewBinary(): string | undefined {
	if (process.env.PIVIEW_BIN && existsSync(process.env.PIVIEW_BIN)) {
		return process.env.PIVIEW_BIN;
	}

	const goos = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
	const goarch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : process.arch;
	const ext = process.platform === "win32" ? ".exe" : "";
	const candidates = [
		join(PACKAGE_ROOT, "bin", `piview-${goos}-${goarch}${ext}`),
		join(PACKAGE_ROOT, "bin", `piview${ext}`),
		join(PACKAGE_ROOT, "viewer", `piview${ext}`),
	];
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}

	// PATH lookup — leave to shell by returning bare name if we can't find file;
	// spawn will fail clearly if missing.
	return "piview";
}

function instanceJsonPath(): string {
	const base = process.env.XDG_RUNTIME_DIR || tmpdir();
	return join(base, "piview", "instance.json");
}

/** Read UI URL from the companion's instance lockfile (same path Go uses). */
export function readUiUrl(): string | undefined {
	try {
		const raw = readFileSync(instanceJsonPath(), "utf8");
		const info = JSON.parse(raw) as { uiAddr?: string; wsUrl?: string };
		if (!info.uiAddr) return undefined;
		return `http://${info.uiAddr}/`;
	} catch {
		return undefined;
	}
}

async function waitForUiUrl(opts: {
	wsUrl: string;
	timeoutMs?: number;
	/** Return an error string to abort the wait early (e.g. spawn failed). */
	failed?: () => string | undefined;
}): Promise<{ uiUrl?: string; error?: string }> {
	const timeoutMs = opts.timeoutMs ?? 4000;
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const failure = opts.failed?.();
		if (failure) return { error: failure };
		try {
			const info = JSON.parse(readFileSync(instanceJsonPath(), "utf8")) as {
				uiAddr?: string;
				wsUrl?: string;
			};
			if (info.uiAddr && info.wsUrl === opts.wsUrl) {
				return { uiUrl: `http://${info.uiAddr}/` };
			}
		} catch {
			/* not ready yet */
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	return {};
}

export interface OpenViewerOptions {
	wsUrl: string;
	title?: string;
	cwd?: string;
}

export type OpenViewerResult =
	| { ok: true; bin: string; uiUrl?: string }
	| { ok: false; error: string };

export async function openViewer(opts: OpenViewerOptions): Promise<OpenViewerResult> {
	const bin = resolvePiviewBinary();
	if (!bin) return { ok: false, error: "piview binary not found" };

	// If we already spawned and it's alive, ask it to focus / reconnect
	if (child?.pid && !child.killed) {
		try {
			const focus = spawn(bin, ["focus", "--ws", opts.wsUrl], {
				detached: true,
				stdio: "ignore",
			});
			focus.unref();
			lastWsUrl = opts.wsUrl;
			const { uiUrl } = await waitForUiUrl({ wsUrl: opts.wsUrl });
			lastUiUrl = uiUrl;
			return { ok: true, bin, uiUrl };
		} catch {
			// fall through to fresh open
		}
	}

	try {
		const args = ["open", "--ws", opts.wsUrl];
		if (opts.title) args.push("--title", opts.title);
		if (opts.cwd) args.push("--cwd", opts.cwd);

		// spawn() reports a missing binary asynchronously via the "error"
		// event, so capture it and surface it instead of timing out silently.
		let spawnError: string | undefined;
		child = spawn(bin, args, {
			detached: true,
			stdio: "ignore",
			env: { ...process.env },
		});
		child.unref();
		child.on("error", (err) => {
			spawnError = err.message;
			child = undefined;
		});
		child.on("exit", (code) => {
			if (code !== null && code !== 0) {
				spawnError = spawnError ?? `${bin} exited with code ${code}`;
			}
			child = undefined;
		});
		lastWsUrl = opts.wsUrl;
		const { uiUrl, error } = await waitForUiUrl({
			wsUrl: opts.wsUrl,
			failed: () => spawnError,
		});
		if (error) return { ok: false, error };
		lastUiUrl = uiUrl;
		return { ok: true, bin, uiUrl };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

export function quitViewer(): void {
	const bin = resolvePiviewBinary();
	if (bin) {
		try {
			const p = spawn(bin, ["quit"], { detached: true, stdio: "ignore" });
			p.unref();
		} catch {
			/* ignore */
		}
	}
	if (child?.pid) {
		try {
			process.kill(child.pid, "SIGTERM");
		} catch {
			/* ignore */
		}
	}
	child = undefined;
	lastWsUrl = undefined;
	lastUiUrl = undefined;
}

export function getLastWsUrl(): string | undefined {
	return lastWsUrl;
}

export function getLastUiUrl(): string | undefined {
	return lastUiUrl ?? readUiUrl();
}
