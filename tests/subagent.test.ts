import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadAgentsFromDir, mergeAgents, parseAgent, parseToolList } from "../extensions/subagent/agents.ts";

test("parses tool lists in both YAML spellings", () => {
	assert.deepEqual(parseToolList("read, grep ,find"), ["read", "grep", "find"]);
	assert.deepEqual(parseToolList(["read", "bash"]), ["read", "bash"]);
	assert.equal(parseToolList(""), undefined);
	assert.equal(parseToolList(42), undefined);
});

test("parses an agent file", () => {
	const agent = parseAgent("---\nname: scout\ndescription: Finds code\ntools: read, grep\n---\n\nYou are a scout.\n", "user", "/x/scout.md");
	assert.equal(agent?.name, "scout");
	assert.deepEqual(agent?.tools, ["read", "grep"]);
	assert.equal(agent?.systemPrompt, "You are a scout.");
	assert.equal(parseAgent("---\nname: nodesc\n---\nbody", "user", "/x/nodesc.md"), undefined);
});

test("later sources override earlier ones by name", () => {
	const base = { description: "d", systemPrompt: "", filePath: "" };
	const merged = mergeAgents(
		[{ ...base, name: "scout", source: "bundled" }, { ...base, name: "planner", source: "bundled" }],
		[{ ...base, name: "scout", source: "user" }],
	);
	assert.deepEqual(
		merged.map((a) => `${a.name}:${a.source}`),
		["scout:user", "planner:bundled"],
	);
});

test("bundled agents are all valid", () => {
	const agents = loadAgentsFromDir(fileURLToPath(new URL("../agents", import.meta.url)), "bundled");
	assert.deepEqual(agents.map((a) => a.name).sort(), ["implementer", "planner", "reviewer", "scout", "tester"]);
	for (const a of agents) assert.ok(a.systemPrompt.length > 100, `${a.name} has a system prompt`);
	assert.deepEqual(agents.find((a) => a.name === "scout")?.tools, ["read", "grep", "find", "ls"]);
});
