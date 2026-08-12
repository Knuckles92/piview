/**
 * Capture cumulative agent file edits during plan execution and serve them as diffs.
 * Bodies live on disk under .piview/changes/<sessionId>/ — not in plan_state.
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { structuredPatch } from "diff";
import type { ExecutionFileOperation } from "./protocol.ts";

const MAX_FILE_BYTES = 1 << 20; // 1 MiB

export interface DiffHunkLine {
	type: "context" | "add" | "del";
	text: string;
	oldLine?: number;
	newLine?: number;
}

export interface DiffHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: DiffHunkLine[];
}

export interface FileChange {
	path: string;
	operation: ExecutionFileOperation;
	/** null means the file did not exist before the first agent edit. */
	before: string | null;
	after: string;
	additions: number;
	deletions: number;
	hasDiff: boolean;
	unavailableReason?: string;
	updatedAt: number;
}

export interface FileChangeView extends FileChange {
	hunks: DiffHunk[];
}

export interface DiffStats {
	additions: number;
	deletions: number;
	hasDiff: boolean;
}

interface PendingSnapshot {
	path: string;
	before: string | null;
	unavailableReason?: string;
}

export class ChangeStore {
	private cwd = "";
	private sessionId = "";
	private pending = new Map<string, PendingSnapshot>();
	private changes = new Map<string, FileChange>();

	configure(cwd: string, sessionId: string): void {
		this.cwd = cwd;
		this.sessionId = sanitizeSessionId(sessionId);
	}

	/** Drop in-memory + on-disk artifacts for a fresh execution run. */
	clear(): void {
		this.pending.clear();
		this.changes.clear();
		const dir = this.sessionDir();
		if (dir && existsSync(dir)) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	}

	captureBefore(toolCallId: string, pathArg: string): void {
		const path = toWorkspacePath(pathArg, this.cwd);
		if (!path) return;
		if (this.pending.has(toolCallId)) return;

		const abs = resolve(this.cwd, path);
		if (!existsSync(abs)) {
			this.pending.set(toolCallId, { path, before: null });
			return;
		}
		try {
			const st = statSync(abs);
			if (!st.isFile()) {
				this.pending.set(toolCallId, {
					path,
					before: null,
					unavailableReason: "not a regular file",
				});
				return;
			}
			if (st.size > MAX_FILE_BYTES) {
				this.pending.set(toolCallId, {
					path,
					before: null,
					unavailableReason: `file too large (${st.size} bytes)`,
				});
				return;
			}
			const buf = readFileSync(abs);
			if (looksBinary(buf)) {
				this.pending.set(toolCallId, {
					path,
					before: null,
					unavailableReason: "binary file",
				});
				return;
			}
			this.pending.set(toolCallId, { path, before: buf.toString("utf8") });
		} catch (err) {
			this.pending.set(toolCallId, {
				path,
				before: null,
				unavailableReason: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * Finalize a successful edit/write: keep first before, latest after.
	 * Returns stats for ExecutionFile metadata, or undefined if nothing recorded.
	 */
	commitAfter(
		toolCallId: string,
		operation: ExecutionFileOperation,
		isError?: boolean,
	): DiffStats | undefined {
		const snap = this.pending.get(toolCallId);
		this.pending.delete(toolCallId);
		if (!snap || isError) return undefined;

		const now = Date.now();
		const existing = this.changes.get(snap.path);

		if (snap.unavailableReason) {
			const change: FileChange = {
				path: snap.path,
				operation,
				before: existing?.before ?? null,
				after: existing?.after ?? "",
				additions: existing?.additions ?? 0,
				deletions: existing?.deletions ?? 0,
				hasDiff: false,
				unavailableReason: snap.unavailableReason,
				updatedAt: now,
			};
			this.changes.set(snap.path, change);
			this.persist(change);
			return { additions: 0, deletions: 0, hasDiff: false };
		}

		const abs = resolve(this.cwd, snap.path);
		let after = "";
		let unavailableReason: string | undefined;
		try {
			if (!existsSync(abs)) {
				unavailableReason = "file missing after edit";
			} else {
				const st = statSync(abs);
				if (!st.isFile()) {
					unavailableReason = "not a regular file";
				} else if (st.size > MAX_FILE_BYTES) {
					unavailableReason = `file too large (${st.size} bytes)`;
				} else {
					const buf = readFileSync(abs);
					if (looksBinary(buf)) {
						unavailableReason = "binary file";
					} else {
						after = buf.toString("utf8");
					}
				}
			}
		} catch (err) {
			unavailableReason = err instanceof Error ? err.message : String(err);
		}

		if (unavailableReason) {
			const change: FileChange = {
				path: snap.path,
				operation,
				before: existing?.before ?? snap.before,
				after: existing?.after ?? "",
				additions: existing?.additions ?? 0,
				deletions: existing?.deletions ?? 0,
				hasDiff: false,
				unavailableReason,
				updatedAt: now,
			};
			this.changes.set(snap.path, change);
			this.persist(change);
			return { additions: 0, deletions: 0, hasDiff: false };
		}

		const before = existing ? existing.before : snap.before;
		const stats = countDiffStats(before ?? "", after);
		const change: FileChange = {
			path: snap.path,
			operation,
			before,
			after,
			additions: stats.additions,
			deletions: stats.deletions,
			hasDiff: true,
			updatedAt: now,
		};
		this.changes.set(snap.path, change);
		this.persist(change);
		return stats;
	}

	list(): FileChangeView[] {
		return [...this.changes.values()]
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.map((change) => toView(change));
	}

	get(pathArg: string): FileChangeView | undefined {
		const path = toWorkspacePath(pathArg, this.cwd) ?? normalizeSlashes(pathArg);
		const change = this.changes.get(path);
		return change ? toView(change) : undefined;
	}

	private sessionDir(): string | undefined {
		const cwd = this.cwd.trim();
		if (!cwd || !this.sessionId) return undefined;
		return join(cwd, ".piview", "changes", this.sessionId);
	}

	private persist(change: FileChange): void {
		const dir = this.sessionDir();
		if (!dir) return;
		try {
			mkdirSync(dir, { recursive: true });
			const file = join(dir, pathKey(change.path) + ".json");
			writeFileSync(file, JSON.stringify(change), "utf8");
		} catch {
			/* best-effort */
		}
	}
}

export function toWorkspacePath(pathArg: string, cwd: string): string | undefined {
	const root = resolve(cwd.trim() || ".");
	const abs = isAbsolute(pathArg) ? resolve(pathArg) : resolve(root, pathArg);
	if (abs !== root && !abs.startsWith(root + sep)) return undefined;
	const rel = relative(root, abs);
	if (!rel || rel.startsWith("..")) return undefined;
	return normalizeSlashes(rel);
}

function normalizeSlashes(path: string): string {
	return path.replace(/\\/g, "/");
}

function sanitizeSessionId(sessionId: string): string {
	const cleaned = sessionId.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
	return cleaned || "session";
}

function pathKey(path: string): string {
	return createHash("sha1").update(path).digest("hex");
}

function looksBinary(buf: Buffer): boolean {
	const n = Math.min(buf.length, 8192);
	for (let i = 0; i < n; i++) {
		if (buf[i] === 0) return true;
	}
	return false;
}

function countDiffStats(before: string, after: string): DiffStats {
	if (before === after) return { additions: 0, deletions: 0, hasDiff: true };
	const patch = structuredPatch("a", "b", before, after, undefined, undefined, { context: 3 });
	let additions = 0;
	let deletions = 0;
	for (const hunk of patch.hunks) {
		for (const line of hunk.lines) {
			if (line.startsWith("+") && !line.startsWith("+++")) additions++;
			else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
		}
	}
	return { additions, deletions, hasDiff: true };
}

function toView(change: FileChange): FileChangeView {
	if (!change.hasDiff || change.unavailableReason) {
		return { ...change, hunks: [] };
	}
	return {
		...change,
		hunks: buildHunks(change.before ?? "", change.after),
	};
}

function buildHunks(before: string, after: string): DiffHunk[] {
	if (before === after) return [];
	const patch = structuredPatch("a", "b", before, after, undefined, undefined, { context: 3 });
	return patch.hunks.map((hunk) => {
		let oldLine = hunk.oldStart;
		let newLine = hunk.newStart;
		const lines: DiffHunkLine[] = [];
		for (const raw of hunk.lines) {
			if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
			const prefix = raw[0];
			const text = raw.slice(1);
			if (prefix === "+") {
				lines.push({ type: "add", text, newLine });
				newLine++;
			} else if (prefix === "-") {
				lines.push({ type: "del", text, oldLine });
				oldLine++;
			} else {
				lines.push({ type: "context", text, oldLine, newLine });
				oldLine++;
				newLine++;
			}
		}
		return {
			oldStart: hunk.oldStart,
			oldLines: hunk.oldLines,
			newStart: hunk.newStart,
			newLines: hunk.newLines,
			lines,
		};
	});
}
