# Host-Side Code Craft Summary

Evaluated **192** passing coder/pair diffs with host-side Ruff, Oxfmt, and Oxlint anti-slop checks (never mounted into trial sandboxes).

Back to [`summary.md`](summary.md) or [`report.html`](report.html).

| Model | Trials | Norm +LOC | Hygiene | Structural | Diff Ratio |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Claude Opus 5.5 (medium) | 19 | 458 | 205 | 0 | 1.01× |
| Gemini 4 Hydrogen (medium) | 22 | 527 | 50 | 0 | 1.00× |
| Gemini 4 Neon (medium) | 24 | 781 | 75 | 1 | 1.00× |
| GPT-6.2 Sol (medium) | 22 | 730 | 211 | 2 | 0.73× |
| Claude Sonnet 5.5 (high) | 14 | 595 | 136 | 3 | 1.00× |
| DeepSeek Flash (high) | 20 | 1319 | 214 | 3 | 1.00× |
| GPT-6.2 Sol (high) | 23 | 705 | 133 | 3 | 0.75× |
| Gemini 4 Neon (high) | 24 | 954 | 76 | 4 | 1.13× |
| Gemini 4 Hydrogen (high) | 24 | 1756 | 218 | 9 | 1.04× |

<details>
<summary>Detailed craft metrics (11 columns)</summary>

| Model | Trials | Norm +LOC | Py Churn | TS Spacing | TS Curly | Curly / 100 LOC | Complexity | Nesting | Perf / Slop | Med Log Ratio |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `anthropic/claude-opus-5-5#medium` | 19 | 458 | 186 | 19 | 0 | 0.0 | 0 | 0 | 0 | 0.01 |
| `google/gemini-4-hydrogen#medium` | 22 | 527 | 9 | 35 | 6 | 4.1 | 0 | 0 | 0 | 0.00 |
| `google/gemini-4-neon#medium` | 24 | 781 | 12 | 57 | 6 | 1.6 | 1 | 0 | 0 | 0.00 |
| `openai/gpt-6.2-sol#medium` | 22 | 730 | 108 | 78 | 25 | 6.4 | 2 | 0 | 0 | -0.31 |
| `anthropic/claude-sonnet-5-5#high` | 14 | 595 | 54 | 55 | 27 | 10.1 | 2 | 1 | 0 | 0.00 |
| `deepseek/deepseek-flash#high` | 20 | 1319 | 40 | 143 | 31 | 3.4 | 3 | 0 | 0 | 0.00 |
| `openai/gpt-6.2-sol#high` | 23 | 705 | 51 | 56 | 26 | 7.2 | 2 | 1 | 0 | -0.29 |
| `google/gemini-4-neon#high` | 24 | 954 | 8 | 61 | 7 | 1.4 | 1 | 3 | 0 | 0.12 |
| `google/gemini-4-hydrogen#high` | 24 | 1756 | 9 | 201 | 8 | 0.7 | 4 | 5 | 0 | 0.04 |

</details>
