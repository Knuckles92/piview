/** piview protocol v1 — keep in sync with protocol/plan.schema.json */

export const PROTOCOL_VERSION = 1 as const;

export type PlanStepStatus = "pending" | "active" | "done" | "skipped" | "failed";
export type PlanMode = "off" | "planning" | "executing" | "complete";
export type ExecutionActivityStatus = "running" | "completed" | "error";
export type ExecutionFileOperation = "edit" | "write";

/** Compact, persisted record of a tool call made during plan execution. */
export interface ExecutionActivity {
	toolCallId: string;
	toolName: string;
	summary?: string;
	path?: string;
	status: ExecutionActivityStatus;
	startedAt: number;
	endedAt?: number;
}

/** A successfully changed file, deduplicated by workspace-relative path. */
export interface ExecutionFile {
	path: string;
	operation: ExecutionFileOperation;
	count: number;
	updatedAt: number;
	/** Cumulative line additions across the execution run (when a diff was captured). */
	additions?: number;
	/** Cumulative line deletions across the execution run (when a diff was captured). */
	deletions?: number;
	/** True when a before/after snapshot is available via /api/changes. */
	hasDiff?: boolean;
}

/** Bounded execution history used by reconnecting viewers to render live metrics. */
export interface ExecutionTelemetry {
	startedAt: number;
	updatedAt: number;
	toolCallsStarted: number;
	toolCallsCompleted: number;
	toolCallsFailed: number;
	activities: ExecutionActivity[];
	files: ExecutionFile[];
}

export interface PlanStep {
	id: string;
	step: number;
	title: string;
	detail?: string;
	status: PlanStepStatus;
	files?: string[];
	notes?: string;
}

/** A non-plan assistant reply captured during planning (Q&A). */
export interface PlanResponse {
	id: string;
	title: string;
	markdown: string;
	createdAt: number;
}

export interface PlanState {
	v: 1;
	mode: PlanMode;
	title?: string;
	/** Full plan document in markdown (overview, rationale, and steps). */
	markdown?: string;
	steps: PlanStep[];
	activeStepId?: string;
	updatedAt: number;
	sessionId?: string;
	cwd?: string;
	/** Optional v1-compatible execution history; absent on older saved plans. */
	execution?: ExecutionTelemetry;
	/** Optional Q&A replies captured during planning; absent on older saved plans. */
	responses?: PlanResponse[];
}

export type PlanOp =
	| { op: "add"; title: string; detail?: string; afterId?: string; id?: string }
	| { op: "update"; id: string; title?: string; detail?: string; notes?: string; files?: string[] }
	| { op: "remove"; id: string }
	| { op: "reorder"; order: string[] }
	| { op: "set_status"; id: string; status: PlanStepStatus };

export type ServerMessage =
	| { v: 1; type: "hello"; protocolVersion: 1; sessionId: string; cwd: string }
	| { v: 1; type: "plan_state"; state: PlanState }
	| { v: 1; type: "activity"; toolCallId: string; toolName: string; phase: "start" | "update" | "end"; summary?: string; isError?: boolean }
	| { v: 1; type: "status"; agentIdle?: boolean; message?: string }
	| { v: 1; type: "pong" }
	| { v: 1; type: "goodbye"; reason?: string }
	| { v: 1; type: "error"; message: string };

export type ClientMessage =
	| { v: 1; type: "hello_ack"; protocolVersion: number; client: string }
	| { v: 1; type: "plan_ops"; ops: PlanOp[] }
	| { v: 1; type: "plan_replace"; state: PlanState }
	| { v: 1; type: "execute"; fromStepId?: string }
	| { v: 1; type: "refine"; text: string }
	| { v: 1; type: "set_mode"; mode: "off" | "planning" }
	| { v: 1; type: "dismiss_response"; id: string }
	| { v: 1; type: "ping" };

export function isClientMessage(value: unknown): value is ClientMessage {
	if (!value || typeof value !== "object") return false;
	const msg = value as { v?: unknown; type?: unknown };
	return msg.v === 1 && typeof msg.type === "string";
}
