---
name: typescript
description: Conventions for writing and changing TypeScript - strict types, modules, errors, async, validation at boundaries, and the type-check / lint / test loop. Use when writing, refactoring or reviewing TypeScript or JavaScript code, or fixing tsc or eslint errors.
license: MIT
---

# TypeScript conventions

The repository's own setup wins. Before writing code, read `package.json` (scripts, `type`, engines), `tsconfig.json`, the lint and format config (`eslint.config.*`, `.prettierrc`, `biome.json`) and a few neighbouring files, and match them. Use the rules below where the repository is silent.

## Check loop

- Find the scripts in `package.json` and use them: typically `typecheck` / `check` (`tsc --noEmit`), `lint`, `test`, `build`. Use the repo's package manager: `pnpm-lock.yaml` means pnpm, `yarn.lock` yarn, `bun.lock` bun, otherwise npm.
- Run the type check after every meaningful change. Fix the first error first.
- Do not change `tsconfig.json`, lint rules or dependency versions to make an error go away unless the user asks.
- Never add `// @ts-ignore` or `eslint-disable`. If a suppression is truly needed, use `// @ts-expect-error <reason>` so it fails once the problem is gone.

## Types

- Assume `strict: true`. No implicit or explicit `any`; use `unknown` and narrow it.
- Let inference work for locals. Annotate exported function signatures and public return types.
- Model states with discriminated unions (`{ status: "ok"; value: T } | { status: "error"; error: E }`) instead of optional fields that must be set together.
- Prefer `type` aliases for unions and `interface` for object shapes that are extended, or follow the repo.
- Use `as const` and `satisfies` instead of `as` casts. A cast is a claim you cannot check; avoid `as` except right after real validation.
- Avoid non-null `!`. Handle the undefined case or narrow with a check.
- Use `readonly` and `ReadonlyArray<T>` for data that must not change.

## Boundaries

- Validate everything that comes from outside (HTTP bodies, env vars, files, `JSON.parse`, third-party responses) with the repo's validator (zod, valibot, typebox, ...) and derive the type from the schema.
- Inside the boundary, trust the types; do not re-check them everywhere.

## Code

- ES modules with named exports. No default exports unless the framework requires them. Follow the repo on file extensions in imports (`./x.js` under `NodeNext`).
- `async`/`await` over raw promise chains. Never leave a promise floating: await it, return it, or handle it with `void` plus a `.catch`.
- Run independent async work with `Promise.all`; use `Promise.allSettled` when partial failure is acceptable.
- Throw `Error` subclasses (or the repo's error type), never strings. Keep the cause: `new Error("Loading config failed", { cause: err })`.
- Pass `AbortSignal` through long-running and network operations.
- Prefer pure functions and small modules; keep side effects at the edges.
- Use `===`, optional chaining `?.` and nullish coalescing `??` (not `||` when `0` or `""` are valid).

## Tests

Follow the vitest skill (or the repo's framework). A bug fix comes with a test that fails without the fix.
