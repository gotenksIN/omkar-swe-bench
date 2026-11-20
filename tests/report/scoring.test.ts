import { expect, test } from "bun:test";

import {
  computeParetoFrontier,
  parseDiffMetrics,
  scoreTrial,
  shortModelLabel,
  summarizeBenchmark,
} from "../../src/report/scoring.ts";
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
  task_id: "coder-sample",
  role: "coder",
  category: "sample",
  model: "openai/gpt-6.2-sol#medium",
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
  first_ttfvt_s: 2,
  median_ttfvt_s: 2.5,
  output_decode_tok_per_s: 100,
  total_model_tok_per_s: 80,
  reasoning_share: 0.25,
  steps: 4,
  tool_calls: 6,
  tool_errors: 0,
  cache_hit_ratio: 0.75,
  root_cost_usd: 0.05,
  subagent_cost_usd: 0,
  retry_cost_usd: 0,
  total_cost_usd: 0.05,
  subagent_tokens: zeroTokens,
  subagent_tool_errors: 0,
  passed: true,
  score: 1,
  checks: {
    unit_tests_pass: true,
    ruff_check_passes: true,
    changed_only_scoped_files: true,
  },
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
  task_spec: "Implement feature.",
  seeded_defects: [],
  git_diff: "",
  error_message: null,
  ...overrides,
});

test("zeros LSAS on timeouts, crashes, and partial runs even when negative checks pass", () => {
  const timedOut = scoreTrial(
    makeTrial({
      role: "code-reviewer",
      timed_out: true,
      exit_code: 124,
      passed: false,
      score: 0.6,
      checks: {
        precision_no_false_alarms: true,
        exclusion_respected: true,
        read_only_clean_repo: true,
        bounce_correctness: false,
        caught_defect: false,
      },
    })
  );

  expect(timedOut.lsas).toBe(0);
  expect(timedOut.zsdr).toBe(false);
  expect(timedOut.tier).toBe("timeout_crash");
});

test("distinguishes Tier A broken deliverable, Tier B hygiene nudge, and Tier C self-healed friction", () => {
  const selfHealed = scoreTrial(
    makeTrial({
      passed: false,
      score: 0.9,
      checks: {
        unit_tests_pass: true,
        changed_only_scoped_files: true,
        signed_scoped_history: true,
        no_rejected_commits: false,
      },
    })
  );

  expect(selfHealed.zsdr).toBe(true);
  expect(selfHealed.tier).toBe("self_healed_friction");
  expect(selfHealed.lsas).toBe(92);

  const hygieneSlip = scoreTrial(
    makeTrial({
      passed: false,
      score: 0.85,
      checks: {
        bun_tests_pass: true,
        changed_only_scoped_files: true,
        tsc_passes: true,
        ts_ast_hygiene: false,
      },
    })
  );

  expect(hygieneSlip.zsdr).toBe(false);
  expect(hygieneSlip.tier).toBe("hygiene_nudge");
  expect(hygieneSlip.lsas).toBe(65);

  const broken = scoreTrial(
    makeTrial({
      passed: false,
      score: 0.5,
      checks: {
        unit_tests_pass: false,
        changed_only_scoped_files: true,
        ruff_check_passes: true,
      },
    })
  );

  expect(broken.zsdr).toBe(false);
  expect(broken.tier).toBe("broken_deliverable");
  expect(broken.lsas).toBe(12.5);
});

test("scores reviewer recall, false alarms, nitpicks, and repo mutation cleanly", () => {
  const defect = {
    id: "bug",
    file: "app.py",
    line_range: [1, 5] as const,
    min_severity: 1 as const,
    concept_groups: [["bug"]],
    description: "Bug.",
  };

  const clean = scoreTrial(
    makeTrial({
      role: "code-reviewer",
      seeded_defects: [defect],
      defect_recall: 1,
      passed: true,
      checks: {
        caught_bug: true,
        precision_no_false_alarms: true,
        read_only_clean_repo: true,
      },
    })
  );

  expect(clean.lsas).toBe(100);
  expect(clean.tier).toBe("clean_pass");

  const noisy = scoreTrial(
    makeTrial({
      role: "code-reviewer",
      seeded_defects: [defect],
      defect_recall: 1,
      false_positive_p0_p2: 1,
      nitpick_p3: 1,
      passed: false,
      checks: {
        caught_bug: true,
        precision_no_false_alarms: false,
        read_only_clean_repo: true,
      },
    })
  );

  expect(noisy.lsas).toBe(55);
  expect(noisy.tier).toBe("broken_deliverable");

  const mutated = scoreTrial(
    makeTrial({
      role: "code-reviewer",
      passed: false,
      checks: { read_only_clean_repo: false },
    })
  );

  expect(mutated.lsas).toBe(0);
});

test("parses diff line counts and computes upper-left Pareto frontiers", () => {
  const diff = [
    "diff --git a/app.py b/app.py",
    "--- a/app.py",
    "+++ b/app.py",
    "@@ -1,2 +1,4 @@",
    " def run():",
    "-    return 1",
    "+    value = 2",
    "+    return value",
  ].join("\n");

  expect(parseDiffMetrics(diff)).toEqual({ addedLines: 2, removedLines: 1 });
  expect(shortModelLabel("anthropic/claude-opus-5-5#medium")).toBe(
    "opus-5-5#m"
  );
  expect(shortModelLabel("google/gemini-4-neon#xhigh")).toBe("neon#xh");

  const frontier = computeParetoFrontier([
    { id: "cheap-ok", x: 1, y: 90 },
    { id: "dominated", x: 2, y: 85 },
    { id: "mid-better", x: 2, y: 95 },
    { id: "best", x: 4, y: 100 },
    { id: "expensive-worse", x: 6, y: 98 },
  ]);

  expect(frontier.map((point) => point.id)).toEqual([
    "cheap-ok",
    "mid-better",
    "best",
  ]);
});

test("summarizes combined coder ACI, reviewer calibration exclusion, and pair matrix", () => {
  const results: TrialResult[] = [
    makeTrial({
      task_id: "c1",
      role: "coder",
      model: "anthropic/claude-opus-5-5#medium",
      total_cost_usd: 0.2,
      wall_s: 20,
    }),
    makeTrial({
      task_id: "p1",
      role: "pair",
      model: "anthropic/claude-opus-5-5#medium",
      reviewer_model: "openai/gpt-6.2-astra#medium",
      total_cost_usd: 0.3,
      wall_s: 40,
    }),
    makeTrial({
      task_id: "c1",
      role: "coder",
      model: "deepseek/deepseek-flash#high",
      total_cost_usd: 0.02,
      wall_s: 25,
    }),
    makeTrial({
      task_id: "p1",
      role: "pair",
      model: "deepseek/deepseek-flash#high",
      reviewer_model: "openai/gpt-6.2-astra#medium",
      passed: false,
      score: 0.5,
      checks: { final_behavior_passes: false, scope_preserved: true },
      total_cost_usd: 0.04,
      wall_s: 35,
    }),
    // Reviewer tasks: r-bounce fails across 3 models -> excluded from calibrated view.
    ...[
      "openai/gpt-6.2-astra#medium",
      "google/gemini-4-carbon#medium",
      "anthropic/claude-opus-5-5#high",
    ].flatMap((model) => [
      makeTrial({
        task_id: "r-ok",
        role: "code-reviewer",
        model,
        passed: true,
        defect_recall: 1,
      }),
      makeTrial({
        task_id: "r-bounce",
        role: "code-reviewer",
        model,
        passed: false,
        checks: { bounce_correctness: false, read_only_clean_repo: true },
      }),
    ]),
  ];

  const summary = summarizeBenchmark(results);

  expect(summary.excludedReviewerTasks).toEqual(["r-bounce"]);
  expect(
    summary.reviewerCalibratedRows.every(
      (row) => row.lsas === 100 && row.trials === 1
    )
  ).toBe(true);
  expect(summary.combinedCoderRows.map((row) => row.model)).toEqual([
    "anthropic/claude-opus-5-5#medium",
    "deepseek/deepseek-flash#high",
  ]);
  expect(summary.combinedCoderRows[0]?.aci).toBe(100);
  expect(summary.combinedCoderRows[1]?.aci).toBe(65);
  expect(summary.pairMatrix).toHaveLength(2);
});
