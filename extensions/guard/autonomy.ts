/**
 * Autonomous-mode policy for the guard. Pure, so it can be unit tested with `node --test`.
 *
 * - Opt-in parsing: only text the user typed can switch autonomous mode on (see index.ts).
 * - System-access checks: commands that reach databases, infrastructure, package registries or send
 *   HTTP writes. Their targets must be on an allowlist; with no detectable target they fail closed.
 */

import { globToRegExp, splitSegments, tokenize } from "./rules.ts";

export const AUTO_TOKEN = "--auto";

/**
 * Detect the opt-in in a typed prompt and strip it.
 * Accepted: `/pitk-ticket 4821 --auto ...` (any /pitk- command) and a prompt that starts with `--auto `.
 * A stray `--auto` elsewhere (pasted docs, a ticket body) does not count.
 */
export function parseAutoOptIn(text: string): { optIn: boolean; text: string } {
	const trimmed = text.trimStart();
	if (trimmed.startsWith(`${AUTO_TOKEN} `) || trimmed === AUTO_TOKEN) {
		return { optIn: true, text: trimmed.slice(AUTO_TOKEN.length).trimStart() };
	}
	if (/^\/pitk-[\w-]+/.test(trimmed)) {
		const firstLine = trimmed.split("\n", 1)[0];
		if (new RegExp(`(^|\\s)${AUTO_TOKEN}(\\s|$)`).test(firstLine)) {
			const stripped = firstLine.replace(new RegExp(`\\s+${AUTO_TOKEN}(?=\\s|$)`), "");
			return { optIn: true, text: stripped + trimmed.slice(firstLine.length) };
		}
	}
	return { optIn: false, text };
}

export const DEFAULT_ALLOW_HOSTS = ["localhost", "127.0.0.1", "::1", "0.0.0.0", ".", "(localdb)", "host.docker.internal", "*.localhost", "*.test"];

export const DEFAULT_SCHEMA_PATHS = ["**/Migrations/**", "**/migrations/**", "**/*.sql", "**/schema.prisma", "**/*.dacpac", "**/*.sqlproj"];

export interface SystemAccess {
	/** What kind of system the command reaches. */
	kind: "database" | "infrastructure" | "publish" | "http-write";
	/** The program, e.g. sqlcmd, kubectl, curl. */
	program: string;
	/** Hosts the command names. Empty when none can be found. */
	targets: string[];
	/** Infrastructure and publish commands have no allowlistable host; only allowCommands can permit them. */
	needsCommandAllow: boolean;
}

/** Reduce a server/host string to something comparable with the allowlist. */
export function normalizeHost(raw: string): string {
	let h = raw.trim().replace(/^['"]|['"]$/g, "").toLowerCase();
	h = h.replace(/^tcp:/, "");
	if (h.startsWith("(localdb)")) return "(localdb)";
	h = h.replace(/,\d+$/, ""); // SQL Server "host,1433"
	if (h.startsWith("[")) h = h.slice(1, h.indexOf("]")); // [::1]:5432
	else if ((h.match(/:/g) ?? []).length === 1) h = h.replace(/:\d+$/, "");
	h = h.split("\\")[0]; // instance name: host\SQLEXPRESS
	return h;
}

export function hostAllowed(host: string, allowHosts: string[]): boolean {
	const h = normalizeHost(host);
	return allowHosts.some((pattern) => {
		const p = pattern.toLowerCase();
		return p.includes("*") ? globToRegExp(p).test(h) : p === h;
	});
}

/** Hosts named in URLs and connection strings anywhere in the text. */
export function extractHosts(text: string): string[] {
	const hosts: string[] = [];
	for (const m of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s'"]+@)?(\[[^\]]+\]|[^/:\s'"?#,;]+)/gi)) hosts.push(m[1]);
	for (const m of text.matchAll(/\b(?:server|data source|host|address|addr|network address)\s*=\s*([^;'"]+)/gi)) hosts.push(m[1]);
	return hosts.map(normalizeHost).filter(Boolean);
}

function flagValue(tokens: string[], names: string[]): string[] {
	const values: string[] = [];
	tokens.forEach((t, i) => {
		for (const n of names) {
			if (t === n && tokens[i + 1]) values.push(tokens[i + 1]);
			else if (t.startsWith(`${n}=`)) values.push(t.slice(n.length + 1));
			else if (n.length === 2 && t.startsWith(n) && t.length > 2 && !t.startsWith("--")) values.push(t.slice(2)); // -Slocalhost
			else if (n.startsWith("/") && t.toLowerCase().startsWith(`${n.toLowerCase()}:`)) values.push(t.slice(n.length + 1)); // /tsn:host
		}
	});
	return values;
}

const program = (token: string) =>
	token
		.split(/[\\/]/)
		.pop()!
		.toLowerCase()
		.replace(/\.(exe|cmd|bat|ps1)$/, "");

const dbHostFlags: Record<string, string[]> = {
	sqlcmd: ["-S"],
	bcp: ["-S"],
	psql: ["-h", "--host"],
	pg_dump: ["-h", "--host"],
	pg_restore: ["-h", "--host"],
	mysql: ["-h", "--host"],
	mariadb: ["-h", "--host"],
	mysqldump: ["-h", "--host"],
	"redis-cli": ["-h"],
	mongosh: ["--host"],
	mongo: ["--host"],
	"invoke-sqlcmd": ["-ServerInstance", "-HostName"],
	sqlpackage: ["/TargetServerName", "/tsn", "/SourceServerName", "/ssn"],
	flyway: [],
	liquibase: [],
};

const infraPrograms = new Set(["kubectl", "helm", "terraform", "tofu", "pulumi", "az", "azd", "func", "aws", "gcloud", "ansible-playbook", "bicep", "kustomize"]);
// Subcommands that only print local information.
const harmlessInfra: Record<string, RegExp> = {
	"*": /^(--version|version|--help|-h|help)$/,
	terraform: /^(fmt|validate)$/,
	tofu: /^(fmt|validate)$/,
	bicep: /^(build|lint|format)$/,
	kustomize: /^(build)$/,
	helm: /^(template|lint|dependency)$/,
};

/** Find every place a command reaches a database, infrastructure, a registry, or sends an HTTP write. */
export function findSystemAccess(command: string): SystemAccess[] {
	const found: SystemAccess[] = [];
	for (const segment of splitSegments(command)) {
		const tokens = tokenize(segment);
		if (tokens.length === 0) continue;
		const prog = program(tokens[0]);
		const args = tokens.slice(1);
		const sub = args.find((a) => !a.startsWith("-"));

		if (prog in dbHostFlags) {
			const targets = [...flagValue(tokens, dbHostFlags[prog]).map(normalizeHost), ...extractHosts(segment)];
			found.push({ kind: "database", program: prog, targets: [...new Set(targets)], needsCommandAllow: false });
			continue;
		}

		if (prog === "dotnet" && args[0] === "ef" && args[1] === "database") {
			const conn = flagValue(tokens, ["--connection"]).join(" ");
			found.push({ kind: "database", program: "dotnet ef", targets: extractHosts(conn), needsCommandAllow: false });
			continue;
		}

		if (infraPrograms.has(prog)) {
			const harmless = harmlessInfra["*"].test(sub ?? args[0] ?? "") || (harmlessInfra[prog]?.test(sub ?? "") ?? false);
			if (!harmless) found.push({ kind: "infrastructure", program: prog, targets: [], needsCommandAllow: true });
			continue;
		}

		const publish =
			(prog === "npm" || prog === "pnpm" || prog === "yarn") && sub === "publish"
				? `${prog} publish`
				: (prog === "dotnet" && args[0] === "nuget" && args[1] === "push") || (prog === "nuget" && sub === "push")
					? "nuget push"
					: prog === "docker" && (sub === "push" || sub === "login")
						? `docker ${sub}`
						: prog === "twine" && sub === "upload"
							? "twine upload"
							: prog === "gh" && args[0] === "release" && args[1] === "create"
								? "gh release create"
								: undefined;
		if (publish) {
			found.push({ kind: "publish", program: publish, targets: [], needsCommandAllow: true });
			continue;
		}

		const isWriteMethod = (m?: string) => /^(post|put|patch|delete)$/i.test(m ?? "");
		let httpWrite = false;
		if (prog === "curl") {
			httpWrite =
				isWriteMethod(flagValue(tokens, ["-X", "--request"])[0]) ||
				args.some((a) => /^(-d|--data|--data-raw|--data-binary|--data-urlencode|-F|--form|-T|--upload-file|--json)(=|$)/.test(a) || /^-d./.test(a));
		} else if (prog === "wget") {
			httpWrite = args.some((a) => /^--(post-data|post-file|body-data|body-file)/.test(a)) || isWriteMethod(flagValue(tokens, ["--method"])[0]);
		} else if (["invoke-webrequest", "invoke-restmethod", "iwr", "irm"].includes(prog)) {
			httpWrite = isWriteMethod(flagValue(tokens, ["-Method"])[0]) || args.some((a) => /^-Body$/i.test(a));
		} else if (prog === "http" || prog === "https" || prog === "xh") {
			httpWrite = isWriteMethod(sub);
		}
		if (httpWrite) found.push({ kind: "http-write", program: prog, targets: extractHosts(segment), needsCommandAllow: false });
	}
	return found;
}

/**
 * Decide whether a system access is permitted. Returns the reason it is not, or undefined.
 * `allowCommands` are regular expressions matched against the whole command, for deliberate exceptions.
 */
export function systemAccessProblem(access: SystemAccess, command: string, allowHosts: string[], allowCommands: string[]): string | undefined {
	if (allowCommands.some((re) => new RegExp(re).test(command))) return undefined;
	if (access.needsCommandAllow) return `${access.kind} command (${access.program}) is not on the allowCommands list`;
	if (access.targets.length === 0) {
		return `${access.kind} command (${access.program}) without an explicit host; name an allowlisted host such as localhost`;
	}
	const bad = access.targets.filter((t) => !hostAllowed(t, allowHosts));
	if (bad.length > 0) return `${access.kind} command (${access.program}) targets ${bad.join(", ")}, which is not on the allowHosts list`;
	return undefined;
}

/** Environment variables that look like connection strings to hosts outside the allowlist. Names only. */
export function riskyEnvVars(env: Record<string, string | undefined>, allowHosts: string[]): string[] {
	return Object.entries(env)
		.filter(([name, value]) => {
			if (!value || !/(conn|database|db_|_db|dsn|sql|redis|mongo|postgres|mysql|cosmos|servicebus|storage)/i.test(name)) return false;
			const hosts = extractHosts(value);
			return hosts.some((h) => !hostAllowed(h, allowHosts));
		})
		.map(([name]) => name)
		.sort();
}
