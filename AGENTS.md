# OmkarSWE bench

## Toolchain

- Use Bun `1.4.4`, TypeScript `7.0.2`, and the strict options in `tsconfig.json`.
- Use TypeScript for type checking and native `oxc-parser@0.159.0` for TypeScript AST analysis.
  Keep the toolchain free of WASM dependencies.
- Keep `oxlint` and `@oxlint/plugins` pinned in lockstep at `1.94.0`.
  Use `.oxlintrc.json` for the harness's lint rules.
  Never mount these packages, the lint configuration, or `tools/oxlint/anti-slop` into trial sandboxes.
  Do not seed trial repositories with the harness lint configuration or load anti-slop in trial configurations.

## Source rules

- Use concrete types instead of `any`, `: object` parameters, or broad dictionaries.
  Use `unknown` only for type predicate subjects and `cause: unknown`.
  Use the recursive JSON types in `src/util/json.ts` for arbitrary JSON.
- Name symbols for their domain and omit `shape` from identifiers.
  Use runtime predicates or AST discriminants instead of `typeof`, except for `"undefined"` checks.
- Narrow values before use.
  For an unavoidable type assertion, put `// SAFETY: <verified invariant>` on the preceding line.
  Never chain assertions.
- Test through public interfaces without mocking modules.
- Use a single loop, `flatMap`, or iterator helpers instead of chaining array `filter` and `map`.
  Mutate a fresh local accumulator instead of copying it on every iteration.

## Module boundaries

| Module | Owns |
| --- | --- |
| `src/ast/` | Shell, Python, and TypeScript analysis |
| `src/sandbox/` | Trial mounts, environment, tools, and process isolation |
| `src/driver/` | OpenCode server, session protocol, and telemetry |
| `src/graders/` | Grading evidence and deterministic checks |
| `src/tasks/` | Benchmark task definitions and fixtures |
| `src/runner/` | Trial lifecycle and scheduling |

## Verification and commits

Run `bun run typecheck`, `bun run lint`, and `bun test`.
If your `node` executable cannot load TypeScript, use `bun run --bun lint` to load the local plugin with Bun.
Inspect `git status` and `git diff` before committing.
Create one scoped commit per task with subject `<scope>: <Capitalized summary>` and sign off with `-s`.
