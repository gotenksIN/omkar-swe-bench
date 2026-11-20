import { expect, test } from "bun:test";

import { renderBenchmarkCharts } from "../../src/report/charts.ts";
import { renderHtmlReport } from "../../src/report/html.ts";
import { renderDetailedReport } from "../../src/report/markdown.ts";
import { summarizeBenchmark } from "../../src/report/scoring.ts";
import type { TrialResult } from "../../src/runner/types.ts";

const zeroTokens = {
  input_tokens: 0,
  output_tokens: 0,
  reasoning_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
};

const makeTrial = (overrides: Partial<TrialResult> = {}): TrialResult => ({
  ...zeroTokens,
  task_id: "coder-a",
  role: "coder",
  category: "sample",
  model: "anthropic/claude-opus-5-5#medium",
  reviewer_model: null,
  agent_profile: "neutral",
  repo_dir: "/tmp/opencode/run/repo",
  repetition: 1,
  session_id: "ses_1",
  exit_code: 0,
  timed_out: false,
  partial: false,
  sandboxed: true,
  wall_s: 30,
  retries: 0,
  outer_retries: 0,
  first_ttfrt_s: 1,
  median_ttfrt_s: 1,
  first_ttfvt_s: 1.8,
  median_ttfvt_s: 2.4,
  output_decode_tok_per_s: 120,
  total_model_tok_per_s: 90,
  reasoning_share: 0.25,
  steps: 4,
  tool_calls: 6,
  tool_errors: 0,
  cache_hit_ratio: 0.8,
  root_cost_usd: 0.15,
  subagent_cost_usd: 0,
  retry_cost_usd: 0,
  total_cost_usd: 0.15,
  subagent_tokens: zeroTokens,
  subagent_tool_errors: 0,
  passed: true,
  score: 1,
  checks: { unit_tests_pass: true, changed_only_scoped_files: true },
  notes: [],
  pedantry_flags: 0,
  false_positive_p0_p2: 0,
  nitpick_p3: 0,
  defect_recall: null,
  precision: null,
  scope_bounced: false,
  blocker_disclosed: null,
  final_text: "Done.",
  transcript_text: "Done.",
  reviewer_text: "",
  planted_brief: "",
  review_spec: "",
  review_diff: null,
  task_spec: "Implement.",
  seeded_defects: [],
  git_diff: "",
  error_message: null,
  ...overrides,
});

test("renders self-contained HTML dashboard and detailed LSAS Markdown report", () => {
  const trials: TrialResult[] = [
    makeTrial({
      model: "anthropic/claude-opus-5-5#medium",
      total_cost_usd: 0.2,
    }),
    makeTrial({
      task_id: "pair-a",
      role: "pair",
      model: "anthropic/claude-opus-5-5#medium",
      reviewer_model: "openai/gpt-6.2-astra#medium",
      total_cost_usd: 0.3,
    }),
    makeTrial({
      task_id: "rev-a",
      role: "code-reviewer",
      model: "openai/gpt-6.2-astra#medium",
      defect_recall: 1,
      total_cost_usd: 0.08,
    }),
  ];

  const summary = summarizeBenchmark(trials);
  const charts = renderBenchmarkCharts(summary);
  const html = renderHtmlReport(summary, charts);
  const md = renderDetailedReport(trials, charts, "charts");

  expect(html.startsWith("<!doctype html>")).toBe(true);
  expect(html).toContain("Claude Opus 5.5 (medium)");
  expect(html).toContain("GPT-6.2 Astra (medium)");
  expect(html).toContain("100.0");
  expect(html).toContain("$0.58");
  expect(html).not.toMatch(/\b(?:src|href)=["']https?:\/\//iu);

  expect(md).toContain("## Combined Autonomous Coder Index (Phases 1 + 3)");
  expect(md).toContain("Claude Opus 5.5 (medium)");
  expect(md).toContain("GPT-6.2 Astra (medium)");
  expect(md).toContain(
    "![Coder Autonomy vs. Cost Pareto Frontier](charts/coder-cost-pareto.svg)"
  );
  expect(md).toContain(
    "![Phase 3 Coder × Reviewer Synergy Matrix](charts/pair-synergy-matrix.svg)"
  );
  expect(md).toContain("report.html");
});
