# OmkarSWE bench

Deterministic benchmark harness for evaluating coding, static code review, and coder-reviewer collaboration in OpenCode.
Every trial runs inside an isolated sandbox and grades outputs with behavioral probes, AST checks, Git history invariants, and session trace verification.

[Rankings](#rankings) · [Quick start](#quick-start) · [How it works](#how-it-works) · [Task suite](#task-suite) · [Default models](#default-models) · [Sandbox isolation](#sandbox-isolation) · [CLI reference](#cli-reference) · [Telemetry](#telemetry) · [Offline judging](#offline-judging)

---

## Overview

| Stage             | CLI flag           |  Tasks | Primary focus                                                                                                |
| ----------------- | ------------------ | -----: | ------------------------------------------------------------------------------------------------------------ |
| **Coder**         | `--phase coder`    |     11 | Scoped edits, behavioral correctness, AST hygiene, test rigor, blocker honesty, and Git workflow             |
| **Code reviewer** | `--phase reviewer` |     11 | Defect recall, architectural critique, scope calibration, exclusion compliance, and restraint on clean diffs |
| **Pair**          | `--phase pair`     |      4 | Review handoff, substantiated `HEAD` amendments, false-alarm pushback, and non-`HEAD` preservation           |
| **Total**         | `--phase all`      | **26** | Full coding, review, and collaboration suite                                                                 |

## Rankings

Models are ranked by **Low-Steering Autonomy Score (`LSAS`, 0–100)**—how rarely you must intervene, debug, nudge static compliance, or fight stubborn review refusals—with cost and wall-clock time on separate Pareto axes.
See the **[full scores, methodology, and 251-trial breakdown](docs/benchmarks/2026-11-19/summary.md)** or open the **[interactive HTML dashboard](docs/benchmarks/2026-11-19/report.html)** (`neutral` profile, `--sandbox require`, OpenCode `2.3.2`, `$37.74` total API spend).

### Autonomous Coders (`ACI` across 19 Solo + Pair trials)

| Rank | Coder                              |      ACI |   ZSDR | Pass@1 | 19-trial cost | Total wall |
| ---: | ---------------------------------- | -------: | -----: | -----: | ------------: | ---------: |
|    1 | `google/gemini-4-hydrogen#high`    | **99.9** | 100.0% |  19/19 |         $4.23 |      2400s |
|    2 | `google/gemini-4-neon#medium`      | **99.9** | 100.0% |  19/19 |         $5.65 |      2722s |
|    3 | `anthropic/claude-opus-5-5#medium` | **98.1** |  94.7% |  18/19 |         $3.51 |      1166s |
|    4 | `deepseek/deepseek-flash#high`     | **95.1** |  94.7% |  17/19 |     **$0.68** |      1718s |
|    5 | `google/gemini-4-neon#high`        | **93.1** |  94.7% |  17/19 |         $8.96 |      4341s |
|    6 | `anthropic/claude-sonnet-5-5#high` | **93.1** |  94.7% |  13/19 |         $1.73 |   **792s** |
|    7 | `openai/gpt-6.2-sol#high`          | **91.3** |  89.5% |  16/19 |         $1.98 |      1678s |
|    8 | `openai/gpt-6.2-sol#medium`        | **89.8** |  84.2% |  16/19 |         $1.65 |      1405s |

![Coder Autonomy vs. Cost Pareto Frontier](docs/benchmarks/2026-11-19/charts/coder-cost-pareto.svg)

![Coder Autonomy vs. Wall-Clock Time Pareto Frontier](docs/benchmarks/2026-11-19/charts/coder-speed-pareto.svg)

### Code Reviewers (`LSAS` across 10 calibrated tasks)

| Rank | Reviewer                          |      LSAS | Pass@1 | Recall | P0–P2 FPs | P3 nits | Suite cost |  Med wall |
| ---: | --------------------------------- | --------: | -----: | -----: | --------: | ------: | ---------: | --------: |
|    1 | `google/gemini-4-carbon#medium`   | **100.0** |  10/10 | 100.0% |         0 |       0 |      $0.93 |     85.2s |
|    2 | `google/gemini-4-neon#xhigh`      | **100.0** |  10/10 | 100.0% |         0 |       0 |      $2.67 |    138.8s |
|    3 | `openai/gpt-6.2-astra#medium`     |  **99.8** |  10/10 | 100.0% |         0 |       0 |      $0.58 | **15.8s** |
|    4 | `anthropic/claude-opus-5-5#high`  |  **96.8** |   9/10 | 100.0% |         1 |       0 |      $0.49 |     18.0s |
|    5 | `openai/gpt-6.2-astra#high`       |  **95.1** |   8/10 | 100.0% |         1 |       1 |      $0.69 |     20.0s |
|    6 | `google/gemini-4-neon#high`       |  **95.0** |   9/10 |  92.9% |         0 |       0 |      $1.25 |     60.8s |
|    7 | `openai/gpt-6.2-sol#high`         |  **89.0** |   6/10 |  92.9% |         1 |       2 |  **$0.18** |     16.2s |
|    8 | `anthropic/claude-fable-5-2#high` |  **87.0** |   7/10 | 100.0% |         3 |       2 |      $1.33 |     19.6s |
|    9 | `openai/gpt-6.2-sol#xhigh`        |  **87.0** |   7/10 |  85.7% |         2 |       2 |      $0.24 |     23.2s |

![Code Reviewer Calibration Quadrant](docs/benchmarks/2026-11-19/charts/reviewer-calibration.svg)

### Pair Collaboration & Babysitting Diagnostics

![Phase 3 Coder × Reviewer Synergy Matrix](docs/benchmarks/2026-11-19/charts/pair-synergy-matrix.svg)

![Low-Steering Babysitting & Failure Taxonomy](docs/benchmarks/2026-11-19/charts/failure-taxonomy.svg)

Full per-stage tables, inference overhead & diff discipline charts, and all 251 trial rows live in **[`docs/benchmarks/2026-11-19/summary.md`](docs/benchmarks/2026-11-19/summary.md)**.

## How it works

### Trial execution pipeline

```mermaid
flowchart LR
  A[Host preflight<br/>Refresh models cache<br/>Check bwrap, ruff, commit-guard] --> B[Trial pool<br/>4 workers total<br/>Max 2 per provider]
  B --> C[Isolated bwrap trial<br/>Ephemeral HOME<br/>Read-only host tools<br/>OpenCode 2.3.2 server]
  C --> D[Deterministic grading<br/>Sandboxed behavioral probes<br/>Python & TS AST analysis<br/>Git reflog & trace checks]
  D --> E[Artifacts<br/>results.json checkpoints<br/>summary.md leaderboard]
```

### Pair review handoff loop

```mermaid
sequenceDiagram
  participant Coder as Coder (primary)
  participant Guard as opencode-commit-guard
  participant Reviewer as Code Reviewer (read-only subagent)

  Coder->>Guard: Capture commit_context baseline
  Coder->>Coder: Implement task, run tests, create signed scoped commit
  Coder->>Reviewer: Delegate static review (repo, commit range, criteria)
  Note over Coder: Ends turn with "Review pending"
  Reviewer->>Reviewer: Inspect diff via git diff/log --no-ext-diff --no-textconv
  Reviewer-->>Coder: Return "## Findings" (P0-P3) or "No actionable findings."
  Coder->>Coder: Fix substantiated defects, decline false alarms with reason
  Coder->>Coder: Rerun tests and fold fixes with git commit --amend --no-edit
```

## Quick start

### 1. Prepare the host

Use Linux with `bwrap` (bubblewrap) and working user namespaces.
Install Bun `1.4.4`, OpenCode `2.3.2`, `ruff` (`0.17.5`), `python3`, `node`, `git`, and `ssh-keygen` on `PATH`.

```sh
bun install
uv tool install ruff==0.17.5
```

For tasks that enable commit guard (`coder-git-commit-guard-two-task` and all four pair tasks), cache `opencode-commit-guard@1.1.1` on the host at `${XDG_CACHE_HOME:-$HOME/.cache}/opencode/npm/opencode-commit-guard@1.1.1`.

### 2. Verify fixtures offline

Run a dry-run with a synthetic provider file to validate every fixture, mount plan, and trial environment without contacting model providers:

```sh
printf '%s\n' '{"providers":{"stub":{}}}' > /tmp/opencode/providers.stub.jsonc
bun ./src/cli.ts run --dry-run --sandbox off \
  --providers-file /tmp/opencode/providers.stub.jsonc \
  --coder-model stub/coder --reviewer-model stub/reviewer \
  --out results/dry-run
```

### 3. Run live evaluations

By default, `run` enforces `--sandbox require`, runs `4` total workers capped at `2` concurrent trials per provider, reads credentials from `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.jsonc`, and writes `results.json` plus `summary.md` under `results/<timestamp>/`.

```sh
# Stage 1: standalone coder (88 trials across 8 default models)
bun ./src/cli.ts run --phase coder

# Stage 2: read-only code reviewer (99 trials across 9 default models)
bun ./src/cli.ts run --phase reviewer

# Stage 3: coder + reviewer collaboration (64 trials across 8 coders × 2 default pair reviewers)
bun ./src/cli.ts run --phase pair
```

### 4. Benchmark custom agent prompts

Pass `--agents-file <path>` to evaluate your own `agents.coder` and `agents["code-reviewer"]` prompts against the `neutral` baseline:

```sh
bun ./src/cli.ts run --phase pair \
  --agents-file ~/scripts/opencode/opencode.json \
  --coder-model 'openai/gpt-6.2-sol#medium' \
  --reviewer-model 'openai/gpt-6.2-sol#high'
```

The harness reads only `system`, `description`, and `permissions` for `coder` and `code-reviewer`, appends benchmark safety rules with last-match-wins precedence, and ignores personal plugins, MCP servers, and instructions.
Results tag the run profile as `file:<basename>`.

## Default models

Model matrices live in [`src/config/models.ts`](src/config/models.ts).
Repeat `--coder-model` or `--reviewer-model` on the CLI to override either list.

| Default `coder` models (8)         | Default `code-reviewer` models (9) |
| ---------------------------------- | ---------------------------------- |
| `openai/gpt-6.2-sol#medium`        | `openai/gpt-6.2-sol#high`          |
| `openai/gpt-6.2-sol#high`          | `openai/gpt-6.2-sol#xhigh`         |
| `google/gemini-4-hydrogen#high`    | `google/gemini-4-carbon#medium`    |
| `google/gemini-4-neon#medium`      | `google/gemini-4-neon#high`        |
| `google/gemini-4-neon#high`        | `google/gemini-4-neon#xhigh`       |
| `anthropic/claude-sonnet-5-5#high` | `anthropic/claude-opus-5-5#high`   |
| `anthropic/claude-opus-5-5#medium` | `openai/gpt-6.2-astra#medium`      |
| `deepseek/deepseek-flash#high`     | `openai/gpt-6.2-astra#high`        |
|                                    | `anthropic/claude-fable-5-2#high`  |

## Task suite

Run `bun ./src/cli.ts list` (or `--json`) to inspect task metadata directly from the catalog.

<details>
<summary><strong>Stage 1 — Coder tasks (11)</strong></summary>

| Task ID                                 | Category           | Language   | Timeout | Commit guard |
| --------------------------------------- | ------------------ | ---------- | ------: | ------------ |
| `coder-py-stitch-collapse`              | `cache-recovery`   | Python     |    480s | No           |
| `coder-py-stream-stop-and-feedback`     | `streaming`        | Python     |    480s | No           |
| `coder-ts-sse-chunk-crlf`               | `framing`          | TypeScript |    480s | No           |
| `coder-ts-shell-heredoc-subst`          | `parser`           | TypeScript |    600s | No           |
| `coder-py-ssrf-ip-pinning`              | `transport-safety` | Python     |    480s | No           |
| `coder-git-commit-guard-two-task`       | `git-workflow`     | Git        |    480s | Yes          |
| `coder-blocker-honesty-v2`              | `blocker-honesty`  | Python     |    480s | No           |
| `coder-convention-autonomy-v2`          | `autonomy`         | Python     |    480s | No           |
| `coder-py-atomic-async-lifecycle`       | `concurrency-io`   | Python     |    480s | No           |
| `coder-ts-boundary-decoder-http`        | `boundary-safety`  | TypeScript |    480s | No           |
| `coder-ts-catalog-alias-and-test-rigor` | `test-rigor`       | TypeScript |    480s | No           |

</details>

<details>
<summary><strong>Stage 2 — Code reviewer tasks (11)</strong></summary>

| Task ID                                   | Category              | Language   | Timeout |
| ----------------------------------------- | --------------------- | ---------- | ------: |
| `rev-clean-personal-script-v2`            | `clean-review`        | Python     |    480s |
| `rev-soft-commit-range-no-filelist`       | `scope-calibration`   | Python     |    480s |
| `rev-missing-scope-true-bounce`           | `scope-calibration`   | Python     |    480s |
| `rev-ts-redirect-leak-and-antislop`       | `standards-review`    | TypeScript |    480s |
| `rev-py-cache-discard-and-monkeypatch`    | `standards-review`    | Python     |    480s |
| `rev-py-ytdlp-thread-leak-and-ratelimit`  | `regression-review`   | Python     |    480s |
| `rev-mixed-committed-plus-worktree`       | `scope-calibration`   | Mixed      |    480s |
| `rev-calibration-trap-clean-idiomatic`    | `clean-review`        | Python     |    480s |
| `rev-py-denylist-bandaid-rewrite`         | `architecture-review` | Python     |    480s |
| `rev-ts-tautological-and-inverted-test`   | `standards-review`    | TypeScript |    480s |
| `rev-py-clean-security-rewrite-restraint` | `clean-review`        | Python     |    480s |

</details>

<details>
<summary><strong>Stage 3 — Pair collaboration tasks (4)</strong></summary>

| Task ID                               | Category           | Language | Timeout | Commit guard |
| ------------------------------------- | ------------------ | -------- | ------: | ------------ |
| `pair-commit-review-amend`            | `pair-workflow`    | Python   |    600s | Yes          |
| `pair-pushback-on-false-nitpick`      | `pair-calibration` | Python   |    600s | Yes          |
| `pair-multitask-review-loop-clean`    | `pair-delegation`  | Python   |    720s | Yes          |
| `pair-unhittable-finding-and-nonhead` | `pair-calibration` | Python   |    720s | Yes          |

</details>

## Sandbox isolation

Each live trial builds an ephemeral workspace under `/tmp/opencode/omkar-swe-bench` and runs OpenCode inside `bwrap` with strict read-only boundaries.

| Boundary            | Inside trial sandbox                                                                                              | Excluded from trial sandbox                                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Repository**      | Fresh seeded Git repo (`rw` for coder/pair, `ro` for reviewer)                                                    | Host workspace and unrelated repos                                                                                                       |
| **Credentials**     | Only active trial provider definitions; `{file:...}` targets mounted `ro` and deleted on teardown                 | Inactive providers, host `service.json`, unapproved env vars                                                                             |
| **Models catalog**  | Host-refreshed `models.json` mounted `ro` via `OPENCODE_MODELS_PATH` (`OPENCODE_DISABLE_MODELS_FETCH=1`)          | Per-trial network catalog races                                                                                                          |
| **Tools & plugins** | Read-only `ruff`, TypeScript compiler (when required), and `opencode-commit-guard@1.1.1` (only on Git/pair tasks) | Host skills (`OPENCODE_DISABLE_EXTERNAL_SKILLS=1`), personal plugins, `oxlint`, `oxfmt`, `ultracite`, `oxlint-tsgolint`, host AST parser |

Even with `--sandbox off`, post-trial behavioral probes still require `bwrap`.

## CLI reference

The package exposes `omkar-swe-bench` (or invoke `bun ./src/cli.ts` directly in a checkout).

| Command                                                                    | Purpose                                                                                                                                 |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `list [--phase <p>] [--json]`                                              | Print task metadata as a table or JSON                                                                                                  |
| `run [options]`                                                            | Execute trials, checkpoint `results.json` after each trial, and write `summary.md`                                                      |
| `report --input <results.json>... [--out <md> \| --out-dir <dir> [--png]]` | Build a Markdown summary or full LSAS report bundle (`summary.md`, `report.html`, `charts/*.svg`) from one or more `results.json` files |
| `judge --input <results.json> [--answers <file>] [--out <file>]`           | Export anonymized blind review packets or validate completed binary judgments                                                           |

<details>
<summary><strong>All <code>run</code> options and defaults</strong></summary>

| Option                                        | Default and behavior                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--phase <all\|coder\|reviewer\|pair>`        | `all`; select a stage or run all stages                                                                                                           |
| `--task <id>`                                 | All tasks in the selected phase; repeat to filter specific task IDs                                                                               |
| `--coder-model <provider/model[#variant]>`    | The 8 coder specs in [`src/config/models.ts`](src/config/models.ts); repeat to replace the list                                                   |
| `--reviewer-model <provider/model[#variant]>` | All 9 reviewer specs for solo review, and `openai/gpt-6.2-astra#medium` + `google/gemini-4-carbon#medium` for pairs; repeat to replace both lists |
| `--all-pairs`                                 | Off; pair each selected coder model with all default reviewer models unless you pass `--reviewer-model`                                           |
| `--trials-per-cell <n>`                       | `1`; positive integer repetitions per task and model or model pair                                                                                |
| `--workers <n>`                               | `4`; positive integer maximum concurrent trials (capped at 2 concurrent trials per provider by default)                                           |
| `--api-retries <n>`                           | `3`; non-negative integer outer retries after transient API or startup failures                                                                   |
| `--sandbox <require\|auto\|off>`              | `require`; fails if `bwrap` is unavailable. `auto` warns and falls back only for read-only reviewer runs. `off` skips sandboxing for OpenCode     |
| `--providers-file <path>`                     | Defaults to `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.jsonc`                                                                           |
| `--agents-file <path>`                        | Neutral role prompts; pass JSON/JSONC to test custom `coder` and `code-reviewer` definitions                                                      |
| `--out <dir>`                                 | `./results/<iso-timestamp-slug>`; destination directory for `results.json` and `summary.md`                                                       |
| `--workspace-root <dir>`                      | `/tmp/opencode/omkar-swe-bench`; base directory for trial workspaces                                                                              |
| `--timeout-scale <factor>`                    | `1`; positive multiplier applied to each task's `timeoutSeconds`                                                                                  |
| `--keep-workspaces`                           | Off; retain trial directories and persist live session data in `session.db` instead of memory                                                     |
| `--dry-run`                                   | Off; prepare fixtures and validate mount plans without starting OpenCode or calling providers                                                     |

</details>

## Telemetry

| Metric                  | Definition                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **TTFRT**               | Seconds from root assistant message creation to first streamed token                                                         |
| **TTFVT**               | Seconds from root assistant message creation to first visible text or tool start                                             |
| **Cold / warm visible** | Cold is the first root assistant step; warm is the median TTFVT of later root assistant steps                                |
| **Decode tok/s**        | Output tokens divided by summed visible-start-to-stream-end seconds across positive-duration steps (root + subagent)         |
| **Total model tok/s**   | Output plus reasoning tokens divided by summed step-creation-to-end seconds across positive-duration steps (root + subagent) |
| **Reasoning share**     | Reasoning tokens divided by `max(1, output + reasoning)`                                                                     |
| **Cache hit ratio**     | Cache-read tokens divided by `max(1, input + cache_read + cache_write)`                                                      |
| **Cost (USD)**          | `total_cost_usd = root_cost_usd + subagent_cost_usd + retry_cost_usd`                                                        |

## Offline judging

Export anonymized blind-judging packets from completed reviewer or pair runs:

```sh
bun ./src/cli.ts judge --input results/pair/results.json --out packet.json
```

The exporter keeps non-partial, non-dry-run results with review text (and a reviewed diff for pairs), deduplicates equivalent evidence, removes model and profile labels, and redacts recognized workspace paths.
Copy the top-level `answers` object into `answers.json`, replace every `null` with `true` or `false` without changing keys, and validate:

```sh
bun ./src/cli.ts judge --input results/pair/results.json \
  --answers answers.json --out judgments.json
```

Inspect free-form evidence before sharing a packet because path redaction does not strip arbitrary sensitive text.

## Development

### Module boundaries

| Directory      | Responsibility                                                                               |
| -------------- | -------------------------------------------------------------------------------------------- |
| `src/ast/`     | Shell, Python, and TypeScript (`oxc-parser`) static analysis                                 |
| `src/sandbox/` | `bwrap` mount planning, environment construction, host tool discovery, and process isolation |
| `src/driver/`  | OpenCode server lifecycle, SSE/REST session protocol, and telemetry extraction               |
| `src/graders/` | Findings parser, Git state and commit checks, trace matchers, and deterministic scoring      |
| `src/tasks/`   | All 26 coder, reviewer, and pair task fixtures and probes                                    |
| `src/runner/`  | Trial scheduling (`runPool`), execution lifecycle, retries, and report generation            |

### Verification

```sh
bun run typecheck
bun lint
bun test
```
