# Changelog

## [0.2.0]

- `pitk_subagent` tool: run agents in separate pi processes, singly, in parallel or chained, with bundled `scout`, `planner`, `implementer`, `tester` and `reviewer` agents and a `/pitk-agents` command.
- `pitk_azure_devops` `pr_create`: open a pull request linked to work items. The guard asks before every call.
- `coordinator` and `ticket-to-pr` skills, and the `/pitk-ticket` prompt template.
- `typescript`, `vitest` and `playwright-mcp` skills.

## [0.1.0]

- `guard` extension: confirm or block pushes to protected branches, force pushes, destructive commands and edits to protected files.
- `pitk_azure_devops` tool: read PRs, changed files, comment threads and work items. Authenticates with a PAT, the Azure CLI or the pipeline token.
- `pitk_dotnet` tool: compact `dotnet build` errors and `dotnet test` failures.
- `pr-review` and `dotnet-conventions` skills.
- `/pitk-review` prompt template.
