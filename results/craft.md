# Host-Side Code Craft Summary

Evaluated **163** passing coder/pair diffs with host-side Ruff, Oxfmt, and Oxlint anti-slop checks (never mounted into trial sandboxes).

Back to [`summary.md`](summary.md) or [`report.html`](report.html).

| Model | Trials | Norm +LOC | Hygiene | Structural | Diff Ratio |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Gemini 4 Neon (high) | 15 | 522 | 82 | 0 | 1.00× |
| Claude Opus 5.5 (high) | 14 | 417 | 48 | 1 | 1.12× |
| GPT-6.2 Sol (high) | 14 | 613 | 93 | 1 | 0.90× |
| Claude Opus 5.5 (medium) | 16 | 967 | 323 | 2 | 1.00× |
| Claude Sonnet 5.5 (high) | 11 | 622 | 165 | 2 | 0.96× |
| GPT-6.2 Sol (medium) | 14 | 478 | 77 | 3 | 0.79× |
| DeepSeek Flash (max) | 13 | 976 | 85 | 5 | 1.00× |
| Gemini 4 Neon (medium) | 17 | 1214 | 149 | 6 | 1.00× |
| DeepSeek Flash (high) | 15 | 1123 | 147 | 8 | 1.00× |
| Gemini 4 Hydrogen (medium) | 17 | 1217 | 103 | 8 | 1.00× |
| Gemini 4 Hydrogen (high) | 17 | 1891 | 245 | 17 | 1.06× |

<details>
<summary>Detailed craft metrics (11 columns)</summary>

| Model | Trials | Norm +LOC | Py Churn | TS Spacing | TS Curly | Curly / 100 LOC | Complexity | Nesting | Perf / Slop | Med Log Ratio |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `google/gemini-4-neon#high` | 15 | 522 | 52 | 23 | 7 | 3.6 | 0 | 0 | 0 | 0.00 |
| `anthropic/claude-opus-5-5#high` | 14 | 417 | 20 | 15 | 13 | 13.3 | 0 | 1 | 0 | 0.12 |
| `openai/gpt-6.2-sol#high` | 14 | 613 | 0 | 66 | 27 | 7.8 | 1 | 0 | 0 | -0.11 |
| `anthropic/claude-opus-5-5#medium` | 16 | 967 | 216 | 78 | 29 | 5.2 | 2 | 0 | 0 | 0.00 |
| `anthropic/claude-sonnet-5-5#high` | 11 | 622 | 76 | 66 | 23 | 5.9 | 2 | 0 | 0 | -0.04 |
| `openai/gpt-6.2-sol#medium` | 14 | 478 | 5 | 43 | 29 | 10.9 | 2 | 1 | 0 | -0.23 |
| `deepseek/deepseek-flash#max` | 13 | 976 | 11 | 70 | 4 | 0.6 | 2 | 3 | 0 | 0.00 |
| `google/gemini-4-neon#medium` | 17 | 1214 | 4 | 136 | 9 | 1.1 | 4 | 2 | 0 | 0.00 |
| `deepseek/deepseek-flash#high` | 15 | 1123 | 6 | 134 | 7 | 0.9 | 3 | 4 | 1 | 0.00 |
| `google/gemini-4-hydrogen#medium` | 17 | 1217 | 8 | 91 | 4 | 0.4 | 3 | 5 | 0 | 0.00 |
| `google/gemini-4-hydrogen#high` | 17 | 1891 | 20 | 219 | 6 | 0.4 | 5 | 12 | 0 | 0.05 |

</details>
