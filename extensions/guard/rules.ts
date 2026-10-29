/**
 * Pure rule logic for the guard extension. No Pi imports, so it can be unit tested with `node --test`.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

export interface GitPushTarget {
	/** Directory the push runs in (from `git -C <dir>`), relative to the tool's cwd. */
	dir?: string;
	/** Destination branches named in refspecs. Empty when the push relies on the current branch. */
	branches: string[];
	force: boolean;
	/** `--all` or `--mirror`: pushes every branch. */
	everything: boolean;
	deletes: boolean;
}

/** Split a shell command into simple segments on `&&`, `||`, `;`, `|` and newlines. */
export function splitSegments(command: string): string[] {
	return command
		.split(/&&|\|\||[;|\n]/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Whitespace tokenizer that understands single and double quotes. Good enough for flag inspection. */
export function tokenize(segment: string): string[] {
	const tokens: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	for (const m of segment.matchAll(re)) tokens.push(m[1] ?? m[2] ?? m[3]);
	return tokens;
}

/** Find every `git push` in a command and describe what it would push. */
export function parseGitPushes(command: string): GitPushTarget[] {
	const pushes: GitPushTarget[] = [];
	for (const segment of splitSegments(command)) {
		const tokens = tokenize(segment);
		const gitIndex = tokens.findIndex((t) => t === "git" || t.endsWith("/git") || t.toLowerCase().endsWith("git.exe"));
		if (gitIndex === -1) continue;

		// Skip git's global options (`-C dir`, `-c key=value`, `--no-pager`, ...) to find the subcommand.
		let i = gitIndex + 1;
		let dir: string | undefined;
		while (i < tokens.length && tokens[i].startsWith("-")) {
			if (tokens[i] === "-C") dir = tokens[i + 1];
			i += tokens[i] === "-C" || tokens[i] === "-c" ? 2 : 1;
		}
		if (tokens[i] !== "push") continue;

		const target: GitPushTarget = { dir, branches: [], force: false, everything: false, deletes: false };
		const positional: string[] = [];
		for (const arg of tokens.slice(i + 1)) {
			if (arg === "--force" || arg === "-f" || arg.startsWith("--force-with-lease") || arg === "--force-if-includes") {
				target.force = true;
			} else if (arg === "--all" || arg === "--mirror" || arg === "--branches") {
				target.everything = true;
			} else if (arg === "--delete" || arg === "-d") {
				target.deletes = true;
			} else if (/^-[a-zA-Z]+$/.test(arg) && arg.includes("f")) {
				target.force = true;
			} else if (!arg.startsWith("-")) {
				positional.push(arg);
			}
		}

		// positional[0] is the remote; the rest are refspecs.
		for (const refspec of positional.slice(1)) {
			let spec = refspec;
			if (spec.startsWith("+")) {
				target.force = true;
				spec = spec.slice(1);
			}
			if (spec.startsWith(":")) target.deletes = true;
			const dest = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : spec;
			if (dest && dest !== "HEAD") target.branches.push(dest.replace(/^refs\/heads\//, ""));
		}
		pushes.push(target);
	}
	return pushes;
}

/**
 * Decide whether a push touches a protected branch.
 * `currentBranch` is used when the push names no destination (plain `git push` or `git push origin`).
 */
export function gitPushProblem(push: GitPushTarget, protectedBranches: string[], currentBranch?: string): string | undefined {
	const isProtected = (b: string) => protectedBranches.includes(b);
	if (push.everything) return "pushes every branch (--all/--mirror)";
	const hit = push.branches.find(isProtected);
	if (hit) return `${push.deletes ? "deletes" : push.force ? "force-pushes" : "pushes"} protected branch "${hit}"`;
	if (push.branches.length === 0 && currentBranch && isProtected(currentBranch)) {
		return `pushes the current branch "${currentBranch}", which is protected`;
	}
	if (push.force) return "force-pushes";
	return undefined;
}

const dangerousCommands: { pattern: RegExp; reason: string }[] = [
	{ pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|--recursive\s+--force|--force\s+--recursive)\b/, reason: "recursive force delete (rm -rf)" },
	{ pattern: /\bRemove-Item\b(?=.*-Recurse)(?=.*-Force)/i, reason: "recursive force delete (Remove-Item -Recurse -Force)" },
	{ pattern: /\bgit\s+reset\s+--hard\b/, reason: "discards uncommitted work (git reset --hard)" },
	{ pattern: /\bgit\s+clean\s+-[a-zA-Z]*f/, reason: "deletes untracked files (git clean -f)" },
	{ pattern: /\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/, reason: "discards working tree changes" },
	{ pattern: /\bgit\s+branch\s+-D\b/, reason: "force-deletes a branch (git branch -D)" },
];

/** Return the reasons a shell command is destructive. Empty when it looks safe. */
export function dangerousCommandReasons(command: string): string[] {
	return dangerousCommands.filter((d) => d.pattern.test(command)).map((d) => d.reason);
}

/** Convert a small glob (`*`, `**`, `?`) to a RegExp. Matching is case-insensitive, for Windows. */
export function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") {
			// `**/` matches zero or more directories.
			if (glob[i + 2] === "/") {
				re += "(?:.*/)?";
				i += 2;
			} else {
				re += ".*";
				i += 1;
			}
		} else if (c === "*") {
			re += "[^/]*";
		} else if (c === "?") {
			re += "[^/]";
		} else {
			re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${re}$`, "i");
}

/**
 * Return the first protected-path glob a file matches, or undefined.
 * Globs are matched against the path relative to `cwd` with forward slashes. Files outside `cwd` are matched by absolute path.
 */
export function matchProtectedPath(filePath: string, cwd: string, globs: string[]): string | undefined {
	const absolute = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
	let rel = relative(cwd, absolute);
	if (rel.startsWith("..") || isAbsolute(rel)) rel = absolute;
	const normalized = rel.split(sep).join("/");
	return globs.find((g) => globToRegExp(g).test(normalized));
}
