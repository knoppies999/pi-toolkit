---
name: dotnet-conventions
description: Conventions for writing and changing C# / .NET code - project layout, nullable, async, DI, logging, exceptions, and testing. Use when writing, refactoring, or reviewing C# code, adding a project or test project, or fixing dotnet build or test failures.
license: MIT
---

# .NET conventions

The repository's own conventions win. Before writing code, check `.editorconfig`, `Directory.Build.props`, `Directory.Packages.props`, `global.json` and a few neighbouring files, and match them. Use the rules below where the repository is silent.

## Build and test loop

- If the `dotnet` tool is available, use it instead of running `dotnet` through bash: `action: "build"` for compile errors, `action: "test"` with `filter` to rerun only what failed.
- Fix compile errors before running tests. Fix the first error first; later ones are often caused by it.
- Do not change `<TargetFramework>`, `<LangVersion>`, `global.json` or package versions to get past an error unless the user asks.
- Package versions live in `Directory.Packages.props` when the repo uses central package management. Add `<PackageVersion>` there and a version-less `<PackageReference>` in the project.

## Code

- **Nullable reference types are on.** Do not silence warnings with `!` unless you can say why the value cannot be null. Prefer guard clauses: `ArgumentNullException.ThrowIfNull(x)`, `ArgumentException.ThrowIfNullOrEmpty(s)`.
- **Async all the way.** Never block with `.Result`, `.Wait()` or `GetAwaiter().GetResult()`. Accept a `CancellationToken` as the last parameter of public async methods and pass it on. Name async methods `...Async`. In library code, follow the repo on `ConfigureAwait(false)`.
- **Dependency injection.** Constructor injection; keep constructors free of work. Register with the narrowest lifetime that is correct, and never capture a scoped service in a singleton. Use `IOptions<T>` for configuration instead of reading `IConfiguration` in business code.
- **Logging.** `ILogger<T>` with message templates, not string interpolation: `logger.LogInformation("Order {OrderId} shipped", id)`. Never log secrets, tokens or personal data. For hot paths, use `LoggerMessage` source generators if the repo does.
- **Exceptions.** Throw for exceptional cases, not control flow. Catch only what you can handle, and rethrow with `throw;` to keep the stack trace. Do not swallow exceptions silently.
- **Types.** Prefer `record` for immutable data, `sealed` for classes not designed for inheritance, file-scoped namespaces, and `var` where the type is obvious from the right-hand side.
- **Collections.** Return `IReadOnlyList<T>` / `IReadOnlyCollection<T>` from public APIs. Do not enumerate an `IEnumerable<T>` more than once.
- **Time and culture.** Inject `TimeProvider` instead of calling `DateTime.Now`. Use `DateTimeOffset` for points in time. Use `CultureInfo.InvariantCulture` or `StringComparison.Ordinal` for anything that is not shown to a user.
- **Data access.** EF Core: `AsNoTracking()` for read-only queries, project to DTOs with `Select`, avoid N+1 queries, never build SQL with string concatenation.

## Tests

- Match the existing framework (xUnit, NUnit or MSTest) and assertion library. Do not add a new one.
- Name tests after behaviour: `Method_State_ExpectedResult` or the repo's style.
- One behaviour per test, arrange-act-assert. Use the real implementation where it is cheap, and fakes over mocks where the repo allows.
- A bug fix comes with a test that fails without the fix.
