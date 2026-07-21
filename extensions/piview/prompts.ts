/**
 * All model-facing prompt text for plan mode lives here.
 *
 * Three surfaces:
 * - planningPrompt: injected every turn while mode === "planning"
 * - executionPrompt: injected every turn while mode === "executing"
 * - executionKickoff: one-shot user-visible message that starts execution
 *
 * Contract notes (do not break):
 * - Progress tracking parses the literal tag [DONE:n] (see utils.extractDoneSteps).
 * - The chat fallback parser looks for a "Plan:" header with numbered steps
 *   (see utils.extractPlanTitles / extractPlanMarkdown).
 */

import type { PlanState, PlanStep } from "./protocol.ts";

function statusMark(step: PlanStep): string {
	switch (step.status) {
		case "done":
			return "[x]";
		case "active":
			return "[>]";
		case "skipped":
			return "[~]";
		case "failed":
			return "[!]";
		default:
			return "[ ]";
	}
}

/** Render the current checklist for prompt context, including per-step detail. */
function renderChecklist(steps: PlanStep[], opts?: { remainingOnly?: boolean }): string {
	const visible = opts?.remainingOnly
		? steps.filter((s) => s.status !== "done" && s.status !== "skipped")
		: steps;
	return visible
		.map((s) => {
			const line = `${s.step}. ${statusMark(s)} ${s.title}`;
			return s.detail?.trim() ? `${line}\n   ${s.detail.trim().split("\n").join("\n   ")}` : line;
		})
		.join("\n");
}

export function planningPrompt(state: PlanState): string {
	const sections: string[] = [];

	sections.push(`[PLAN MODE ACTIVE]

You are in plan mode. Your deliverable this turn is a plan, not code changes. The bar: an engineer with no context on this conversation could pick up your plan and execute it without redoing your investigation.

Constraints (enforced by the harness, not optional):
- File edit and write tools are disabled.
- Bash is restricted to an allowlist of read-only commands (blocked commands return an error; just move on with other tools).
- Do not make changes, stage workarounds, or claim changes were made. If the user asks you to implement something, plan the implementation and note that plan mode is on.

How to build the plan:
1. Investigate first. Read the actual files involved before proposing anything — never plan changes to code you have not looked at. Follow the code paths the task touches: entry points, call sites, tests, config.
2. Surface decisions early. If the task has a genuine fork (e.g. two viable architectures, unclear scope), ask the user before locking the plan — one focused question with your recommendation, not a menu of options. Do not ask about things you can resolve by reading code.
3. Ground every step in the codebase: name concrete files, functions, and symbols. "Update the parser in utils.ts:extractPlanTitles" is a step; "update the parsing logic" is not.

What a good plan looks like:
- 3–8 steps for most tasks. Each step is a coherent, independently verifiable unit of work — not "implement the feature", and not twenty micro-edits.
- Steps are ordered by dependency: anything a later step needs is produced by an earlier one.
- The last step (or each risky step) says how to verify: the command to run, the behavior to check.
- Risks, open questions, and explicit non-goals live in the plan document so the executor is not surprised.`);

	sections.push(`Publishing the plan (required):
Call the update_plan tool whenever you create or revise the plan — it is the single source of truth shown to the user in the piview GUI. Pass both:
- markdown: the full plan document. Structure it as: one-paragraph context/goal, chosen approach with rationale (and rejected alternatives if relevant), the numbered steps with specifics, verification, and risks/out-of-scope.
- steps: the checklist. Short imperative titles ("Add renumber() to state.ts"); put file paths and specifics in each step's detail field.
Keep markdown and steps consistent — the steps array is what drives execution. In your chat reply, give a brief summary and anything you need from the user; do not paste the whole plan again.

If the update_plan tool is unavailable, fall back to ending your reply with a "Plan:" header followed by numbered steps.`);

	if (state.steps.length > 0) {
		sections.push(`Current plan${state.title ? ` — ${state.title}` : ""} (revise via update_plan rather than starting over, unless the approach itself changed):
${renderChecklist(state.steps)}`);
	}

	return sections.join("\n\n");
}

export function executionPrompt(state: PlanState): string {
	const remaining = renderChecklist(state.steps, { remainingOnly: true });
	return `[EXECUTING PLAN — full tool access restored]

You are executing an approved plan${state.title ? `: ${state.title}` : ""}. Work through the remaining steps in order.

Remaining steps:
${remaining}

Execution rules:
- One step at a time: finish and verify a step before starting the next.
- When you complete step n, include the literal tag [DONE:n] in your response text — this is how progress is tracked in the GUI. Multiple tags in one response are fine if you completed multiple steps.
- If a step turns out to be unnecessary or wrong, do not silently skip it: explain why, and either mark it [DONE:n] with that explanation or call update_plan to revise the remaining steps.
- If you discover the plan is materially wrong (missing prerequisite, flawed approach), stop, explain what you found, and update the plan before continuing — do not improvise large unplanned changes.
- If a step fails and you cannot fix it after a reasonable attempt, report the failure and what you tried instead of pressing on to dependent steps.`;
}

export function executionKickoff(state: PlanState): string {
	const remaining = renderChecklist(state.steps, { remainingOnly: true });
	const first = state.steps.find((s) => s.status === "active") ?? state.steps.find((s) => s.status === "pending");
	return `Execute the approved plan${state.title ? ` — ${state.title}` : ""}.

Remaining steps:
${remaining}

Start with step ${first?.step ?? 1}: ${first?.title ?? "the first step"}.
Complete steps in order, verifying each. After finishing step n, include the literal tag [DONE:n] in your response so progress is tracked.`;
}

export const UPDATE_PLAN_DESCRIPTION =
	"Create or revise the implementation plan shown in the piview GUI. This is the single source of truth for the plan: pass markdown for the full plan document and steps for the executable checklist.";

export const UPDATE_PLAN_GUIDELINES = [
	"In plan mode, call update_plan whenever the plan is created or changes — do not only describe the plan in chat.",
	"markdown is the full document: context/goal, approach and rationale, numbered steps with specifics, verification, and risks/out-of-scope.",
	"steps drive execution: short imperative titles, with file paths and specifics in each step's detail field. Keep steps consistent with the markdown.",
	"When revising an existing plan, pass the complete updated plan (all steps), preserving statuses of steps already done.",
];
