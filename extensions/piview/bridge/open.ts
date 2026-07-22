/**
 * Open a localhost URL in the user's browser.
 * Prefers Chrome/Chromium app mode for a chromeless feel (ported from Go open.go).
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { platform } from "node:os";

function run(cmd: string, args: string[], opts?: { wait?: boolean }): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, {
			detached: !opts?.wait,
			stdio: "ignore",
			shell: false,
		});
		child.on("error", () => resolve(false));
		if (opts?.wait) {
			child.on("exit", (code) => resolve(code === 0));
		} else {
			child.unref();
			// Spawn succeeded if we didn't get an immediate error
			setTimeout(() => resolve(true), 50);
		}
	});
}

function isWSL(): boolean {
	if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
	try {
		const ver = readFileSync("/proc/version", "utf8").toLowerCase();
		return ver.includes("microsoft");
	} catch {
		return false;
	}
}

function which(bin: string): string | undefined {
	const pathEnv = process.env.PATH ?? "";
	const parts = pathEnv.split(platform() === "win32" ? ";" : ":");
	const ext = platform() === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
	for (const dir of parts) {
		for (const e of ext) {
			const full = `${dir}${dir.endsWith("/") || dir.endsWith("\\") ? "" : "/"}${bin}${e}`;
			if (existsSync(full)) return full;
		}
	}
	return undefined;
}

/** Open url in a browser window. Returns true if a launcher was started. */
export async function openBrowser(url: string, _title = "piview"): Promise<boolean> {
	const os = platform();

	if (os === "darwin") {
		for (const app of ["Google Chrome", "Chromium", "Microsoft Edge", "Brave Browser"]) {
			if (await run("open", ["-na", app, "--args", `--app=${url}`, "--new-window"], { wait: true })) {
				return true;
			}
		}
		return run("open", [url]);
	}

	if (os === "linux") {
		if (isWSL()) {
			const wslview = which("wslview");
			if (wslview) return run(wslview, [url]);
			const cmd = which("cmd.exe");
			if (cmd) return run(cmd, ["/c", "start", "", url]);
		}
		for (const bin of ["google-chrome", "chromium", "chromium-browser"]) {
			const path = which(bin);
			if (path) return run(path, [`--app=${url}`]);
		}
		const xdg = which("xdg-open");
		if (xdg) return run(xdg, [url]);
		return false;
	}

	if (os === "win32") {
		// `start` is a cmd built-in; empty title arg avoids swallowing the URL.
		return run("cmd", ["/c", "start", "", url]);
	}

	return false;
}
