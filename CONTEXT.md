# OmkarSWE bench decision records

## ADR-001: Run isolated OpenCode servers over HTTP and SSE

Start `opencode serve --stdio --hostname 127.0.0.1 --port 0` inside `bwrap` for each sandboxed trial attempt.
Read the loopback URL from the first stdout line and use `@opencode/client@2.3.2` for HTTP and server-sent events (SSE).
Generate a fresh `OPENCODE_PASSWORD` per attempt and authenticate client requests with HTTP Basic auth as `opencode`.
Collect messages through the API instead of reading the session database.

The startup URL does not guarantee that OpenCode has loaded the repository's configuration.
Start iterating the lazy SSE subscription and wait for `server.connected` before creating a session because the stream does not replay earlier events.
Then call `waitForLocationReady` to poll `agent.list` and `provider.list` until both benchmark agents and every active provider appear at the trial location.
Each readiness barrier has a 10-second bound.

## ADR-002: Separate provider credentials from benchmark settings

Generate two files in `$trialDir/config/opencode`.
Write only active provider definitions and schema metadata to `opencode.jsonc` and write benchmark settings and neutral prompts to `opencode.json`.
If you pass `--agents-file`, import only the two benchmark agent definitions and keep the enforced benchmark rules.
Use file-level `--ro-bind` overlays in the sandbox so neither file can change while the enclosing directory remains writable for service and lock files.
Remove the generated credential file in `finally` even if you retain the workspace.

Set `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`, `OPENCODE_DISABLE_CLAUDE_CODE=1`, `OPENCODE_DISABLE_PROJECT_CONFIG=1`, and `OPENCODE_DISABLE_MODELS_FETCH=1`.
Deny `external_directory:*` across all roles.
In writable `pair` trials, route reviewer `git diff` and `git log` commands through `ask` and validate them with the strict AST allowlist (`isSafePairReviewerShellCommand`) so working-tree clean filters, unknown flags, and shell redirections cannot run.
Use `plugins: []` for the 21 tasks without commit guard.
Enable only `opencode-commit-guard@1.1.1` on the signed Git coder task and the four pair tasks.
Keep the harness's Oxlint packages, `.oxlintrc.json`, and `tools/oxlint/anti-slop` outside trial sandboxes.
Seed task-specific coding instructions as prose where the task needs them.

## ADR-003: Analyze syntax without WASM

Use the native `tsgo` compiler from `typescript@7.0.2` for `tsc --noEmit`.
The TypeScript package does not expose the compiler AST API in its JavaScript entry point.
Use the native N-API binding in `oxc-parser@0.159.0` to parse TypeScript into ESTree in `src/ast/typescript.ts` on the host.

Analyze Python with a host `python3` subprocess that uses the standard library `ast` module and exchanges JSON with the harness.
Parse shell traces with a pure-TypeScript parser to inspect heredocs, command substitutions, and wrapper commands without executing them.
None of the three analyzers needs a WASM grammar or runtime.

## ADR-004: Bind the global Ruff binary read-only

Install the standalone `ruff` executable globally on `PATH` (for example with `uv tool install ruff==0.17.5`).
Expose `ruff` and any allowlisted host tool (`opencode`, `bun`, `node`, `git`, `python3`, `ssh-keygen`) whose resolved executable lives outside `/usr` and `/bin` by bind-mounting each binary read-only inside a read-only `${trialDir}/host-bin` tmpfs directory.
For TypeScript `coder` tasks, mount only `typescript`, `@typescript`, `@types`, `bun-types`, and `undici-types` read-only into `${trialDir}/node_modules`.
This removes per-trial `uv` cache clones, eliminates `tmpfs` duplication across concurrent workers, and avoids shadowing `/usr/bin/python3` with a tool virtualenv.
Grade Python lint on the host with `ruff check --no-cache .` using the immutable host binary.

## ADR-005: Retry transient failures with clean state

Default to `--api-retries 3` so a transient failure can receive up to three fresh attempts after the first.
Retry HTTP `408`, `429`, `500`, `502`, `503`, `504`, and `520`–`529`, along with recognized transport failures, premature SSE disconnects, unexpected server exits, readiness timeouts, and statusless `OverloadedError` / `RateLimitError` / `ServerStartupError` failures, including execution errors raised in child subagents.
Do not retry request, authentication, model, agent, config, schema, sandbox-launch (`SandboxLaunchError`), or external form errors or trial wall-clock timeouts.
The CLI records diagnostics on failed runs that produce a trial result, checkpoints completed rows to `results.json` as trials finish, and isolates post-run grading exceptions to the affected trial.

Close the failed server and reset the repository, config, and other trial state before retrying.
Use a fresh `:memory:` database by default.
With `--keep-workspaces`, delete the previous attempt's `session.db` and sidecar files before retrying.
Use cancellable exponential backoff with jitter and honor server retry hints up to 30 seconds.
Charge discarded attempts' root and subagent costs to `retry_cost_usd`.

Default to `--workers 4` to bound concurrent trials and host resource use.
Place `--workspace-root` on disk if you keep many workspaces and `/tmp` is a size-limited memory filesystem.

## ADR-006: Keep network access separate from grading isolation

Live sandboxes omit `--unshare-net` so OpenCode can reach HTTPS model endpoints.
Assume code inside a trial can read the active provider credentials and use the network.
Use scoped credentials for live trials and do not treat the sandbox as a network security boundary.

The sandbox masks the host home and `/tmp`, then exposes the trial directory and explicit read-only host mounts.
The harness does not inherit the host environment wholesale.
It excludes SSH and GPG agent variables, common Git and cloud tokens, and inactive provider definitions.
It injects `GIT_CONFIG_COUNT` overrides (`core.hooksPath=/dev/null`, `core.fsmonitor=false`, `log.showSignature=false`, `gpg.ssh.program=ssh-keygen`) so trial-controlled Git settings cannot execute hooks or verifiers.
It forwards allowed credential environment variables and mounts credential files only when active provider definitions reference them.

After the trial, Python and Bun behavioral probes run in a separate `bwrap` sandbox with `--unshare-net` and a read-only repository mount.
The harness does not run those probes without isolation if `bwrap` fails.
Host-side static analysis, type checking, and Ruff linting are separate from these behavioral probes.
