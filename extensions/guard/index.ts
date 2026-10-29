/**
 * Guard Extension
 *
 * Hooks `tool_call` to stop risky agent actions before they run:
 * - `git push` to a protected branch (main/master by default), force pushes and `--all`/`--mirror`
 * - destructive shell commands (rm -rf, git reset --hard, git clean -f, ...)
 * - write/edit of protected files (.env, keys, lockfiles, .git/)
 * - opening an Azure DevOps pull request with pitk_azure_devops pr_create
 * - commands that reach databases, infrastructure or package registries, or send HTTP writes, to a
 *   target that is not on the allowlist (see autonomy.ts)
 *
 * With a UI it asks for confirmation; without one (print/RPC mode, subagents) it blocks.
 *
 * Autonomous mode (opt-in by the user only: `/pitk-ticket 4821 --auto`, a prompt starting with `--auto`,
 * or `/pitk-auto on`): nothing asks any more. Opening a PR is allowed; everything else above is a hard
 * block, and so are schema changes (migrations, .sql), which need a human decision.
 *
 * Config: ~/.pi/agent/guard.json (personal, can change everything) and .pi/guard.json
 * (project, can only add protections). `/guard` shows the active rules.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_ALLOW_HOSTS, DEFAULT_SCHEMA_PATHS, findSystemAccess, parseAutoOptIn, riskyEnvVars, systemAccessProblem } from "./autonomy.ts";
import { dangerousCommandReasons, gitPushProblem, matchProtectedPath, parseGitPushes } from "./rules.ts";

interface GuardConfig {
	/** "confirm" asks when a UI is available; "block" always blocks. */
	mode: "confirm" | "block";
	protectedBranches: string[];
	protectedPaths: string[];
	/** Check destructive shell commands. */
	dangerousCommands: boolean;
	/** Hosts databases, HTTP writes and similar may target. Personal config only: a project cannot widen it. */
	allowHosts: string[];
	/** Regexes for infrastructure/publish commands you deliberately allow. Personal config only. */
	allowCommands: string[];
	/** Paths whose change needs a human decision in autonomous mode. */
	schemaPaths: string[];
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
	allowHosts: DEFAULT_ALLOW_HOSTS,
	allowCommands: [],
	schemaPaths: DEFAULT_SCHEMA_PATHS,
};

function readJson(path: string): Partial<GuardConfig> & { extraPaths?: string[]; extraBranches?: string[]; extraAllowHosts?: string[] } {
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
		// Copies: the pushes below must not grow the shared defaults on every tool call.
		protectedBranches: [...(personal.protectedBranches ?? defaults.protectedBranches)],
		protectedPaths: [...(personal.protectedPaths ?? defaults.protectedPaths), ...(personal.extraPaths ?? [])],
		dangerousCommands: personal.dangerousCommands ?? defaults.dangerousCommands,
		allowHosts: [...(personal.allowHosts ?? defaults.allowHosts), ...(personal.extraAllowHosts ?? [])],
		allowCommands: [...(personal.allowCommands ?? defaults.allowCommands)],
		schemaPaths: [...(personal.schemaPaths ?? defaults.schemaPaths)],
	};

	// A repository you clone must not be able to switch the guard off, so project config only adds
	// protection. In particular it cannot add allowHosts or allowCommands.
	config.protectedBranches.push(...(project.protectedBranches ?? []), ...(project.extraBranches ?? []));
	config.protectedPaths.push(...(project.protectedPaths ?? []), ...(project.extraPaths ?? []));
	config.schemaPaths.push(...(project.schemaPaths ?? []));
	if (project.mode === "block") config.mode = "block";

	const sources = [personalPath, projectPath].filter((p) => existsSync(p));
	return { config, sources };
}

const DECISION_MARKER = "NEEDS DECISION";

function autonomyBriefing(config: GuardConfig, riskyEnv: string[]): string {
	return [
		"AUTONOMOUS MODE IS ON. The user opted in and is not watching. Work end to end without asking for confirmation.",
		"- Skip approval checkpoints in skills (ticket-to-pr, coordinator). Record the plan in the PR description instead.",
		`- Stop and ask only for decisions you are not allowed to make: requirements that are unclear in a way that changes the outcome, or contradict the code; database schema changes or migrations; breaking changes to public APIs, contracts, message formats or config keys other systems use. To stop, end your turn with a line starting "${DECISION_MARKER}:" followed by the question and the options you see.`,
		`- Hard limits enforced by the guard: no pushes to ${config.protectedBranches.join("/")}, no force pushes, no destructive commands, no edits to secrets or lockfiles, no schema files (${config.schemaPaths.join(", ")}), and databases, deployments, registries and HTTP writes only to: ${config.allowHosts.join(", ")}. A blocked call is final: do not work around it, find another way or stop with ${DECISION_MARKER}.`,
		"- Opening the pull request is allowed. Never merge, complete or approve it.",
		riskyEnv.length > 0
			? `- These environment variables point at hosts outside the allowlist; never use them: ${riskyEnv.join(", ")}.`
			: "",
	]
		.filter(Boolean)
		.join("\n");
}

/** Best-effort desktop notification, so a user who stepped away sees that the run ended. */
function desktopNotify(title: string, body: string) {
	if (process.platform !== "win32") {
		process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
		return;
	}
	const t = "Windows.UI.Notifications";
	// Title and body are fixed strings from this file, never model output.
	const script = [
		`[${t}.ToastNotificationManager, ${t}, ContentType = WindowsRuntime] > $null`,
		`$xml = [${t}.ToastNotificationManager]::GetTemplateContent([${t}.ToastTemplateType]::ToastText02)`,
		`$text = $xml.GetElementsByTagName('text'); $text[0].AppendChild($xml.CreateTextNode('${title}')) > $null; $text[1].AppendChild($xml.CreateTextNode('${body}')) > $null`,
		`[${t}.ToastNotificationManager]::CreateToastNotifier('Windows PowerShell').Show([${t}.ToastNotification]::new($xml))`,
	].join("; ");
	execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true }, () => undefined);
}

export default function (pi: ExtensionAPI) {
	let autonomous = false;
	let pendingBriefing: string | undefined;
	let lastAssistantText = "";

	async function currentBranch(dir: string): Promise<string | undefined> {
		const result = await pi.exec("git", ["branch", "--show-current"], { cwd: dir, timeout: 5000 }).catch(() => undefined);
		return result?.code === 0 ? result.stdout.trim() || undefined : undefined;
	}

	function setAutonomous(on: boolean, ctx: ExtensionContext) {
		autonomous = on;
		if (on) {
			const config = loadConfig(ctx.cwd).config;
			const risky = riskyEnvVars(process.env, config.allowHosts);
			pendingBriefing = autonomyBriefing(config, risky);
			ctx.ui.setStatus("pitk-auto", "AUTONOMOUS");
			ctx.ui.notify(
				`Autonomous mode on. The guard no longer asks: it blocks hard limits and allows opening the PR. /pitk-auto off to stop.${risky.length ? `\nWarning: env vars pointing outside the allowlist: ${risky.join(", ")}` : ""}`,
				risky.length ? "warning" : "info",
			);
		} else {
			pendingBriefing = "AUTONOMOUS MODE IS OFF. Ask the user before risky steps and stop at skill checkpoints again.";
			ctx.ui.setStatus("pitk-auto", undefined);
			ctx.ui.notify("Autonomous mode off.", "info");
		}
	}

	async function decide(ctx: ExtensionContext, config: GuardConfig, title: string, detail: string) {
		if (autonomous) {
			return {
				block: true,
				reason: `guard (autonomous mode, hard stop): ${title}.\n${detail}\nDo not work around this. Continue another way, or end your turn with "${DECISION_MARKER}:" and what you need from the user.`,
			};
		}
		if (config.mode === "block" || !ctx.hasUI) {
			return { block: true, reason: `guard: ${title}.\n${detail}\nAsk the user to run it themselves if it is intended.` };
		}
		const ok = await ctx.ui.confirm(`guard: ${title}`, `${detail}\n\nAllow it?`);
		return ok ? undefined : { block: true, reason: `guard: the user declined: ${title}` };
	}

	// Opt-in comes only from what the user typed (or an RPC host sent), never from model output or other extensions.
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" as const };
		const { optIn, text } = parseAutoOptIn(event.text);
		if (!optIn) return { action: "continue" as const };
		setAutonomous(true, ctx);
		return { action: "transform" as const, text };
	});

	pi.on("before_agent_start", async () => {
		if (!pendingBriefing) return undefined;
		const content = pendingBriefing;
		pendingBriefing = undefined;
		return { message: { customType: "pitk-autonomy", content, display: true } };
	});

	pi.on("message_end", async (event) => {
		const msg: any = event.message;
		if (msg?.role !== "assistant") return;
		const text = (msg.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
		if (text.trim()) lastAssistantText = text;
	});

	pi.on("agent_settled", async (event, ctx) => {
		if (!autonomous || event.aborted) return;
		const needsDecision = lastAssistantText.includes(DECISION_MARKER);
		if (needsDecision) ctx.ui.notify("The autonomous run stopped and needs your decision.", "warning");
		if (ctx.hasUI) desktopNotify("Pi", needsDecision ? "Autonomous run needs your decision" : "Autonomous run finished");
	});

	pi.registerCommand("pitk-auto", {
		description: "Autonomous mode: on, off or status",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "on") setAutonomous(true, ctx);
			else if (arg === "off") setAutonomous(false, ctx);
			else ctx.ui.notify(`Autonomous mode is ${autonomous ? "on" : "off"}. Use /pitk-auto on or /pitk-auto off.`, "info");
		},
	});

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

			for (const access of findSystemAccess(command)) {
				const problem = systemAccessProblem(access, command, config.allowHosts, config.allowCommands);
				if (problem) return decide(ctx, config, problem, `Command:\n  ${command}`);
			}

			if (autonomous && /\bdotnet\s+ef\s+migrations\s+(add|remove)\b|\bprisma\s+migrate\b/.test(command)) {
				return decide(ctx, config, "schema change (migration) needs a human decision", `Command:\n  ${command}`);
			}
		}

		// Opening a pull request is visible to the whole team: asked about normally, allowed in autonomous mode
		// (the user opted in to ticket-to-PR without a human), blocked in subagents.
		if (event.toolName === "pitk_azure_devops" && event.input.action === "pr_create") {
			if (autonomous) return undefined;
			const i = event.input;
			const items = Array.isArray(i.workItemIds) && i.workItemIds.length > 0 ? `\nWork items: ${i.workItemIds.join(", ")}` : "";
			return decide(
				ctx,
				config,
				"open an Azure DevOps pull request",
				`Title: ${i.title}\n${i.sourceBranch ?? "(current branch)"} -> ${i.targetBranch ?? "(default branch)"}${i.draft ? " (draft)" : ""}${items}`,
			);
		}

		if (event.toolName === "write" || event.toolName === "edit") {
			const path = String(event.input.path ?? "");
			const glob = matchProtectedPath(path, ctx.cwd, config.protectedPaths);
			if (glob) return decide(ctx, config, `${event.toolName} of protected file ${path}`, `Matches protected path "${glob}".`);
			const schema = autonomous ? matchProtectedPath(path, ctx.cwd, config.schemaPaths) : undefined;
			if (schema) return decide(ctx, config, `schema change (${path}) needs a human decision`, `Matches schema path "${schema}".`);
		}

		return undefined;
	});

	pi.registerCommand("guard", {
		description: "Show the guard's active rules and config files",
		handler: async (_args, ctx) => {
			const { config, sources } = loadConfig(ctx.cwd);
			const lines = [
				`mode: ${autonomous ? "AUTONOMOUS (hard blocks, PR creation allowed)" : config.mode}${ctx.hasUI ? "" : " (no UI, so hits are blocked)"}`,
				`protected branches: ${config.protectedBranches.join(", ")}`,
				`protected paths: ${config.protectedPaths.join(", ")}`,
				`dangerous commands: ${config.dangerousCommands ? "on" : "off"}`,
				`allowed hosts (databases, HTTP writes): ${config.allowHosts.join(", ")}`,
				`allowed infrastructure/publish commands: ${config.allowCommands.length ? config.allowCommands.join(", ") : "none"}`,
				`schema paths (stop in autonomous mode): ${config.schemaPaths.join(", ")}`,
				`config files: ${sources.length > 0 ? sources.join(", ") : "none (defaults)"}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
