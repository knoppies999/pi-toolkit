---
name: vitest
description: Write, run and debug Vitest tests - running a subset, structure, mocking with vi, fake timers, async tests, snapshots, and coverage. Use when adding or fixing tests in a project that uses Vitest, or when a vitest run fails.
license: MIT
---

# Vitest

Check how the repository runs tests first: the `test` script in `package.json`, `vitest.config.*` or the `test` block in `vite.config.*` (environment, setup files, globals, include patterns), and an existing test next to the code you are changing. Match its style.

## Running

Always run non-interactively. `vitest` alone starts watch mode and never exits.

```bash
npx vitest run                                  # everything once
npx vitest run src/orders                       # files whose path matches
npx vitest run src/orders/price.test.ts -t "applies discount"   # one test by name
npx vitest run --reporter=verbose               # see each test name
npx vitest run --coverage                       # needs @vitest/coverage-v8 (or -istanbul)
```

Use the repo's script when it adds flags (`npm test -- src/orders`). In a monorepo, run from the package directory or use `--project <name>`.

Run the narrowest set while working, then the whole suite before you finish.

## Writing tests

- Import explicitly unless the config sets `globals: true`: `import { describe, it, expect, vi, beforeEach } from "vitest"`.
- Name tests after behaviour: `it("rejects an order with no lines")`.
- Arrange, act, assert. One behaviour per test. Keep setup close to the test that needs it.
- Test through the public API of the module, not its private helpers.
- Use `expect(...).toEqual` for values, `toBe` for identity and primitives, `toThrow` / `rejects.toThrow` for errors, `toHaveBeenCalledWith` for interactions.
- Async: `await` the code under test, or `await expect(promise).rejects.toThrow(...)`. A test that does not await can pass while the code fails.
- Parametrise with `it.each([...])("...%s", ...)` instead of copying tests.

## Mocking

- Prefer real code and simple fakes over mocks. Mock only at boundaries: network, time, randomness, the file system, other services.
- `vi.fn()` for a stub, `vi.spyOn(obj, "method")` to observe or replace one method.
- `vi.mock("./module", () => ({ ... }))` is hoisted above imports. To use a variable inside it, create it with `vi.hoisted(() => ...)`. Use `vi.mock(import("./module"), async (orig) => ({ ...(await orig()), one: vi.fn() }))` to keep the rest of a module real.
- Reset between tests: `afterEach(() => { vi.restoreAllMocks(); })`, or rely on `restoreMocks: true` / `mockReset: true` in the config. Never let one test's mock leak into the next.
- Time: `vi.useFakeTimers()`, `vi.setSystemTime(new Date("2026-01-01"))`, `await vi.advanceTimersByTimeAsync(1000)`, and `vi.useRealTimers()` afterwards.
- HTTP: use the repo's approach (MSW, a fake client, `vi.spyOn(globalThis, "fetch")`).

## Snapshots

Use them only for large, stable output (serialised structures, rendered markup). Prefer `toMatchInlineSnapshot()` for small values. When a snapshot fails, read the diff and decide whether the change is intended. Update with `npx vitest run -u` only if it is, and say so.

## When a run fails

1. Read the first failure completely: assertion, expected vs received, and the stack trace into your code.
2. Re-run just that test with `-t`.
3. Decide whether the code or the test is wrong. Fix that one. Never delete, skip (`.skip`) or loosen an assertion to get green.
4. For failures that only happen in the full suite, suspect shared state: leaked mocks, timers, module-level singletons, test order. `--sequence.shuffle` helps to reproduce.
