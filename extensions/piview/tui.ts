import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlanState } from "./protocol.ts";
import { progress } from "./state.ts";

export function updateTui(ctx: ExtensionContext, state: PlanState): void {
	const { done, total } = progress(state);

	if (state.mode === "executing" && total > 0) {
		ctx.ui.setStatus("piview", ctx.ui.theme.fg("accent", `📋 ${done}/${total}`));
	} else if (state.mode === "planning") {
		ctx.ui.setStatus("piview", ctx.ui.theme.fg("warning", "⏸ plan"));
	} else if (state.mode === "complete") {
		ctx.ui.setStatus("piview", ctx.ui.theme.fg("success", "✓ plan done"));
	} else {
		ctx.ui.setStatus("piview", undefined);
	}

	if ((state.mode === "executing" || state.mode === "planning") && state.steps.length > 0) {
		const lines = state.steps.map((item) => {
			if (item.status === "done") {
				return ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.title));
			}
			if (item.status === "active") {
				return ctx.ui.theme.fg("accent", "▶ ") + item.title;
			}
			if (item.status === "skipped") {
				return ctx.ui.theme.fg("dim", "– ") + ctx.ui.theme.fg("muted", item.title);
			}
			if (item.status === "failed") {
				return ctx.ui.theme.fg("error", "✗ ") + item.title;
			}
			return `${ctx.ui.theme.fg("muted", "☐ ")}${item.title}`;
		});
		ctx.ui.setWidget("piview-plan", lines);
	} else {
		ctx.ui.setWidget("piview-plan", undefined);
	}
}

export function clearTui(ctx: ExtensionContext): void {
	ctx.ui.setStatus("piview", undefined);
	ctx.ui.setWidget("piview-plan", undefined);
}
