/**
 * piview — plan-mode companion for pi
 *
 * /plangui  open long-lived Go plan viewer
 * /plan     toggle plan mode (TUI-only ok)
 * /todos    show plan progress
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createBridgeServer, type BridgeServer } from "./bridge/server.ts";
import { openViewer, quitViewer } from "./bridge/spawn.ts";
import type { PlanState } from "./protocol.ts";
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
	applyOps,
	createStepsFromTitles,
	emptyPlanState,
	markStepStatus,
	progress,
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

const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire", "update_plan"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];
const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write"]);
const PLAN_MANAGED_TOOLS = new Set<string>([...PLAN_MODE_TOOLS, ...NORMAL_MODE_TOOLS]);

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

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("plangui", {
		description: "Start in plan mode and open the piview GUI",
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
		bridge?.broadcast({ v: 1, type: "plan_state", state });
		persist();
	}

	function getPlanModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...activeToolNames.filter((name) => !PLAN_MODE_DISABLED_TOOLS.has(name)),
			...PLAN_MODE_TOOLS,
		]);
	}

	function getNormalModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...NORMAL_MODE_TOOLS,
			...activeToolNames.filter((name) => !PLAN_MANAGED_TOOLS.has(name) || name === "update_plan"),
		]);
	}

	function enablePlanModeTools(): void {
		if (toolsBeforePlanMode === undefined) {
			toolsBeforePlanMode = pi.getActiveTools();
		}
		pi.setActiveTools(getPlanModeTools(toolsBeforePlanMode));
	}

	function restoreNormalModeTools(): void {
		const base = toolsBeforePlanMode ?? getNormalModeTools(pi.getActiveTools());
		// Keep update_plan available only during planning/exec setup; drop when fully off
		pi.setActiveTools(base.filter((t) => t !== "update_plan"));
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
		enablePlanModeTools();
		publish(ctx);
	}

	function exitPlanModes(ctx: ExtensionContext): void {
		state = setMode({ ...state, steps: state.mode === "complete" ? state.steps : state.steps }, "off");
		restoreNormalModeTools();
		publish(ctx);
	}

	async function ensureBridge(ctx: ExtensionContext): Promise<BridgeServer> {
		if (bridge) {
			bridge.setSessionMeta({
				sessionId: ctx.sessionManager.getSessionId(),
				cwd: ctx.cwd,
			});
			return bridge;
		}

		bridge = createBridgeServer({
			sessionId: ctx.sessionManager.getSessionId(),
			cwd: ctx.cwd,
		});

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
					void startExecution(c);
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
						c.ui.notify("Plan mode enabled", "info");
					} else {
						exitPlanModes(c);
						c.ui.notify("Plan mode disabled", "info");
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
		// Push current state to any new client shortly after connect
		setTimeout(() => b.broadcast({ v: 1, type: "plan_state", state }), 150);

		const title = `piview — ${ctx.cwd.split("/").filter(Boolean).pop() ?? ctx.cwd}`;
		const result = await openViewer({
			wsUrl: b.getConnectUrl(),
			title,
			cwd: ctx.cwd,
		});

		if (!result.ok) {
			ctx.ui.notify(
				`Could not open piview (${result.error}). Install Go 1.22+ and run npm run build:viewer, or set PIVIEW_BIN to a piview binary. See README.md.`,
				"error",
			);
			return;
		}
		if (result.uiUrl) {
			ctx.ui.notify(`Plan GUI: ${result.uiUrl}`, "info");
		} else {
			ctx.ui.notify("Plan GUI opened (UI URL not ready yet — retry /plangui)", "warning");
		}
	}

	async function startExecution(ctx: ExtensionContext): Promise<void> {
		if (state.steps.length === 0) {
			ctx.ui.notify("No plan steps to execute", "warning");
			return;
		}

		state = setMode(state, "executing");
		// Mark first pending as active
		const first = state.steps.find((s) => s.status === "pending");
		if (first) {
			state = applyOps(state, [{ op: "set_status", id: first.id, status: "active" }]);
		}
		restoreNormalModeTools();
		// Ensure write tools on for execution; keep update_plan so the model can revise the plan mid-run
		const active = pi.getActiveTools();
		pi.setActiveTools(uniqueToolNames([...active, "read", "bash", "edit", "write", "update_plan"]));
		publish(ctx);

		const execMessage = executionKickoff(state);

		pi.sendMessage(
			{
				customType: "plan-todo-list",
				content: `**Plan Steps (${state.steps.length}):**\n\n${state.steps
					.map((t) => `${t.step}. ${t.status === "done" ? "☑" : "☐"} ${t.title}`)
					.join("\n")}`,
				display: true,
			},
			{ deliverAs: "followUp" },
		);
		pi.sendMessage(
			{ customType: "plan-mode-execute", content: execMessage, display: true },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	// --- tools ---
	pi.registerTool({
		name: "update_plan",
		label: "Update Plan",
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
			const markdown =
				params.markdown?.trim() ||
				synthesizePlanMarkdown({ title, steps });
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
	pi.registerCommand("plangui", {
		description: "Open plan GUI companion (enables plan mode). Use: /plangui | /plangui close",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const a = args.trim().toLowerCase();
			if (a === "close" || a === "quit" || a === "stop") {
				quitViewer();
				if (bridge) {
					await bridge.stop("user closed");
					bridge = undefined;
				}
				ctx.ui.notify("Plan GUI closed", "info");
				return;
			}

			if (state.mode === "off") {
				enterPlanning(ctx);
				ctx.ui.notify("Plan mode enabled (read-only). Opened GUI.", "info");
			}
			await openGui(ctx);
		},
	});

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (_args, ctx) => {
			lastCtx = ctx;
			if (state.mode === "planning") {
				exitPlanModes(ctx);
				ctx.ui.notify("Plan mode disabled. Full access restored.", "info");
			} else if (state.mode === "executing") {
				ctx.ui.notify("Currently executing a plan. Finish or clear steps first.", "warning");
			} else {
				enterPlanning(ctx);
				ctx.ui.notify("Plan mode enabled. Built-in write tools disabled.", "info");
			}
		},
	});

	pi.registerCommand("todos", {
		description: "Show current plan todo list",
		handler: async (_args, ctx) => {
			lastCtx = ctx;
			if (state.steps.length === 0) {
				ctx.ui.notify("No plan steps. Use /plangui or ask for a plan in plan mode.", "info");
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
			ctx.ui.notify(`Plan (${state.mode}) ${done}/${total}:\n${list}`, "info");
			bridge?.broadcast({ v: 1, type: "plan_state", state });
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

		const flagPlan = pi.getFlag("plan") === true || pi.getFlag("plangui") === true;
		if (flagPlan && state.mode === "off") {
			state = setMode(state, "planning");
		}

		if (state.mode === "planning") {
			enablePlanModeTools();
		} else if (state.mode === "executing") {
			const active = pi.getActiveTools();
			pi.setActiveTools(uniqueToolNames([...active, "read", "bash", "edit", "write", "update_plan"]));
		}

		updateTui(ctx, state);

		if (pi.getFlag("plangui") === true || (event.reason === "startup" && process.env.PIVIEW_AUTO === "1")) {
			try {
				await openGui(ctx);
			} catch (err) {
				ctx.ui.notify(`piview auto-open failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		}
	});

	pi.on("session_shutdown", async () => {
		quitViewer();
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
				reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable.\nCommand: ${command}`,
			};
		}
	});

	pi.on("tool_execution_start", async (event) => {
		bridge?.broadcast({
			v: 1,
			type: "activity",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			phase: "start",
			summary: summarizeArgs(event.toolName, event.args),
		});
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
	});

	pi.on("context", async (event) => {
		if (state.mode === "planning") return;
		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.role !== "user") return true;
				const content = msg.content;
				if (typeof content === "string") return !content.includes("[PLAN MODE ACTIVE]");
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	pi.on("before_agent_start", async () => {
		if (state.mode === "planning") {
			return {
				message: {
					customType: "plan-mode-context",
					content: planningPrompt(state),
					display: false,
				},
			};
		}

		if (state.mode === "executing" && state.steps.length > 0) {
			return {
				message: {
					customType: "plan-execution-context",
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
						customType: "plan-complete",
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

		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			const text = getTextContent(lastAssistant);
			const titles = extractPlanTitles(text);
			const markdown = extractPlanMarkdown(text);
			if (titles.length > 0) {
				const steps = createStepsFromTitles(titles);
				state = {
					...state,
					steps,
					markdown: markdown || synthesizePlanMarkdown({ title: state.title, steps }),
					updatedAt: Date.now(),
				};
				publish(ctx);
			} else if (markdown && !state.markdown) {
				state = { ...state, markdown, updatedAt: Date.now() };
				publish(ctx);
			}
		}

		if (state.steps.length === 0) return;

		// GUI connected: let the user act there
		if (bridge?.hasClients()) {
			ctx.ui.notify("Plan ready — use the piview GUI to Execute or Refine", "info");
			return;
		}

		const choice = await ctx.ui.select("Plan ready — what next?", [
			"Execute the plan",
			"Open plan GUI",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (choice === "Execute the plan") {
			await startExecution(ctx);
		} else if (choice === "Open plan GUI") {
			await openGui(ctx);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		lastCtx = ctx;
		bridge?.broadcast({ v: 1, type: "status", agentIdle: true });
	});

	pi.on("agent_start", async (_event, ctx) => {
		lastCtx = ctx;
		bridge?.broadcast({ v: 1, type: "status", agentIdle: false });
	});
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
