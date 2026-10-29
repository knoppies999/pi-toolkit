import assert from "node:assert/strict";
import { test } from "node:test";
import { dangerousCommandReasons, gitPushProblem, matchProtectedPath, parseGitPushes } from "../extensions/guard/rules.ts";

const protectedBranches = ["main", "master"];
const problem = (command: string, current?: string) =>
	parseGitPushes(command)
		.map((p) => gitPushProblem(p, protectedBranches, current))
		.find(Boolean);

test("allows pushing a feature branch", () => {
	assert.equal(problem("git push origin feature/login"), undefined);
	assert.equal(problem("git push -u origin feature/login", "feature/login"), undefined);
	assert.equal(problem("git push", "feature/login"), undefined);
});

test("flags pushes to protected branches", () => {
	assert.match(problem("git push origin main")!, /protected branch "main"/);
	assert.match(problem("git push origin HEAD:master")!, /"master"/);
	assert.match(problem("git push origin feature:refs/heads/main")!, /"main"/);
	assert.match(problem("npm test && git push origin main")!, /"main"/);
	assert.match(problem("git -C ../other push origin main")!, /"main"/);
});

test("uses the current branch when no refspec is given", () => {
	assert.match(problem("git push", "main")!, /current branch "main"/);
	assert.match(problem("git push origin", "master")!, /current branch "master"/);
});

test("flags force pushes, deletes and --all", () => {
	assert.match(problem("git push --force origin feature")!, /force/);
	assert.match(problem("git push -f origin feature")!, /force/);
	assert.match(problem("git push origin +feature")!, /force/);
	assert.match(problem("git push --force-with-lease")!, /force/);
	assert.match(problem("git push origin --delete main")!, /deletes protected branch "main"/);
	assert.match(problem("git push --all origin")!, /every branch/);
});

test("ignores commands that only mention git push", () => {
	assert.deepEqual(parseGitPushes('echo "do not git push origin main"'), []);
	assert.deepEqual(parseGitPushes("git status"), []);
});

test("detects destructive commands", () => {
	assert.ok(dangerousCommandReasons("rm -rf build").length > 0);
	assert.ok(dangerousCommandReasons("rm -fr build").length > 0);
	assert.ok(dangerousCommandReasons("Remove-Item -Recurse -Force .\\bin").length > 0);
	assert.ok(dangerousCommandReasons("git reset --hard HEAD~1").length > 0);
	assert.ok(dangerousCommandReasons("git clean -fdx").length > 0);
	assert.deepEqual(dangerousCommandReasons("rm build/out.txt"), []);
	assert.deepEqual(dangerousCommandReasons("git reset HEAD file.cs"), []);
});

test("matches protected paths relative to cwd", () => {
	const cwd = process.platform === "win32" ? "C:\\repo" : "/repo";
	const globs = [".env", ".env.*", "**/*.pem", ".git/**", "**/package-lock.json"];
	assert.equal(matchProtectedPath(".env", cwd, globs), ".env");
	assert.equal(matchProtectedPath(".env.local", cwd, globs), ".env.*");
	assert.equal(matchProtectedPath("certs/dev/server.pem", cwd, globs), "**/*.pem");
	assert.equal(matchProtectedPath("server.PEM", cwd, globs), "**/*.pem");
	assert.equal(matchProtectedPath(".git/config", cwd, globs), ".git/**");
	assert.equal(matchProtectedPath("web/package-lock.json", cwd, globs), "**/package-lock.json");
	assert.equal(matchProtectedPath("src/env.ts", cwd, globs), undefined);
	assert.equal(matchProtectedPath("src/.envrc", cwd, globs), undefined);
});
