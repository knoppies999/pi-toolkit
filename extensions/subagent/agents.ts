/**
 * Agent discovery for pitk_subagent.
 *
 * Agents are Markdown files with frontmatter (name, description, optional tools and model) whose body is
 * appended to the subagent's system prompt. Sources, later ones overriding earlier ones by name:
 * 1. bundled: this package's agents/ directory
 * 2. user:    ~/.pi/agent/agents/
 * 3. project: the nearest .pi/agents/ above the working directory (only when asked for, see index.ts)
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentSource = "bundled" | "user" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	thinking?: unknown;
};

/** Accept `tools: read, bash` and `tools: [read, bash]`; anything else means "default tools". */
export function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

/** Parse one agent file. Returns undefined when name or description is missing. */
export function parseAgent(content: string, source: AgentSource, filePath: string): AgentConfig | undefined {
	const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);
	if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") return undefined;
	return {
		name: frontmatter.name,
		description: frontmatter.description,
		tools: parseToolList(frontmatter.tools),
		model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
		thinking: typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined,
		systemPrompt: body.trim(),
		source,
		filePath,
	};
}

export function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	if (!existsSync(dir)) return [];
	const agents: AgentConfig[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.name.endsWith(".md") || !(entry.isFile() || entry.isSymbolicLink())) continue;
		const filePath = join(dir, entry.name);
		try {
			// One bad file must not hide every other agent.
			const agent = parseAgent(readFileSync(filePath, "utf8"), source, filePath);
			if (agent) agents.push(agent);
		} catch {
			continue;
		}
	}
	return agents;
}

export function findProjectAgentsDir(cwd: string): string | undefined {
	let dir = cwd;
	while (true) {
		const candidate = join(dir, ".pi", "agents");
		try {
			if (statSync(candidate).isDirectory()) return candidate;
		} catch {
			// keep walking up
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** Merge agent lists; a later list replaces agents of the same name from an earlier one. */
export function mergeAgents(...lists: AgentConfig[][]): AgentConfig[] {
	const byName = new Map<string, AgentConfig>();
	for (const list of lists) for (const agent of list) byName.set(agent.name, agent);
	return [...byName.values()];
}
