/** Pure helpers for piview planning (bash allowlist + plan extraction). */

const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

export function isSafeCommand(command: string): boolean {
	const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
	const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
	return !isDestructive && isSafe;
}

export function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(
			/^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
			"",
		)
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	if (cleaned.length > 80) {
		cleaned = `${cleaned.slice(0, 77)}...`;
	}
	return cleaned;
}

/** Find the start index of a Plan: header in a message, or -1. */
function findPlanHeaderIndex(message: string): number {
	const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!headerMatch || headerMatch.index === undefined) return -1;
	return headerMatch.index;
}

/** Extract numbered steps under a Plan: header. Returns titles only. */
export function extractPlanTitles(message: string): string[] {
	const titles: string[] = [];
	const headerIdx = findPlanHeaderIndex(message);
	if (headerIdx < 0) return titles;

	const headerMatch = message.slice(headerIdx).match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!headerMatch) return titles;

	const planSection = message.slice(headerIdx + headerMatch[0].length);
	const numberedPattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;

	for (const match of planSection.matchAll(numberedPattern)) {
		const text = match[2]
			.trim()
			.replace(/\*{1,2}$/, "")
			.trim();
		if (text.length > 5 && !text.startsWith("`") && !text.startsWith("/") && !text.startsWith("-")) {
			const cleaned = cleanStepText(text);
			if (cleaned.length > 3) titles.push(cleaned);
		}
	}
	return titles;
}

/**
 * Extract the full plan markdown document from an assistant message.
 * Prefers content from a Plan: header (plus preceding overview) through the
 * end of the message; falls back to the whole message when it looks like a plan.
 */
export function extractPlanMarkdown(message: string): string | undefined {
	const trimmed = message.trim();
	if (!trimmed) return undefined;

	const headerIdx = findPlanHeaderIndex(trimmed);
	if (headerIdx >= 0) {
		let overview: string[] = [];
		const before = trimmed.slice(0, headerIdx);
		const paras = before.split(/\n{2,}/);
		for (let i = paras.length - 1; i >= 0; i--) {
			const p = paras[i].trim();
			if (!p) continue;
			if (/^(I'll |I will |Let me |Looking at |Based on )/i.test(p) && overview.length > 2) break;
			overview.unshift(p);
			if (overview.join("\n\n").length > 2000) break;
		}
		const body = trimmed.slice(headerIdx).trim();
		const doc = [...overview, body].join("\n\n").trim();
		return doc || undefined;
	}

	const numbered = trimmed.match(/^\s*\d+[.)]\s+\S+/gm);
	if (numbered && numbered.length >= 2 && trimmed.length < 12000) {
		return trimmed;
	}
	return undefined;
}

/** Build a readable markdown document from structured plan steps. */
export function synthesizePlanMarkdown(opts: {
	title?: string;
	steps: Array<{ step: number; title: string; detail?: string; status: string }>;
}): string {
	const lines: string[] = [];
	if (opts.title?.trim()) {
		lines.push(`# ${opts.title.trim()}`, "");
	} else {
		lines.push("# Plan", "");
	}
	for (const s of opts.steps) {
		const box =
			s.status === "done" ? "[x]" : s.status === "skipped" ? "[~]" : s.status === "failed" ? "[!]" : "[ ]";
		lines.push(`${s.step}. ${box} **${s.title}**`);
		if (s.detail?.trim()) {
			for (const line of s.detail.trim().split("\n")) {
				lines.push(`   ${line}`);
			}
		}
		lines.push("");
	}
	return `${lines.join("\n").trim()}\n`;
}

export function extractDoneSteps(message: string): number[] {
	const steps: number[] = [];
	for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		if (Number.isFinite(step)) steps.push(step);
	}
	return steps;
}
