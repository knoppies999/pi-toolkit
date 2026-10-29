/**
 * Dotnet Extension
 *
 * Registers a `dotnet` tool that runs `dotnet build` or `dotnet test` and returns compact results:
 * unique compiler errors (and warnings on request) with file:line, and failed tests with message and
 * stack trace read from TRX files, instead of thousands of lines of MSBuild log.
 *
 * Test results use the VSTest TRX logger. Projects on Microsoft.Testing.Platform's `dotnet test` mode do
 * not accept `--logger`; for those the tool falls back to the tail of the console output.
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, truncateTail } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatDiagnostic, mergeRuns, parseMsBuildDiagnostics, parseTrx, type TestRun } from "./parse.ts";

const Params = Type.Object({
	action: StringEnum(["build", "test"] as const, { description: "build: compile and report errors. test: build and run tests, report failures." }),
	target: Type.Optional(Type.String({ description: "Solution, project or directory. Defaults to the working directory." })),
	configuration: Type.Optional(Type.String({ description: "Build configuration, e.g. Debug or Release (default Debug)" })),
	filter: Type.Optional(Type.String({ description: "dotnet test --filter expression, e.g. FullyQualifiedName~OrderTests" })),
	noBuild: Type.Optional(Type.Boolean({ description: "test only: skip the build (--no-build)" })),
	includeWarnings: Type.Optional(Type.Boolean({ description: "List warnings as well as errors (default false; the count is always shown)" })),
	timeoutSeconds: Type.Optional(Type.Number({ description: "Kill the command after this many seconds (default 600)" })),
});

const MAX_LISTED = 50;
const MAX_STACK_LINES = 8;

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "dotnet",
		label: "dotnet",
		description:
			"Run `dotnet build` or `dotnet test` and get a compact summary: compiler errors with file:line, and failed tests with message and stack trace. Prefer this over running dotnet through bash.",
		promptSnippet: "Build and test .NET solutions with compact error and test-failure output",
		promptGuidelines: [
			"Use the dotnet tool rather than bash for dotnet build and dotnet test.",
			"After fixing compile errors, run dotnet build again before running tests.",
			"Use filter to rerun only the failing tests while fixing them.",
		],
		parameters: Params,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const args = [params.action, ...(params.target ? [params.target] : []), "--nologo", "-c", params.configuration ?? "Debug"];
			let resultsDir: string | undefined;

			if (params.action === "build") {
				args.push("-v", "q", "-clp:NoSummary");
			} else {
				resultsDir = await mkdtemp(join(tmpdir(), "pi-dotnet-test-"));
				args.push("--logger", "trx;LogFilePrefix=pi", "--results-directory", resultsDir);
				if (params.filter) args.push("--filter", params.filter);
				if (params.noBuild) args.push("--no-build");
			}

			onUpdate?.({ content: [{ type: "text", text: `Running dotnet ${args.join(" ")}` }], details: undefined });
			const result = await pi.exec("dotnet", args, { cwd: ctx.cwd, signal, timeout: (params.timeoutSeconds ?? 600) * 1000 });
			const output = `${result.stdout}\n${result.stderr}`;

			const diagnostics = parseMsBuildDiagnostics(output, ctx.cwd);
			const errors = diagnostics.filter((d) => d.severity === "error");
			const warnings = diagnostics.filter((d) => d.severity === "warning");

			let run: TestRun | undefined;
			if (resultsDir) {
				const files = (await readdir(resultsDir).catch(() => [] as string[])).filter((f) => f.endsWith(".trx"));
				if (files.length > 0) run = mergeRuns(await Promise.all(files.map(async (f) => parseTrx(await readFile(join(resultsDir!, f), "utf8")))));
				await rm(resultsDir, { recursive: true, force: true }).catch(() => undefined);
			}

			const out: string[] = [`dotnet ${args.slice(0, args.indexOf("--nologo")).join(" ")}: exit code ${result.code}${result.killed ? " (killed: timeout or abort)" : ""}`];
			out.push(`${errors.length} error(s), ${warnings.length} warning(s)`);
			for (const d of errors.slice(0, MAX_LISTED)) out.push(formatDiagnostic(d));
			if (errors.length > MAX_LISTED) out.push(`... ${errors.length - MAX_LISTED} more errors`);
			if (params.includeWarnings) {
				for (const d of warnings.slice(0, MAX_LISTED)) out.push(formatDiagnostic(d));
				if (warnings.length > MAX_LISTED) out.push(`... ${warnings.length - MAX_LISTED} more warnings`);
			}

			if (run) {
				out.push("", `Tests: ${run.passed} passed, ${run.failed} failed, ${run.skipped} skipped, ${run.total} total`);
				for (const f of run.failures.slice(0, MAX_LISTED)) {
					out.push("", `FAILED ${f.name}`);
					if (f.message) out.push(`  ${f.message.replace(/\n/g, "\n  ")}`);
					if (f.stackTrace) out.push(...f.stackTrace.split(/\r?\n/).slice(0, MAX_STACK_LINES).map((l) => `  ${l.trim()}`));
				}
				if (run.failures.length > MAX_LISTED) out.push(`... ${run.failures.length - MAX_LISTED} more failures`);
			}

			// Nothing parsed but the command failed: show the end of the raw output so the model can see why.
			const explained = errors.length > 0 || (run !== undefined && (run.failed > 0 || result.code === 0));
			if (result.code !== 0 && !explained) {
				const tail = truncateTail(output.trim(), { maxLines: 80, maxBytes: 16 * 1024 });
				out.push("", "Output (tail):", tail.content);
			}

			const details = {
				exitCode: result.code,
				errors: errors.length,
				warnings: warnings.length,
				tests: run && { total: run.total, passed: run.passed, failed: run.failed, skipped: run.skipped },
			};
			const text = out.join("\n");
			if (result.code !== 0) return { content: [{ type: "text", text }], details, isError: true };
			return { content: [{ type: "text", text }], details };
		},
	});
}
