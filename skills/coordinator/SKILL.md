---
name: coordinator
description: Coordinate a multi-step coding task by splitting it into pieces and delegating them to subagents (scout, planner, implementer, tester, reviewer) with pitk_subagent, while keeping the plan and the decisions yourself. Use for tasks that span several files or areas, need research before changes, or benefit from an independent review.
license: MIT
---

# Coordinator

You are the coordinator. You own the goal, the plan, the decisions and the final answer. Subagents do focused pieces of work in their own context windows and report back. They start knowing nothing about this conversation.

Use this pattern when a task is big enough that one context would fill up with exploration, or when an independent check is worth having. For a small, local change, just do it yourself.

## Agents

Run `/pitk-agents` to list them. The bundled ones:

| Agent | Use it to | Edits files |
|---|---|---|
| `scout` | find relevant code, conventions and tests, and return a map with `path:line` | no |
| `planner` | turn the goal and scout findings into ordered steps, tests and risks | no |
| `implementer` | make one well-defined change and verify it | yes |
| `tester` | build, run tests, find root causes, add missing tests | when asked |
| `reviewer` | review the diff with the pr-review skill | no |

## Procedure

1. **Frame the goal.** Write down, for yourself, what done looks like and the acceptance criteria. Ask the user about anything ambiguous that changes the outcome *before* delegating.

2. **Scout in parallel.** Split the unknowns into independent questions and send them as one `pitk_subagent` call with `tasks` (2 to 4 scouts is typical). Example:
   ```json
   { "tasks": [
     { "agent": "scout", "task": "In this repo, find where orders are priced: entry points, the pricing classes and their tests. Return paths with line numbers." },
     { "agent": "scout", "task": "Find how feature flags are defined and read in this repo, with one example of a flag guarding a code path." }
   ] }
   ```

3. **Plan.** Give the planner the goal, the acceptance criteria and the scout reports verbatim. Read the plan critically and fix it yourself if it is wrong or vague. You are accountable for it, not the planner.

4. **Implement.** Send plan steps to `implementer`, one step or one group of related steps per call.
   - Run implementers **one at a time** unless their steps touch completely separate files. Two agents editing the same file will overwrite each other.
   - Each task must be self-contained: the step, the files, the conventions the scouts found, how to verify, and what to report.
   - After each step, check the report and the diff (`git diff --stat`, then the changed files). Do not move on from a failing step.

5. **Test.** Send `tester` the acceptance criteria and what changed. Fix the failures it finds (through `implementer` or yourself) and test again.

6. **Review.** Send `reviewer` the base branch and the goal. Treat its findings as input: fix the real ones, and note why you are dismissing the others.

7. **Report.** Summarise for the user what changed, how it was verified (with the actual results), and what is left or uncertain.

## Writing good subagent tasks

- State the goal, the relevant paths, the constraints and the exact output you want back.
- Paste in the context it needs: findings, the plan step, error messages. Do not write "as discussed".
- Ask for facts with `path:line`, not opinions.
- Use `chain` when each step needs the previous one's output: `{previous}` in a task is replaced by the prior agent's final answer.

## Autonomous mode

When the guard's "AUTONOMOUS MODE IS ON" message is in the conversation, the user is not watching. Do not ask them to approve plans. Make the calls a senior engineer would, record them, and stop with a line starting `NEEDS DECISION:` only for unclear requirements that change the outcome, schema changes or migrations, breaking API or contract changes, or a step the guard blocks. You remain responsible for checking every subagent report against the code; nobody else will.

## Limits

- Subagents have no UI. The guard extension blocks risky actions in them (pushing to main, `rm -rf`, editing secrets, opening PRs) instead of asking. Do those steps yourself, in this session, where the user can approve them.
- Subagents cannot start subagents.
- Every subagent costs a full model session. Do not delegate what a single `grep` would answer.
