import { randomUUID } from "node:crypto";
import type {
	ExecutionActivity,
	ExecutionFileOperation,
	PlanMode,
	PlanOp,
	PlanState,
	PlanStep,
	PlanStepStatus,
} from "./protocol.ts";

export const PLAN_ENTRY_TYPE = "piview-plan";

export function emptyPlanState(partial?: Partial<PlanState>): PlanState {
	return {
		v: 1,
		mode: "off",
		steps: [],
		updatedAt: Date.now(),
		...partial,
	};
}

export function newStepId(): string {
	return randomUUID();
}

export function renumber(steps: PlanStep[]): PlanStep[] {
	return steps.map((step, index) => ({ ...step, step: index + 1 }));
}

export function createStepsFromTitles(titles: string[]): PlanStep[] {
	return renumber(
		titles.map((title) => ({
			id: newStepId(),
			step: 0,
			title,
			status: "pending" as const,
		})),
	);
}

export function applyOps(state: PlanState, ops: PlanOp[]): PlanState {
	let steps = [...state.steps];
	let activeStepId = state.activeStepId;
	let title = state.title;

	for (const op of ops) {
		switch (op.op) {
			case "add": {
				const step: PlanStep = {
					id: op.id ?? newStepId(),
					step: 0,
					title: op.title.trim() || "New step",
					detail: op.detail,
					status: "pending",
				};
				if (op.afterId) {
					const idx = steps.findIndex((s) => s.id === op.afterId);
					if (idx >= 0) steps.splice(idx + 1, 0, step);
					else steps.push(step);
				} else {
					steps.push(step);
				}
				break;
			}
			case "update": {
				steps = steps.map((s) => {
					if (s.id !== op.id) return s;
					return {
						...s,
						title: op.title !== undefined ? op.title : s.title,
						detail: op.detail !== undefined ? op.detail : s.detail,
						notes: op.notes !== undefined ? op.notes : s.notes,
						files: op.files !== undefined ? op.files : s.files,
					};
				});
				break;
			}
			case "remove": {
				steps = steps.filter((s) => s.id !== op.id);
				if (activeStepId === op.id) activeStepId = undefined;
				break;
			}
			case "reorder": {
				const map = new Map(steps.map((s) => [s.id, s]));
				const next: PlanStep[] = [];
				for (const id of op.order) {
					const step = map.get(id);
					if (step) {
						next.push(step);
						map.delete(id);
					}
				}
				for (const step of map.values()) next.push(step);
				steps = next;
				break;
			}
			case "set_status": {
				steps = steps.map((s) => (s.id === op.id ? { ...s, status: op.status } : s));
				if (op.status === "active") activeStepId = op.id;
				break;
			}
		}
	}

	return {
		...state,
		title,
		steps: renumber(steps),
		activeStepId,
		updatedAt: Date.now(),
	};
}

export function replacePlan(state: PlanState, incoming: PlanState): PlanState {
	return {
		...incoming,
		v: 1,
		sessionId: incoming.sessionId ?? state.sessionId,
		cwd: incoming.cwd ?? state.cwd,
		execution: incoming.execution ?? state.execution,
		updatedAt: Date.now(),
		steps: renumber(
			incoming.steps.map((s) => ({
				...s,
				id: s.id || newStepId(),
				status: s.status ?? "pending",
			})),
		),
	};
}

export function setMode(state: PlanState, mode: PlanMode): PlanState {
	return { ...state, mode, updatedAt: Date.now() };
}

export function markStepStatus(state: PlanState, stepNumber: number, status: PlanStepStatus): PlanState {
	const steps = state.steps.map((s) => (s.step === stepNumber ? { ...s, status } : s));
	const active = steps.find((s) => s.status === "active");
	return {
		...state,
		steps,
		activeStepId: active?.id,
		updatedAt: Date.now(),
	};
}

export function allStepsDone(state: PlanState): boolean {
	return state.steps.length > 0 && state.steps.every((s) => s.status === "done" || s.status === "skipped");
}

export function progress(state: PlanState): { done: number; total: number } {
	const total = state.steps.length;
	const done = state.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
	return { done, total };
}

/** Count steps by each PlanStepStatus. Pure; zeros for missing statuses. */
export function countByStatus(steps: PlanStep[]): Record<PlanStepStatus, number> {
	const counts: Record<PlanStepStatus, number> = {
		pending: 0,
		active: 0,
		done: 0,
		skipped: 0,
		failed: 0,
	};
	for (const step of steps) {
		counts[step.status] += 1;
	}
	return counts;
}

const MAX_EXECUTION_ACTIVITIES = 24;
const MAX_EXECUTION_FILES = 48;

/** Start a fresh, bounded execution history for a newly approved plan run. */
export function beginExecutionTelemetry(state: PlanState, now = Date.now()): PlanState {
	return {
		...state,
		execution: {
			startedAt: now,
			updatedAt: now,
			toolCallsStarted: 0,
			toolCallsCompleted: 0,
			toolCallsFailed: 0,
			activities: [],
			files: [],
		},
		updatedAt: now,
	};
}

/** Record a tool start while retaining enough context to attribute a later edit. */
export function recordExecutionToolStart(
	state: PlanState,
	input: { toolCallId: string; toolName: string; summary?: string; path?: string },
	now = Date.now(),
): PlanState {
	const execution = state.execution ?? beginExecutionTelemetry(state, now).execution!;
	if (execution.activities.some((activity) => activity.toolCallId === input.toolCallId)) return state;
	const activity: ExecutionActivity = {
		toolCallId: input.toolCallId,
		toolName: input.toolName,
		summary: input.summary,
		path: input.path,
		status: "running",
		startedAt: now,
	};
	return {
		...state,
		execution: {
			...execution,
			updatedAt: now,
			toolCallsStarted: execution.toolCallsStarted + 1,
			activities: [...execution.activities, activity].slice(-MAX_EXECUTION_ACTIVITIES),
		},
		updatedAt: now,
	};
}

/** Finalize a recorded tool call and count successful edit/write operations by path. */
export function recordExecutionToolEnd(
	state: PlanState,
	input: { toolCallId: string; toolName: string; isError?: boolean },
	now = Date.now(),
): PlanState {
	const execution = state.execution;
	if (!execution) return state;
	const old = execution.activities.find((activity) => activity.toolCallId === input.toolCallId);
	if (old && old.status !== "running") return state;
	const activity: ExecutionActivity = old
		? { ...old, status: input.isError ? "error" : "completed", endedAt: now }
		: {
				toolCallId: input.toolCallId,
				toolName: input.toolName,
				status: input.isError ? "error" : "completed",
				startedAt: now,
				endedAt: now,
			};
	const activities = old
		? execution.activities.map((item) => (item.toolCallId === input.toolCallId ? activity : item))
		: [...execution.activities, activity].slice(-MAX_EXECUTION_ACTIVITIES);
	const files = !input.isError && isFileEdit(activity) && activity.path
		? recordEditedFile(execution.files, activity.path, activity.toolName, now)
		: execution.files;
	return {
		...state,
		execution: {
			...execution,
			updatedAt: now,
			toolCallsCompleted: execution.toolCallsCompleted + 1,
			toolCallsFailed: execution.toolCallsFailed + (input.isError ? 1 : 0),
			activities,
			files,
		},
		updatedAt: now,
	};
}

function isFileEdit(activity: ExecutionActivity): activity is ExecutionActivity & { toolName: ExecutionFileOperation } {
	return activity.toolName === "edit" || activity.toolName === "write";
}

function recordEditedFile(
	files: NonNullable<PlanState["execution"]>["files"],
	path: string,
	operation: ExecutionFileOperation,
	now: number,
) {
	const existing = files.find((file) => file.path === path);
	if (existing) {
		return files.map((file) =>
			file.path === path ? { ...file, operation, count: file.count + 1, updatedAt: now } : file,
		);
	}
	return [...files, { path, operation, count: 1, updatedAt: now }].slice(-MAX_EXECUTION_FILES);
}
