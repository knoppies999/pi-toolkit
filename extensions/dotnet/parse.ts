/**
 * Parsers for MSBuild console output and VSTest TRX files. Pure, so they can be unit tested with `node --test`.
 */

import { isAbsolute, relative } from "node:path";

export interface Diagnostic {
	severity: "error" | "warning";
	code: string;
	message: string;
	file?: string;
	line?: number;
	column?: number;
	project?: string;
}

// `File.cs(12,5): error CS1002: ; expected [Proj.csproj]` and `MSBUILD : error MSB1009: ...`
const diagnosticLine =
	/^\s*(?<origin>.+?)(?:\((?<line>\d+)(?:,(?<col>\d+))?(?:,\d+,\d+)?\))?\s*:\s*(?<sev>error|warning)\s+(?<code>[A-Za-z]+\d+)\s*:\s*(?<msg>.*?)(?:\s+\[(?<proj>[^\]]+)\])?\s*$/;

/** Extract unique errors and warnings from `dotnet build` / `dotnet test` output. */
export function parseMsBuildDiagnostics(output: string, cwd?: string): Diagnostic[] {
	const seen = new Set<string>();
	const diagnostics: Diagnostic[] = [];
	const rel = (p: string) => (cwd && isAbsolute(p) ? relative(cwd, p) || p : p);

	for (const raw of output.split(/\r?\n/)) {
		const m = raw.match(diagnosticLine);
		if (!m?.groups) continue;
		const g = m.groups;
		const hasLocation = g.line !== undefined;
		// Tool origins such as `MSBUILD`, `CSC` or `NETSDK` are not files.
		const isTool = !hasLocation && !/[\\/.]/.test(g.origin);
		const d: Diagnostic = {
			severity: g.sev as "error" | "warning",
			code: g.code,
			message: g.msg.trim(),
			file: isTool ? undefined : rel(g.origin.trim()),
			line: hasLocation ? Number(g.line) : undefined,
			column: g.col ? Number(g.col) : undefined,
			project: g.proj ? rel(g.proj) : undefined,
		};
		// MSBuild prints each diagnostic again in the summary; keep the first.
		const key = `${d.severity}|${d.code}|${d.file}|${d.line}|${d.column}|${d.message}`;
		if (seen.has(key)) continue;
		seen.add(key);
		diagnostics.push(d);
	}
	return diagnostics;
}

export function formatDiagnostic(d: Diagnostic): string {
	const where = d.file ? `${d.file}${d.line ? `(${d.line}${d.column ? `,${d.column}` : ""})` : ""}: ` : "";
	return `${where}${d.severity} ${d.code}: ${d.message}`;
}

export interface TestFailure {
	name: string;
	message?: string;
	stackTrace?: string;
}

export interface TestRun {
	total: number;
	passed: number;
	failed: number;
	skipped: number;
	failures: TestFailure[];
}

function decodeXml(s: string): string {
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
		.replace(/&amp;/g, "&");
}

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

/** Parse one VSTest TRX document. */
export function parseTrx(xml: string): TestRun {
	const run: TestRun = { total: 0, passed: 0, failed: 0, skipped: 0, failures: [] };

	const counters = xml.match(/<Counters\b[^>]*>/)?.[0];
	if (counters) {
		run.total = Number(attr(counters, "total") ?? 0);
		run.passed = Number(attr(counters, "passed") ?? 0);
		run.failed = Number(attr(counters, "failed") ?? 0);
		run.skipped = Number(attr(counters, "notExecuted") ?? 0);
	}

	for (const m of xml.matchAll(/<UnitTestResult\b([^>]*?)(?:\/>|>([\s\S]*?)<\/UnitTestResult>)/g)) {
		const tag = m[1];
		if (attr(tag, "outcome") !== "Failed") continue;
		const body = m[2] ?? "";
		const message = body.match(/<Message>([\s\S]*?)<\/Message>/)?.[1];
		const stackTrace = body.match(/<StackTrace>([\s\S]*?)<\/StackTrace>/)?.[1];
		run.failures.push({
			name: decodeXml(attr(tag, "testName") ?? "unknown"),
			message: message ? decodeXml(message).trim() : undefined,
			stackTrace: stackTrace ? decodeXml(stackTrace).trim() : undefined,
		});
	}
	return run;
}

/** Add several TRX runs together (one per test project). */
export function mergeRuns(runs: TestRun[]): TestRun {
	return runs.reduce<TestRun>(
		(acc, r) => ({
			total: acc.total + r.total,
			passed: acc.passed + r.passed,
			failed: acc.failed + r.failed,
			skipped: acc.skipped + r.skipped,
			failures: [...acc.failures, ...r.failures],
		}),
		{ total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
	);
}
