# OmkarSWE bench

OmkarSWE bench lets you evaluate coding, static review, and collaboration across 26 tasks with deterministic checks.

| Stage | `--phase` | Tasks | What you measure |
| --- | --- | ---: | --- |
| `coder` | `coder` | 11 | Scoped implementation, verification, and Git workflow |
| `code-reviewer` | `reviewer` | 11 | Defect detection, architectural critique, scope handling, and restraint in read-only reviews |
| `pair` | `pair` | 4 | Review handoff, response to findings, and scoped amendments |

## Set up the host

Use Linux with `bwrap` (bubblewrap) and working namespaces for sandboxed trials.
Put Bun `1.4.4`, OpenCode `2.3.2`, `ruff` (`0.17.5`), `python3`, `git`, and `ssh-keygen` on `PATH`.
Make sure `node` is on `PATH` for the TypeScript compiler on TypeScript coder tasks.

From the repository root, install dependencies and install `ruff` globally if it is not on `PATH`:

```sh
bun install
uv tool install ruff==0.17.5
```

Before you run live tasks that use commit guard, cache `opencode-commit-guard@1.1.1` on the host at `~/.cache/opencode/npm/opencode-commit-guard@1.1.1` (under `$XDG_CACHE_HOME/opencode/npm` if you set `XDG_CACHE_HOME`).

## Choose credentials and prompts

Use `--providers-file <path>` to supply OpenCode provider definitions explicitly.
Without it, the harness reads `$XDG_CONFIG_HOME/opencode/opencode.jsonc` or `~/.config/opencode/opencode.jsonc` if you do not set `XDG_CONFIG_HOME`.
The harness copies only the selected provider definitions for each trial, not the rest of your OpenCode configuration.
For active providers, it resolves `{file:...}` credentials to host files and forwards allowed `{env:...}` variables.
With `bwrap`, the harness mounts those credential files read-only.
Without `bwrap`, OpenCode sees the host files directly.
It removes the generated provider config after each trial, even if you keep the workspace.

By default, you compare models using neutral role prompts and the `neutral` agent profile.
Each sandbox uses its own home and sets `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` so host skills do not load.
The harness sets `plugins: []` except on `coder-git-commit-guard-two-task` and the four pair tasks.
Those five tasks enable only `opencode-commit-guard@1.1.1`.
The harness uses `oxlint`, `@oxlint/plugins`, `.oxlintrc.json`, and `tools/oxlint/anti-slop` for development only.
It does not mount these assets or the host-side AST parser into trial sandboxes.

Use `--agents-file <path>` to compare your own `coder` and `code-reviewer` prompts.
The file accepts JSON or JSONC with `agents.coder` and `agents["code-reviewer"]` entries.
The harness reads their `system`, `description`, and `permissions` fields and adds benchmark protocol and permission rules.
It ignores personal plugins, MCP settings, and instructions.
Results identify the profile as `file:<basename>`.

## Run the CLI

The package exposes `omkar-swe-bench`.
In the checkout, use `bun ./src/cli.ts` in its place if the executable is not on `PATH`.

```sh
omkar-swe-bench list --phase reviewer --json
omkar-swe-bench run --phase coder --task coder-ts-sse-chunk-crlf \
  --coder-model 'openai/gpt-6.2-sol#medium' --trials-per-cell 2 \
  --workers 4 --api-retries 3 --sandbox require --out results/coder
omkar-swe-bench run --phase reviewer --reviewer-model 'openai/gpt-6.2-sol#high' \
  --sandbox require --out results/reviewer
omkar-swe-bench run --phase pair --all-pairs --providers-file ./providers.jsonc \
  --agents-file ./agents.jsonc --timeout-scale 1.5 \
  --workspace-root /tmp/opencode/bench-pair --keep-workspaces --out results/pair
omkar-swe-bench report --input results/coder/results.json --out results/coder/rebuilt.md
```

`list` prints task metadata as a table or, with `--json`, as JSON.
For `list` and `run`, `--phase` defaults to `all`.
`run` checkpoints completed rows to `results.json` as each trial finishes, writes `summary.md` at the end, and isolates unexpected post-run grading failures to the affected trial row.
`report` rebuilds the Markdown from `results.json` and prints it to standard output unless you pass `--out`.

| `run` option | Default and behavior |
| --- | --- |
| `--phase <all\|coder\|reviewer\|pair>` | `all`; select a stage or all stages. |
| `--task <id>` | All tasks in the selected phase; repeat to select specific tasks. |
| `--coder-model <provider/model[#variant]>` | The eight coder specs in [`src/config/models.ts`](src/config/models.ts); repeat to replace the default list. |
| `--reviewer-model <provider/model[#variant]>` | All nine reviewer specs in [`src/config/models.ts`](src/config/models.ts) for solo review, and only `openai/gpt-6.2-sol#high` for pairs; repeat to replace both lists. |
| `--all-pairs` | Off; pair each selected coder model with all default reviewer models unless you provide an explicit reviewer list. |
| `--trials-per-cell <n>` | `1`; use a positive integer for repetitions per task and model or model pair. |
| `--workers <n>` | `4`; use a positive integer for the maximum number of concurrent trials (capped at 2 concurrent trials per provider by default). |
| `--api-retries <n>` | `3`; use a non-negative integer for the number of outer retries after a transient failure. |
| `--sandbox <require\|auto\|off>` | Defaults to `require`, which fails if `bwrap` is unavailable. `auto` warns and falls back to an unsandboxed OpenCode process, but refuses live runs that include coder or pair tasks when `bwrap` is unavailable. `off` skips the sandbox probe and runs OpenCode without isolation. |
| `--providers-file <path>` | Use the OpenCode JSONC path described above; pass this flag to read a different file. |
| `--agents-file <path>` | Use neutral prompts; pass this flag to supply custom agent definitions. |
| `--out <dir>` | `./results/<iso-timestamp-slug>`; choose where to write results and the report. |
| `--workspace-root <dir>` | `/tmp/opencode/omkar-swe-bench`; choose where to create trial workspaces. |
| `--timeout-scale <factor>` | `1`; use a positive factor that keeps the scaled task timeout within timer limits. |
| `--keep-workspaces` | Off; retain trial directories and store live session data in `session.db` instead of memory. |
| `--dry-run` | Off; prepare and validate fixtures without starting OpenCode or contacting model providers. |

Keep `--sandbox require` for live trials with credentials.
Even with `--sandbox off`, post-trial behavioral probes still need `bwrap`.

### Check fixtures offline

Use a synthetic provider file to avoid reading your credentials.
This example runs one fixture per task and skips the host sandbox probe:

```sh
printf '%s\n' '{"providers":{"stub":{}}}' > providers.stub.jsonc
omkar-swe-bench run --dry-run --sandbox off --providers-file providers.stub.jsonc \
  --coder-model stub/coder --reviewer-model stub/reviewer --out results/dry-run
```

The harness prepares each repository, writes the trial configs, and validates the mount plan and environment without launching OpenCode.
It does not grade agent behavior or verify that your model names exist in a provider catalog.
A ready fixture reports `dry_run_fixture_ready: true`, `passed: true`, `score: 1`, `exit_code: 0`, and `session_id: null`.
If you omit `--providers-file`, dry-run uses the configured host file when it exists and creates synthetic provider entries only when that file is missing.

## Read telemetry

- **TTFRT (time to first raw token):** The seconds from creation of a root assistant message to its first streamed token.
- **TTFVT (time to first visible token):** The seconds from creation of a root assistant message to its first visible text or tool start.
  The harness uses stream events and tool timestamps when available and falls back to reasoning completion or first-token timing.
- **Cold and warm latency:** Cold is the first root assistant step.
  Warm is the median of measured latencies from later root assistant steps.
  The report shows medians of cold and warm visible latencies across trials.
- **Decode tok/s:** Output tokens divided by summed seconds from visible start to stream end (or completion if stream end is missing).
  The calculation includes only steps with positive output and a positive visible interval.
- **Total model tok/s:** Output plus reasoning tokens divided by summed seconds from step creation to stream end or completion across steps with a positive duration.
  Both throughput measures include root and subagent steps and use summed step time, not trial wall time.
- **Reasoning share:** Reasoning tokens divided by output plus reasoning tokens, with a minimum divisor of one.
- **Cache hit ratio:** Cache-read tokens divided by input plus cache-read and cache-write tokens, with a minimum divisor of one.
- **USD cost:** `root_cost_usd` and `subagent_cost_usd` report separate costs for the final attempt.
  `retry_cost_usd` sums both costs from discarded attempts.
  `total_cost_usd` adds all three.

## Judge reviews offline

Export a packet from an existing results file.
The harness selects non-partial, non-dry-run reviewer and pair results with review text, and requires a reviewed diff for pairs.
It deduplicates equivalent evidence, omits the model and profile fields, and redacts recognized workspace paths.

```sh
omkar-swe-bench judge --input results/pair/results.json --out packet.json
```

Read the cases and copy the top-level `answers` object into `answers.json` as the entire document.
Replace every `null` with `true` or `false`, without adding or removing case IDs or rubric keys.
Then validate your completed answers:

```sh
omkar-swe-bench judge --input results/pair/results.json --answers answers.json \
  --out judgments.json
```

Both commands run offline and print to standard output if you omit `--out`.
Validation returns the number of judged cases and their answers.
Inspect free-form evidence before you share a packet because path redaction does not remove arbitrary sensitive text.
