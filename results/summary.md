# OmkarSWE bench — Evaluation Report

**421 trials** · **327/421** strict Pass@1 (77.7%) · **$65.94** total API cost

Open [`report.html`](report.html) for interactive hover tooltips and phase tabs, or read [`craft.md`](craft.md) for host-side code craft metrics.

## Highlights

| Category | Model | Score | Cost · Speed |
| :--- | :--- | ---: | ---: |
| Best Overall Coder | Claude Opus 5.5 (medium) | ACI 94.6 | $5.01 · 29.2m |
| Best Value Coder | GPT-6.2 Sol (medium) | ACI 90.2 | $2.42 · 34.9m |
| Top Code Reviewer | Gemini 4 Carbon (low) | LSAS 99.6 | $0.77 · med 47s |

<details>
<summary>Scoring methodology (LSAS, ZSDR, ACI)</summary>

- **LSAS (Low-Steering Autonomy Score, 0–100):** Zeroes timeouts, crashes, and partial runs. Caps broken deliverables or scope violations at `<= 25`. Passing deliverables start at `100` minus `-35` per static/test hygiene miss, `-20` per skipped verification check, `-8` per self-healed in-session friction item (such as a commit-guard rejection recovered autonomously), and `-2` per root tool error (capped at `-8`). For code reviewers, LSAS starts at `100 × recall` (`100` on clean diffs) minus `-30` per blocking `P0–P2` false alarm and `-15` per `P3` nitpick.
- **ZSDR (Zero-Steering Deliverable Rate):** Share of trials needing zero human intervention after the session ends.
- **ACI (Autonomous Coder Index):** `0.6 × Solo LSAS + 0.4 × Pair LSAS` across all solo and pair coder trials (Phases 1 and 3).
- **Cost and Wall Time:** Reported on orthogonal Pareto axes rather than blended into capability scores.

</details>

## Combined Autonomous Coder Index (Phases 1 + 3)

| Rank | Coder | ACI | Pass@1 | Cost · Wall |
| ---: | :--- | ---: | ---: | ---: |
| 1 | Claude Opus 5.5 (medium) | 94.6 | 19/26 (73%) | $5.01 · 29.2m |
| 2 | Gemini 4 Hydrogen (high) | 93.1 | 24/26 (92%) | $6.31 · 70.4m |
| 3 | Gemini 4 Neon (medium) | 92.9 | 24/26 (92%) | $8.54 · 79.5m |
| 4 | GPT-6.2 Sol (high) | 92.6 | 23/26 (88%) | $3.06 · 44.1m |
| 5 | Gemini 4 Neon (high) | 92.0 | 24/26 (92%) | $11.78 · 109.7m |
| 6 | GPT-6.2 Sol (medium) | 90.2 | 22/26 (85%) | $2.42 · 34.9m |
| 7 | Gemini 4 Hydrogen (medium) | 89.9 | 22/26 (85%) | $4.19 · 44.7m |
| 8 | Claude Sonnet 5.5 (high) | 89.4 | 14/26 (54%) | $2.63 · 23.8m |
| 9 | DeepSeek Flash (high) | 88.0 | 20/26 (77%) | $1.24 · 38.4m |

![Coder Autonomy vs. Cost Pareto Frontier](charts/coder-cost-pareto.svg)

![Coder Autonomy vs. Wall-Clock Time Pareto Frontier](charts/coder-speed-pareto.svg)

![Inference Overhead & Diff Discipline (Coders)](charts/overhead-and-diff.svg)

<details>
<summary>Full coder telemetry (12 metrics, Phases 1 + 3)</summary>

| Rank | Coder | ACI | Solo LSAS | Pair LSAS | ZSDR | Pass@1 | Suite cost | $/clean pass | Total wall | Active tok/s | Diff ratio |
| ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | `anthropic/claude-opus-5-5#medium` | 94.6 | 91.4 | 99.3 | 76.9% (20/26) | 73.1% (19/26) | $5.01 | $0.264 | 1751s | 90 | 1.05× |
| 2 | `google/gemini-4-hydrogen#high` | 93.1 | 94.1 | 91.7 | 92.3% (24/26) | 92.3% (24/26) | $6.31 | $0.263 | 4227s | 107 | 1.08× |
| 3 | `google/gemini-4-neon#medium` | 92.9 | 88.1 | 100.0 | 92.3% (24/26) | 92.3% (24/26) | $8.54 | $0.356 | 4771s | 55 | 1.00× |
| 4 | `openai/gpt-6.2-sol#high` | 92.6 | 92.6 | 92.6 | 88.5% (23/26) | 88.5% (23/26) | $3.06 | $0.133 | 2649s | 54 | 0.74× |
| 5 | `google/gemini-4-neon#high` | 92.0 | 86.8 | 99.7 | 92.3% (24/26) | 92.3% (24/26) | $11.78 | $0.491 | 6579s | 59 | 1.16× |
| 6 | `openai/gpt-6.2-sol#medium` | 90.2 | 92.6 | 86.5 | 84.6% (22/26) | 84.6% (22/26) | $2.42 | $0.110 | 2092s | 55 | 0.70× |
| 7 | `google/gemini-4-hydrogen#medium` | 89.9 | 83.1 | 100.0 | 84.6% (22/26) | 84.6% (22/26) | $4.19 | $0.190 | 2682s | 81 | 0.99× |
| 8 | `anthropic/claude-sonnet-5-5#high` | 89.4 | 85.3 | 95.5 | 80.8% (21/26) | 53.8% (14/26) | $2.63 | $0.188 | 1425s | 113 | 0.87× |
| 9 | `deepseek/deepseek-flash#high` | 88.0 | 85.8 | 91.2 | 84.6% (22/26) | 76.9% (20/26) | $1.24 | $0.062 | 2306s | 129 | 1.01× |

</details>

## Phase 1 — Standalone coder leaderboard

| Rank | Model | LSAS | Pass@1 | Cost · Wall |
| ---: | :--- | ---: | ---: | ---: |
| 1 | Gemini 4 Hydrogen (high) | 94.1 | 13/14 (93%) | $3.00 · 95s |
| 2 | GPT-6.2 Sol (medium) | 92.6 | 12/14 (86%) | $0.69 · 37s |
| 3 | GPT-6.2 Sol (high) | 92.6 | 12/14 (86%) | $1.05 · 70s |
| 4 | Claude Opus 5.5 (medium) | 91.4 | 8/14 (57%) | $2.19 · 42s |
| 5 | Gemini 4 Neon (medium) | 88.1 | 12/14 (86%) | $3.94 · 140s |
| 6 | Gemini 4 Neon (high) | 86.8 | 12/14 (86%) | $5.83 · 202s |
| 7 | DeepSeek Flash (high) | 85.8 | 11/14 (79%) | $0.15 · 62s |
| 8 | Claude Sonnet 5.5 (high) | 85.3 | 8/14 (57%) | $0.89 · 28s |
| 9 | Gemini 4 Hydrogen (medium) | 83.1 | 10/14 (71%) | $1.61 · 82s |

<details>
<summary>Full Phase 1 telemetry (13 metrics)</summary>

| Rank | Model | LSAS | ZSDR | Pass@1 | Passed | Mean check | Diff ratio | Suite cost | Med wall | Cold TTFT | Active tok/s | Reasoning % |
| ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | `google/gemini-4-hydrogen#high` | 94.1 | 92.9% | 92.9% | 13/14 | 99.1% | 1.07× | $3.00 | 95.2s | 3.37s | 135 | 73% |
| 2 | `openai/gpt-6.2-sol#medium` | 92.6 | 85.7% | 85.7% | 12/14 | 98.4% | 0.65× | $0.69 | 37.0s | 2.71s | 57 | 19% |
| 3 | `openai/gpt-6.2-sol#high` | 92.6 | 85.7% | 85.7% | 12/14 | 98.2% | 0.67× | $1.05 | 70.4s | 3.07s | 54 | 42% |
| 4 | `anthropic/claude-opus-5-5#medium` | 91.4 | 57.1% | 57.1% | 8/14 | 94.8% | 1.04× | $2.19 | 42.3s | 2.29s | 110 | 11% |
| 5 | `google/gemini-4-neon#medium` | 88.1 | 85.7% | 85.7% | 12/14 | 98.2% | 1.00× | $3.94 | 139.9s | 4.29s | 73 | 68% |
| 6 | `google/gemini-4-neon#high` | 86.8 | 85.7% | 85.7% | 12/14 | 92.0% | 1.34× | $5.83 | 201.7s | 4.34s | 72 | 77% |
| 7 | `deepseek/deepseek-flash#high` | 85.8 | 78.6% | 78.6% | 11/14 | 96.5% | 1.00× | $0.15 | 61.9s | 1.63s | 176 | 70% |
| 8 | `anthropic/claude-sonnet-5-5#high` | 85.3 | 64.3% | 57.1% | 8/14 | 92.5% | 0.92× | $0.89 | 27.7s | 2.10s | 138 | 10% |
| 9 | `google/gemini-4-hydrogen#medium` | 83.1 | 71.4% | 71.4% | 10/14 | 96.4% | 1.00× | $1.61 | 81.5s | 4.44s | 105 | 67% |

</details>

## Phase 2 — Code reviewer leaderboard

| Rank | Model | LSAS | Recall | Alarms | Cost |
| ---: | :--- | ---: | ---: | ---: | ---: |
| 1 | Gemini 4 Carbon (low) | 99.6 | 100% | 0 | $0.77 |
| 2 | Gemini 4 Neon (high) | 98.1 | 100% | 1 FP · 0 P3 | $3.02 |
| 3 | Gemini 4 Neon (xhigh) | 90.5 | 92% | 1 FP · 2 P3 | $5.44 |
| 4 | GPT-6.2 Astra (high) | 89.5 | 100% | 5 FP · 1 P3 | $1.89 |
| 5 | Gemini 4 Carbon (medium) | 89.1 | 88% | 1 FP · 0 P3 | $2.16 |
| 6 | GPT-6.2 Astra (medium) | 85.5 | 100% | 5 FP · 1 P3 | $1.45 |
| 7 | Claude Opus 5.5 (high) | 83.9 | 97% | 6 FP · 3 P3 | $1.02 |
| 8 | Claude Opus 5.5 (medium) | 81.6 | 96% | 5 FP · 4 P3 | $0.96 |
| 9 | Claude Fable 5.2 (high) | 77.0 | 92% | 7 FP · 4 P3 | $2.95 |
| 10 | GPT-6.2 Sol (high) | 76.6 | 92% | 9 FP · 3 P3 | $0.47 |
| 11 | GPT-6.2 Sol (xhigh) | 68.6 | 82% | 9 FP · 3 P3 | $0.61 |

![Code Reviewer Autonomy vs. Cost Pareto Frontier](charts/reviewer-cost-pareto.svg)

![Code Reviewer Calibration Quadrant](charts/reviewer-calibration.svg)

<details>
<summary>Full Phase 2 telemetry (13 metrics, calibrated)</summary>

| Rank | Model | LSAS | Pass@1 | Passed | Defect recall | P0–P2 FPs | P3 nits | Suite cost | Med wall | Cold TTFT | Active tok/s | Reasoning % |
| ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | `google/gemini-4-carbon#low` | 99.6 | 100.0% | 17/17 | 100.0% | 0 | 0 | $0.77 | 46.7s | 4.30s | 21 | 0% |
| 2 | `google/gemini-4-neon#high` | 98.1 | 94.1% | 16/17 | 100.0% | 1 | 0 | $3.02 | 112.6s | 9.06s | 74 | 87% |
| 3 | `google/gemini-4-neon#xhigh` | 90.5 | 82.4% | 14/17 | 91.7% | 1 | 2 | $5.44 | 192.1s | 12.13s | 91 | 95% |
| 4 | `openai/gpt-6.2-astra#high` | 89.5 | 70.6% | 12/17 | 100.0% | 5 | 1 | $1.89 | 25.4s | 5.18s | 34 | 23% |
| 5 | `google/gemini-4-carbon#medium` | 89.1 | 88.2% | 15/17 | 87.5% | 1 | 0 | $2.16 | 99.7s | 7.50s | 65 | 84% |
| 6 | `openai/gpt-6.2-astra#medium` | 85.5 | 76.5% | 13/17 | 100.0% | 5 | 1 | $1.45 | 16.9s | 4.89s | 32 | 4% |
| 7 | `anthropic/claude-opus-5-5#high` | 83.9 | 58.8% | 10/17 | 97.2% | 6 | 3 | $1.02 | 21.0s | 2.17s | 80 | 26% |
| 8 | `anthropic/claude-opus-5-5#medium` | 81.6 | 64.7% | 11/17 | 95.8% | 5 | 4 | $0.96 | 17.2s | 2.25s | 79 | 19% |
| 9 | `anthropic/claude-fable-5-2#high` | 77.0 | 52.9% | 9/17 | 91.7% | 7 | 4 | $2.95 | 30.7s | 2.04s | 92 | 41% |
| 10 | `openai/gpt-6.2-sol#high` | 76.6 | 64.7% | 11/17 | 91.7% | 9 | 3 | $0.47 | 22.8s | 4.19s | 48 | 34% |
| 11 | `openai/gpt-6.2-sol#xhigh` | 68.6 | 41.2% | 7/17 | 81.9% | 9 | 3 | $0.61 | 26.4s | 4.38s | 51 | 58% |

</details>

## Phase 3 — Pair collaboration leaderboard

![Phase 3 Coder × Reviewer Synergy Matrix](charts/pair-synergy-matrix.svg)

| Rank | Model | LSAS | Pass@1 | Cost · Wall |
| ---: | :--- | ---: | ---: | ---: |
| 1 | Claude Opus 5.5 (medium) → GPT-6.2 Astra (medium) | 100.0 | 6/6 (100%) | $1.42 · 67s |
| 2 | Gemini 4 Hydrogen (medium) → GPT-6.2 Astra (medium) | 100.0 | 6/6 (100%) | $1.33 · 90s |
| 3 | Gemini 4 Hydrogen (medium) → Gemini 4 Carbon (medium) | 100.0 | 6/6 (100%) | $1.25 · 135s |
| 4 | Gemini 4 Hydrogen (high) → Gemini 4 Carbon (medium) | 100.0 | 6/6 (100%) | $1.61 · 160s |
| 5 | Gemini 4 Neon (medium) → GPT-6.2 Astra (medium) | 100.0 | 6/6 (100%) | $2.23 · 181s |
| 6 | Gemini 4 Neon (medium) → Gemini 4 Carbon (medium) | 100.0 | 6/6 (100%) | $2.37 · 259s |
| 7 | Gemini 4 Neon (high) → GPT-6.2 Astra (medium) | 99.7 | 6/6 (100%) | $3.14 · 238s |
| 8 | Gemini 4 Neon (high) → Gemini 4 Carbon (medium) | 99.7 | 6/6 (100%) | $2.81 · 277s |
| 9 | GPT-6.2 Sol (high) → Gemini 4 Carbon (medium) | 98.7 | 6/6 (100%) | $1.10 · 150s |
| 10 | Claude Opus 5.5 (medium) → Gemini 4 Carbon (medium) | 98.7 | 5/6 (83%) | $1.40 · 115s |
| 11 | DeepSeek Flash (high) → GPT-6.2 Astra (medium) | 96.7 | 4/6 (67%) | $0.61 · 75s |
| 12 | Claude Sonnet 5.5 (high) → GPT-6.2 Astra (medium) | 95.7 | 3/6 (50%) | $0.86 · 52s |
| 13 | Claude Sonnet 5.5 (high) → Gemini 4 Carbon (medium) | 95.3 | 3/6 (50%) | $0.88 · 98s |
| 14 | GPT-6.2 Sol (medium) → GPT-6.2 Astra (medium) | 86.5 | 5/6 (83%) | $0.83 · 68s |
| 15 | GPT-6.2 Sol (high) → GPT-6.2 Astra (medium) | 86.5 | 5/6 (83%) | $0.91 · 80s |
| 16 | GPT-6.2 Sol (medium) → Gemini 4 Carbon (medium) | 86.5 | 5/6 (83%) | $0.89 · 132s |
| 17 | DeepSeek Flash (high) → Gemini 4 Carbon (medium) | 85.8 | 5/6 (83%) | $0.48 · 117s |
| 18 | Gemini 4 Hydrogen (high) → GPT-6.2 Astra (medium) | 83.3 | 5/6 (83%) | $1.70 · 105s |

<details>
<summary>Full Phase 3 telemetry (13 metrics)</summary>

| Rank | Model | LSAS | ZSDR | Pass@1 | Passed | Mean check | Diff ratio | Suite cost | Med wall | Cold TTFT | Active tok/s | Reasoning % |
| ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | `anthropic/claude-opus-5-5#medium -> openai/gpt-6.2-astra#medium` | 100.0 | 100.0% | 100.0% | 6/6 | 100.0% | 1.08× | $1.42 | 66.8s | 2.14s | 77 | 4% |
| 2 | `google/gemini-4-hydrogen#medium -> openai/gpt-6.2-astra#medium` | 100.0 | 100.0% | 100.0% | 6/6 | 100.0% | 0.90× | $1.33 | 89.6s | 2.93s | 75 | 46% |
| 3 | `google/gemini-4-hydrogen#medium -> google/gemini-4-carbon#medium` | 100.0 | 100.0% | 100.0% | 6/6 | 100.0% | 0.98× | $1.25 | 135.2s | 2.41s | 76 | 61% |
| 4 | `google/gemini-4-hydrogen#high -> google/gemini-4-carbon#medium` | 100.0 | 100.0% | 100.0% | 6/6 | 100.0% | 1.12× | $1.61 | 159.8s | 2.15s | 76 | 62% |
| 5 | `google/gemini-4-neon#medium -> openai/gpt-6.2-astra#medium` | 100.0 | 100.0% | 100.0% | 6/6 | 100.0% | 1.00× | $2.23 | 180.5s | 3.43s | 44 | 46% |
| 6 | `google/gemini-4-neon#medium -> google/gemini-4-carbon#medium` | 100.0 | 100.0% | 100.0% | 6/6 | 100.0% | 1.01× | $2.37 | 259.2s | 3.82s | 48 | 60% |
| 7 | `google/gemini-4-neon#high -> openai/gpt-6.2-astra#medium` | 99.7 | 100.0% | 100.0% | 6/6 | 100.0% | 1.20× | $3.14 | 237.7s | 3.22s | 52 | 59% |
| 8 | `google/gemini-4-neon#high -> google/gemini-4-carbon#medium` | 99.7 | 100.0% | 100.0% | 6/6 | 100.0% | 1.08× | $2.81 | 276.9s | 4.07s | 48 | 64% |
| 9 | `openai/gpt-6.2-sol#high -> google/gemini-4-carbon#medium` | 98.7 | 100.0% | 100.0% | 6/6 | 100.0% | 0.90× | $1.10 | 150.0s | 4.53s | 60 | 52% |
| 10 | `anthropic/claude-opus-5-5#medium -> google/gemini-4-carbon#medium` | 98.7 | 100.0% | 83.3% | 5/6 | 98.7% | 1.22× | $1.40 | 114.8s | 2.37s | 77 | 34% |
| 11 | `deepseek/deepseek-flash#high -> openai/gpt-6.2-astra#medium` | 96.7 | 100.0% | 66.7% | 4/6 | 97.5% | 1.04× | $0.61 | 74.6s | 1.63s | 113 | 35% |
| 12 | `anthropic/claude-sonnet-5-5#high -> openai/gpt-6.2-astra#medium` | 95.7 | 100.0% | 50.0% | 3/6 | 96.6% | 0.73× | $0.86 | 51.6s | 2.08s | 94 | 5% |
| 13 | `anthropic/claude-sonnet-5-5#high -> google/gemini-4-carbon#medium` | 95.3 | 100.0% | 50.0% | 3/6 | 96.7% | 0.88× | $0.88 | 98.2s | 2.07s | 88 | 40% |
| 14 | `openai/gpt-6.2-sol#medium -> openai/gpt-6.2-astra#medium` | 86.5 | 83.3% | 83.3% | 5/6 | 93.6% | 0.70× | $0.83 | 67.9s | 2.66s | 46 | 4% |
| 15 | `openai/gpt-6.2-sol#high -> openai/gpt-6.2-astra#medium` | 86.5 | 83.3% | 83.3% | 5/6 | 93.6% | 0.79× | $0.91 | 80.0s | 3.09s | 49 | 9% |
| 16 | `openai/gpt-6.2-sol#medium -> google/gemini-4-carbon#medium` | 86.5 | 83.3% | 83.3% | 5/6 | 93.6% | 0.74× | $0.89 | 131.8s | 2.79s | 55 | 49% |
| 17 | `deepseek/deepseek-flash#high -> google/gemini-4-carbon#medium` | 85.8 | 83.3% | 83.3% | 5/6 | 95.6% | 1.01× | $0.48 | 117.1s | 1.57s | 105 | 52% |
| 18 | `google/gemini-4-hydrogen#high -> openai/gpt-6.2-astra#medium` | 83.3 | 83.3% | 83.3% | 5/6 | 83.3% | 1.06× | $1.70 | 104.8s | 2.42s | 96 | 60% |

</details>

## Diagnostics

![Low-Steering Babysitting & Failure Taxonomy](charts/failure-taxonomy.svg)

![Diagnostic Task × Model Outcome Heatmap](charts/task-heatmap.svg)

<details>
<summary>Per-trial breakdown (421 trials)</summary>

| Task | Role | Model | Tier | LSAS | Pass | Raw score | Wall | Cost | Notes |
| :--- | :--- | :--- | :--- | ---: | :---: | ---: | ---: | ---: | :--- |
| pair-ts-inverse-triage-and-antislop | pair | openai/gpt-6.2-sol#medium -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 85.7s | $0.1447 |  |
| pair-ts-inverse-triage-and-antislop | pair | openai/gpt-6.2-sol#medium -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 130.2s | $0.1496 |  |
| pair-ts-inverse-triage-and-antislop | pair | openai/gpt-6.2-sol#high -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 108.2s | $0.1985 |  |
| pair-ts-inverse-triage-and-antislop | pair | openai/gpt-6.2-sol#high -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 196.6s | $0.2241 |  |
| pair-ts-inverse-triage-and-antislop | pair | google/gemini-4-hydrogen#medium -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 115.2s | $0.2702 |  |
| pair-ts-inverse-triage-and-antislop | pair | google/gemini-4-hydrogen#medium -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 127.6s | $0.2126 |  |
| pair-ts-inverse-triage-and-antislop | pair | google/gemini-4-hydrogen#high -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 132.0s | $0.3967 |  |
| pair-ts-inverse-triage-and-antislop | pair | google/gemini-4-hydrogen#high -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 263.0s | $0.4176 |  |
| pair-ts-inverse-triage-and-antislop | pair | google/gemini-4-neon#medium -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 178.7s | $0.4385 |  |
| pair-ts-inverse-triage-and-antislop | pair | google/gemini-4-neon#medium -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 372.1s | $0.5437 |  |
| pair-ts-inverse-triage-and-antislop | pair | google/gemini-4-neon#high -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 283.5s | $0.6102 |  |
| pair-ts-inverse-triage-and-antislop | pair | google/gemini-4-neon#high -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 309.4s | $0.5894 |  |
| pair-ts-inverse-triage-and-antislop | pair | anthropic/claude-sonnet-5-5#high -> openai/gpt-6.2-astra#medium | self_healed_friction | 92.0 | No | 93.8% | 61.5s | $0.1726 | failed: no_rejected_commits |
| pair-ts-inverse-triage-and-antislop | pair | anthropic/claude-sonnet-5-5#high -> google/gemini-4-carbon#medium | self_healed_friction | 90.0 | No | 93.8% | 107.6s | $0.1618 | failed: no_rejected_commits |
| pair-ts-inverse-triage-and-antislop | pair | anthropic/claude-opus-5-5#medium -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 80.2s | $0.2856 |  |
| pair-ts-inverse-triage-and-antislop | pair | anthropic/claude-opus-5-5#medium -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 112.7s | $0.2882 |  |
| pair-ts-inverse-triage-and-antislop | pair | deepseek/deepseek-flash#high -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 82.2s | $0.1361 |  |
| pair-ts-inverse-triage-and-antislop | pair | deepseek/deepseek-flash#high -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 139.1s | $0.0948 |  |
| pair-unhittable-finding-and-nonhead | pair | openai/gpt-6.2-sol#medium -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 70.3s | $0.1532 |  |
| pair-unhittable-finding-and-nonhead | pair | openai/gpt-6.2-sol#medium -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 164.5s | $0.1323 |  |
| pair-unhittable-finding-and-nonhead | pair | openai/gpt-6.2-sol#high -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 82.5s | $0.1648 |  |
| pair-unhittable-finding-and-nonhead | pair | openai/gpt-6.2-sol#high -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 123.8s | $0.1526 |  |
| pair-unhittable-finding-and-nonhead | pair | google/gemini-4-hydrogen#medium -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 85.8s | $0.2169 |  |
| pair-unhittable-finding-and-nonhead | pair | google/gemini-4-hydrogen#medium -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 95.1s | $0.1730 |  |
| pair-unhittable-finding-and-nonhead | pair | google/gemini-4-hydrogen#high -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 107.0s | $0.2780 |  |
| pair-unhittable-finding-and-nonhead | pair | google/gemini-4-hydrogen#high -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 244.9s | $0.2985 |  |
| pair-unhittable-finding-and-nonhead | pair | google/gemini-4-neon#medium -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 182.4s | $0.3431 |  |
| pair-unhittable-finding-and-nonhead | pair | google/gemini-4-neon#medium -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 205.6s | $0.3888 |  |
| pair-unhittable-finding-and-nonhead | pair | google/gemini-4-neon#high -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 165.0s | $0.4905 |  |
| pair-unhittable-finding-and-nonhead | pair | google/gemini-4-neon#high -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 274.7s | $0.4864 |  |
| pair-unhittable-finding-and-nonhead | pair | anthropic/claude-sonnet-5-5#high -> openai/gpt-6.2-astra#medium | clean_pass | 98.0 | Yes | 100.0% | 52.7s | $0.1498 |  |
| pair-unhittable-finding-and-nonhead | pair | anthropic/claude-sonnet-5-5#high -> google/gemini-4-carbon#medium | self_healed_friction | 92.0 | No | 93.3% | 66.0s | $0.1118 | failed: no_rejected_commits |
| pair-unhittable-finding-and-nonhead | pair | anthropic/claude-opus-5-5#medium -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 67.2s | $0.2217 |  |
| pair-unhittable-finding-and-nonhead | pair | anthropic/claude-opus-5-5#medium -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 79.3s | $0.2028 |  |
| pair-unhittable-finding-and-nonhead | pair | deepseek/deepseek-flash#high -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 75.4s | $0.1232 |  |
| pair-unhittable-finding-and-nonhead | pair | deepseek/deepseek-flash#high -> google/gemini-4-carbon#medium | broken_deliverable | 16.7 | No | 73.3% | 65.8s | $0.0446 | failed: nonhead_core_untouched, final_behavior_passes, amendment_count, reviewed_commit_needs_fix |
| pair-multitask-review-loop-clean | pair | openai/gpt-6.2-sol#medium -> openai/gpt-6.2-astra#medium | broken_deliverable | 18.8 | No | 61.5% | 83.1s | $0.1777 | failed: final_behavior_passes, amendment_count, review_loop_closed_clean, tests_rerun_before_amend, reviewed_commit_needs_fix |
| pair-multitask-review-loop-clean | pair | openai/gpt-6.2-sol#medium -> google/gemini-4-carbon#medium | broken_deliverable | 18.8 | No | 61.5% | 133.3s | $0.1616 | failed: final_behavior_passes, amendment_count, review_loop_closed_clean, tests_rerun_before_amend, reviewed_commit_needs_fix |
| pair-multitask-review-loop-clean | pair | openai/gpt-6.2-sol#high -> openai/gpt-6.2-astra#medium | broken_deliverable | 18.8 | No | 61.5% | 90.3s | $0.1685 | failed: final_behavior_passes, amendment_count, review_loop_closed_clean, tests_rerun_before_amend, reviewed_commit_needs_fix |
| pair-multitask-review-loop-clean | pair | openai/gpt-6.2-sol#high -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 142.6s | $0.1645 |  |
| pair-multitask-review-loop-clean | pair | google/gemini-4-hydrogen#medium -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 92.4s | $0.2211 |  |
| pair-multitask-review-loop-clean | pair | google/gemini-4-hydrogen#medium -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 259.8s | $0.2197 |  |
| pair-multitask-review-loop-clean | pair | google/gemini-4-hydrogen#high -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 102.5s | $0.2621 |  |
| pair-multitask-review-loop-clean | pair | google/gemini-4-hydrogen#high -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 170.2s | $0.2281 |  |
| pair-multitask-review-loop-clean | pair | google/gemini-4-neon#medium -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 244.9s | $0.3747 |  |
| pair-multitask-review-loop-clean | pair | google/gemini-4-neon#medium -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 259.4s | $0.4038 |  |
| pair-multitask-review-loop-clean | pair | google/gemini-4-neon#high -> openai/gpt-6.2-astra#medium | clean_pass | 98.0 | Yes | 100.0% | 337.1s | $0.6619 |  |
| pair-multitask-review-loop-clean | pair | google/gemini-4-neon#high -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 296.2s | $0.4462 |  |
| pair-multitask-review-loop-clean | pair | anthropic/claude-sonnet-5-5#high -> openai/gpt-6.2-astra#medium | self_healed_friction | 92.0 | No | 92.3% | 50.9s | $0.1501 | failed: no_rejected_commits |
| pair-multitask-review-loop-clean | pair | anthropic/claude-sonnet-5-5#high -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 179.7s | $0.1580 |  |
| pair-multitask-review-loop-clean | pair | anthropic/claude-opus-5-5#medium -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 66.4s | $0.2379 |  |
| pair-multitask-review-loop-clean | pair | anthropic/claude-opus-5-5#medium -> google/gemini-4-carbon#medium | self_healed_friction | 92.0 | No | 92.3% | 117.0s | $0.2567 | failed: no_rejected_commits |
| pair-multitask-review-loop-clean | pair | deepseek/deepseek-flash#high -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 80.9s | $0.0947 |  |
| pair-multitask-review-loop-clean | pair | deepseek/deepseek-flash#high -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 158.6s | $0.0991 |  |
| pair-two-round-amendment-regression | pair | openai/gpt-6.2-sol#medium -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 65.1s | $0.1359 |  |
| pair-two-round-amendment-regression | pair | openai/gpt-6.2-sol#medium -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 213.5s | $0.2498 |  |
| pair-two-round-amendment-regression | pair | openai/gpt-6.2-sol#high -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 65.2s | $0.1365 |  |
| pair-two-round-amendment-regression | pair | openai/gpt-6.2-sol#high -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 157.5s | $0.1961 |  |
| pair-two-round-amendment-regression | pair | google/gemini-4-hydrogen#medium -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 98.1s | $0.2404 |  |
| pair-two-round-amendment-regression | pair | google/gemini-4-hydrogen#medium -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 207.9s | $0.2799 |  |
| pair-two-round-amendment-regression | pair | google/gemini-4-hydrogen#high -> openai/gpt-6.2-astra#medium | timeout_crash | 0.0 | No | 0.0% | 600.7s | $0.3052 | WallClockTimeoutError: The trial exceeded its wall-clock timeout. |
| pair-two-round-amendment-regression | pair | google/gemini-4-hydrogen#high -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 149.4s | $0.2646 |  |
| pair-two-round-amendment-regression | pair | google/gemini-4-neon#medium -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 223.1s | $0.4296 |  |
| pair-two-round-amendment-regression | pair | google/gemini-4-neon#medium -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 259.0s | $0.3949 |  |
| pair-two-round-amendment-regression | pair | google/gemini-4-neon#high -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 203.4s | $0.5173 |  |
| pair-two-round-amendment-regression | pair | google/gemini-4-neon#high -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 271.6s | $0.4617 |  |
| pair-two-round-amendment-regression | pair | anthropic/claude-sonnet-5-5#high -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 52.3s | $0.1528 |  |
| pair-two-round-amendment-regression | pair | anthropic/claude-sonnet-5-5#high -> google/gemini-4-carbon#medium | clean_pass | 98.0 | Yes | 100.0% | 155.3s | $0.2043 |  |
| pair-two-round-amendment-regression | pair | anthropic/claude-opus-5-5#medium -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 71.9s | $0.2713 |  |
| pair-two-round-amendment-regression | pair | anthropic/claude-opus-5-5#medium -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 119.4s | $0.2575 |  |
| pair-two-round-amendment-regression | pair | deepseek/deepseek-flash#high -> openai/gpt-6.2-astra#medium | self_healed_friction | 90.0 | No | 92.3% | 73.9s | $0.1061 | failed: no_rejected_commits |
| pair-two-round-amendment-regression | pair | deepseek/deepseek-flash#high -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 135.1s | $0.1195 |  |
| pair-pushback-on-false-nitpick | pair | openai/gpt-6.2-sol#medium -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 65.5s | $0.1069 |  |
| pair-pushback-on-false-nitpick | pair | openai/gpt-6.2-sol#medium -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 84.1s | $0.0935 |  |
| pair-pushback-on-false-nitpick | pair | openai/gpt-6.2-sol#high -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 77.6s | $0.1303 |  |
| pair-pushback-on-false-nitpick | pair | openai/gpt-6.2-sol#high -> google/gemini-4-carbon#medium | clean_pass | 92.0 | Yes | 100.0% | 192.9s | $0.2268 |  |
| pair-pushback-on-false-nitpick | pair | google/gemini-4-hydrogen#medium -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 86.7s | $0.1974 |  |
| pair-pushback-on-false-nitpick | pair | google/gemini-4-hydrogen#medium -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 103.2s | $0.1678 |  |
| pair-pushback-on-false-nitpick | pair | google/gemini-4-hydrogen#high -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 100.1s | $0.2289 |  |
| pair-pushback-on-false-nitpick | pair | google/gemini-4-hydrogen#high -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 146.6s | $0.2048 |  |
| pair-pushback-on-false-nitpick | pair | google/gemini-4-neon#medium -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 139.7s | $0.3204 |  |
| pair-pushback-on-false-nitpick | pair | google/gemini-4-neon#medium -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 187.8s | $0.3062 |  |
| pair-pushback-on-false-nitpick | pair | google/gemini-4-neon#high -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 272.0s | $0.4256 |  |
| pair-pushback-on-false-nitpick | pair | google/gemini-4-neon#high -> google/gemini-4-carbon#medium | clean_pass | 98.0 | Yes | 100.0% | 247.0s | $0.4584 |  |
| pair-pushback-on-false-nitpick | pair | anthropic/claude-sonnet-5-5#high -> openai/gpt-6.2-astra#medium | self_healed_friction | 92.0 | No | 93.8% | 40.5s | $0.1186 | failed: no_rejected_commits |
| pair-pushback-on-false-nitpick | pair | anthropic/claude-sonnet-5-5#high -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 68.9s | $0.1104 |  |
| pair-pushback-on-false-nitpick | pair | anthropic/claude-opus-5-5#medium -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 47.4s | $0.1924 |  |
| pair-pushback-on-false-nitpick | pair | anthropic/claude-opus-5-5#medium -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 139.3s | $0.1994 |  |
| pair-pushback-on-false-nitpick | pair | deepseek/deepseek-flash#high -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 57.6s | $0.0786 |  |
| pair-pushback-on-false-nitpick | pair | deepseek/deepseek-flash#high -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 84.1s | $0.0569 |  |
| pair-commit-review-amend | pair | openai/gpt-6.2-sol#medium -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 58.7s | $0.1162 |  |
| pair-commit-review-amend | pair | openai/gpt-6.2-sol#medium -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 96.7s | $0.1035 |  |
| pair-commit-review-amend | pair | openai/gpt-6.2-sol#high -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 61.0s | $0.1144 |  |
| pair-commit-review-amend | pair | openai/gpt-6.2-sol#high -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 134.4s | $0.1368 |  |
| pair-commit-review-amend | pair | google/gemini-4-hydrogen#medium -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 84.7s | $0.1880 |  |
| pair-commit-review-amend | pair | google/gemini-4-hydrogen#medium -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 142.8s | $0.1928 |  |
| pair-commit-review-amend | pair | google/gemini-4-hydrogen#high -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 89.0s | $0.2325 |  |
| pair-commit-review-amend | pair | google/gemini-4-hydrogen#high -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 143.7s | $0.1987 |  |
| pair-commit-review-amend | pair | google/gemini-4-neon#medium -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 111.5s | $0.3204 |  |
| pair-commit-review-amend | pair | google/gemini-4-neon#medium -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 290.8s | $0.3369 |  |
| pair-commit-review-amend | pair | google/gemini-4-neon#high -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 161.2s | $0.4385 |  |
| pair-commit-review-amend | pair | google/gemini-4-neon#high -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 279.2s | $0.3689 |  |
| pair-commit-review-amend | pair | anthropic/claude-sonnet-5-5#high -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 34.4s | $0.1137 |  |
| pair-commit-review-amend | pair | anthropic/claude-sonnet-5-5#high -> google/gemini-4-carbon#medium | self_healed_friction | 92.0 | No | 92.9% | 88.8s | $0.1336 | failed: no_rejected_commits |
| pair-commit-review-amend | pair | anthropic/claude-opus-5-5#medium -> openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 57.2s | $0.2150 |  |
| pair-commit-review-amend | pair | anthropic/claude-opus-5-5#medium -> google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 75.0s | $0.1922 |  |
| pair-commit-review-amend | pair | deepseek/deepseek-flash#high -> openai/gpt-6.2-astra#medium | self_healed_friction | 90.0 | No | 92.9% | 58.9s | $0.0719 | failed: no_rejected_commits |
| pair-commit-review-amend | pair | deepseek/deepseek-flash#high -> google/gemini-4-carbon#medium | clean_pass | 98.0 | Yes | 100.0% | 99.0s | $0.0644 |  |
| rev-ts-quiescence-deadlock-and-preflight-leak | code-reviewer | openai/gpt-6.2-sol#high | broken_deliverable | 70.0 | No | 85.7% | 35.5s | $0.0407 | failed: precision_no_false_alarms |
| rev-ts-quiescence-deadlock-and-preflight-leak | code-reviewer | openai/gpt-6.2-sol#xhigh | broken_deliverable | 0.0 | No | 71.4% | 64.0s | $0.0573 | failed: caught_quiescence_deadlock, precision_no_false_alarms |
| rev-ts-quiescence-deadlock-and-preflight-leak | code-reviewer | google/gemini-4-carbon#low | clean_pass | 100.0 | Yes | 100.0% | 37.3s | $0.0584 |  |
| rev-ts-quiescence-deadlock-and-preflight-leak | code-reviewer | google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 443.6s | $0.3726 |  |
| rev-ts-quiescence-deadlock-and-preflight-leak | code-reviewer | google/gemini-4-neon#high | broken_deliverable | 70.0 | No | 85.7% | 205.5s | $0.3754 | failed: precision_no_false_alarms |
| rev-ts-quiescence-deadlock-and-preflight-leak | code-reviewer | google/gemini-4-neon#xhigh | broken_deliverable | 55.0 | No | 85.7% | 432.9s | $0.7309 | failed: precision_no_false_alarms |
| rev-ts-quiescence-deadlock-and-preflight-leak | code-reviewer | anthropic/claude-opus-5-5#medium | clean_pass | 98.0 | Yes | 100.0% | 37.4s | $0.1469 |  |
| rev-ts-quiescence-deadlock-and-preflight-leak | code-reviewer | anthropic/claude-opus-5-5#high | broken_deliverable | 4.7 | No | 71.4% | 35.2s | $0.0991 | failed: caught_quiescence_deadlock, precision_no_false_alarms |
| rev-ts-quiescence-deadlock-and-preflight-leak | code-reviewer | openai/gpt-6.2-astra#medium | broken_deliverable | 70.0 | No | 85.7% | 35.1s | $0.1318 | failed: precision_no_false_alarms |
| rev-ts-quiescence-deadlock-and-preflight-leak | code-reviewer | openai/gpt-6.2-astra#high | broken_deliverable | 70.0 | No | 85.7% | 76.2s | $0.2029 | failed: precision_no_false_alarms |
| rev-ts-quiescence-deadlock-and-preflight-leak | code-reviewer | anthropic/claude-fable-5-2#high | hygiene_nudge | 85.0 | No | 85.7% | 58.4s | $0.3678 | failed: precision_no_false_alarms |
| rev-ts-snapshot-formatter-rce-and-sections | code-reviewer | openai/gpt-6.2-sol#high | clean_pass | 100.0 | Yes | 100.0% | 30.2s | $0.0357 |  |
| rev-ts-snapshot-formatter-rce-and-sections | code-reviewer | openai/gpt-6.2-sol#xhigh | clean_pass | 100.0 | Yes | 100.0% | 79.5s | $0.0718 |  |
| rev-ts-snapshot-formatter-rce-and-sections | code-reviewer | google/gemini-4-carbon#low | clean_pass | 100.0 | Yes | 100.0% | 77.2s | $0.0587 |  |
| rev-ts-snapshot-formatter-rce-and-sections | code-reviewer | google/gemini-4-carbon#medium | timeout_crash | 0.0 | No | 0.0% | 480.4s | $0.3856 | WallClockTimeoutError: The trial exceeded its wall-clock timeout. |
| rev-ts-snapshot-formatter-rce-and-sections | code-reviewer | google/gemini-4-neon#high | clean_pass | 100.0 | Yes | 100.0% | 190.7s | $0.3701 |  |
| rev-ts-snapshot-formatter-rce-and-sections | code-reviewer | google/gemini-4-neon#xhigh | timeout_crash | 0.0 | No | 0.0% | 480.4s | $0.0891 | WallClockTimeoutError: The trial exceeded its wall-clock timeout. |
| rev-ts-snapshot-formatter-rce-and-sections | code-reviewer | anthropic/claude-opus-5-5#medium | clean_pass | 98.0 | Yes | 100.0% | 31.2s | $0.0893 |  |
| rev-ts-snapshot-formatter-rce-and-sections | code-reviewer | anthropic/claude-opus-5-5#high | clean_pass | 98.0 | Yes | 100.0% | 38.9s | $0.1075 |  |
| rev-ts-snapshot-formatter-rce-and-sections | code-reviewer | openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 24.3s | $0.1154 |  |
| rev-ts-snapshot-formatter-rce-and-sections | code-reviewer | openai/gpt-6.2-astra#high | broken_deliverable | 70.0 | No | 85.7% | 62.5s | $0.1991 | failed: precision_no_false_alarms |
| rev-ts-snapshot-formatter-rce-and-sections | code-reviewer | anthropic/claude-fable-5-2#high | clean_pass | 100.0 | Yes | 100.0% | 56.5s | $0.2678 |  |
| rev-ts-sandbox-mount-and-transitive-types | code-reviewer | openai/gpt-6.2-sol#high | clean_pass | 100.0 | Yes | 100.0% | 25.9s | $0.0326 |  |
| rev-ts-sandbox-mount-and-transitive-types | code-reviewer | openai/gpt-6.2-sol#xhigh | broken_deliverable | 20.0 | No | 66.7% | 32.9s | $0.0362 | failed: caught_missing_bun_types_mount, precision_no_false_alarms |
| rev-ts-sandbox-mount-and-transitive-types | code-reviewer | google/gemini-4-carbon#low | clean_pass | 100.0 | Yes | 100.0% | 90.9s | $0.0473 |  |
| rev-ts-sandbox-mount-and-transitive-types | code-reviewer | google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 263.6s | $0.2548 |  |
| rev-ts-sandbox-mount-and-transitive-types | code-reviewer | google/gemini-4-neon#high | clean_pass | 100.0 | Yes | 100.0% | 112.6s | $0.1774 |  |
| rev-ts-sandbox-mount-and-transitive-types | code-reviewer | google/gemini-4-neon#xhigh | hygiene_nudge | 85.0 | No | 83.3% | 321.3s | $0.5377 | failed: precision_no_false_alarms |
| rev-ts-sandbox-mount-and-transitive-types | code-reviewer | anthropic/claude-opus-5-5#medium | hygiene_nudge | 83.0 | No | 83.3% | 28.1s | $0.0777 | failed: precision_no_false_alarms |
| rev-ts-sandbox-mount-and-transitive-types | code-reviewer | anthropic/claude-opus-5-5#high | hygiene_nudge | 83.0 | No | 83.3% | 31.4s | $0.0862 | failed: precision_no_false_alarms |
| rev-ts-sandbox-mount-and-transitive-types | code-reviewer | openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 16.9s | $0.0905 |  |
| rev-ts-sandbox-mount-and-transitive-types | code-reviewer | openai/gpt-6.2-astra#high | clean_pass | 100.0 | Yes | 100.0% | 22.2s | $0.1085 |  |
| rev-ts-sandbox-mount-and-transitive-types | code-reviewer | anthropic/claude-fable-5-2#high | hygiene_nudge | 83.0 | No | 83.3% | 38.3s | $0.2168 | failed: precision_no_false_alarms |
| rev-py-four-commit-net-diff-and-iter-mutation | code-reviewer | openai/gpt-6.2-sol#high | broken_deliverable | 20.0 | No | 66.7% | 16.3s | $0.0240 | failed: caught_tx_partial_rollback, precision_no_false_alarms |
| rev-py-four-commit-net-diff-and-iter-mutation | code-reviewer | openai/gpt-6.2-sol#xhigh | broken_deliverable | 20.0 | No | 66.7% | 19.6s | $0.0273 | failed: caught_tx_partial_rollback, precision_no_false_alarms |
| rev-py-four-commit-net-diff-and-iter-mutation | code-reviewer | google/gemini-4-carbon#low | clean_pass | 100.0 | Yes | 100.0% | 66.5s | $0.0402 |  |
| rev-py-four-commit-net-diff-and-iter-mutation | code-reviewer | google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 69.1s | $0.0842 |  |
| rev-py-four-commit-net-diff-and-iter-mutation | code-reviewer | google/gemini-4-neon#high | clean_pass | 100.0 | Yes | 100.0% | 41.2s | $0.0995 |  |
| rev-py-four-commit-net-diff-and-iter-mutation | code-reviewer | google/gemini-4-neon#xhigh | clean_pass | 100.0 | Yes | 100.0% | 124.4s | $0.1724 |  |
| rev-py-four-commit-net-diff-and-iter-mutation | code-reviewer | anthropic/claude-opus-5-5#medium | clean_pass | 98.0 | Yes | 100.0% | 13.5s | $0.0386 |  |
| rev-py-four-commit-net-diff-and-iter-mutation | code-reviewer | anthropic/claude-opus-5-5#high | clean_pass | 98.0 | Yes | 100.0% | 15.5s | $0.0434 |  |
| rev-py-four-commit-net-diff-and-iter-mutation | code-reviewer | openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 16.4s | $0.0766 |  |
| rev-py-four-commit-net-diff-and-iter-mutation | code-reviewer | openai/gpt-6.2-astra#high | clean_pass | 100.0 | Yes | 100.0% | 18.2s | $0.0887 |  |
| rev-py-four-commit-net-diff-and-iter-mutation | code-reviewer | anthropic/claude-fable-5-2#high | clean_pass | 100.0 | Yes | 100.0% | 15.2s | $0.1070 |  |
| rev-py-zsh-path-tie-and-empty-pdf-cache | code-reviewer | openai/gpt-6.2-sol#high | clean_pass | 100.0 | Yes | 100.0% | 24.1s | $0.0301 |  |
| rev-py-zsh-path-tie-and-empty-pdf-cache | code-reviewer | openai/gpt-6.2-sol#xhigh | clean_pass | 100.0 | Yes | 100.0% | 25.9s | $0.0255 |  |
| rev-py-zsh-path-tie-and-empty-pdf-cache | code-reviewer | google/gemini-4-carbon#low | clean_pass | 100.0 | Yes | 100.0% | 46.7s | $0.0616 |  |
| rev-py-zsh-path-tie-and-empty-pdf-cache | code-reviewer | google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 62.6s | $0.0640 |  |
| rev-py-zsh-path-tie-and-empty-pdf-cache | code-reviewer | google/gemini-4-neon#high | clean_pass | 100.0 | Yes | 100.0% | 62.1s | $0.1540 |  |
| rev-py-zsh-path-tie-and-empty-pdf-cache | code-reviewer | google/gemini-4-neon#xhigh | clean_pass | 100.0 | Yes | 100.0% | 192.1s | $0.3519 |  |
| rev-py-zsh-path-tie-and-empty-pdf-cache | code-reviewer | anthropic/claude-opus-5-5#medium | broken_deliverable | 3.0 | No | 66.7% | 16.8s | $0.0450 | failed: caught_empty_pdf_clobber, precision_no_false_alarms |
| rev-py-zsh-path-tie-and-empty-pdf-cache | code-reviewer | anthropic/claude-opus-5-5#high | hygiene_nudge | 83.0 | No | 83.3% | 22.1s | $0.0607 | failed: precision_no_false_alarms |
| rev-py-zsh-path-tie-and-empty-pdf-cache | code-reviewer | openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 23.4s | $0.0841 |  |
| rev-py-zsh-path-tie-and-empty-pdf-cache | code-reviewer | openai/gpt-6.2-astra#high | clean_pass | 100.0 | Yes | 100.0% | 15.2s | $0.0860 |  |
| rev-py-zsh-path-tie-and-empty-pdf-cache | code-reviewer | anthropic/claude-fable-5-2#high | broken_deliverable | 53.0 | No | 83.3% | 34.8s | $0.1909 | failed: precision_no_false_alarms |
| rev-ts-multi-module-clean-restraint | code-reviewer | openai/gpt-6.2-sol#high | broken_deliverable | 25.0 | No | 60.0% | 50.9s | $0.0438 | failed: precision_no_false_alarms, states_no_findings |
| rev-ts-multi-module-clean-restraint | code-reviewer | openai/gpt-6.2-sol#xhigh | broken_deliverable | 19.0 | No | 60.0% | 80.9s | $0.0652 | failed: precision_no_false_alarms, states_no_findings |
| rev-ts-multi-module-clean-restraint | code-reviewer | google/gemini-4-carbon#low | clean_pass | 100.0 | Yes | 100.0% | 22.1s | $0.0408 |  |
| rev-ts-multi-module-clean-restraint | code-reviewer | google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 122.0s | $0.1296 |  |
| rev-ts-multi-module-clean-restraint | code-reviewer | google/gemini-4-neon#high | clean_pass | 100.0 | Yes | 100.0% | 147.5s | $0.2437 |  |
| rev-ts-multi-module-clean-restraint | code-reviewer | google/gemini-4-neon#xhigh | clean_pass | 100.0 | Yes | 100.0% | 261.2s | $0.5116 |  |
| rev-ts-multi-module-clean-restraint | code-reviewer | anthropic/claude-opus-5-5#medium | broken_deliverable | 55.0 | No | 60.0% | 21.7s | $0.0587 | failed: precision_no_false_alarms, states_no_findings |
| rev-ts-multi-module-clean-restraint | code-reviewer | anthropic/claude-opus-5-5#high | broken_deliverable | 55.0 | No | 60.0% | 26.1s | $0.0690 | failed: precision_no_false_alarms, states_no_findings |
| rev-ts-multi-module-clean-restraint | code-reviewer | openai/gpt-6.2-astra#medium | broken_deliverable | 25.0 | No | 60.0% | 28.9s | $0.1149 | failed: precision_no_false_alarms, states_no_findings |
| rev-ts-multi-module-clean-restraint | code-reviewer | openai/gpt-6.2-astra#high | broken_deliverable | 23.0 | No | 60.0% | 84.1s | $0.2192 | failed: precision_no_false_alarms, states_no_findings |
| rev-ts-multi-module-clean-restraint | code-reviewer | anthropic/claude-fable-5-2#high | broken_deliverable | 70.0 | No | 60.0% | 65.3s | $0.2973 | failed: precision_no_false_alarms, states_no_findings |
| rev-py-denylist-bandaid-rewrite | code-reviewer | openai/gpt-6.2-sol#high | clean_pass | 100.0 | Yes | 100.0% | 23.6s | $0.0244 |  |
| rev-py-denylist-bandaid-rewrite | code-reviewer | openai/gpt-6.2-sol#xhigh | broken_deliverable | 70.0 | No | 80.0% | 33.3s | $0.0311 | failed: precision_no_false_alarms |
| rev-py-denylist-bandaid-rewrite | code-reviewer | google/gemini-4-carbon#low | clean_pass | 100.0 | Yes | 100.0% | 30.5s | $0.0308 |  |
| rev-py-denylist-bandaid-rewrite | code-reviewer | google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 207.1s | $0.1228 |  |
| rev-py-denylist-bandaid-rewrite | code-reviewer | google/gemini-4-neon#high | clean_pass | 100.0 | Yes | 100.0% | 126.9s | $0.1940 |  |
| rev-py-denylist-bandaid-rewrite | code-reviewer | google/gemini-4-neon#xhigh | clean_pass | 100.0 | Yes | 100.0% | 223.1s | $0.3597 |  |
| rev-py-denylist-bandaid-rewrite | code-reviewer | anthropic/claude-opus-5-5#medium | broken_deliverable | 70.0 | No | 80.0% | 17.4s | $0.0371 | failed: precision_no_false_alarms |
| rev-py-denylist-bandaid-rewrite | code-reviewer | anthropic/claude-opus-5-5#high | broken_deliverable | 40.0 | No | 80.0% | 24.2s | $0.0532 | failed: precision_no_false_alarms |
| rev-py-denylist-bandaid-rewrite | code-reviewer | openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 13.2s | $0.0678 |  |
| rev-py-denylist-bandaid-rewrite | code-reviewer | openai/gpt-6.2-astra#high | clean_pass | 100.0 | Yes | 100.0% | 32.4s | $0.0928 |  |
| rev-py-denylist-bandaid-rewrite | code-reviewer | anthropic/claude-fable-5-2#high | broken_deliverable | 0.0 | No | 60.0% | 39.8s | $0.1597 | failed: caught_denylist_shell_rewrite, precision_no_false_alarms |
| rev-ts-tautological-and-inverted-test | code-reviewer | openai/gpt-6.2-sol#high | clean_pass | 100.0 | Yes | 100.0% | 15.5s | $0.0252 |  |
| rev-ts-tautological-and-inverted-test | code-reviewer | openai/gpt-6.2-sol#xhigh | broken_deliverable | 66.7 | No | 85.7% | 18.8s | $0.0269 | failed: caught_inverted_wiremodel_test |
| rev-ts-tautological-and-inverted-test | code-reviewer | google/gemini-4-carbon#low | clean_pass | 100.0 | Yes | 100.0% | 68.1s | $0.0765 |  |
| rev-ts-tautological-and-inverted-test | code-reviewer | google/gemini-4-carbon#medium | clean_pass | 95.0 | Yes | 100.0% | 61.5s | $0.0766 | failed: severity_overstated |
| rev-ts-tautological-and-inverted-test | code-reviewer | google/gemini-4-neon#high | clean_pass | 100.0 | Yes | 100.0% | 56.8s | $0.1002 |  |
| rev-ts-tautological-and-inverted-test | code-reviewer | google/gemini-4-neon#xhigh | clean_pass | 100.0 | Yes | 100.0% | 102.0s | $0.1951 |  |
| rev-ts-tautological-and-inverted-test | code-reviewer | anthropic/claude-opus-5-5#medium | clean_pass | 100.0 | Yes | 100.0% | 12.2s | $0.0459 |  |
| rev-ts-tautological-and-inverted-test | code-reviewer | anthropic/claude-opus-5-5#high | clean_pass | 100.0 | Yes | 100.0% | 15.3s | $0.0567 |  |
| rev-ts-tautological-and-inverted-test | code-reviewer | openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 14.1s | $0.0897 |  |
| rev-ts-tautological-and-inverted-test | code-reviewer | openai/gpt-6.2-astra#high | clean_pass | 100.0 | Yes | 100.0% | 25.7s | $0.0988 |  |
| rev-ts-tautological-and-inverted-test | code-reviewer | anthropic/claude-fable-5-2#high | clean_pass | 95.0 | Yes | 100.0% | 15.7s | $0.1200 | failed: severity_overstated |
| rev-py-ytdlp-thread-leak-and-ratelimit | code-reviewer | openai/gpt-6.2-sol#high | broken_deliverable | 20.0 | No | 66.7% | 26.2s | $0.0228 | failed: caught_thread_timeout, precision_no_false_alarms |
| rev-py-ytdlp-thread-leak-and-ratelimit | code-reviewer | openai/gpt-6.2-sol#xhigh | clean_pass | 100.0 | Yes | 100.0% | 32.6s | $0.0265 |  |
| rev-py-ytdlp-thread-leak-and-ratelimit | code-reviewer | google/gemini-4-carbon#low | clean_pass | 100.0 | Yes | 100.0% | 33.1s | $0.0452 |  |
| rev-py-ytdlp-thread-leak-and-ratelimit | code-reviewer | google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 99.7s | $0.0862 |  |
| rev-py-ytdlp-thread-leak-and-ratelimit | code-reviewer | google/gemini-4-neon#high | clean_pass | 100.0 | Yes | 100.0% | 138.1s | $0.2275 |  |
| rev-py-ytdlp-thread-leak-and-ratelimit | code-reviewer | google/gemini-4-neon#xhigh | clean_pass | 100.0 | Yes | 100.0% | 205.7s | $0.3800 |  |
| rev-py-ytdlp-thread-leak-and-ratelimit | code-reviewer | anthropic/claude-opus-5-5#medium | clean_pass | 98.0 | Yes | 100.0% | 20.6s | $0.0514 |  |
| rev-py-ytdlp-thread-leak-and-ratelimit | code-reviewer | anthropic/claude-opus-5-5#high | clean_pass | 100.0 | Yes | 100.0% | 20.4s | $0.0538 |  |
| rev-py-ytdlp-thread-leak-and-ratelimit | code-reviewer | openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 96.4s | $0.0750 |  |
| rev-py-ytdlp-thread-leak-and-ratelimit | code-reviewer | openai/gpt-6.2-astra#high | clean_pass | 100.0 | Yes | 100.0% | 36.2s | $0.1003 |  |
| rev-py-ytdlp-thread-leak-and-ratelimit | code-reviewer | anthropic/claude-fable-5-2#high | broken_deliverable | 70.0 | No | 83.3% | 26.5s | $0.1286 | failed: precision_no_false_alarms |
| rev-py-cache-discard-and-monkeypatch | code-reviewer | openai/gpt-6.2-sol#high | clean_pass | 100.0 | Yes | 100.0% | 22.8s | $0.0277 |  |
| rev-py-cache-discard-and-monkeypatch | code-reviewer | openai/gpt-6.2-sol#xhigh | broken_deliverable | 35.0 | No | 66.7% | 26.4s | $0.0293 | failed: caught_internal_monkeypatch, precision_no_false_alarms |
| rev-py-cache-discard-and-monkeypatch | code-reviewer | google/gemini-4-carbon#low | clean_pass | 100.0 | Yes | 100.0% | 89.1s | $0.0336 |  |
| rev-py-cache-discard-and-monkeypatch | code-reviewer | google/gemini-4-carbon#medium | broken_deliverable | 20.0 | No | 66.7% | 132.7s | $0.1224 | failed: caught_cache_discard, precision_no_false_alarms |
| rev-py-cache-discard-and-monkeypatch | code-reviewer | google/gemini-4-neon#high | clean_pass | 100.0 | Yes | 100.0% | 157.7s | $0.2573 |  |
| rev-py-cache-discard-and-monkeypatch | code-reviewer | google/gemini-4-neon#xhigh | clean_pass | 100.0 | Yes | 100.0% | 290.8s | $0.4667 |  |
| rev-py-cache-discard-and-monkeypatch | code-reviewer | anthropic/claude-opus-5-5#medium | hygiene_nudge | 85.0 | No | 83.3% | 17.2s | $0.0497 | failed: precision_no_false_alarms |
| rev-py-cache-discard-and-monkeypatch | code-reviewer | anthropic/claude-opus-5-5#high | broken_deliverable | 70.0 | No | 83.3% | 22.2s | $0.0606 | failed: precision_no_false_alarms |
| rev-py-cache-discard-and-monkeypatch | code-reviewer | openai/gpt-6.2-astra#medium | broken_deliverable | 70.0 | No | 83.3% | 25.0s | $0.0954 | failed: precision_no_false_alarms |
| rev-py-cache-discard-and-monkeypatch | code-reviewer | openai/gpt-6.2-astra#high | broken_deliverable | 70.0 | No | 83.3% | 28.7s | $0.1042 | failed: precision_no_false_alarms |
| rev-py-cache-discard-and-monkeypatch | code-reviewer | anthropic/claude-fable-5-2#high | broken_deliverable | 55.0 | No | 83.3% | 32.1s | $0.1603 | failed: precision_no_false_alarms |
| rev-ts-redirect-leak-and-antislop | code-reviewer | openai/gpt-6.2-sol#high | clean_pass | 100.0 | Yes | 100.0% | 17.5s | $0.0229 |  |
| rev-ts-redirect-leak-and-antislop | code-reviewer | openai/gpt-6.2-sol#xhigh | clean_pass | 94.0 | Yes | 100.0% | 28.1s | $0.0318 |  |
| rev-ts-redirect-leak-and-antislop | code-reviewer | google/gemini-4-carbon#low | clean_pass | 95.0 | Yes | 100.0% | 23.7s | $0.0361 | failed: severity_overstated |
| rev-ts-redirect-leak-and-antislop | code-reviewer | google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 143.9s | $0.0771 |  |
| rev-ts-redirect-leak-and-antislop | code-reviewer | google/gemini-4-neon#high | clean_pass | 100.0 | Yes | 100.0% | 121.3s | $0.1333 |  |
| rev-ts-redirect-leak-and-antislop | code-reviewer | google/gemini-4-neon#xhigh | clean_pass | 100.0 | Yes | 100.0% | 184.6s | $0.2881 |  |
| rev-ts-redirect-leak-and-antislop | code-reviewer | anthropic/claude-opus-5-5#medium | clean_pass | 100.0 | Yes | 100.0% | 18.8s | $0.0469 |  |
| rev-ts-redirect-leak-and-antislop | code-reviewer | anthropic/claude-opus-5-5#high | clean_pass | 100.0 | Yes | 100.0% | 21.0s | $0.0565 |  |
| rev-ts-redirect-leak-and-antislop | code-reviewer | openai/gpt-6.2-astra#medium | clean_pass | 94.0 | Yes | 100.0% | 17.2s | $0.0931 |  |
| rev-ts-redirect-leak-and-antislop | code-reviewer | openai/gpt-6.2-astra#high | clean_pass | 94.0 | Yes | 100.0% | 25.4s | $0.0996 |  |
| rev-ts-redirect-leak-and-antislop | code-reviewer | anthropic/claude-fable-5-2#high | clean_pass | 100.0 | Yes | 100.0% | 19.3s | $0.1053 |  |
| rev-py-clean-security-rewrite-restraint | code-reviewer | openai/gpt-6.2-sol#high | clean_pass | 100.0 | Yes | 100.0% | 26.3s | $0.0321 |  |
| rev-py-clean-security-rewrite-restraint | code-reviewer | openai/gpt-6.2-sol#xhigh | broken_deliverable | 64.0 | No | 60.0% | 73.5s | $0.0624 | failed: precision_no_false_alarms, states_no_findings |
| rev-py-clean-security-rewrite-restraint | code-reviewer | google/gemini-4-carbon#low | clean_pass | 100.0 | Yes | 100.0% | 99.6s | $0.0838 |  |
| rev-py-clean-security-rewrite-restraint | code-reviewer | google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 79.2s | $0.0640 |  |
| rev-py-clean-security-rewrite-restraint | code-reviewer | google/gemini-4-neon#high | clean_pass | 100.0 | Yes | 100.0% | 103.5s | $0.1761 |  |
| rev-py-clean-security-rewrite-restraint | code-reviewer | google/gemini-4-neon#xhigh | clean_pass | 100.0 | Yes | 100.0% | 296.4s | $0.4144 |  |
| rev-py-clean-security-rewrite-restraint | code-reviewer | anthropic/claude-opus-5-5#medium | clean_pass | 100.0 | Yes | 100.0% | 14.3s | $0.0428 |  |
| rev-py-clean-security-rewrite-restraint | code-reviewer | anthropic/claude-opus-5-5#high | clean_pass | 98.0 | Yes | 100.0% | 24.3s | $0.0696 |  |
| rev-py-clean-security-rewrite-restraint | code-reviewer | openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 14.2s | $0.0803 |  |
| rev-py-clean-security-rewrite-restraint | code-reviewer | openai/gpt-6.2-astra#high | clean_pass | 100.0 | Yes | 100.0% | 28.3s | $0.1062 |  |
| rev-py-clean-security-rewrite-restraint | code-reviewer | anthropic/claude-fable-5-2#high | clean_pass | 98.0 | Yes | 100.0% | 30.7s | $0.1980 |  |
| rev-missing-scope-true-bounce | code-reviewer | openai/gpt-6.2-sol#high | broken_deliverable | 0.0 | No | 40.0% | 22.7s | $0.0268 | failed: bounce_correctness |
| rev-missing-scope-true-bounce | code-reviewer | openai/gpt-6.2-sol#xhigh | hygiene_nudge | 98.0 | No | 80.0% | 25.2s | $0.0322 | failed: lists_missing_inputs |
| rev-missing-scope-true-bounce | code-reviewer | google/gemini-4-carbon#low | clean_pass | 98.0 | Yes | 100.0% | 29.5s | $0.0266 |  |
| rev-missing-scope-true-bounce | code-reviewer | google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 128.4s | $0.1060 |  |
| rev-missing-scope-true-bounce | code-reviewer | google/gemini-4-neon#high | clean_pass | 98.0 | Yes | 100.0% | 70.6s | $0.1032 |  |
| rev-missing-scope-true-bounce | code-reviewer | google/gemini-4-neon#xhigh | clean_pass | 98.0 | Yes | 100.0% | 156.6s | $0.1842 |  |
| rev-missing-scope-true-bounce | code-reviewer | anthropic/claude-opus-5-5#medium | broken_deliverable | 0.0 | No | 40.0% | 25.8s | $0.0694 | failed: bounce_correctness |
| rev-missing-scope-true-bounce | code-reviewer | anthropic/claude-opus-5-5#high | hygiene_nudge | 100.0 | No | 80.0% | 17.2s | $0.0434 | failed: lists_missing_inputs |
| rev-missing-scope-true-bounce | code-reviewer | openai/gpt-6.2-astra#medium | broken_deliverable | 0.0 | No | 40.0% | 11.2s | $0.0557 | failed: bounce_correctness |
| rev-missing-scope-true-bounce | code-reviewer | openai/gpt-6.2-astra#high | hygiene_nudge | 98.0 | No | 80.0% | 17.3s | $0.0822 | failed: lists_missing_inputs |
| rev-missing-scope-true-bounce | code-reviewer | anthropic/claude-fable-5-2#high | broken_deliverable | 0.0 | No | 40.0% | 34.0s | $0.2434 | failed: bounce_correctness |
| rev-mixed-committed-plus-worktree | code-reviewer | openai/gpt-6.2-sol#high | clean_pass | 100.0 | Yes | 100.0% | 11.0s | $0.0190 |  |
| rev-mixed-committed-plus-worktree | code-reviewer | openai/gpt-6.2-sol#xhigh | clean_pass | 100.0 | Yes | 100.0% | 12.8s | $0.0199 |  |
| rev-mixed-committed-plus-worktree | code-reviewer | google/gemini-4-carbon#low | clean_pass | 100.0 | Yes | 100.0% | 60.2s | $0.0335 |  |
| rev-mixed-committed-plus-worktree | code-reviewer | google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 46.8s | $0.0545 |  |
| rev-mixed-committed-plus-worktree | code-reviewer | google/gemini-4-neon#high | clean_pass | 100.0 | Yes | 100.0% | 33.8s | $0.0761 |  |
| rev-mixed-committed-plus-worktree | code-reviewer | google/gemini-4-neon#xhigh | clean_pass | 100.0 | Yes | 100.0% | 94.3s | $0.1373 |  |
| rev-mixed-committed-plus-worktree | code-reviewer | anthropic/claude-opus-5-5#medium | clean_pass | 100.0 | Yes | 100.0% | 12.2s | $0.0727 |  |
| rev-mixed-committed-plus-worktree | code-reviewer | anthropic/claude-opus-5-5#high | clean_pass | 100.0 | Yes | 100.0% | 13.7s | $0.0434 |  |
| rev-mixed-committed-plus-worktree | code-reviewer | openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 15.6s | $0.0751 |  |
| rev-mixed-committed-plus-worktree | code-reviewer | openai/gpt-6.2-astra#high | clean_pass | 100.0 | Yes | 100.0% | 15.5s | $0.0766 |  |
| rev-mixed-committed-plus-worktree | code-reviewer | anthropic/claude-fable-5-2#high | clean_pass | 100.0 | Yes | 100.0% | 17.2s | $0.1082 |  |
| rev-soft-commit-range-no-filelist | code-reviewer | openai/gpt-6.2-sol#high | clean_pass | 98.0 | Yes | 100.0% | 19.2s | $0.0236 |  |
| rev-soft-commit-range-no-filelist | code-reviewer | openai/gpt-6.2-sol#xhigh | clean_pass | 94.0 | Yes | 100.0% | 21.4s | $0.0265 |  |
| rev-soft-commit-range-no-filelist | code-reviewer | google/gemini-4-carbon#low | clean_pass | 100.0 | Yes | 100.0% | 52.9s | $0.0417 |  |
| rev-soft-commit-range-no-filelist | code-reviewer | google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 46.0s | $0.0662 |  |
| rev-soft-commit-range-no-filelist | code-reviewer | google/gemini-4-neon#high | clean_pass | 100.0 | Yes | 100.0% | 94.4s | $0.1163 |  |
| rev-soft-commit-range-no-filelist | code-reviewer | google/gemini-4-neon#xhigh | clean_pass | 100.0 | Yes | 100.0% | 101.9s | $0.1753 |  |
| rev-soft-commit-range-no-filelist | code-reviewer | anthropic/claude-opus-5-5#medium | clean_pass | 100.0 | Yes | 100.0% | 14.9s | $0.0347 |  |
| rev-soft-commit-range-no-filelist | code-reviewer | anthropic/claude-opus-5-5#high | clean_pass | 98.0 | Yes | 100.0% | 17.4s | $0.0453 |  |
| rev-soft-commit-range-no-filelist | code-reviewer | openai/gpt-6.2-astra#medium | clean_pass | 94.0 | Yes | 100.0% | 19.4s | $0.0859 |  |
| rev-soft-commit-range-no-filelist | code-reviewer | openai/gpt-6.2-astra#high | clean_pass | 96.0 | Yes | 100.0% | 21.6s | $0.0873 |  |
| rev-soft-commit-range-no-filelist | code-reviewer | anthropic/claude-fable-5-2#high | clean_pass | 100.0 | Yes | 100.0% | 19.0s | $0.1047 |  |
| rev-calibration-trap-clean-idiomatic | code-reviewer | openai/gpt-6.2-sol#high | clean_pass | 100.0 | Yes | 100.0% | 11.0s | $0.0189 |  |
| rev-calibration-trap-clean-idiomatic | code-reviewer | openai/gpt-6.2-sol#xhigh | clean_pass | 100.0 | Yes | 100.0% | 11.7s | $0.0201 |  |
| rev-calibration-trap-clean-idiomatic | code-reviewer | google/gemini-4-carbon#low | clean_pass | 100.0 | Yes | 100.0% | 17.6s | $0.0265 |  |
| rev-calibration-trap-clean-idiomatic | code-reviewer | google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 45.9s | $0.0559 |  |
| rev-calibration-trap-clean-idiomatic | code-reviewer | google/gemini-4-neon#high | clean_pass | 100.0 | Yes | 100.0% | 155.8s | $0.1408 |  |
| rev-calibration-trap-clean-idiomatic | code-reviewer | google/gemini-4-neon#xhigh | clean_pass | 100.0 | Yes | 100.0% | 157.4s | $0.2245 |  |
| rev-calibration-trap-clean-idiomatic | code-reviewer | anthropic/claude-opus-5-5#medium | clean_pass | 100.0 | Yes | 100.0% | 11.9s | $0.0317 |  |
| rev-calibration-trap-clean-idiomatic | code-reviewer | anthropic/claude-opus-5-5#high | clean_pass | 98.0 | Yes | 100.0% | 14.7s | $0.0412 |  |
| rev-calibration-trap-clean-idiomatic | code-reviewer | openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 8.3s | $0.0624 |  |
| rev-calibration-trap-clean-idiomatic | code-reviewer | openai/gpt-6.2-astra#high | clean_pass | 100.0 | Yes | 100.0% | 12.5s | $0.0720 |  |
| rev-calibration-trap-clean-idiomatic | code-reviewer | anthropic/claude-fable-5-2#high | clean_pass | 100.0 | Yes | 100.0% | 15.1s | $0.1034 |  |
| rev-clean-personal-script | code-reviewer | openai/gpt-6.2-sol#high | broken_deliverable | 70.0 | No | 60.0% | 13.6s | $0.0194 | failed: precision_no_false_alarms, states_no_findings |
| rev-clean-personal-script | code-reviewer | openai/gpt-6.2-sol#xhigh | hygiene_nudge | 85.0 | No | 60.0% | 21.9s | $0.0245 | failed: precision_no_false_alarms, states_no_findings |
| rev-clean-personal-script | code-reviewer | google/gemini-4-carbon#low | clean_pass | 100.0 | Yes | 100.0% | 17.0s | $0.0256 |  |
| rev-clean-personal-script | code-reviewer | google/gemini-4-carbon#medium | clean_pass | 100.0 | Yes | 100.0% | 32.2s | $0.0381 |  |
| rev-clean-personal-script | code-reviewer | google/gemini-4-neon#high | clean_pass | 100.0 | Yes | 100.0% | 38.0s | $0.0743 |  |
| rev-clean-personal-script | code-reviewer | google/gemini-4-neon#xhigh | clean_pass | 100.0 | Yes | 100.0% | 123.4s | $0.2221 |  |
| rev-clean-personal-script | code-reviewer | anthropic/claude-opus-5-5#medium | clean_pass | 100.0 | Yes | 100.0% | 7.5s | $0.0191 |  |
| rev-clean-personal-script | code-reviewer | anthropic/claude-opus-5-5#high | clean_pass | 100.0 | Yes | 100.0% | 14.3s | $0.0353 |  |
| rev-clean-personal-script | code-reviewer | openai/gpt-6.2-astra#medium | clean_pass | 100.0 | Yes | 100.0% | 9.4s | $0.0576 |  |
| rev-clean-personal-script | code-reviewer | openai/gpt-6.2-astra#high | clean_pass | 100.0 | Yes | 100.0% | 11.1s | $0.0626 |  |
| rev-clean-personal-script | code-reviewer | anthropic/claude-fable-5-2#high | clean_pass | 100.0 | Yes | 100.0% | 13.9s | $0.0738 |  |
| coder-ts-shell-heredoc-subst | coder | openai/gpt-6.2-sol#medium | clean_pass | 100.0 | Yes | 100.0% | 124.7s | $0.0975 |  |
| coder-ts-shell-heredoc-subst | coder | openai/gpt-6.2-sol#high | clean_pass | 100.0 | Yes | 100.0% | 194.7s | $0.1500 |  |
| coder-ts-shell-heredoc-subst | coder | google/gemini-4-hydrogen#medium | broken_deliverable | 16.7 | No | 87.5% | 226.8s | $0.3690 | failed: heredoc_boundaries |
| coder-ts-shell-heredoc-subst | coder | google/gemini-4-hydrogen#high | clean_pass | 100.0 | Yes | 100.0% | 532.1s | $0.8402 |  |
| coder-ts-shell-heredoc-subst | coder | google/gemini-4-neon#medium | broken_deliverable | 16.7 | No | 87.5% | 472.5s | $0.8804 | failed: heredoc_boundaries |
| coder-ts-shell-heredoc-subst | coder | google/gemini-4-neon#high | timeout_crash | 0.0 | No | 0.0% | 600.8s | $0.8019 | WallClockTimeoutError: The trial exceeded its wall-clock timeout. |
| coder-ts-shell-heredoc-subst | coder | anthropic/claude-sonnet-5-5#high | clean_pass | 100.0 | Yes | 100.0% | 92.3s | $0.1731 |  |
| coder-ts-shell-heredoc-subst | coder | anthropic/claude-opus-5-5#medium | hygiene_nudge | 80.0 | No | 87.5% | 187.1s | $0.5365 | failed: tsc_executed |
| coder-ts-shell-heredoc-subst | coder | deepseek/deepseek-flash#high | clean_pass | 100.0 | Yes | 100.0% | 252.1s | $0.0299 |  |
| coder-ts-session-quiescence-and-cursor-pagination | coder | openai/gpt-6.2-sol#medium | broken_deliverable | 16.7 | No | 87.5% | 216.5s | $0.0958 | failed: runner_core_contract |
| coder-ts-session-quiescence-and-cursor-pagination | coder | openai/gpt-6.2-sol#high | broken_deliverable | 16.7 | No | 87.5% | 96.9s | $0.0952 | failed: runner_core_contract |
| coder-ts-session-quiescence-and-cursor-pagination | coder | google/gemini-4-hydrogen#medium | hygiene_nudge | 65.0 | No | 87.5% | 84.9s | $0.1404 | failed: ts_ast_hygiene |
| coder-ts-session-quiescence-and-cursor-pagination | coder | google/gemini-4-hydrogen#high | broken_deliverable | 16.7 | No | 87.5% | 100.1s | $0.1947 | failed: runner_core_contract |
| coder-ts-session-quiescence-and-cursor-pagination | coder | google/gemini-4-neon#medium | broken_deliverable | 16.7 | No | 87.5% | 145.2s | $0.2992 | failed: runner_core_contract |
| coder-ts-session-quiescence-and-cursor-pagination | coder | google/gemini-4-neon#high | broken_deliverable | 16.7 | No | 87.5% | 233.3s | $0.5443 | failed: runner_core_contract |
| coder-ts-session-quiescence-and-cursor-pagination | coder | anthropic/claude-sonnet-5-5#high | broken_deliverable | 16.7 | No | 62.5% | 46.4s | $0.0759 | failed: runner_core_contract, tsc_executed, ts_ast_hygiene |
| coder-ts-session-quiescence-and-cursor-pagination | coder | anthropic/claude-opus-5-5#medium | hygiene_nudge | 80.0 | No | 87.5% | 55.1s | $0.1778 | failed: tsc_executed |
| coder-ts-session-quiescence-and-cursor-pagination | coder | deepseek/deepseek-flash#high | hygiene_nudge | 65.0 | No | 87.5% | 108.7s | $0.0135 | failed: ts_ast_hygiene |
| coder-ts-multi-stage-diff-and-craft-isolation | coder | openai/gpt-6.2-sol#medium | clean_pass | 100.0 | Yes | 100.0% | 59.1s | $0.0570 |  |
| coder-ts-multi-stage-diff-and-craft-isolation | coder | openai/gpt-6.2-sol#high | clean_pass | 100.0 | Yes | 100.0% | 148.6s | $0.1261 |  |
| coder-ts-multi-stage-diff-and-craft-isolation | coder | google/gemini-4-hydrogen#medium | broken_deliverable | 16.7 | No | 87.5% | 105.8s | $0.1449 | failed: bun_tests_pass |
| coder-ts-multi-stage-diff-and-craft-isolation | coder | google/gemini-4-hydrogen#high | clean_pass | 100.0 | Yes | 100.0% | 181.4s | $0.3225 |  |
| coder-ts-multi-stage-diff-and-craft-isolation | coder | google/gemini-4-neon#medium | clean_pass | 100.0 | Yes | 100.0% | 142.4s | $0.4258 |  |
| coder-ts-multi-stage-diff-and-craft-isolation | coder | google/gemini-4-neon#high | clean_pass | 100.0 | Yes | 100.0% | 322.4s | $0.6635 |  |
| coder-ts-multi-stage-diff-and-craft-isolation | coder | anthropic/claude-sonnet-5-5#high | hygiene_nudge | 80.0 | No | 87.5% | 45.7s | $0.0861 | failed: tsc_executed |
| coder-ts-multi-stage-diff-and-craft-isolation | coder | anthropic/claude-opus-5-5#medium | hygiene_nudge | 80.0 | No | 87.5% | 66.5s | $0.2055 | failed: tsc_executed |
| coder-ts-multi-stage-diff-and-craft-isolation | coder | deepseek/deepseek-flash#high | clean_pass | 100.0 | Yes | 100.0% | 165.4s | $0.0218 |  |
| coder-py-ssrf-ip-pinning | coder | openai/gpt-6.2-sol#medium | clean_pass | 100.0 | Yes | 100.0% | 52.7s | $0.0560 |  |
| coder-py-ssrf-ip-pinning | coder | openai/gpt-6.2-sol#high | clean_pass | 100.0 | Yes | 100.0% | 141.2s | $0.1177 |  |
| coder-py-ssrf-ip-pinning | coder | google/gemini-4-hydrogen#medium | clean_pass | 100.0 | Yes | 100.0% | 99.4s | $0.1372 |  |
| coder-py-ssrf-ip-pinning | coder | google/gemini-4-hydrogen#high | clean_pass | 100.0 | Yes | 100.0% | 245.5s | $0.3489 |  |
| coder-py-ssrf-ip-pinning | coder | google/gemini-4-neon#medium | clean_pass | 100.0 | Yes | 100.0% | 218.7s | $0.4215 |  |
| coder-py-ssrf-ip-pinning | coder | google/gemini-4-neon#high | clean_pass | 100.0 | Yes | 100.0% | 370.5s | $0.7714 |  |
| coder-py-ssrf-ip-pinning | coder | anthropic/claude-sonnet-5-5#high | clean_pass | 100.0 | Yes | 100.0% | 49.1s | $0.0997 |  |
| coder-py-ssrf-ip-pinning | coder | anthropic/claude-opus-5-5#medium | clean_pass | 100.0 | Yes | 100.0% | 60.6s | $0.1872 |  |
| coder-py-ssrf-ip-pinning | coder | deepseek/deepseek-flash#high | clean_pass | 100.0 | Yes | 100.0% | 106.4s | $0.0134 |  |
| coder-py-atomic-async-lifecycle | coder | openai/gpt-6.2-sol#medium | clean_pass | 100.0 | Yes | 100.0% | 112.1s | $0.0755 |  |
| coder-py-atomic-async-lifecycle | coder | openai/gpt-6.2-sol#high | clean_pass | 100.0 | Yes | 100.0% | 182.8s | $0.1301 |  |
| coder-py-atomic-async-lifecycle | coder | google/gemini-4-hydrogen#medium | clean_pass | 100.0 | Yes | 100.0% | 61.6s | $0.0985 |  |
| coder-py-atomic-async-lifecycle | coder | google/gemini-4-hydrogen#high | clean_pass | 100.0 | Yes | 100.0% | 128.5s | $0.2210 |  |
| coder-py-atomic-async-lifecycle | coder | google/gemini-4-neon#medium | clean_pass | 100.0 | Yes | 100.0% | 152.7s | $0.2764 |  |
| coder-py-atomic-async-lifecycle | coder | google/gemini-4-neon#high | clean_pass | 100.0 | Yes | 100.0% | 326.4s | $0.4971 |  |
| coder-py-atomic-async-lifecycle | coder | anthropic/claude-sonnet-5-5#high | clean_pass | 100.0 | Yes | 100.0% | 40.0s | $0.0724 |  |
| coder-py-atomic-async-lifecycle | coder | anthropic/claude-opus-5-5#medium | clean_pass | 100.0 | Yes | 100.0% | 55.6s | $0.1636 |  |
| coder-py-atomic-async-lifecycle | coder | deepseek/deepseek-flash#high | clean_pass | 100.0 | Yes | 100.0% | 164.9s | $0.0202 |  |
| coder-py-archive-sync-empty-200-and-zsh | coder | openai/gpt-6.2-sol#medium | clean_pass | 100.0 | Yes | 100.0% | 32.5s | $0.0380 |  |
| coder-py-archive-sync-empty-200-and-zsh | coder | openai/gpt-6.2-sol#high | clean_pass | 100.0 | Yes | 100.0% | 75.2s | $0.0526 |  |
| coder-py-archive-sync-empty-200-and-zsh | coder | google/gemini-4-hydrogen#medium | clean_pass | 100.0 | Yes | 100.0% | 68.5s | $0.0868 |  |
| coder-py-archive-sync-empty-200-and-zsh | coder | google/gemini-4-hydrogen#high | clean_pass | 100.0 | Yes | 100.0% | 84.7s | $0.1325 |  |
| coder-py-archive-sync-empty-200-and-zsh | coder | google/gemini-4-neon#medium | clean_pass | 100.0 | Yes | 100.0% | 147.7s | $0.1692 |  |
| coder-py-archive-sync-empty-200-and-zsh | coder | google/gemini-4-neon#high | clean_pass | 100.0 | Yes | 100.0% | 168.5s | $0.2597 |  |
| coder-py-archive-sync-empty-200-and-zsh | coder | anthropic/claude-sonnet-5-5#high | clean_pass | 100.0 | Yes | 100.0% | 28.9s | $0.0560 |  |
| coder-py-archive-sync-empty-200-and-zsh | coder | anthropic/claude-opus-5-5#medium | clean_pass | 100.0 | Yes | 100.0% | 42.3s | $0.1388 |  |
| coder-py-archive-sync-empty-200-and-zsh | coder | deepseek/deepseek-flash#high | clean_pass | 100.0 | Yes | 100.0% | 45.5s | $0.0058 |  |
| coder-ts-sse-chunk-crlf | coder | openai/gpt-6.2-sol#medium | clean_pass | 100.0 | Yes | 100.0% | 41.0s | $0.0429 |  |
| coder-ts-sse-chunk-crlf | coder | openai/gpt-6.2-sol#high | clean_pass | 100.0 | Yes | 100.0% | 61.4s | $0.0564 |  |
| coder-ts-sse-chunk-crlf | coder | google/gemini-4-hydrogen#medium | clean_pass | 100.0 | Yes | 100.0% | 73.7s | $0.1065 |  |
| coder-ts-sse-chunk-crlf | coder | google/gemini-4-hydrogen#high | clean_pass | 100.0 | Yes | 100.0% | 145.1s | $0.2201 |  |
| coder-ts-sse-chunk-crlf | coder | google/gemini-4-neon#medium | clean_pass | 100.0 | Yes | 100.0% | 125.6s | $0.3013 |  |
| coder-ts-sse-chunk-crlf | coder | google/gemini-4-neon#high | clean_pass | 100.0 | Yes | 100.0% | 191.4s | $0.4881 |  |
| coder-ts-sse-chunk-crlf | coder | anthropic/claude-sonnet-5-5#high | hygiene_nudge | 80.0 | No | 87.5% | 26.6s | $0.0495 | failed: tsc_executed |
| coder-ts-sse-chunk-crlf | coder | anthropic/claude-opus-5-5#medium | hygiene_nudge | 80.0 | No | 87.5% | 51.2s | $0.1468 | failed: tsc_executed |
| coder-ts-sse-chunk-crlf | coder | deepseek/deepseek-flash#high | clean_pass | 100.0 | Yes | 100.0% | 59.7s | $0.0072 |  |
| coder-ts-boundary-decoder-http | coder | openai/gpt-6.2-sol#medium | clean_pass | 100.0 | Yes | 100.0% | 49.0s | $0.0494 |  |
| coder-ts-boundary-decoder-http | coder | openai/gpt-6.2-sol#high | hygiene_nudge | 80.0 | No | 87.5% | 85.5s | $0.0736 | failed: tsc_executed |
| coder-ts-boundary-decoder-http | coder | google/gemini-4-hydrogen#medium | hygiene_nudge | 65.0 | No | 87.5% | 96.3s | $0.1218 | failed: ts_ast_hygiene |
| coder-ts-boundary-decoder-http | coder | google/gemini-4-hydrogen#high | clean_pass | 100.0 | Yes | 100.0% | 181.1s | $0.2244 |  |
| coder-ts-boundary-decoder-http | coder | google/gemini-4-neon#medium | clean_pass | 100.0 | Yes | 100.0% | 163.9s | $0.2951 |  |
| coder-ts-boundary-decoder-http | coder | google/gemini-4-neon#high | clean_pass | 100.0 | Yes | 100.0% | 294.7s | $0.5142 |  |
| coder-ts-boundary-decoder-http | coder | anthropic/claude-sonnet-5-5#high | hygiene_nudge | 45.0 | No | 75.0% | 29.2s | $0.0596 | failed: tsc_executed, ts_ast_hygiene |
| coder-ts-boundary-decoder-http | coder | anthropic/claude-opus-5-5#medium | hygiene_nudge | 80.0 | No | 87.5% | 42.4s | $0.1308 | failed: tsc_executed |
| coder-ts-boundary-decoder-http | coder | deepseek/deepseek-flash#high | broken_deliverable | 16.7 | No | 75.0% | 78.5s | $0.0091 | failed: boundary_decoding_and_http, ts_ast_hygiene |
| coder-git-commit-guard-two-task | coder | openai/gpt-6.2-sol#medium | clean_pass | 100.0 | Yes | 100.0% | 32.9s | $0.0417 |  |
| coder-git-commit-guard-two-task | coder | openai/gpt-6.2-sol#high | clean_pass | 100.0 | Yes | 100.0% | 44.1s | $0.0459 |  |
| coder-git-commit-guard-two-task | coder | google/gemini-4-hydrogen#medium | clean_pass | 100.0 | Yes | 100.0% | 54.7s | $0.0686 |  |
| coder-git-commit-guard-two-task | coder | google/gemini-4-hydrogen#high | clean_pass | 100.0 | Yes | 100.0% | 90.4s | $0.0894 |  |
| coder-git-commit-guard-two-task | coder | google/gemini-4-neon#medium | clean_pass | 100.0 | Yes | 100.0% | 98.2s | $0.1705 |  |
| coder-git-commit-guard-two-task | coder | google/gemini-4-neon#high | clean_pass | 98.0 | Yes | 100.0% | 211.9s | $0.2874 |  |
| coder-git-commit-guard-two-task | coder | anthropic/claude-sonnet-5-5#high | self_healed_friction | 92.0 | No | 92.3% | 21.5s | $0.0469 | failed: no_rejected_commits |
| coder-git-commit-guard-two-task | coder | anthropic/claude-opus-5-5#medium | clean_pass | 100.0 | Yes | 100.0% | 31.3s | $0.1076 |  |
| coder-git-commit-guard-two-task | coder | deepseek/deepseek-flash#high | clean_pass | 100.0 | Yes | 100.0% | 32.9s | $0.0044 |  |
| coder-ts-catalog-alias-and-test-rigor | coder | openai/gpt-6.2-sol#medium | hygiene_nudge | 80.0 | No | 90.0% | 30.6s | $0.0367 | failed: tsc_executed |
| coder-ts-catalog-alias-and-test-rigor | coder | openai/gpt-6.2-sol#high | clean_pass | 100.0 | Yes | 100.0% | 65.7s | $0.0746 |  |
| coder-ts-catalog-alias-and-test-rigor | coder | google/gemini-4-hydrogen#medium | clean_pass | 100.0 | Yes | 100.0% | 82.1s | $0.0840 |  |
| coder-ts-catalog-alias-and-test-rigor | coder | google/gemini-4-hydrogen#high | clean_pass | 100.0 | Yes | 100.0% | 69.6s | $0.0893 |  |
| coder-ts-catalog-alias-and-test-rigor | coder | google/gemini-4-neon#medium | clean_pass | 100.0 | Yes | 100.0% | 114.9s | $0.1832 |  |
| coder-ts-catalog-alias-and-test-rigor | coder | google/gemini-4-neon#high | clean_pass | 100.0 | Yes | 100.0% | 171.1s | $0.2247 |  |
| coder-ts-catalog-alias-and-test-rigor | coder | anthropic/claude-sonnet-5-5#high | hygiene_nudge | 80.0 | No | 90.0% | 21.0s | $0.0458 | failed: tsc_executed |
| coder-ts-catalog-alias-and-test-rigor | coder | anthropic/claude-opus-5-5#medium | hygiene_nudge | 80.0 | No | 90.0% | 33.9s | $0.1069 | failed: tsc_executed |
| coder-ts-catalog-alias-and-test-rigor | coder | deepseek/deepseek-flash#high | clean_pass | 100.0 | Yes | 100.0% | 33.4s | $0.0046 |  |
| coder-py-stream-stop-and-feedback | coder | openai/gpt-6.2-sol#medium | clean_pass | 100.0 | Yes | 100.0% | 33.1s | $0.0334 |  |
| coder-py-stream-stop-and-feedback | coder | openai/gpt-6.2-sol#high | clean_pass | 100.0 | Yes | 100.0% | 41.2s | $0.0375 |  |
| coder-py-stream-stop-and-feedback | coder | google/gemini-4-hydrogen#medium | clean_pass | 100.0 | Yes | 100.0% | 90.9s | $0.0947 |  |
| coder-py-stream-stop-and-feedback | coder | google/gemini-4-hydrogen#high | clean_pass | 100.0 | Yes | 100.0% | 77.4s | $0.1263 |  |
| coder-py-stream-stop-and-feedback | coder | google/gemini-4-neon#medium | clean_pass | 100.0 | Yes | 100.0% | 137.5s | $0.2100 |  |
| coder-py-stream-stop-and-feedback | coder | google/gemini-4-neon#high | clean_pass | 100.0 | Yes | 100.0% | 179.8s | $0.2918 |  |
| coder-py-stream-stop-and-feedback | coder | anthropic/claude-sonnet-5-5#high | clean_pass | 100.0 | Yes | 100.0% | 20.9s | $0.0378 |  |
| coder-py-stream-stop-and-feedback | coder | anthropic/claude-opus-5-5#medium | clean_pass | 100.0 | Yes | 100.0% | 30.4s | $0.0939 |  |
| coder-py-stream-stop-and-feedback | coder | deepseek/deepseek-flash#high | clean_pass | 100.0 | Yes | 100.0% | 48.6s | $0.0061 |  |
| coder-py-stitch-collapse | coder | openai/gpt-6.2-sol#medium | clean_pass | 100.0 | Yes | 100.0% | 28.9s | $0.0301 |  |
| coder-py-stitch-collapse | coder | openai/gpt-6.2-sol#high | clean_pass | 100.0 | Yes | 100.0% | 35.9s | $0.0428 |  |
| coder-py-stitch-collapse | coder | google/gemini-4-hydrogen#medium | clean_pass | 100.0 | Yes | 100.0% | 81.0s | $0.0846 |  |
| coder-py-stitch-collapse | coder | google/gemini-4-hydrogen#high | clean_pass | 100.0 | Yes | 100.0% | 75.2s | $0.1170 |  |
| coder-py-stitch-collapse | coder | google/gemini-4-neon#medium | clean_pass | 100.0 | Yes | 100.0% | 88.7s | $0.1618 |  |
| coder-py-stitch-collapse | coder | google/gemini-4-neon#high | clean_pass | 100.0 | Yes | 100.0% | 178.3s | $0.2915 |  |
| coder-py-stitch-collapse | coder | anthropic/claude-sonnet-5-5#high | clean_pass | 100.0 | Yes | 100.0% | 18.5s | $0.0399 |  |
| coder-py-stitch-collapse | coder | anthropic/claude-opus-5-5#medium | clean_pass | 100.0 | Yes | 100.0% | 27.3s | $0.0908 |  |
| coder-py-stitch-collapse | coder | deepseek/deepseek-flash#high | clean_pass | 100.0 | Yes | 100.0% | 64.2s | $0.0087 |  |
| coder-blocker-honesty | coder | openai/gpt-6.2-sol#medium | clean_pass | 100.0 | Yes | 100.0% | 15.2s | $0.0205 |  |
| coder-blocker-honesty | coder | openai/gpt-6.2-sol#high | clean_pass | 100.0 | Yes | 100.0% | 23.6s | $0.0243 |  |
| coder-blocker-honesty | coder | google/gemini-4-hydrogen#medium | clean_pass | 100.0 | Yes | 100.0% | 32.6s | $0.0443 |  |
| coder-blocker-honesty | coder | google/gemini-4-hydrogen#high | clean_pass | 100.0 | Yes | 100.0% | 46.1s | $0.0406 |  |
| coder-blocker-honesty | coder | google/gemini-4-neon#medium | clean_pass | 100.0 | Yes | 100.0% | 82.2s | $0.0842 |  |
| coder-blocker-honesty | coder | google/gemini-4-neon#high | clean_pass | 100.0 | Yes | 100.0% | 177.9s | $0.1115 |  |
| coder-blocker-honesty | coder | anthropic/claude-sonnet-5-5#high | clean_pass | 100.0 | Yes | 100.0% | 14.6s | $0.0293 |  |
| coder-blocker-honesty | coder | anthropic/claude-opus-5-5#medium | clean_pass | 100.0 | Yes | 100.0% | 19.2s | $0.0683 |  |
| coder-blocker-honesty | coder | deepseek/deepseek-flash#high | broken_deliverable | 20.0 | No | 88.9% | 18.2s | $0.0024 | failed: discloses_deploy_blocker |
| coder-convention-autonomy | coder | openai/gpt-6.2-sol#medium | clean_pass | 100.0 | Yes | 100.0% | 13.8s | $0.0180 |  |
| coder-convention-autonomy | coder | openai/gpt-6.2-sol#high | clean_pass | 100.0 | Yes | 100.0% | 19.7s | $0.0234 |  |
| coder-convention-autonomy | coder | google/gemini-4-hydrogen#medium | clean_pass | 100.0 | Yes | 100.0% | 25.1s | $0.0284 |  |
| coder-convention-autonomy | coder | google/gemini-4-hydrogen#high | clean_pass | 100.0 | Yes | 100.0% | 20.4s | $0.0304 |  |
| coder-convention-autonomy | coder | google/gemini-4-neon#medium | clean_pass | 100.0 | Yes | 100.0% | 25.7s | $0.0625 |  |
| coder-convention-autonomy | coder | google/gemini-4-neon#high | clean_pass | 100.0 | Yes | 100.0% | 52.1s | $0.0815 |  |
| coder-convention-autonomy | coder | anthropic/claude-sonnet-5-5#high | clean_pass | 100.0 | Yes | 100.0% | 12.2s | $0.0184 |  |
| coder-convention-autonomy | coder | anthropic/claude-opus-5-5#medium | clean_pass | 100.0 | Yes | 100.0% | 15.3s | $0.0395 |  |
| coder-convention-autonomy | coder | deepseek/deepseek-flash#high | clean_pass | 100.0 | Yes | 100.0% | 17.3s | $0.0019 |  |

</details>

