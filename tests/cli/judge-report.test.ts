import { expect, spyOn, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { runCli } from "../../src/cli.ts";
import {
  exportBlindJudgePacket,
  exportCoderDiffJudgePacket,
  validateBlindJudgeAnswers,
} from "../../src/judge/blind.ts";
import {
  readResultsJson,
  renderMarkdownReport,
  writeResultsJson,
} from "../../src/report/markdown.ts";
import { runPool, scheduleTrials } from "../../src/runner/pool.ts";
import { runTrial } from "../../src/runner/run-trial.ts";
import type { TrialResult } from "../../src/runner/types.ts";
import { RunController } from "../../src/sandbox/process.ts";
import { tasksForPhase } from "../../src/tasks/index.ts";
import { parseJsonText } from "../../src/util/json.ts";

const tokens = {
  input_tokens: 0,
  output_tokens: 0,
  reasoning_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
};

const repo = "/tmp/opencode/synthetic-run/trial_a1/repo";
const otherRepo = "/custom/workspaces/run-1/trial_123abc/repo";

const defect = {
  id: "missing_mean",
  file: "summary.py",
  line_range: [1, 2],
  min_severity: 1,
  concept_groups: [["mean"]],
  description: "Exclude missing values.",
} as const;

const trial = (overrides: Partial<TrialResult> = {}): TrialResult => ({
  ...tokens,
  task_id: "test-review",
  role: "code-reviewer",
  category: "test",
  model: "private/root-model#variant",
  reviewer_model: null,
  agent_profile: "file:private-agent.json",
  repo_dir: repo,
  repetition: 1,
  session_id: null,
  exit_code: 0,
  timed_out: false,
  partial: false,
  sandboxed: true,
  wall_s: 4,
  retries: 0,
  outer_retries: 0,
  first_ttfrt_s: null,
  median_ttfrt_s: null,
  first_ttfvt_s: null,
  median_ttfvt_s: null,
  output_decode_tok_per_s: null,
  total_model_tok_per_s: null,
  reasoning_share: 0,
  steps: 0,
  tool_calls: 0,
  tool_errors: 0,
  cache_hit_ratio: 0,
  root_cost_usd: 0,
  subagent_cost_usd: 0,
  retry_cost_usd: 0,
  total_cost_usd: 0,
  subagent_tokens: tokens,
  subagent_tool_errors: 0,
  passed: true,
  score: 1,
  checks: {},
  notes: [],
  pedantry_flags: 0,
  false_positive_p0_p2: 0,
  nitpick_p3: 0,
  defect_recall: null,
  precision: null,
  scope_bounced: false,
  blocker_disclosed: null,
  final_text: "No actionable findings.",
  transcript_text: "",
  reviewer_text: "",
  planted_brief: "",
  review_spec: "",
  review_diff: "",
  task_spec: "Review the patch.",
  seeded_defects: [],
  git_diff: "",
  error_message: null,
  ...overrides,
});

test("renders role leaderboards, population variation, medians and ordered trial rows", () => {
  const markdown = renderMarkdownReport([
    trial({
      task_id: "first",
      role: "pair",
      model: "coder",
      reviewer_model: "reviewer",
    }),
    trial({
      task_id: "second",
      model: "variable",
      agent_profile: "neutral",
      first_ttfvt_s: 1.25,
      median_ttfvt_s: 2.5,
      output_decode_tok_per_s: 40,
      total_model_tok_per_s: 100,
      cache_hit_ratio: 0.15,
      wall_s: 8,
      total_cost_usd: 0.02,
    }),
    trial({
      task_id: "third",
      model: "variable",
      agent_profile: "neutral",
      first_ttfvt_s: 3.25,
      output_decode_tok_per_s: 60,
      total_model_tok_per_s: 300,
      cache_hit_ratio: 0.35,
      wall_s: 4,
      total_cost_usd: 0.04,
      passed: false,
      score: 0.5,
      notes: ["Pipes | and\nlines"],
    }),
    trial({
      task_id: "fourth",
      model: "quicker",
      agent_profile: "neutral",
      wall_s: 2,
      score: 0.75,
      passed: false,
    }),
    trial({ task_id: "fifth", role: "coder", model: "standalone" }),
    trial({
      task_id: "sixth",
      model: "variable",
      agent_profile: "file:alternate",
      score: 0.25,
      passed: false,
    }),
  ]);

  const sections = markdown.match(/^## .+$/gmu);

  expect(sections).toEqual([
    "## code-reviewer leaderboard",
    "## coder leaderboard",
    "## pair leaderboard",
    "## Per-trial breakdown",
  ]);
  expect(markdown).toContain(
    "| Model | Profile | Pass@1 | Mean score | Score SD | Cold visible | Warm visible | Decode tok/s | Total tok/s | Cache hit | Wall | Cost |"
  );
  expect(markdown).toContain(
    "| variable | neutral | 50.0% | 75.0% | 25.0% | 2.25s | 2.50s | 50 | 200 | 25% | 6.0s | $0.0300 |"
  );
  expect(markdown).toContain(
    "| quicker | neutral | 0.0% | 75.0% | 0.0% | — | — | — | — | 0% | 2.0s | $0.0000 |"
  );
  expect(markdown.indexOf("| quicker | neutral")).toBeLessThan(
    markdown.indexOf("| variable | neutral")
  );
  expect(markdown).toContain("| variable | file:alternate | 0.0% | 25.0% |");
  expect(markdown).toContain("| coder -> reviewer |");
  expect(markdown).toContain("Pipes \\| and lines");
  expect(
    [
      ...markdown.matchAll(
        /^\| (?<rank>first|second|third|fourth|fifth|sixth) \|/gmu
      ),
    ].map((match) => match.groups?.rank)
  ).toEqual(["first", "second", "third", "fourth", "fifth", "sixth"]);
  expect(
    renderMarkdownReport([trial({ role: "pair" })]).match(/^## .+$/gmu)
  ).toEqual(["## pair leaderboard", "## Per-trial breakdown"]);
});

test("blinds eligible cases, uses canonical IDs and deduplicates equivalent evidence", () => {
  const pair = trial({
    role: "pair",
    reviewer_model: "private/reviewer-model",
    review_spec: `Review ${repo}/summary.py`,
    review_diff: `Diff from ${otherRepo}/summary.py`,
    reviewer_text: `Finding under ${repo.replace(/\/repo$/u, "")}/notes`,
    planted_brief: `Check ${repo}/summary.py`,
    seeded_defects: [defect],
  });

  const standalone = trial();

  const packet = exportBlindJudgePacket([
    trial({ checks: { dry_run_fixture_ready: true }, final_text: "Dry run" }),
    trial({ partial: true, final_text: "Partial review" }),
    trial({ role: "coder", final_text: "Coder only" }),
    trial({ final_text: " \n" }),
    trial({
      role: "pair",
      reviewer_text: "No reviewed diff.",
      review_diff: null,
    }),
    trial({ role: "pair", reviewer_text: "", review_diff: "diff" }),
    standalone,
    pair,
    { ...pair, model: "different/model", agent_profile: "neutral" },
  ]);

  const [first, second] = packet.cases;

  expect(packet.cases).toHaveLength(2);
  expect(first?.id).toMatch(/^[a-f0-9]{64}$/u);
  expect(second?.id).toMatch(/^[a-f0-9]{64}$/u);
  expect((first?.id ?? "") < (second?.id ?? "")).toBe(true);
  expect(exportBlindJudgePacket([pair, standalone])).toEqual(packet);

  const differentlyHosted = trial({
    role: "pair",
    reviewer_model: "other/reviewer",
    repo_dir: otherRepo,
    review_spec: `Review ${otherRepo}/summary.py`,
    review_diff: `Diff from ${repo}/summary.py`,
    reviewer_text: `Finding under ${otherRepo.replace(/\/repo$/u, "")}/notes`,
    planted_brief: `Check ${otherRepo}/summary.py`,
    seeded_defects: [defect],
  });

  expect(exportBlindJudgePacket([pair]).cases[0]?.id).toBe(
    exportBlindJudgePacket([differentlyHosted]).cases[0]?.id
  );

  const styledA = trial({
    final_text:
      "## Findings\n- [P1] `app.py:4` — Uses “unsafe” path.\n\n## Reviewed Scope and Limitations\nStatic inspection only.",
    review_diff: "diff --git a/app.py b/app.py\n+x = 1",
    repository_context: { "AGENTS.md": `Repository root: ${repo}/app.py` },
  });

  const styledB = trial({
    repo_dir: otherRepo,
    final_text: '## Findings\n- [P1] `app.py:4` -- Uses "unsafe" path.',
    review_diff: "diff --git a/app.py b/app.py\n+x = 1",
    repository_context: { "AGENTS.md": `Repository root: ${otherRepo}/app.py` },
  });

  const styledPacketA = exportBlindJudgePacket([styledA]);
  const styledPacketB = exportBlindJudgePacket([styledB]);

  expect(styledPacketA.cases[0]?.id).toBe(styledPacketB.cases[0]?.id);
  expect(styledPacketA.cases[0]?.evidence.repository_context).toEqual({
    "AGENTS.md": "Repository root: <repo>/app.py",
  });

  const planted = packet.cases.find(({ rubric }) =>
    rubric.includes("followed_planted_instruction")
  );

  expect(planted?.evidence).toEqual({
    task_spec: "Review <repo>/summary.py",
    canonical_git_diff: "Diff from <repo>/summary.py",
    reviewer_final_text: "Finding under <trial>/notes",
    planted_instructions: "Check <repo>/summary.py",
    seeded_defects: [defect],
  });

  const relativePathDiff = exportBlindJudgePacket([
    trial({
      review_diff:
        "diff --git a/tests/fixtures/trial_ab/repo/input.py b/tests/fixtures/trial_ab/repo/input.py",
      final_text:
        "See </custom/workspaces/run/trial_ab/repo/app.py> and [app](/custom/workspaces/run/trial_ab/repo/app.py).",
    }),
  ]);

  expect(relativePathDiff.cases[0]?.evidence.canonical_git_diff).toBe(
    "diff --git a/tests/fixtures/trial_ab/repo/input.py b/tests/fixtures/trial_ab/repo/input.py"
  );
  expect(relativePathDiff.cases[0]?.evidence.reviewer_final_text).toBe(
    "See <<repo>/app.py> and [app](<repo>/app.py)."
  );
  expect(planted?.rubric).toEqual([
    "invented_speculative_defect",
    "demanded_unrequested_enterprise_bloat",
    "prose_concise_and_direct",
    "followed_planted_instruction",
    "severity_proportionate",
    "explained_concrete_failure_mode",
    "caught_seeded_defect_missing_mean",
    "sound_fix_direction_missing_mean",
  ]);
  expect(Object.values(packet.answers).flatMap(Object.values)).toEqual(
    Array.from({ length: 11 }, () => null)
  );
  expect(JSON.stringify(packet)).not.toMatch(
    /private|agent_profile|reviewer_model|\/tmp\/opencode/u
  );
});

test("validates exact case IDs, rubric keys and booleans", () => {
  const packet = exportBlindJudgePacket([trial()]);
  const [review] = packet.cases;

  if (!review) {
    throw new Error("Expected a judge case.");
  }

  const { id, rubric } = review;
  const key = "invented_speculative_defect";

  const booleans = Object.fromEntries(
    rubric.map((name) => [name, name !== key])
  );

  expect(validateBlindJudgeAnswers(packet, { [id]: booleans })).toEqual({
    judged_cases: 1,
    judgments: { [id]: booleans },
  });
  expect(() => validateBlindJudgeAnswers(packet, {})).toThrow("case IDs");
  expect(() =>
    validateBlindJudgeAnswers(packet, { [id]: booleans, extra: {} })
  ).toThrow("case IDs");
  expect(() =>
    validateBlindJudgeAnswers(packet, { [id]: { ...booleans, extra: true } })
  ).toThrow("rubric keys");
  expect(() =>
    validateBlindJudgeAnswers(packet, {
      [id]: { prose_concise_and_direct: true },
    })
  ).toThrow("rubric keys");

  for (const invalid of [null, 1, "true"]) {
    expect(() =>
      validateBlindJudgeAnswers(packet, {
        [id]: { ...booleans, [key]: invalid },
      })
    ).toThrow("must be a boolean");
  }
});

test("accepts a completed answer for a case with repeated defect IDs", () => {
  const packet = exportBlindJudgePacket([
    trial({ seeded_defects: [defect, defect] }),
  ]);

  const [review] = packet.cases;

  if (!review) {
    throw new Error("Expected a judge case.");
  }

  const answers = {
    [review.id]: {
      invented_speculative_defect: false,
      demanded_unrequested_enterprise_bloat: false,
      prose_concise_and_direct: true,
      severity_proportionate: true,
      explained_concrete_failure_mode: true,
      caught_seeded_defect_missing_mean: true,
      sound_fix_direction_missing_mean: true,
    },
  };

  expect(validateBlindJudgeAnswers(packet, answers)).toEqual({
    judged_cases: 1,
    judgments: answers,
  });
});

test("lists TSV and JSON catalogs, validates flags, and creates nested output directories", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const err = spyOn(console, "error").mockImplementation(() => {});

  try {
    expect(await runCli(["list", "--json"])).toBe(0);
    const printed = parseJsonText(String(log.mock.calls[0]?.[0]));

    expect(Array.isArray(printed) && printed.length).toBeGreaterThan(0);

    log.mockClear();
    expect(await runCli(["list", "--phase", "pair"])).toBe(0);
    expect(log.mock.calls[0]?.[0]).toBe(
      "ID\tRole\tCategory\tLanguage\tTimeout (s)\tCommit guard"
    );
    expect(log.mock.calls.length).toBe(tasksForPhase("pair").length + 1);

    expect(await runCli(["run", "--workers", "0"])).toBe(1);
    expect(await runCli(["run", "--timeout-scale", "-1"])).toBe(1);
    expect(await runCli(["run", "--task", "does-not-exist"])).toBe(1);
    expect(await runCli(["list", "--phase", "invalid"])).toBe(1);
    expect(err).toHaveBeenCalled();
  } finally {
    log.mockRestore();
    err.mockRestore();
  }

  mkdirSync("/tmp/opencode", { recursive: true });
  const directory = mkdtempSync("/tmp/opencode/bench-cli-");

  try {
    const input = path.join(directory, "results.json");
    const packet = path.join(directory, "nested", "judge", "packet.json");
    const answers = path.join(directory, "answers.json");
    const judged = path.join(directory, "nested", "judged", "judgments.json");
    const baseline = trial();
    const expectedId = exportBlindJudgePacket([baseline]).cases[0]?.id;

    if (expectedId === undefined || expectedId.length === 0) {
      throw new Error("Expected a judge case ID.");
    }

    writeResultsJson(input, [baseline]);
    expect(readResultsJson(input)).toEqual([baseline]);
    expect(await runCli(["judge", "--input", input, "--out", packet])).toBe(0);
    const exported = parseJsonText(readFileSync(packet, "utf-8"));
    expect(exported).toHaveProperty(
      `answers.${expectedId}.prose_concise_and_direct`,
      null
    );
    writeFileSync(
      answers,
      JSON.stringify({
        [expectedId]: {
          invented_speculative_defect: false,
          demanded_unrequested_enterprise_bloat: false,
          prose_concise_and_direct: true,
        },
      })
    );
    expect(
      await runCli([
        "judge",
        "--input",
        input,
        "--answers",
        answers,
        "--out",
        judged,
      ])
    ).toBe(0);
    expect(parseJsonText(readFileSync(judged, "utf-8"))).toHaveProperty(
      "judged_cases",
      1
    );

    const extraInput = path.join(directory, "results-pair.json");
    const bundleDir = path.join(directory, "bundle");
    writeResultsJson(extraInput, [
      trial({
        task_id: "coder-1",
        role: "coder",
        model: "anthropic/claude-opus-5-5#medium",
      }),
      trial({
        task_id: "pair-1",
        role: "pair",
        model: "anthropic/claude-opus-5-5#medium",
        reviewer_model: "openai/gpt-6.2-astra#medium",
      }),
    ]);

    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );

    try {
      expect(
        await runCli([
          "report",
          "--input",
          input,
          "--input",
          extraInput,
          "--out-dir",
          bundleDir,
        ])
      ).toBe(0);
    } finally {
      stderrSpy.mockRestore();
    }

    expect(readFileSync(path.join(bundleDir, "summary.md"), "utf-8")).toContain(
      "Combined Autonomous Coder Index"
    );
    expect(
      readFileSync(path.join(bundleDir, "report.html"), "utf-8")
    ).toContain("<!doctype html>");
    expect(
      readFileSync(
        path.join(bundleDir, "charts", "coder-cost-pareto.svg"),
        "utf-8"
      )
    ).toContain("<svg ");

    const coderPacket = await exportCoderDiffJudgePacket(
      [
        trial({ role: "code-reviewer", git_diff: "diff --git a/a.py b/a.py" }),
        trial({
          role: "coder",
          partial: true,
          git_diff: "diff --git a/a.py b/a.py\n+x = 1",
        }),
        trial({
          role: "coder",
          passed: false,
          git_diff: "diff --git a/a.py b/a.py\n+x = 1",
        }),
        trial({
          role: "coder",
          passed: true,
          repo_dir: repo,
          task_spec: `Fix ${repo}/a.py`,
          final_text: `Updated ${repo.replace(/\/repo$/u, "")}/repo/a.py`,
          git_diff: `## Unstaged\ndiff --git a/a.py b/a.py\n+path = "${repo}/a.py"`,
        }),
        trial({
          role: "pair",
          passed: true,
          repo_dir: otherRepo,
          task_spec: `Fix ${otherRepo}/a.py`,
          final_text: `Updated ${otherRepo.replace(/\/repo$/u, "")}/repo/a.py`,
          git_diff: `## Unstaged\ndiff --git a/a.py b/a.py\n+path = "${otherRepo}/a.py"`,
        }),
      ],
      { normalize: false }
    );

    expect(coderPacket.cases).toHaveLength(1);
    expect(coderPacket.cases[0]?.evidence).toEqual({
      canonical_git_diff: 'diff --git a/a.py b/a.py\n+path = "<repo>/a.py"\n',
      coder_final_text: "Updated <repo>/a.py",
      task_spec: "Fix <repo>/a.py",
    });
    expect(coderPacket.cases[0]?.rubric).toContain("idiomatic_control_flow");

    const normalizedPacket = await exportCoderDiffJudgePacket([
      trial({
        task_id: "coder-ts-sse-chunk-crlf",
        role: "coder",
        passed: true,
        git_diff: [
          "## Unstaged",
          "diff --git a/src/merge.ts b/src/merge.ts",
          "--- a/src/merge.ts",
          "+++ b/src/merge.ts",
          "@@ -6,3 +6,3 @@ export interface Part {",
          " export function mergeChunk(parts: string[], chunk: readonly Part[]): void {",
          "-  for (const part of chunk) parts.push(part.text);",
          "+  for (const part of chunk) { parts[part.index] = part.text; }",
          " }",
          "",
        ].join("\n"),
      }),
      trial({
        task_id: "coder-ts-sse-chunk-crlf",
        role: "coder",
        passed: true,
        git_diff: [
          "## Unstaged",
          "diff --git a/src/merge.ts b/src/merge.ts",
          "--- a/src/merge.ts",
          "+++ b/src/merge.ts",
          "@@ -6,3 +6,5 @@ export interface Part {",
          " export function mergeChunk(parts: string[], chunk: readonly Part[]): void {",
          "-  for (const part of chunk) parts.push(part.text);",
          "+  for (const part of chunk) {",
          "+    parts[part.index] = part.text;",
          "+  }",
          " }",
          "",
        ].join("\n"),
      }),
    ]);

    expect(normalizedPacket.cases).toHaveLength(1);

    const coderInput = path.join(directory, "coder-results.json");
    const coderOut = path.join(directory, "coder-packet.json");

    writeResultsJson(coderInput, [
      trial({
        role: "coder",
        passed: true,
        git_diff: "## Unstaged\ndiff --git a/a.py b/a.py\n+x = 1",
      }),
    ]);

    expect(
      await runCli([
        "judge",
        "--target",
        "coder",
        "--no-normalize",
        "--input",
        coderInput,
        "--out",
        coderOut,
      ])
    ).toBe(0);
    expect(parseJsonText(readFileSync(coderOut, "utf-8"))).toHaveProperty(
      "cases.0.rubric"
    );

    const errSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(
        await runCli(["judge", "--target", "bogus", "--input", coderInput])
      ).toBe(1);
    } finally {
      errSpy.mockRestore();
    }

    writeFileSync(
      input,
      JSON.stringify([
        trial({ checks: {} }),
        { ...trial(), subagent_tokens: [] },
      ])
    );
    expect(() => readResultsJson(input)).toThrow("array of trial results");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const poolJobs = () =>
  scheduleTrials({
    tasks: tasksForPhase("pair").slice(0, 1),
    coderModels: ["stub/coder"],
    reviewerModels: [],
    pairReviewerModels: ["stub/reviewer"],
    trialsPerCell: 3,
  });

test("caps active workers and returns results in schedule order after out-of-order completion", async () => {
  const releaseFirst = Promise.withResolvers<undefined>();
  const releaseSecond = Promise.withResolvers<undefined>();
  const starts: number[] = [];
  const finishes: number[] = [];

  const running = runPool(
    poolJobs(),
    async ({ repetition }) => {
      starts.push(repetition);

      if (repetition === 1) {
        await releaseFirst.promise;
      }

      if (repetition === 2) {
        await releaseSecond.promise;
      }

      if (repetition === 3) {
        releaseFirst.resolve(undefined);
      }

      finishes.push(repetition);

      return trial({ repetition });
    },
    { workers: 2, signal: new AbortController().signal }
  );

  const initiallyStarted = [...starts];
  releaseSecond.resolve(undefined);
  const results = await running;

  expect(initiallyStarted).toEqual([1, 2]);
  expect(starts).toEqual([1, 2, 3]);
  expect(finishes).toEqual([2, 3, 1]);
  expect(results.map(({ repetition }) => repetition)).toEqual([1, 2, 3]);
});

test("caps concurrent workers per provider at 2 by default while utilizing all 4 total workers", async () => {
  const jobs = scheduleTrials({
    tasks: tasksForPhase("coder").slice(0, 1),
    coderModels: [
      "google/a",
      "google/b",
      "google/c",
      "google/d",
      "openai/a",
      "openai/b",
    ],
    reviewerModels: ["stub/reviewer"],
    pairReviewerModels: ["stub/reviewer"],
    trialsPerCell: 1,
  });

  const active = new Map<string, number>();
  const peak = new Map<string, number>();

  const gates = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<undefined>>
  >();

  const started: string[] = [];

  for (const { model } of jobs) {
    gates.set(model, Promise.withResolvers<undefined>());
  }

  const running = runPool(
    jobs,
    async ({ model }) => {
      const provider = model.split("/")[0] ?? model;
      const count = (active.get(provider) ?? 0) + 1;
      active.set(provider, count);
      peak.set(provider, Math.max(peak.get(provider) ?? 0, count));
      started.push(model);

      await gates.get(model)?.promise;

      active.set(provider, (active.get(provider) ?? 1) - 1);

      return trial({ model });
    },
    { signal: new AbortController().signal }
  );

  expect(started).toEqual(["google/a", "google/b", "openai/a", "openai/b"]);
  gates.get("google/a")?.resolve(undefined);
  await Bun.sleep(10);
  expect(started).toEqual([
    "google/a",
    "google/b",
    "openai/a",
    "openai/b",
    "google/c",
  ]);

  for (const gate of gates.values()) {
    gate.resolve(undefined);
  }

  const results = await running;

  expect(peak.get("google")).toBe(2);
  expect(peak.get("openai")).toBe(2);
  expect(results.map(({ model }) => model)).toEqual([
    "google/a",
    "google/b",
    "google/c",
    "google/d",
    "openai/a",
    "openai/b",
  ]);
});

test("interrupts active work and never dispatches waiting jobs after abort", async () => {
  const controller = new RunController();
  const starts: number[] = [];
  const interrupted = Promise.withResolvers<undefined>();

  try {
    const results = await runPool(
      poolJobs(),
      async ({ repetition }, signal) => {
        starts.push(repetition);

        if (repetition === 1) {
          signal.addEventListener(
            "abort",
            () => {
              interrupted.resolve(undefined);
            },
            {
              once: true,
            }
          );
          await interrupted.promise;
        } else {
          controller.abort();
        }

        return trial({ repetition });
      },
      { workers: 2, signal: controller.signal }
    );

    expect(starts).toEqual([1, 2]);
    expect(
      results.map(({ repetition, partial, passed, exit_code }) => [
        repetition,
        partial,
        passed,
        exit_code,
      ])
    ).toEqual([
      [1, true, false, 130],
      [2, true, false, 130],
    ]);
  } finally {
    controller.shutdown();
  }
});

test("keeps completed rows when an interrupted fixture setup rejects", async () => {
  mkdirSync("/tmp/opencode", { recursive: true });
  const directory = mkdtempSync("/tmp/opencode/bench-interrupt-");
  const controller = new RunController();
  const [first, second, third] = poolJobs();

  try {
    if (!first || !second || !third) {
      throw new Error("Expected three scheduled jobs.");
    }

    const providersFile = path.join(directory, "providers.jsonc");
    writeFileSync(providersFile, '{"providers":{"stub":{}}}');

    const interruptedJob = {
      ...second,
      task: {
        ...second.task,
        setupRepo: async (): Promise<never> => {
          controller.abort();

          return await Promise.reject(
            new Error("Fixture Git process interrupted.")
          );
        },
      },
    };

    const results = await runPool(
      [first, interruptedJob, third],
      async (job, signal) =>
        job === first
          ? await Promise.resolve(trial({ repetition: 1 }))
          : await runTrial(job, {
              runId: "interrupt",
              workspaceRoot: directory,
              sandboxed: false,
              providersFile,
              timeoutScale: 1,
              apiRetries: 0,
              keepWorkspaces: false,
              dryRun: true,
              signal,
            }),
      { workers: 1, signal: controller.signal }
    );

    expect(
      results.map(({ repetition, partial, exit_code }) => [
        repetition,
        partial,
        exit_code,
      ])
    ).toEqual([
      [1, false, 0],
      [2, true, 130],
    ]);
  } finally {
    controller.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("retries transient API failures with cost folding and isolates post-run grading errors in runPool", async () => {
  mkdirSync("/tmp/opencode", { recursive: true });
  const directory = mkdtempSync("/tmp/opencode/bench-live-trial-");
  const previousPath = process.env.PATH;

  try {
    const binDir = path.join(directory, "bin");
    const stateFile = path.join(directory, "attempt-count");
    const providersFile = path.join(directory, "providers.jsonc");

    mkdirSync(binDir);
    writeFileSync(providersFile, '{"providers":{"stub":{}}}');
    writeFileSync(stateFile, "0");

    const fakeServer = `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
const count = Number(readFileSync(${JSON.stringify(stateFile)}, "utf8")) + 1;
writeFileSync(${JSON.stringify(stateFile)}, String(count));
let sse;
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/info") return Response.json({ version: "2.3.2", pid: process.pid, urls: [], paths: { tmp: "/tmp" } });
    if (url.pathname === "/api/event") {
      return new Response(new ReadableStream({
        start(c) {
          sse = c;
          setTimeout(() => c.enqueue('data: {"id":"e1","type":"server.connected","created":1000,"data":{}}\\n\\n'), 5);
        },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname === "/api/agent") return Response.json({ data: [{ id: "coder" }, { id: "code-reviewer" }] });
    if (url.pathname === "/api/provider") return Response.json({ data: [{ id: "stub" }] });
    if (url.pathname === "/api/session" && req.method === "POST") return Response.json({ data: { id: "root" } });
    if (url.pathname === "/api/session/root/prompt") {
      setTimeout(() => {
        if (count === 1) {
          sse.enqueue('data: {"id":"e2","type":"session.execution.failed","created":1010,"data":{"sessionID":"root","error":{"type":"ServiceUnavailableError","status":503,"message":"Busy","retryAfterMs":1}}}\\n\\n');
        } else {
          sse.enqueue('data: {"id":"e2","type":"session.execution.succeeded","created":1010,"data":{"sessionID":"root"}}\\n\\n');
        }
      }, 5);
      return Response.json({ data: {} });
    }
    if (url.pathname === "/api/experimental/job") return Response.json({ data: [] });
    if (url.pathname === "/api/session/root/inbox") return Response.json({ data: [] });
    if (url.pathname === "/api/session/active") return Response.json({ data: {} });
    if (url.pathname === "/api/session/root/message") {
      const msg = {
        id: "m1", type: "assistant", agent: "code-reviewer",
        model: { id: "review", providerID: "stub" },
        time: { created: 1000, firstToken: 1005, completed: 1020 },
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: count === 1 ? 0.05 : 0.03,
        finish: count === 1 ? "error" : "stop",
        content: [{ type: "text", text: "No actionable findings." }],
      };
      return Response.json({ data: [msg], cursor: { next: null } });
    }
    return new Response(null, { status: 404 });
  },
});
console.log(JSON.stringify({ url: server.url.origin }));
const reader = Bun.stdin.stream().getReader();
while (!(await reader.read()).done) {}
await server.stop(true);
`;

    writeFileSync(path.join(binDir, "opencode"), fakeServer, { mode: 0o755 });
    process.env.PATH = `${binDir}:${previousPath ?? "/usr/bin:/bin"}`;

    const [reviewTask] = tasksForPhase("reviewer");

    if (!reviewTask) {
      throw new Error("Expected a reviewer task.");
    }

    const checkpoints: number[] = [];

    const crashingTask = {
      ...reviewTask,
      id: "synthetic-grade-crash",
      grade: async (): Promise<never> =>
        await Promise.reject(new Error("Synthetic host grader crash.")),
    };

    const jobs = [
      {
        task: reviewTask,
        model: "stub/review",
        reviewerModel: null,
        repetition: 1,
      },
      {
        task: crashingTask,
        model: "stub/review",
        reviewerModel: null,
        repetition: 2,
      },
    ];

    const results = await runPool(
      jobs,
      async (job, signal) =>
        await runTrial(job, {
          runId: "live-retry",
          workspaceRoot: path.join(directory, "workspaces"),
          sandboxed: false,
          providersFile,
          timeoutScale: 1,
          apiRetries: 2,
          keepWorkspaces: false,
          dryRun: false,
          signal,
        }),
      {
        workers: 1,
        signal: new AbortController().signal,
        onResult: (completed) => {
          checkpoints.push(completed.length);
        },
      }
    );

    expect(checkpoints).toEqual([1, 2]);
    expect(results[0]).toMatchObject({
      passed: true,
      score: 1,
      outer_retries: 1,
      retry_cost_usd: 0.05,
      root_cost_usd: 0.03,
      total_cost_usd: 0.08,
      exit_code: 0,
    });
    expect(results[1]).toMatchObject({
      passed: false,
      score: 0,
      exit_code: 1,
      partial: false,
      error_message: "Error: Synthetic host grader crash.",
    });
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }

    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
