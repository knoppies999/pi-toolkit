---
name: pr-review
description: Review a pull request or local branch diff for correctness, security, and maintainability, and report findings ranked by severity. Use when asked to review a PR, review changes, or check a branch before merging. Works with Azure DevOps or GitHub PRs, or a plain git diff.
license: MIT
---

# PR review

Review the change the user names: an Azure DevOps PR id, a GitHub PR number, a branch, or by default the current branch against its target.

## 1. Get the change

Pick the first source that applies:

- **Azure DevOps PR.** If an `azure_devops` tool is available, call it with `pr_get`, then `pr_changes`, then `pr_threads`. Read the title, description and linked work items first, because they say what the change is meant to do.
- **GitHub PR.** Run `gh pr view <n> --json title,body,baseRefName,headRefName` and `gh pr diff <n>`.
- **Local branch.** Find the target branch (usually `main` or `master`), then run `git diff <target>...HEAD --stat` and `git diff <target>...HEAD`.

If the diff is large, start from `--stat` and read the files with the most logic first. Skip generated files, lockfiles and snapshots.

## 2. Understand before judging

- Read the changed files in full where the diff leaves out context: callers, the types used, the tests.
- Work out what each change is meant to do. A finding is "this does not do what it is meant to", not "I would have written it differently".
- Check whether tests cover the new behaviour and whether the existing tests still describe it.

## 3. Look for, in priority order

1. **Correctness:** wrong logic, missed edge cases (null, empty, off-by-one, time zones, culture), broken error handling, race conditions, resource leaks.
2. **Security:** injection (SQL, shell, path), missing authorization checks, secrets in code or logs, unsafe deserialization, unvalidated input crossing a trust boundary.
3. **Breaking changes:** public API, database schema, config keys, message contracts, behaviour other teams depend on.
4. **Tests:** new behaviour without tests, tests that cannot fail, mocks that hide the bug.
5. **Maintainability:** duplication of existing helpers, misleading names, dead code. Only raise these when they matter.

Do not report style that a formatter or analyzer would catch, and do not repeat comments already in the PR threads.

## 4. Report

Lead with a one-line verdict: **approve**, **approve with suggestions**, or **changes needed**.

Then list findings, most severe first. For each:

```
[severity] path/to/File.cs:42 - one-sentence problem
Why: the concrete input or state that goes wrong, and what happens.
Fix: the smallest change that fixes it.
```

Severities: `blocker` (must fix before merge), `major` (should fix), `minor` (worth fixing), `nit` (optional, use sparingly).

Only report what you have checked against the code. If you are unsure, say so and say what would confirm it. If there are no findings, say that plainly rather than inventing some.

Never post comments to the PR, approve, or push changes unless the user asks you to.
