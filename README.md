# pi-toolkit

A [Pi](https://pi.dev) package for day-to-day work on .NET, TypeScript and Azure DevOps codebases:

| Resource | Type | What it does |
|---|---|---|
| `guard` | extension (hook) | Asks before, or blocks, `git push` to main/master, force pushes, `rm -rf`-style commands, edits to secrets, keys, lockfiles and `.git/`, databases and systems outside an allowlist, and opening pull requests. Also provides [autonomous mode](#autonomous-mode) |
| `pitk_subagent` | extension (tool) | Runs agents in separate `pi` processes with their own context: one, several in parallel, or chained |
| `pitk_azure_devops` | extension (tool) | Azure DevOps PRs (details, changed files, comment threads), work items, and opening PRs linked to work items |
| `pitk_dotnet` | extension (tool) | Runs `dotnet build` / `dotnet test` and returns only errors with file:line and failed tests with message and stack trace |
| `scout`, `planner`, `implementer`, `tester`, `reviewer` | agents | Bundled agent definitions for `pitk_subagent` |
| `coordinator` | skill | Split a task into pieces, delegate them to subagents, keep the plan and decisions in the main session |
| `ticket-to-pr` | skill | Work item to pull request: read, investigate, plan, implement, test, self-review, open the PR. Stops for approval after the plan and before the PR |
| `pr-review` | skill | A review procedure: get the change, understand it, check correctness, security, breaking changes and tests, report ranked findings |
| `dotnet-conventions` | skill | C# / .NET conventions to apply where the repository has none of its own |
| `typescript` | skill | TypeScript conventions and the type-check / lint / test loop |
| `vitest` | skill | Running, writing, mocking and debugging Vitest tests |
| `playwright-mcp` | skill | Driving a browser through the Playwright MCP server, and turning the flow into a Playwright test |
| `/pitk-review` | prompt template | `/pitk-review [PR id or branch] [focus]` runs the `pr-review` skill |
| `/pitk-ticket` | prompt template | `/pitk-ticket <work item id> [notes]` runs the `ticket-to-pr` skill |

The skills follow the [Agent Skills](https://agentskills.io) format, so the same `SKILL.md` files also work in Claude Code and GitHub Copilot.

Tool and prompt names start with `pitk_` / `pitk-` on purpose. Pi refuses to start when two extensions register a tool with the same name, so generic names like `dotnet` would clash with other packages. If another package also offers a dotnet or Azure DevOps tool, turn one of them off with `pi config` so the model has only one to choose from.

## Install

```bash
pi install git:github.com/knoppies999/pi-toolkit
```

Pin a version with a tag, for example `git:github.com/knoppies999/pi-toolkit@v0.1.0`. Add `-l` to install it for the current project only (written to `.pi/settings.json`).

Try it for one session without installing:

```bash
pi -e git:github.com/knoppies999/pi-toolkit
```

Load only some of it by using the object form in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/knoppies999/pi-toolkit",
      "extensions": ["extensions/guard/index.ts", "extensions/dotnet/index.ts"],
      "skills": []
    }
  ]
}
```

## guard

Hooks Pi's `tool_call` event. When the agent tries one of the following, you get a confirmation dialog. In print or RPC mode, where there is no UI, the call is blocked.

- `git push` that targets a protected branch, either named (`git push origin main`, `HEAD:main`) or the current branch (`git push` while on `main`)
- force pushes (`--force`, `-f`, `--force-with-lease`, `+refspec`), `--all`, `--mirror` and branch deletes
- `rm -rf`, `Remove-Item -Recurse -Force`, `git reset --hard`, `git clean -f`, `git checkout .`, `git branch -D`
- `write` or `edit` of `.env`, `.env.*`, `*.pem`, `*.pfx`, `*.key`, `secrets.json`, `.git/**` and lockfiles
- opening a pull request with `pitk_azure_devops` `pr_create` (asked about; allowed only in [autonomous mode](#autonomous-mode))
- commands that reach **databases** (`sqlcmd`, `psql`, `mysql`, `mongosh`, `redis-cli`, `Invoke-Sqlcmd`, `sqlpackage`, `dotnet ef database ...`) or send **HTTP writes** (`curl -X POST`, `-d`, `Invoke-RestMethod -Method Post`, ...) to a host that is not on `allowHosts`, or with no explicit host at all
- **infrastructure and publishing** commands (`kubectl`, `helm`, `terraform`, `az`, `azd`, `func`, `aws`, `gcloud`, `npm publish`, `dotnet nuget push`, `docker push`, ...) unless they match `allowCommands`. Read-only forms such as `--version`, `terraform validate` and `helm template` are fine.

It checks both the `bash` and the `powershell` tools. Commands you type yourself with `!` are not checked.

Run `/guard` to see the active rules.

### Configuration

Personal config, `~/.pi/agent/guard.json`. Every key is optional:

```json
{
  "mode": "confirm",
  "protectedBranches": ["main", "master", "develop"],
  "extraPaths": ["**/appsettings.Production.json"],
  "dangerousCommands": true,
  "extraAllowHosts": ["sql-dev-01", "*.dev.contoso.internal"],
  "allowCommands": ["^kubectl --context kind-dev\\b", "^docker push localhost:5000/"]
}
```

- `mode`: `"confirm"` asks; `"block"` always blocks.
- `protectedPaths` replaces the default list; `extraPaths` adds to it.
- `allowHosts` replaces the default host allowlist (`localhost`, `127.0.0.1`, `::1`, `(localdb)`, `.`, `host.docker.internal`, `*.localhost`, `*.test`); `extraAllowHosts` adds to it. `*` matches within a host name.
- `allowCommands`: regular expressions matched against the whole command, for infrastructure or publish commands you deliberately allow.
- `schemaPaths`: files whose change needs a human decision in autonomous mode (default: `**/Migrations/**`, `**/migrations/**`, `**/*.sql`, `**/schema.prisma`, `**/*.dacpac`, `**/*.sqlproj`).

Project config, `.pi/guard.json` in the repository, can only **add** protection (`protectedBranches`, `protectedPaths`, `extraPaths`, `schemaPaths`, `"mode": "block"`). It cannot add `allowHosts` or `allowCommands`. That way a repository you clone cannot switch the guard off or widen what it may reach. If either file contains invalid JSON, every tool call is blocked until you fix it.

Branch names match exactly. Globs like `release/*` are not supported yet.

## pitk_azure_devops

Actions: `pr_list`, `pr_get` (with linked work items), `pr_changes` (files in the latest iteration), `pr_threads` (review comments, without system messages), `work_item`, and `pr_create`.

`pr_create` is the only action that changes anything. It opens a pull request from an already pushed branch (default: the current branch) into the repository's default branch (or `targetBranch`), with `title`, `description`, `draft` and `workItemIds` to link work items. The guard asks you before every call; with no UI (print mode, subagents) it is blocked.

The organization, project and repository come from the `origin` remote when Pi runs inside an Azure Repos clone. Every common remote form is understood: `dev.azure.com`, `visualstudio.com` and SSH. Outside a clone, pass `orgUrl`, `project` and `repository`, or set `AZURE_DEVOPS_ORG_URL` and `AZURE_DEVOPS_PROJECT`.

### Authentication

The first one that is available is used:

1. **Personal access token**: `AZURE_DEVOPS_PAT` (or `AZURE_DEVOPS_EXT_PAT`, the variable `az devops` uses). It needs the **Code (Read)** and **Work Items (Read)** scopes, and **Code (Read & write)** for `pr_create`.
2. **Azure CLI**: an Entra ID token from `az account get-access-token`, if `az` is installed and you have run `az login`. Use this if your organization restricts PATs.
3. **Azure Pipelines**: `SYSTEM_ACCESSTOKEN`.

Set the PAT for your user on Windows, then start a new terminal:

```powershell
[Environment]::SetEnvironmentVariable("AZURE_DEVOPS_PAT", "<token>", "User")
```

If you get HTTP 401 or 203 even though the token is valid, check whether your organization has Conditional Access policies that block tokens from your current network.

## pitk_dotnet

```text
pitk_dotnet  action=build                                   -> errors with file:line, warning count
pitk_dotnet  action=test  filter=FullyQualifiedName~Orders  -> pass/fail counts, failed tests with message and stack
```

Optional arguments: `target` (solution, project or folder), `configuration`, `noBuild`, `includeWarnings` and `timeoutSeconds` (default 600).

Test results come from the VSTest TRX logger. Repositories that opt `dotnet test` into Microsoft.Testing.Platform mode (in `global.json`) do not accept `--logger`. For those, the tool returns the tail of the console output instead.

## pitk_subagent

Each subagent is a separate `pi` process (`pi --mode json -p --no-session`) with its own context window. It uses your current model unless the agent file sets one, and its final answer comes back as the tool result.

```json
{ "agent": "scout", "task": "Find where orders are priced and how it is tested" }
{ "tasks": [ { "agent": "scout", "task": "..." }, { "agent": "scout", "task": "..." } ] }
{ "chain": [ { "agent": "scout", "task": "..." }, { "agent": "planner", "task": "Plan the change using: {previous}" } ] }
```

Parallel mode runs up to 8 tasks, 4 at a time. In a chain, `{previous}` is replaced by the previous step's answer, and the chain stops at the first failure.

### Agents

An agent is a Markdown file: frontmatter plus a body that is appended to the subagent's system prompt.

```markdown
---
name: scout
description: Fast read-only reconnaissance
tools: read, grep, find, ls      # optional allowlist; default is pi's default tools
model: anthropic/claude-haiku-5-5  # optional; default is your current model
thinking: low                    # optional
---

You are a scout. ...
```

Sources, later ones replacing earlier ones with the same name:

1. this package's `agents/` (scout, planner, implementer, tester, reviewer)
2. `~/.pi/agent/agents/`
3. the project's `.pi/agents/`, only with `agentScope: "all"`. In a project you have not trusted, you are asked first, because those prompts come from the repository.

`/pitk-agents` lists what is available.

### Safety

- Subagents load the same packages as you, including `guard`, but have no UI, so guard **blocks** what it would otherwise ask about: pushing to protected branches, destructive commands, protected files, opening PRs. Do those steps in the main session.
- Subagents cannot start subagents. `PITK_SUBAGENT_MAX_DEPTH` (default `1`) raises the limit.
- `PITK_SUBAGENT_ARGS` adds arguments to every subagent process, as a JSON array, for example `["--offline"]`.

## Coordinator and ticket-to-pr

The `coordinator` skill is the pattern for bigger tasks. The main session frames the goal, sends parallel scouts, has the planner write a plan it then checks, sends steps to implementers one at a time, has the tester verify, has the reviewer review, and reports. Ask for it ("use the coordinator skill to ...") or let the model pick it.

`/pitk-ticket 4821` runs `ticket-to-pr` for a work item:

1. read the work item and its acceptance criteria
2. create a branch from the latest target branch
3. investigate (and reproduce, for a bug)
4. **checkpoint: you approve the plan**
5. implement with tests, committing with `AB#4821`
6. build and run unit and end-to-end tests
7. self-review with `pr-review`
8. **checkpoint: you approve the diff, test results and PR text**
9. push and open the PR linked to the work item (guard asks once more)

It works without `pitk_subagent` too; it then does every step in the main session.

## Autonomous mode

For ticket to PR with no human in the loop, add `--auto`:

```text
/pitk-ticket 4821 --auto
--auto use the coordinator skill to add a 50% cap to discounts, with tests
/pitk-auto on        (or off, or status)
```

Only text **you** type can switch it on: `--auto` on a `/pitk-` command line, at the start of a prompt, or `/pitk-auto on`. The same words in a ticket, a file, a web page or another extension's message do nothing. The footer shows `AUTONOMOUS` while it is on; it stays on for the session until `/pitk-auto off`.

What changes:

| | Normal | Autonomous |
|---|---|---|
| Skill checkpoints (plan, before PR) | stop and wait for you | skipped; the plan and test results go into the PR description |
| Guard: push to protected branch, force push, destructive commands, secrets, lockfiles | asks you | **blocked** |
| Guard: databases, HTTP writes, infrastructure, publishing outside the allowlist | asks you | **blocked** |
| Guard: schema files and `dotnet ef migrations add` | allowed (the plan checkpoint covers it) | **blocked**: needs your decision |
| Opening the PR (`pr_create`) | asks you | allowed, as a ready PR, or a draft if tests are still red after 3 attempts |
| Merging, completing or approving the PR | not possible | not possible |

The agent stops early only for decisions it is not allowed to make: requirements that are unclear in a way that changes the outcome, schema changes, breaking API or contract changes, or a step the guard blocks. It ends its turn with `NEEDS DECISION:` and the question. You get a Windows notification when the run finishes or needs you.

### Production safety: the guard is the second line

The guard reads commands, so it cannot prove an action never touches production. A connection string read from `appsettings.json` by your app, a test that calls a real API, or an unusual tool can get past it. Make sure the agent **cannot** reach production in the first place:

- Do not keep production connection strings or keys in the environment of the terminal you run Pi in. When autonomous mode switches on, the guard lists environment variables that look like connection strings to non-allowlisted hosts (names only) and tells the model not to use them.
- Log `az` in to a dev subscription only, and use a kube context that cannot reach production.
- Keep production settings out of the files the app loads in Development (`appsettings.Development.json`, user secrets).
- Keep branch policies on `main` in Azure DevOps: required reviewers and build validation still apply to every PR the agent opens.

## Develop

```bash
git clone https://github.com/knoppies999/pi-toolkit
cd pi-toolkit
npm install
npm run check   # TypeScript
npm test        # node --test, no build step (Node 22.19+ runs .ts directly)
```

Point Pi at your working copy. Local packages load in place, so edits show up after `/reload`:

```bash
pi install ./
```

Layout:

```text
extensions/<name>/index.ts   entry point Pi loads (listed in package.json "pi.extensions")
extensions/<name>/*.ts       logic split out of the entry point, covered by tests/
agents/*.md                  bundled agent definitions for pitk_subagent
skills/<name>/SKILL.md       Agent Skills
prompts/*.md                 prompt templates; the file name is the command
```

The Pi host packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `typebox`) are peer dependencies. Pi provides them at runtime, so they are never bundled.

## License

MIT
