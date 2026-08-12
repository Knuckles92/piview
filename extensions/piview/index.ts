/**
 * piview — standalone planning companion for pi
 *
 * /piview        open/manage the long-lived plan viewer (local HTTP UI)
 * /piview on     enable piview planning without opening the GUI
 * /piview todos  show piview plan progress
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { openBrowser } from "./bridge/open.ts";
import { createBridgeServer, type BridgeServer } from "./bridge/server.ts";
import { ChangeStore } from "./changes.ts";
import type { ExecutionFileOperation, PlanOp, PlanState } from "./protocol.ts";
import {
	UPDATE_PLAN_DESCRIPTION,
	UPDATE_PLAN_GUIDELINES,
	executionKickoff,
	executionPrompt,
	planningPrompt,
} from "./prompts.ts";
import {
	PLAN_ENTRY_TYPE,
	allStepsDone,
	appendPlanResponse,
	applyOps,
	createStepsFromTitles,
	dismissPlanResponse,
	emptyPlanState,
	beginExecutionTelemetry,
	markStepStatus,
	progress,
	recordExecutionToolEnd,
	recordExecutionToolStart,
	replacePlan,
	setMode,
} from "./state.ts";
import { clearTui, updateTui } from "./tui.ts";
import {
	extractDoneSteps,
	extractPlanMarkdown,
	extractPlanTitles,
	isSafeCommand,
	synthesizePlanMarkdown,
} from "./utils.ts";

const PIVIEW_PLAN_TOOL = "piview_plan";
const PIVIEW_PLANNING_CONTEXT = "piview-planning-context";
const PIVIEW_EXECUTION_CONTEXT = "piview-execution-context";
const PIVIEW_PLANNING_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire", PIVIEW_PLAN_TOOL];
const PIVIEW_DISABLED_TOOLS = new Set<string>(["edit", "write"]);

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function uniqueToolNames(toolNames: string[]): string[] {
	return [...new Set(toolNames)];
}

export default function piviewExtension(pi: ExtensionAPI): void {
	let state: PlanState = emptyPlanState();
	let toolsBeforePlanMode: string[] | undefined;
	let bridge: BridgeServer | undefined;
	let lastCtx: ExtensionContext | undefined;
	const changeStore = new ChangeStore();
	// True when piview_plan ran during the current agent run; the chat-text
	// fallback parser must not overwrite a plan authored via the tool.
	let planUpdatedByTool = false;

	pi.registerFlag("piview", {
		description: "Start piview planning and open its GUI",
		type: "boolean",
		default: false,
	});

	function persist(): void {
		pi.appendEntry(PLAN_ENTRY_TYPE, {
			state,
			toolsBeforePlanMode,
		});
	}

	function publish(ctx?: ExtensionContext): void {
		const c = ctx ?? lastCtx;
		if (c) updateTui(c, state);
		// Broadcast fans out to WS clients and browser SSE subscribers.
		bridge?.broadcast({ v: 1, type: "plan_state", state });
		persist();
	}

	function getPiviewPlanningTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...activeToolNames.filter((name) => !PIVIEW_DISABLED_TOOLS.has(name)),
			...PIVIEW_PLANNING_TOOLS,
		]);
	}

	function enablePiviewPlanningTools(): void {
		if (toolsBeforePlanMode === undefined) {
			toolsBeforePlanMode = pi.getActiveTools();
		}
		pi.setActiveTools(getPiviewPlanningTools(toolsBeforePlanMode));
	}

	function restoreNormalModeTools(): void {
		const base = toolsBeforePlanMode ?? pi.getActiveTools();
		// Restore exactly the tool set from before piview planning. This preserves
		// user configuration and another extension's read-only mode.
		pi.setActiveTools(base.filter((t) => t !== PIVIEW_PLAN_TOOL));
		toolsBeforePlanMode = undefined;
	}

	function enterPlanning(ctx: ExtensionContext): void {
		state = setMode(
			{
				...state,
				sessionId: ctx.sessionManager.getSessionId(),
				cwd: ctx.cwd,
			},
			"planning",
		);
		enablePiviewPlanningTools();
		publish(ctx);
	}

	function exitPlanModes(ctx: ExtensionContext): void {
		state = setMode({ ...state, steps: state.mode === "complete" ? state.steps : state.steps }, "off");
		restoreNormalModeTools();
		publish(ctx);
	}

	function syncChangeStore(ctx: ExtensionContext): void {
		changeStore.configure(ctx.cwd, ctx.sessionManager.getSessionId());
		bridge?.setChangeStore(changeStore);
	}

	async function ensureBridge(ctx: ExtensionContext): Promise<BridgeServer> {
		if (bridge) {
			bridge.setSessionMeta({
				sessionId: ctx.sessionManager.getSessionId(),
				cwd: ctx.cwd,
			});
			syncChangeStore(ctx);
			return bridge;
		}

		bridge = createBridgeServer({
			sessionId: ctx.sessionManager.getSessionId(),
			cwd: ctx.cwd,
		});
		syncChangeStore(ctx);

		// New viewers get the current plan immediately, even after a viewer restart
		bridge.onClientConnect((send) => {
			send({ v: 1, type: "plan_state", state });
		});

		bridge.onClientMessage((msg) => {
			const c = lastCtx;
			if (!c) return;

			switch (msg.type) {
				case "plan_ops": {
					state = applyOps(state, msg.ops);
					publish(c);
					break;
				}
				case "plan_replace": {
					state = replacePlan(state, msg.state);
					publish(c);
					break;
				}
				case "execute": {
					void startExecution(c, msg.fromStepId);
					break;
				}
				case "refine": {
					if (msg.text.trim()) {
						pi.sendUserMessage(msg.text.trim(), { deliverAs: "followUp" });
						c.ui.notify("Refinement sent", "info");
					}
					break;
				}
				case "set_mode": {
					if (msg.mode === "planning") {
						enterPlanning(c);
						c.ui.notify("piview planning enabled", "info");
					} else {
						exitPlanModes(c);
						c.ui.notify("piview planning disabled", "info");
					}
					break;
				}
				case "dismiss_response": {
					if (typeof msg.id === "string" && msg.id) {
						state = dismissPlanResponse(state, msg.id);
						publish(c);
					}
					break;
				}
			}
		});

		await bridge.start();
		return bridge;
	}

	async function openGui(ctx: ExtensionContext): Promise<void> {
		const b = await ensureBridge(ctx);
		b.setPlan(state);
		// Push current state shortly after open so a reconnecting EventSource catches up.
		setTimeout(() => b.broadcast({ v: 1, type: "plan_state", state }), 150);

		const title = `piview — ${ctx.cwd.split(/[/\\]/).filter(Boolean).pop() ?? ctx.cwd}`;
		const uiUrl = b.getUiUrl();
		const opened = await openBrowser(uiUrl, title);
		if (!opened) {
			ctx.ui.notify(`Could not open a browser. Open the plan GUI at ${uiUrl}`, "warning");
			return;
		}
		ctx.ui.notify(`Plan GUI: ${uiUrl}`, "info");
	}

	/**
	 * After a plan is authored, let the user review before any execution.
	 * Opening the GUI must never start the agent — only an explicit Execute does.
	 */
	async function promptPlanReady(ctx: ExtensionContext): Promise<void> {
		// Already viewing: hand off to the GUI; do not start execution.
		if (bridge?.hasClients()) {
			ctx.ui.notify("Plan ready — review in the piview GUI, then Execute when ready", "info");
			return;
		}

		const OPEN = "Open plan GUI";
		const STAY = "Stay in piview planning";
		const REFINE = "Refine the plan";
		const EXECUTE = "Execute the plan";

		// Open first so Enter (default) reviews instead of running the plan.
		const choice = await ctx.ui.select("Plan ready — what next?", [OPEN, STAY, REFINE, EXECUTE]);

		switch (choice) {
			case OPEN:
				await openGui(ctx);
				// Stay in planning; execution only via GUI Execute or a later explicit choice.
				ctx.ui.notify("Plan GUI opened — press Execute there when ready", "info");
				return;
			case STAY:
				return;
			case REFINE: {
				const refinement = await ctx.ui.editor("Refine the plan:", "");
				if (refinement?.trim()) {
					pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
				}
				return;
			}
			case EXECUTE: {
				const ok = await ctx.ui.confirm(
					"Execute plan?",
					"Start executing this plan now? You can also open the GUI and press Execute there.",
				);
				if (ok) await startExecution(ctx);
				return;
			}
			default:
				// Cancelled / dismissed — remain in piview planning, do not execute.
				return;
		}
	}

	async function startExecution(ctx: ExtensionContext, fromStepId?: string): Promise<void> {
		if (state.steps.length === 0) {
			ctx.ui.notify("No plan steps to execute", "warning");
			return;
		}
		if (state.mode === "executing") {
			ctx.ui.notify("Plan is already executing", "info");
			return;
		}

		state = beginExecutionTelemetry(setMode(state, "executing"));
		changeStore.configure(ctx.cwd, ctx.sessionManager.getSessionId());
		changeStore.clear();
		bridge?.setChangeStore(changeStore);

		const fromIdx = fromStepId ? state.steps.findIndex((s) => s.id === fromStepId) : -1;
		if (fromIdx >= 0) {
			// Start at the requested step: skip earlier unfinished work, activate target.
			const ops: PlanOp[] = [];
			for (let i = 0; i < state.steps.length; i++) {
				const step = state.steps[i];
				if (i < fromIdx) {
					if (step.status === "pending" || step.status === "active") {
						ops.push({ op: "set_status", id: step.id, status: "skipped" });
					}
				} else if (i === fromIdx) {
					ops.push({ op: "set_status", id: step.id, status: "active" });
				} else if (step.status === "active") {
					ops.push({ op: "set_status", id: step.id, status: "pending" });
				}
			}
			if (ops.length) state = applyOps(state, ops);
			state = { ...state, activeStepId: fromStepId };
		} else {
			// Mark first pending as active
			const first = state.steps.find((s) => s.status === "pending");
			if (first) {
				state = applyOps(state, [{ op: "set_status", id: first.id, status: "active" }]);
				state = { ...state, activeStepId: first.id };
			}
		}
		restoreNormalModeTools();
		// Restore the pre-piview tool set for execution and keep piview's plan tool
		// available for mid-run revisions. Do not override another extension's tool restrictions.
		const active = pi.getActiveTools();
		pi.setActiveTools(uniqueToolNames([...active, PIVIEW_PLAN_TOOL]));
		publish(ctx);

		const execMessage = executionKickoff(state);

		pi.sendMessage(
			{
				customType: "piview-todo-list",
				content: `**Plan Steps (${state.steps.length}):**\n\n${state.steps
					.map((t) => `${t.step}. ${t.status === "done" ? "☑" : "☐"} ${t.title}`)
					.join("\n")}`,
				display: true,
			},
			{ deliverAs: "followUp" },
		);
		pi.sendMessage(
			{ customType: "piview-execute", content: execMessage, display: true },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	// --- tools ---
	pi.registerTool({
		name: PIVIEW_PLAN_TOOL,
		label: "Update piview Plan",
		description: UPDATE_PLAN_DESCRIPTION,
		promptSnippet: "Create or revise the structured implementation plan",
		promptGuidelines: UPDATE_PLAN_GUIDELINES,
		parameters: Type.Object({
			title: Type.Optional(Type.String({ description: "Short plan title, e.g. 'Add WebSocket reconnect'" })),
			markdown: Type.Optional(
				Type.String({
					description:
						"Full plan document in markdown, shown in the Plan tab: context/goal, chosen approach and rationale, numbered steps with file-level specifics, verification, and risks/out-of-scope.",
				}),
			),
			steps: Type.Array(
				Type.Object({
					title: Type.String({
						description: "Short imperative step title, e.g. 'Add renumber() to state.ts'",
					}),
					detail: Type.Optional(
						Type.String({
							description: "Specifics for the executor: files, functions, edge cases, how to verify",
						}),
					),
					status: Type.Optional(
						Type.Unsafe<"pending" | "active" | "done" | "skipped" | "failed">({
							type: "string",
							enum: ["pending", "active", "done", "skipped", "failed"],
						}),
					),
				}),
				{ minItems: 1 },
			),
		}),
		async execute(_id, params) {
			const steps = createStepsFromTitles(params.steps.map((s) => s.title)).map((step, i) => ({
				...step,
				detail: params.steps[i]?.detail,
				status: params.steps[i]?.status ?? ("pending" as const),
			}));
			const title = params.title ?? state.title;
			// When markdown is omitted (common for mid-execution step revisions),
			// keep the authored plan document instead of replacing it with a
			// synthesized checklist. Only synthesize when no document ever existed.
			const markdown =
				params.markdown?.trim() ||
				(state.markdown?.trim() ? state.markdown : synthesizePlanMarkdown({ title, steps }));
			planUpdatedByTool = true;
			state = {
				...state,
				mode: state.mode === "off" ? "planning" : state.mode,
				title,
				markdown,
				steps,
				updatedAt: Date.now(),
			};
			if (lastCtx) publish(lastCtx);
			else {
				bridge?.broadcast({ v: 1, type: "plan_state", state });
				persist();
			}
			return {
				content: [
					{
						type: "text",
						text: `Plan updated: ${steps.length} steps${params.title ? ` — ${params.title}` : ""}`,
					},
				],
				details: { stepCount: steps.length },
			};
		},
	});

	// --- commands ---
	function showPiviewTodos(ctx: ExtensionContext): void {
		if (state.steps.length === 0) {
			ctx.ui.notify("No piview steps. Use /piview to start a planning session.", "info");
			return;
		}
		const { done, total } = progress(state);
		const list = state.steps
			.map((item) => {
				const mark =
					item.status === "done" ? "✓" : item.status === "active" ? "▶" : item.status === "skipped" ? "–" : "○";
				return `${item.step}. ${mark} ${item.title}`;
			})
			.join("\n");
		ctx.ui.notify(`piview (${state.mode}) ${done}/${total}:\n${list}`, "info");
		bridge?.broadcast({ v: 1, type: "plan_state", state });
	}

	pi.registerCommand("piview", {
		description: "Open or manage piview. Use: /piview [open|close|on|off|todos]",
		getArgumentCompletions: (prefix) => {
			const actions = ["open", "close", "on", "off", "todos"];
			const matches = actions.filter((action) => action.startsWith(prefix.toLowerCase()));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const action = args.trim().toLowerCase() || "open";

			if (action === "close" || action === "quit" || action === "stop") {
				if (bridge) {
					await bridge.stop("user closed");
					bridge = undefined;
				}
				const suffix = state.mode === "planning" ? "; piview planning remains active" : "";
				ctx.ui.notify(`piview GUI closed${suffix}`, "info");
				return;
			}

			if (action === "todos" || action === "status") {
				showPiviewTodos(ctx);
				return;
			}

			if (action === "off" || action === "disable") {
				if (state.mode === "executing") {
					ctx.ui.notify("piview is executing a plan. Finish the run before disabling it.", "warning");
					return;
				}
				if (state.mode !== "off") exitPlanModes(ctx);
				ctx.ui.notify("piview planning disabled. Full access restored.", "info");
				return;
			}

			if (action === "on" || action === "enable") {
				if (state.mode === "executing") {
					ctx.ui.notify("piview is already executing a plan.", "warning");
					return;
				}
				if (state.mode !== "planning") enterPlanning(ctx);
				ctx.ui.notify("piview planning enabled. Built-in write tools disabled.", "info");
				return;
			}

			if (action !== "open") {
				ctx.ui.notify("Usage: /piview [open|close|on|off|todos]", "warning");
				return;
			}

			if (state.mode === "off" || state.mode === "complete") {
				enterPlanning(ctx);
				ctx.ui.notify("piview planning enabled (read-only).", "info");
			}
			await openGui(ctx);
		},
	});

	// --- events ---
	pi.on("session_start", async (event, ctx) => {
		lastCtx = ctx;

		const entries = ctx.sessionManager.getEntries();
		const saved = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === PLAN_ENTRY_TYPE)
			.pop() as { data?: { state?: PlanState; toolsBeforePlanMode?: string[] } } | undefined;

		if (saved?.data?.state) {
			state = { ...emptyPlanState(), ...saved.data.state, v: 1 };
			toolsBeforePlanMode = saved.data.toolsBeforePlanMode;
		}

		state = {
			...state,
			sessionId: ctx.sessionManager.getSessionId(),
			cwd: ctx.cwd,
		};

		const flagPiview = pi.getFlag("piview") === true;
		if (flagPiview && state.mode === "off") {
			state = setMode(state, "planning");
		}

		if (state.mode === "planning") {
			enablePiviewPlanningTools();
		} else if (state.mode === "executing") {
			const active = pi.getActiveTools();
			pi.setActiveTools(uniqueToolNames([...active, PIVIEW_PLAN_TOOL]));
		}

		updateTui(ctx, state);

		if (flagPiview || (event.reason === "startup" && process.env.PIVIEW_AUTO === "1")) {
			try {
				await openGui(ctx);
			} catch (err) {
				ctx.ui.notify(`piview auto-open failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		}
	});

	pi.on("session_shutdown", async () => {
		if (bridge) {
			await bridge.stop("session_shutdown");
			bridge = undefined;
		}
		if (lastCtx) clearTui(lastCtx);
	});

	pi.on("tool_call", async (event) => {
		if (state.mode !== "planning" || event.toolName !== "bash") return;
		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `piview planning: command blocked (not allowlisted). Use /piview off to disable.\nCommand: ${command}`,
			};
		}
	});

	pi.on("tool_execution_start", async (event) => {
		const summary = summarizeArgs(event.toolName, event.args);
		bridge?.broadcast({
			v: 1,
			type: "activity",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			phase: "start",
			summary,
		});
		if (state.mode === "executing") {
			const path = toolPath(event.args);
			if (path && isFileEditTool(event.toolName)) {
				const ctx = lastCtx;
				if (ctx) changeStore.configure(ctx.cwd, ctx.sessionManager.getSessionId());
				changeStore.captureBefore(event.toolCallId, path);
			}
			state = recordExecutionToolStart(state, {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				summary,
				path,
			});
			publish();
		}
	});

	pi.on("tool_execution_end", async (event) => {
		bridge?.broadcast({
			v: 1,
			type: "activity",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			phase: "end",
			isError: event.isError,
		});
		if (state.mode === "executing") {
			const diff =
				isFileEditTool(event.toolName)
					? changeStore.commitAfter(event.toolCallId, event.toolName, event.isError)
					: undefined;
			state = recordExecutionToolEnd(state, {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				isError: event.isError,
				diff,
			});
			publish();
		}
	});

	pi.on("context", async (event) => {
		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === PIVIEW_PLANNING_CONTEXT) return state.mode === "planning";
				if (msg.customType === PIVIEW_EXECUTION_CONTEXT) return state.mode === "executing";

				// Remove only piview's legacy unnamespaced contexts. Do not remove the
				// stock plan-mode extension's messages when both packages are installed.
				if (
					(msg.customType === "plan-mode-context" || msg.customType === "plan-execution-context") &&
					msg.role === "user"
				) {
					const content = msg.content;
					const text = typeof content === "string"
						? content
						: Array.isArray(content)
							? content
								.filter((c): c is TextContent => c.type === "text")
								.map((c) => c.text)
								.join("\n")
							: "";
					const isLegacyPlanning =
						msg.customType === "plan-mode-context" &&
						text.includes("[PLAN MODE ACTIVE]") &&
						text.includes("piview GUI");
					const isLegacyExecution =
						msg.customType === "plan-execution-context" && text.includes("progress is tracked in the GUI");
					if (isLegacyPlanning || isLegacyExecution) return false;
				}
				return true;
			}),
		};
	});

	pi.on("before_agent_start", async () => {
		if (state.mode === "planning") {
			return {
				message: {
					customType: PIVIEW_PLANNING_CONTEXT,
					content: planningPrompt(state),
					display: false,
				},
			};
		}

		if (state.mode === "executing" && state.steps.length > 0) {
			return {
				message: {
					customType: PIVIEW_EXECUTION_CONTEXT,
					content: executionPrompt(state),
					display: false,
				},
			};
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		lastCtx = ctx;
		if (state.mode !== "executing" || state.steps.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		const done = extractDoneSteps(text);
		if (done.length === 0) return;

		for (const n of done) {
			state = markStepStatus(state, n, "done");
		}
		// Activate next pending
		const next = state.steps.find((s) => s.status === "pending");
		if (next) {
			state = applyOps(state, [{ op: "set_status", id: next.id, status: "active" }]);
		}
		publish(ctx);
	});

	pi.on("agent_end", async (event, ctx) => {
		lastCtx = ctx;

		if (state.mode === "executing" && state.steps.length > 0) {
			if (allStepsDone(state)) {
				pi.sendMessage(
					{
						customType: "piview-complete",
						content: `**Plan Complete!** ✓\n\n${state.steps.map((t) => `~~${t.title}~~`).join("\n")}`,
						display: true,
					},
					{ triggerTurn: false },
				);
				state = setMode(state, "complete");
				publish(ctx);
			}
			return;
		}

		if (state.mode !== "planning" || !ctx.hasUI) return;

		// Chat-text fallback for when piview_plan is unavailable. Skip it when the
		// tool ran this turn — a chat summary must not clobber the authored plan.
		// Non-plan replies are captured as response tabs instead of filling markdown.
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant && !planUpdatedByTool) {
			const text = getTextContent(lastAssistant);
			const titles = extractPlanTitles(text);
			const markdown = extractPlanMarkdown(text);
			if (titles.length > 0) {
				const steps = createStepsFromTitles(titles);
				state = {
					...state,
					steps,
					markdown: markdown || state.markdown || synthesizePlanMarkdown({ title: state.title, steps }),
					updatedAt: Date.now(),
				};
				publish(ctx);
			} else if (text.trim().length >= 20) {
				state = appendPlanResponse(state, text);
				publish(ctx);
			}
		}

		if (state.steps.length === 0) return;

		// Plan is ready for review. Never auto-start execution from this prompt —
		// Execute must be an explicit choice (TUI) or a GUI Execute click.
		await promptPlanReady(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		lastCtx = ctx;
		bridge?.broadcast({ v: 1, type: "status", agentIdle: true });
	});

	pi.on("agent_start", async (_event, ctx) => {
		lastCtx = ctx;
		planUpdatedByTool = false;
		bridge?.broadcast({ v: 1, type: "status", agentIdle: false });
	});
}

function toolPath(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const path = (args as Record<string, unknown>).path;
	return typeof path === "string" ? path : undefined;
}

function isFileEditTool(toolName: string): toolName is ExecutionFileOperation {
	return toolName === "edit" || toolName === "write";
}

function summarizeArgs(toolName: string, args: unknown): string {
	if (!args || typeof args !== "object") return toolName;
	const a = args as Record<string, unknown>;
	if (typeof a.path === "string") return `${toolName} ${a.path}`;
	if (typeof a.command === "string") {
		const cmd = a.command.length > 60 ? `${a.command.slice(0, 57)}...` : a.command;
		return `${toolName}: ${cmd}`;
	}
	return toolName;
}
