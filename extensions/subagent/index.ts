/**
 * Subagent Extension
 *
 * Registers `pitk_subagent`, which delegates work to agents that each run in their own `pi` process with
 * an isolated context window. Modes:
 * - single:   { agent, task }
 * - parallel: { tasks: [{ agent, task }, ...] }   up to 8 tasks, 4 at a time
 * - chain:    { chain: [{ agent, task }, ...] }    each task can use {previous}, the prior step's output
 *
 * Agents come from this package's agents/ directory, ~/.pi/agent/agents/ and, with agentScope "all",
 * the project's .pi/agents/ (see agents.ts). Subagents get the same packages and extensions as you,
 * including guard, but no UI, so guard blocks risky actions in them instead of asking.
 *
 * Environment:
 * - PITK_SUBAGENT_ARGS: JSON array of extra arguments for every subagent `pi` process, e.g. ["--offline"]
 * - PITK_SUBAGENT_MAX_DEPTH: how deep subagents may nest (default 1: subagents cannot start subagents)
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, findProjectAgentsDir, loadAgentsFromDir, mergeAgents } from "./agents.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const DEPTH_ENV = "PITK_SUBAGENT_DEPTH";

const bundledAgentsDir = fileURLToPath(new URL("../../agents", import.meta.url));

interface RunResult {
	agent: string;
	task: string;
	exitCode: number;
	output: string;
	stderr: string;
	stopReason?: string;
	errorMessage?: string;
	turns: number;
	cost: number;
}

const failed = (r: RunResult) => r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
const resultText = (r: RunResult) =>
	failed(r) ? r.errorMessage || r.output || r.stderr.trim().split("\n").slice(-20).join("\n") || "(no output)" : r.output || "(no output)";

function cap(text: string): string {
	if (Buffer.byteLength(text, "utf8") <= PER_TASK_OUTPUT_CAP) return text;
	return `${Buffer.from(text, "utf8").subarray(0, PER_TASK_OUTPUT_CAP).toString("utf8")}\n\n[Output truncated to ${PER_TASK_OUTPUT_CAP / 1024} KB]`;
}

/** Start pi the same way the current process was started, so subagents use the same install. */
function piInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && existsSync(script)) return { command: process.execPath, args: [script, ...args] };
	const exe = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(exe)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function extraArgs(): string[] {
	const raw = process.env.PITK_SUBAGENT_ARGS;
	if (!raw) return [];
	const parsed = JSON.parse(raw);
	if (!Array.isArray(parsed) || !parsed.every((a) => typeof a === "string")) {
		throw new Error("PITK_SUBAGENT_ARGS must be a JSON array of strings");
	}
	return parsed;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return results;
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Agent name" }),
	task: Type.String({ description: "What the agent should do. In a chain, {previous} is replaced with the previous step's output." }),
	cwd: Type.Optional(Type.String({ description: "Working directory for this agent (default: current)" })),
});

const Params = Type.Object({
	agent: Type.Optional(Type.String({ description: "Single mode: agent name" })),
	task: Type.Optional(Type.String({ description: "Single mode: the task" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: `Parallel mode: up to ${MAX_PARALLEL_TASKS} independent tasks` })),
	chain: Type.Optional(Type.Array(TaskItem, { description: "Chain mode: tasks run in order, each can use {previous}" })),
	agentScope: Type.Optional(
		StringEnum(["default", "all"] as const, {
			description: 'default: bundled and user agents. all: also the project\'s .pi/agents (asks first in untrusted projects).',
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Single mode: working directory" })),
});

export default function (pi: ExtensionAPI) {
	const depth = Number(process.env[DEPTH_ENV] ?? 0);
	const maxDepth = Number(process.env.PITK_SUBAGENT_MAX_DEPTH ?? 1);
	// Inside a subagent at the depth limit: do not offer the tool at all, so it cannot recurse.
	if (depth >= maxDepth) return;

	function discover(cwd: string, includeProject: boolean) {
		const bundled = loadAgentsFromDir(bundledAgentsDir, "bundled");
		const user = loadAgentsFromDir(join(getAgentDir(), "agents"), "user");
		const projectDir = includeProject ? findProjectAgentsDir(cwd) : undefined;
		const project = projectDir ? loadAgentsFromDir(projectDir, "project") : [];
		return { agents: mergeAgents(bundled, user, project), projectDir };
	}

	pi.registerCommand("pitk-agents", {
		description: "List the agents pitk_subagent can run",
		handler: async (_args, ctx) => {
			const { agents, projectDir } = discover(ctx.cwd, true);
			const lines = agents.map((a) => `${a.name} (${a.source}${a.tools ? `; tools: ${a.tools.join(",")}` : ""}): ${a.description}`);
			if (projectDir) lines.push("", `Project agents in ${projectDir} run only with agentScope "all".`);
			ctx.ui.notify(lines.join("\n") || "No agents found.", "info");
		},
	});

	pi.registerTool({
		name: "pitk_subagent",
		label: "Subagent",
		description: [
			"Delegate work to specialised agents that run in separate pi processes with their own context window, and get back their final answer.",
			"Modes: single (agent + task), parallel (tasks: independent work, e.g. several scouts), chain (each step can use {previous}).",
			"Subagents start with no knowledge of this conversation: put everything they need in the task.",
			`Bundled agents: scout, planner, implementer, tester, reviewer. More in ${join(getAgentDir(), "agents")}.`,
		].join(" "),
		promptSnippet: "Delegate tasks to isolated subagents (single, parallel, or chained)",
		promptGuidelines: [
			"Use pitk_subagent parallel mode for independent read-only research; never run two agents that edit the same files at once.",
			"Give each subagent a self-contained task: goal, relevant paths, constraints, and the exact output you want back.",
		],
		parameters: Params,
		annotations: { readOnlyHint: false, openWorldHint: true },

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const includeProject = params.agentScope === "all";
			const { agents, projectDir } = discover(ctx.cwd, includeProject);
			const modes = [params.agent && params.task, params.tasks?.length, params.chain?.length].filter(Boolean).length;
			if (modes !== 1) {
				throw new Error(`Use exactly one mode: agent + task, tasks, or chain. Agents: ${agents.map((a) => a.name).join(", ") || "none"}`);
			}

			const requested = [params.agent, ...(params.tasks ?? []).map((t) => t.agent), ...(params.chain ?? []).map((t) => t.agent)].filter(
				(n): n is string => Boolean(n),
			);
			const projectAgents = requested.map((n) => agents.find((a) => a.name === n)).filter((a) => a?.source === "project");
			if (projectAgents.length > 0 && !ctx.isProjectTrusted()) {
				if (!ctx.hasUI) throw new Error("Project agents need a trusted project or an interactive session to approve them.");
				const ok = await ctx.ui.confirm(
					"Run project agents?",
					`${projectAgents.map((a) => a!.name).join(", ")} from ${projectDir}\nThese prompts come from the repository. Only continue if you trust it.`,
				);
				if (!ok) throw new Error("The user declined to run project agents.");
			}

			const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const extra = extraArgs();
			const progress: string[] = [];
			const report = (line: string) => {
				progress.push(line);
				onUpdate?.({ content: [{ type: "text", text: progress.join("\n") }], details: undefined });
			};

			const run = async (agentName: string, task: string, cwd?: string): Promise<RunResult> => {
				const agent: AgentConfig | undefined = agents.find((a) => a.name === agentName);
				const result: RunResult = { agent: agentName, task, exitCode: 1, output: "", stderr: "", turns: 0, cost: 0 };
				if (!agent) {
					result.errorMessage = `Unknown agent "${agentName}". Available: ${agents.map((a) => a.name).join(", ") || "none"}`;
					return result;
				}

				const args = ["--mode", "json", "-p", "--no-session"];
				const agentModel = agent.model ?? model;
				if (agentModel) args.push("--model", agentModel);
				const thinking = agent.thinking ?? (agent.model ? undefined : ctx.thinkingLevel);
				if (thinking) args.push("--thinking", thinking);
				if (agent.tools) args.push("--tools", agent.tools.join(","));

				const promptDir = await mkdtemp(join(tmpdir(), "pitk-subagent-"));
				try {
					if (agent.systemPrompt) {
						const promptFile = join(promptDir, `${agent.name.replace(/[^\w.-]+/g, "_")}.md`);
						await writeFile(promptFile, agent.systemPrompt, { encoding: "utf8", mode: 0o600 });
						args.push("--append-system-prompt", promptFile);
					}
					args.push(...extra, "--", `Task: ${task}`);

					report(`[${agentName}] started`);
					const invocation = piInvocation(args);
					result.exitCode = await new Promise<number>((resolve) => {
						const proc = spawn(invocation.command, invocation.args, {
							cwd: cwd ?? ctx.cwd,
							env: { ...process.env, [DEPTH_ENV]: String(depth + 1) },
							stdio: ["ignore", "pipe", "pipe"],
							windowsHide: true,
						});
						let buffer = "";
						const onLine = (line: string) => {
							let event: any;
							try {
								event = JSON.parse(line);
							} catch {
								return;
							}
							if (event.type === "message_end" && event.message?.role === "assistant") {
								const msg = event.message;
								result.turns++;
								result.cost += msg.usage?.cost?.total ?? 0;
								if (msg.stopReason) result.stopReason = msg.stopReason;
								if (msg.errorMessage) result.errorMessage = msg.errorMessage;
								const text = (msg.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
								if (text.trim()) result.output = text;
							} else if (event.type === "tool_execution_start") {
								report(`[${agentName}] ${event.toolName}`);
							}
						};
						proc.stdout.on("data", (chunk) => {
							buffer += chunk.toString();
							const lines = buffer.split("\n");
							buffer = lines.pop() ?? "";
							for (const l of lines) if (l.trim()) onLine(l);
						});
						proc.stderr.on("data", (chunk) => {
							result.stderr += chunk.toString();
						});
						proc.on("error", (err) => {
							result.stderr += err.message;
							resolve(1);
						});
						proc.on("close", (code) => {
							if (buffer.trim()) onLine(buffer);
							resolve(code ?? 1);
						});
						const kill = () => proc.kill();
						if (signal?.aborted) kill();
						else signal?.addEventListener("abort", kill, { once: true });
					});
					report(`[${agentName}] ${failed(result) ? "failed" : "done"} (${result.turns} turn(s))`);
					return result;
				} finally {
					await rm(promptDir, { recursive: true, force: true }).catch(() => undefined);
				}
			};

			const details = (mode: string, results: RunResult[]) => ({
				mode,
				results: results.map((r) => ({ agent: r.agent, exitCode: r.exitCode, stopReason: r.stopReason, turns: r.turns, cost: r.cost })),
			});

			if (params.agent && params.task) {
				const r = await run(params.agent, params.task, params.cwd);
				return { content: [{ type: "text", text: cap(resultText(r)) }], details: details("single", [r]), isError: failed(r) };
			}

			if (params.chain?.length) {
				const results: RunResult[] = [];
				let previous = "";
				for (const [i, step] of params.chain.entries()) {
					const r = await run(step.agent, step.task.replaceAll("{previous}", previous), step.cwd);
					results.push(r);
					if (failed(r)) {
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}):\n${cap(resultText(r))}` }],
							details: details("chain", results),
							isError: true,
						};
					}
					previous = r.output;
				}
				return { content: [{ type: "text", text: cap(previous || "(no output)") }], details: details("chain", results) };
			}

			const tasks = params.tasks ?? [];
			if (tasks.length > MAX_PARALLEL_TASKS) throw new Error(`At most ${MAX_PARALLEL_TASKS} parallel tasks, got ${tasks.length}`);
			const results = await mapLimit(tasks, MAX_CONCURRENCY, (t) => run(t.agent, t.task, t.cwd));
			const ok = results.filter((r) => !failed(r)).length;
			const sections = results.map((r) => `### [${r.agent}] ${failed(r) ? "failed" : "done"}\n\n${cap(resultText(r))}`);
			return {
				content: [{ type: "text", text: `Parallel: ${ok}/${results.length} succeeded\n\n${sections.join("\n\n---\n\n")}` }],
				details: details("parallel", results),
				isError: ok === 0,
			};
		},
	});
}
