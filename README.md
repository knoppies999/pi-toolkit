# pi-toolkit

A [Pi](https://pi.dev) package for day-to-day work on .NET and Azure DevOps codebases:

| Resource | Type | What it does |
|---|---|---|
| `guard` | extension (hook) | Asks before, or blocks, `git push` to main/master, force pushes, `rm -rf`-style commands, and edits to secrets, keys, lockfiles and `.git/` |
| `pitk_azure_devops` | extension (tool) | Read-only access to Azure DevOps PRs (details, changed files, comment threads) and work items |
| `pitk_dotnet` | extension (tool) | Runs `dotnet build` / `dotnet test` and returns only errors with file:line and failed tests with message and stack trace |
| `pr-review` | skill | A review procedure: get the change, understand it, check correctness, security, breaking changes and tests, report ranked findings |
| `dotnet-conventions` | skill | C# / .NET conventions to apply where the repository has none of its own |
| `/pitk-review` | prompt template | `/pitk-review [PR id or branch] [focus]` runs the `pr-review` skill |

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

It checks both the `bash` and the `powershell` tools. Commands you type yourself with `!` are not checked.

Run `/guard` to see the active rules.

### Configuration

Personal config, `~/.pi/agent/guard.json`. Every key is optional:

```json
{
  "mode": "confirm",
  "protectedBranches": ["main", "master", "develop"],
  "extraPaths": ["**/appsettings.Production.json"],
  "dangerousCommands": true
}
```

- `mode`: `"confirm"` asks; `"block"` always blocks.
- `protectedPaths` replaces the default list; `extraPaths` adds to it.

Project config, `.pi/guard.json` in the repository, can only **add** protection (`protectedBranches`, `protectedPaths`, `extraPaths`, `"mode": "block"`). That way a repository you clone cannot switch the guard off. If either file contains invalid JSON, every tool call is blocked until you fix it.

Branch names match exactly. Globs like `release/*` are not supported yet.

## pitk_azure_devops

Actions: `pr_list`, `pr_get` (with linked work items), `pr_changes` (files in the latest iteration), `pr_threads` (review comments, without system messages), `work_item`.

The organization, project and repository come from the `origin` remote when Pi runs inside an Azure Repos clone. Every common remote form is understood: `dev.azure.com`, `visualstudio.com` and SSH. Outside a clone, pass `orgUrl`, `project` and `repository`, or set `AZURE_DEVOPS_ORG_URL` and `AZURE_DEVOPS_PROJECT`.

### Authentication

The first one that is available is used:

1. **Personal access token**: `AZURE_DEVOPS_PAT` (or `AZURE_DEVOPS_EXT_PAT`, the variable `az devops` uses). It needs the **Code (Read)** and **Work Items (Read)** scopes.
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
extensions/<name>/*.ts       pure logic with no Pi imports, covered by tests/
skills/<name>/SKILL.md       Agent Skills
prompts/*.md                 prompt templates; the file name is the command
```

The Pi host packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `typebox`) are peer dependencies. Pi provides them at runtime, so they are never bundled.

## License

MIT
