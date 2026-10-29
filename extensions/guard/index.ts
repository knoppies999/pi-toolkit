/**
 * Guard Extension
 *
 * Hooks `tool_call` to stop risky agent actions before they run:
 * - `git push` to a protected branch (main/master by default), force pushes and `--all`/`--mirror`
 * - destructive shell commands (rm -rf, git reset --hard, git clean -f, ...)
 * - write/edit of protected files (.env, keys, lockfiles, .git/)
 *
 * With a UI it asks for confirmation; without one (print/RPC mode) it blocks.
 * Config: ~/.pi/agent/guard.json (personal, can change everything) and .pi/guard.json
 * (project, can only add protections). `/guard` shows the active rules.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dangerousCommandReasons, gitPushProblem, matchProtectedPath, parseGitPushes } from "./rules.ts";

interface GuardConfig {
	/** "confirm" asks when a UI is available; "block" always blocks. */
	mode: "confirm" | "block";
	protectedBranches: string[];
	protectedPaths: string[];
	/** Check destructive shell commands. */
	dangerousCommands: boolean;
}

const defaults: GuardConfig = {
	mode: "confirm",
	protectedBranches: ["main", "master"],
	protectedPaths: [
		".env",
		".env.*",
		"**/*.pem",
		"**/*.pfx",
		"**/*.key",
		"**/secrets.json",
		".git/**",
		"**/package-lock.json",
		"**/pnpm-lock.yaml",
		"**/yarn.lock",
		"**/packages.lock.json",
	],
	dangerousCommands: true,
};

function readJson(path: string): Partial<GuardConfig> & { extraPaths?: string[]; extraBranches?: string[] } {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		throw new Error(`guard: invalid JSON in ${path}: ${(err as Error).message}`);
	}
}

function loadConfig(cwd: string): { config: GuardConfig; sources: string[] } {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const personalPath = join(agentDir, "guard.json");
	const projectPath = join(cwd, ".pi", "guard.json");
	const personal = readJson(personalPath);
	const project = readJson(projectPath);

	const config: GuardConfig = {
		mode: personal.mode ?? defaults.mode,
		protectedBranches: personal.protectedBranches ?? defaults.protectedBranches,
		protectedPaths: [...(personal.protectedPaths ?? defaults.protectedPaths), ...(personal.extraPaths ?? [])],
		dangerousCommands: personal.dangerousCommands ?? defaults.dangerousCommands,
	};

	// A repository you clone must not be able to switch the guard off, so project config only adds.
	config.protectedBranches.push(...(project.protectedBranches ?? []), ...(project.extraBranches ?? []));
	config.protectedPaths.push(...(project.protectedPaths ?? []), ...(project.extraPaths ?? []));
	if (project.mode === "block") config.mode = "block";

	const sources = [personalPath, projectPath].filter((p) => existsSync(p));
	return { config, sources };
}

export default function (pi: ExtensionAPI) {
	async function currentBranch(dir: string): Promise<string | undefined> {
		const result = await pi.exec("git", ["branch", "--show-current"], { cwd: dir, timeout: 5000 }).catch(() => undefined);
		return result?.code === 0 ? result.stdout.trim() || undefined : undefined;
	}

	async function decide(ctx: ExtensionContext, config: GuardConfig, title: string, detail: string) {
		if (config.mode === "block" || !ctx.hasUI) {
			return { block: true, reason: `guard: ${title}.\n${detail}\nAsk the user to run it themselves if it is intended.` };
		}
		const ok = await ctx.ui.confirm(`guard: ${title}`, `${detail}\n\nAllow it?`);
		return ok ? undefined : { block: true, reason: `guard: the user declined: ${title}` };
	}

	pi.on("tool_call", async (event, ctx) => {
		let config: GuardConfig;
		try {
			config = loadConfig(ctx.cwd).config;
		} catch (err) {
			// Fail closed: a broken config must not silently disable the guard.
			return { block: true, reason: (err as Error).message };
		}

		if (event.toolName === "bash" || event.toolName === "powershell") {
			const command = String(event.input.command ?? "");

			for (const push of parseGitPushes(command)) {
				const dir = push.dir ? resolve(ctx.cwd, push.dir) : ctx.cwd;
				const branch = push.branches.length === 0 ? await currentBranch(dir) : undefined;
				const problem = gitPushProblem(push, config.protectedBranches, branch);
				if (problem) return decide(ctx, config, `git push ${problem}`, `Command:\n  ${command}`);
			}

			if (config.dangerousCommands) {
				const reasons = dangerousCommandReasons(command);
				if (reasons.length > 0) return decide(ctx, config, reasons.join(", "), `Command:\n  ${command}`);
			}
		}

		if (event.toolName === "write" || event.toolName === "edit") {
			const path = String(event.input.path ?? "");
			const glob = matchProtectedPath(path, ctx.cwd, config.protectedPaths);
			if (glob) return decide(ctx, config, `${event.toolName} of protected file ${path}`, `Matches protected path "${glob}".`);
		}

		return undefined;
	});

	pi.registerCommand("guard", {
		description: "Show the guard's active rules and config files",
		handler: async (_args, ctx) => {
			const { config, sources } = loadConfig(ctx.cwd);
			const lines = [
				`mode: ${config.mode}${ctx.hasUI ? "" : " (no UI, so hits are blocked)"}`,
				`protected branches: ${config.protectedBranches.join(", ")}`,
				`protected paths: ${config.protectedPaths.join(", ")}`,
				`dangerous commands: ${config.dangerousCommands ? "on" : "off"}`,
				`config files: ${sources.length > 0 ? sources.join(", ") : "none (defaults)"}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
