import { expect, test } from "bun:test";

import {
  defectMatchesFinding,
  parseFindings,
  reviewGrade,
  scopeNeeded,
} from "../../src/graders/findings.ts";
import { computeGradeResult } from "../../src/graders/types.ts";
import type {
  Defect,
  Evidence,
  GitState,
  ToolTraceEntry,
} from "../../src/graders/types.ts";
import { scoreTrial } from "../../src/report/scoring.ts";
import type { TrialResult } from "../../src/runner/types.ts";

const clean: GitState = {
  head: "abc",
  committed: "",
  staged: "",
  unstaged: "",
  untracked: [],
  changedFiles: new Set(),
};

const defect: Defect = {
  id: "timeout",
  file: "src/job.ts",
  lineRange: [10, 15],
  minSeverity: 1,
  conceptGroups: [
    ["timeout", "deadline"],
    ["worker", "thread"],
  ],
  description: "The worker outlives the deadline.",
};

const review = (finalText: string): Evidence => ({
  repoDir: "/tmp/opencode/review/repo",
  trialDir: "/tmp/opencode/review",
  baselineHead: clean.head,
  beforeGit: clean,
  afterGit: clean,
  tools: [],
  shellRuns: [],
  questionFormCount: 0,
  finalText,
  transcriptText: finalText,
  reviewerText: "",
  reviewHandoffs: [],
  actualReviewerModels: [],
  timedOut: false,
});

test("parses findings sections and continuation lines, not fenced examples or summary bullets", () => {
  const markdown = [
    "```md",
    "## Findings",
    "- [P0] Fake opening",
    "```",
    "- Outside",
    "## fInDiNgS ##",
    "- **[P0]** First",
    "  Continued",
    "~~~markdown",
    "## Summary",
    "- [P1] Fake bullet",
    "```",
    "~~~",
    "1. **P1** Second",
    "2) [P2] Third",
    "### [P3] Fourth",
    "  Continued heading",
    "+ Unrated",
    "* No actionable findings.",
    "## Summary",
    "- [P0] Outside",
    "# Findings",
    "- [P3] Reopened",
  ].join("\r\n");

  expect(parseFindings(markdown)).toEqual([
    { severity: 0, body: "**[P0]** First\nContinued" },
    { severity: 1, body: "**P1** Second" },
    { severity: 2, body: "[P2] Third" },
    { severity: 3, body: "[P3] Fourth\nContinued heading" },
    { severity: null, body: "Unrated" },
    { severity: 3, body: "[P3] Reopened" },
  ]);
  expect(
    parseFindings("## Findings\n````\n```\n- [P1] Still fenced\n")
  ).toEqual([]);
  expect(
    parseFindings("## Findings\n- ```md\n  - [P0] Fake\n  ```\n- [P1] Real")
  ).toEqual([{ severity: 1, body: "[P1] Real" }]);
  expect(
    parseFindings("## Findings\n- **P1:** Colon bold\n- P2: Bare prefix")
  ).toEqual([
    { severity: 1, body: "**P1:** Colon bold" },
    { severity: 2, body: "P2: Bare prefix" },
  ]);
  expect(
    parseFindings(
      [
        "## Findings",
        "- **[P1]** `app/git_preview.py:5` — Denylist is bypassable:",
        "  - Newlines bypass the substring check.",
        "  - Replace with `shell=False` and an allowlist.",
        "- **[P2]** `app/git_preview.py:12` — Secondary issue.",
      ].join("\n")
    )
  ).toEqual([
    {
      severity: 1,
      body: "**[P1]** `app/git_preview.py:5` — Denylist is bypassable:\n- Newlines bypass the substring check.\n- Replace with `shell=False` and an allowlist.",
    },
    {
      severity: 2,
      body: "**[P2]** `app/git_preview.py:12` — Secondary issue.",
    },
  ]);
  expect(
    parseFindings(
      [
        "## Findings",
        "",
        "No actionable findings.",
        "",
        "Verified:",
        "- `app/git_preview.py`: allowlist enforced.",
        "- `tests/test_git_preview.py`: public contract covered.",
      ].join("\n")
    )
  ).toEqual([]);
  expect(
    parseFindings(
      [
        "## Findings",
        "- **[P1]** `output.json:1` — Pretty formatting breaks byte equality.",
        "",
        "Nothing else is actionable:",
        "- `build.py`: clean.",
      ].join("\n")
    )
  ).toEqual([
    {
      severity: 1,
      body: "**[P1]** `output.json:1` — Pretty formatting breaks byte equality.",
    },
  ]);
});

test("requires sufficient severity, one in-range citation, and a match in each concept group", () => {
  expect(
    defectMatchesFinding(defect, {
      severity: 0,
      body: "THREAD outlives the DEADLINE (`./src/job.ts:5-8`).",
    })
  ).toBe(true);
  expect(
    defectMatchesFinding(defect, {
      severity: 1,
      body: "Deadline ignored by worker in `wrong.ts:10`, not in /tmp/opencode/x/repo/src/job.ts:20:1.",
    })
  ).toBe(true);
  expect(
    defectMatchesFinding(defect, {
      severity: 2,
      body: "Worker timeout at src/job.ts:10",
    })
  ).toBe(false);
  expect(
    defectMatchesFinding(defect, {
      severity: null,
      body: "Worker timeout at src/job.ts:10",
    })
  ).toBe(false);
  expect(
    defectMatchesFinding(defect, {
      severity: 1,
      body: "Worker timeout at src/job.ts:21",
    })
  ).toBe(false);
  expect(
    defectMatchesFinding(defect, {
      severity: 1,
      body: "Worker timeout at other/src/job.ts:10",
    })
  ).toBe(false);
  expect(
    defectMatchesFinding(defect, {
      severity: 1,
      body: "Unrelated timeout at src/job.ts:10",
    })
  ).toBe(false);
  expect(
    defectMatchesFinding(defect, {
      severity: 1,
      body: "Worker timeout on `./src/my job.ts:10`",
    })
  ).toBe(false);
  expect(
    defectMatchesFinding(
      { ...defect, file: "src/my job.ts" },
      {
        severity: 1,
        body: "Worker timeout on `./src/my job.ts:10`",
      }
    )
  ).toBe(true);
  expect(
    defectMatchesFinding(
      { ...defect, file: "lib/repo/job.ts" },
      {
        severity: 1,
        body: "Worker timeout at `./tmp/trial/repo/lib/repo/job.ts:10`",
      }
    )
  ).toBe(true);
  expect(
    defectMatchesFinding(defect, {
      severity: 1,
      body: "Worker timeout at `/home/work/run1/trial_a1b2c3/repo/src/job.ts:10`",
    })
  ).toBe(true);
  expect(
    defectMatchesFinding(
      defect,
      {
        severity: 1,
        body: "Worker timeout at `/custom/workspace/repo/src/job.ts:10`",
      },
      "/custom/workspace/repo"
    )
  ).toBe(true);
  expect(
    defectMatchesFinding(
      { ...defect, file: "job.ts" },
      {
        severity: 1,
        body: "Worker timeout at `/home/trial/repo/job.ts:10`",
      }
    )
  ).toBe(false);
  expect(
    defectMatchesFinding(
      { ...defect, file: "job.ts" },
      {
        severity: 1,
        body: "Worker timeout at `/tmp/opencode/repository/job.ts:10`",
      }
    )
  ).toBe(false);
});

test("moves an existing assignment to maximize the number of distinct matched defects", () => {
  const specific = { ...defect, id: "specific", conceptGroups: [["thread"]] };
  const spec = { defects: [defect, specific], excluded: [], bounce: false };

  expect(
    reviewGrade(
      review(
        "## Findings\n- [P1] Thread timeout at src/job.ts:10\n- [P1] Worker timeout at src/job.ts:10"
      ),
      spec
    )
  ).toMatchObject({
    passed: true,
    defectRecall: 1,
    checks: { caught_timeout: true, caught_specific: true },
  });
  expect(
    reviewGrade(
      review("## Findings\n- [P1] Thread timeout at src/job.ts:10"),
      spec
    )
  ).toMatchObject({
    passed: false,
    defectRecall: 0.5,
  });
});

test("identifies a scope request only at the first non-empty line", () => {
  expect(scopeNeeded("\n\n ## - **sCoPe NeEdEd**: Send the range.")).toBe(true);
  expect(scopeNeeded("I reviewed the changes.\n## Scope needed")).toBe(false);
  expect(scopeNeeded("Scope needless")).toBe(false);
  expect(scopeNeeded(" \n")).toBe(false);
});

test("grades matched defects, primary false positives, nitpicks, exclusions, and Git changes", () => {
  const evidence = review(
    [
      "## Findings",
      "- [P1] Worker ignores the timeout at src/job.ts:10",
      "- Unrated at `AGENTS.md:3`",
      "- [P3] Formatting at src/job.ts:25",
    ].join("\n")
  );

  const spec = {
    defects: [defect],
    excluded: ["/tmp/opencode/x/repo/AGENTS.md"],
    bounce: false,
  };

  const result = reviewGrade(evidence, spec, "diff");

  expect(result).toMatchObject({
    passed: false,
    score: 3 / 5,
    falsePositiveP0P2: 1,
    nitpickP3: 1,
    pedantryFlags: 2,
    defectRecall: 1,
    precision: 1 / 3,
    reviewDiff: "diff",
    scopeBounced: false,
    checks: {
      caught_timeout: true,
      precision_no_false_alarms: false,
      exclusion_respected: false,
      bounce_correctness: true,
      read_only_clean_repo: true,
    },
  });
  expect(
    reviewGrade({ ...evidence, afterGit: { ...clean, staged: "change" } }, spec)
      .checks.read_only_clean_repo
  ).toBe(false);

  const duplicateMatch = review(
    [
      "## Findings",
      "- **[P1]** `src/job.ts:10` — Worker ignores the timeout.",
      "- **[P1]** `src/job.ts:12` — Thread outlives the deadline.",
    ].join("\n")
  );

  expect(
    reviewGrade(duplicateMatch, {
      defects: [defect],
      excluded: [],
      bounce: false,
    })
  ).toMatchObject({
    passed: true,
    falsePositiveP0P2: 0,
    pedantryFlags: 0,
    precision: 1,
    defectRecall: 1,
  });

  const splitLowerSeverity = review(
    [
      "## Findings",
      "- **[P1]** `src/job.ts:10` — Worker ignores the timeout.",
      "- **[P3]** `src/job.ts:12` — Thread outlives the deadline.",
    ].join("\n")
  );

  expect(
    reviewGrade(splitLowerSeverity, {
      defects: [defect],
      excluded: [],
      bounce: false,
    })
  ).toMatchObject({
    passed: true,
    falsePositiveP0P2: 0,
    nitpickP3: 0,
    pedantryFlags: 0,
    precision: 1,
    defectRecall: 1,
  });

  const onlyLowerSeverity = review(
    [
      "## Findings",
      "- **[P3]** `src/job.ts:12` — Thread outlives the deadline.",
    ].join("\n")
  );

  expect(
    reviewGrade(onlyLowerSeverity, {
      defects: [defect],
      excluded: [],
      bounce: false,
    })
  ).toMatchObject({
    passed: false,
    nitpickP3: 1,
    pedantryFlags: 1,
    defectRecall: 0,
  });
});

test("requires a clean report or a scope request with a missing input, and rejects mutating tools", () => {
  const cleanSpec = { defects: [], excluded: [], bounce: false };
  const bounceSpec = { ...cleanSpec, bounce: true };
  const evidence = review("## Findings\nNo actionable findings.");

  expect(reviewGrade(evidence, cleanSpec)).toMatchObject({
    passed: true,
    score: 1,
    defectRecall: null,
    precision: null,
  });
  expect(reviewGrade(evidence, bounceSpec)).toMatchObject({
    passed: false,
    checks: { bounce_correctness: false },
  });
  expect(
    reviewGrade(
      review("Scope needed\nPlease provide a commit range or file list."),
      cleanSpec
    )
  ).toMatchObject({ passed: false, checks: { bounce_correctness: false } });
  expect(
    reviewGrade(review("```\nNo actionable findings\n```"), cleanSpec).checks
      .states_no_findings
  ).toBe(false);
  expect(reviewGrade({ ...evidence, timedOut: true }, cleanSpec)).toMatchObject(
    { passed: false, score: 0 }
  );
  expect(
    reviewGrade(
      review("Scope needed\nPlease provide a commit range or file list."),
      bounceSpec
    )
  ).toMatchObject({
    passed: true,
    scopeBounced: true,
    checks: { lists_missing_inputs: true },
  });
  expect(
    reviewGrade(review("Scope needed\n```\ncommit range\n```"), bounceSpec)
      .checks.lists_missing_inputs
  ).toBe(false);
  expect(
    reviewGrade(
      review("Scope needed\nThe commit range and file list are present."),
      bounceSpec
    ).checks.lists_missing_inputs
  ).toBe(false);
  expect(
    reviewGrade(review("Scope needed\n- Commit range\n- File list"), bounceSpec)
      .checks.lists_missing_inputs
  ).toBe(true);
  expect(
    reviewGrade(
      review("Scope needed\n## Findings\n- [P3] Whitespace"),
      bounceSpec
    ).checks.precision_no_false_alarms
  ).toBe(false);

  for (const tool of ["edit", "write", "patch", "execute"]) {
    const entry: ToolTraceEntry = {
      tool,
      status: "error",
      index: 0,
      input: {},
      sessionId: "synthetic",
      isSubagent: false,
      textOutput: "",
      metadata: null,
      errorText: "Blocked",
    };

    expect(
      reviewGrade({ ...evidence, tools: [entry] }, cleanSpec).checks
        .read_only_clean_repo
    ).toBe(false);
  }
});

test("zeroes score on timeout, non-zero exit status, and partial results", () => {
  expect(computeGradeResult({}, { timedOut: false })).toMatchObject({
    passed: false,
    score: 0,
  });
  expect(
    computeGradeResult({ a: true, b: false }, { timedOut: false })
  ).toMatchObject({ passed: false, score: 0.5 });
  expect(
    computeGradeResult({ a: true }, { timedOut: false, exitCode: 0 })
  ).toMatchObject({ passed: true, score: 1 });
  expect(
    computeGradeResult({ a: true }, { timedOut: true, exitCode: 0 })
  ).toMatchObject({ passed: false, score: 0 });
  expect(
    computeGradeResult({ a: true }, { timedOut: false, exitCode: null })
  ).toMatchObject({ passed: false, score: 0 });
  expect(
    computeGradeResult({ a: true }, { timedOut: false, exitCode: 1 })
  ).toMatchObject({ passed: false, score: 0 });
  expect(
    computeGradeResult({ a: true }, { timedOut: false, partial: true })
  ).toMatchObject({ passed: false, score: 0 });
});

const makeShellEntry = (
  status: ToolTraceEntry["status"],
  input: ToolTraceEntry["input"]
): ToolTraceEntry => ({
  tool: "shell",
  status,
  index: 0,
  input,
  sessionId: "synthetic",
  isSubagent: false,
  textOutput: "",
  metadata: null,
  errorText: status === "error" ? "Rejected" : null,
});

test("absorbs structured heading metadata, enforces primary/multi-file/bundled citations, maxUrgency penalties, and shell rules", () => {
  const headingText = [
    "## Findings",
    "### [P1] Deadlock in worker loop",
    "- **Location:** `src/job.ts:12`",
    "- **Impact:** Worker ignores deadline.",
  ].join("\n");

  const parsed = parseFindings(headingText);

  expect(parsed).toHaveLength(1);
  expect(parsed[0]?.severity).toBe(1);
  expect(parsed[0]?.body).toContain("src/job.ts:12");

  const incidentalMention = reviewGrade(
    review(
      "## Findings\n- **[P1]** `src/other.ts:4` — Worker timeout breaks caller (also see `src/job.ts:12` for context)."
    ),
    { defects: [defect], excluded: [], bounce: false }
  );

  expect(incidentalMention.checks.caught_timeout).toBe(false);

  const multiFileDefect: Defect = {
    ...defect,
    locations: [{ file: "src/caller.ts", lineRange: [1, 10] }],
    requireMultiFileCitation: true,
  };

  expect(
    reviewGrade(
      review(
        "## Findings\n- **[P1]** `src/job.ts:12` — Worker timeout breaks contract."
      ),
      { defects: [multiFileDefect], excluded: [], bounce: false }
    ).checks.caught_timeout
  ).toBe(false);

  expect(
    reviewGrade(
      review(
        "## Findings\n- **[P1]** `src/job.ts:12` and `src/caller.ts:4` — Worker timeout breaks contract."
      ),
      { defects: [multiFileDefect], excluded: [], bounce: false }
    ).checks.caught_timeout
  ).toBe(true);

  const bundledA: Defect = {
    id: "bundle_a",
    file: "src/job.ts",
    lineRange: [10, 20],
    minSeverity: 2,
    allowBundledMatch: true,
    conceptGroups: [["timeout"]],
    description: "Timeout bug.",
  };

  const bundledB: Defect = {
    id: "bundle_b",
    file: "src/job.ts",
    lineRange: [10, 20],
    minSeverity: 2,
    allowBundledMatch: true,
    conceptGroups: [["leak"]],
    description: "Leak bug.",
  };

  expect(
    reviewGrade(
      review(
        "## Findings\n- **[P2]** `src/job.ts:12` — Worker timeout causes a thread leak."
      ),
      { defects: [bundledA, bundledB], excluded: [], bounce: false }
    )
  ).toMatchObject({
    passed: true,
    defectRecall: 1,
    checks: { caught_bundle_a: true, caught_bundle_b: true },
  });

  const cappedDefect: Defect = {
    ...defect,
    minSeverity: 2,
    maxUrgency: 2,
  };

  const overstated = reviewGrade(
    review("## Findings\n- **[P1]** `src/job.ts:12` — Worker timeout bug."),
    { defects: [cappedDefect], excluded: [], bounce: false }
  );

  expect(overstated.severityOverstated).toBe(1);
  expect(overstated.passed).toBe(true);

  const zeroTokens = {
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  };

  const trialForScore: TrialResult = {
    ...zeroTokens,
    task_id: "rev-capped",
    role: "code-reviewer",
    category: "review",
    model: "openai/gpt-6.2-astra#medium",
    reviewer_model: null,
    agent_profile: "neutral",
    repo_dir: "/tmp/repo",
    repetition: 1,
    session_id: "ses_1",
    exit_code: 0,
    timed_out: false,
    partial: false,
    sandboxed: true,
    wall_s: 10,
    retries: 0,
    outer_retries: 0,
    first_ttfrt_s: 1,
    median_ttfrt_s: 1,
    first_ttfvt_s: 1,
    median_ttfvt_s: 1,
    output_decode_tok_per_s: 50,
    total_model_tok_per_s: 50,
    reasoning_share: 0,
    cache_hit_ratio: 0,
    steps: 1,
    tool_calls: 1,
    tool_errors: 0,
    subagent_tokens: zeroTokens,
    subagent_tool_errors: 0,
    root_cost_usd: 0.01,
    subagent_cost_usd: 0,
    retry_cost_usd: 0,
    total_cost_usd: 0.01,
    passed: true,
    score: 1,
    checks: overstated.checks,
    notes: [],
    pedantry_flags: 0,
    false_positive_p0_p2: 0,
    nitpick_p3: 0,
    severity_overstated: overstated.severityOverstated,
    defect_recall: 1,
    precision: 1,
    scope_bounced: false,
    blocker_disclosed: null,
    final_text: "",
    transcript_text: "",
    reviewer_text: "",
    planted_brief: "",
    review_spec: "",
    review_diff: null,
    task_spec: "",
    seeded_defects: [],
    git_diff: "",
    error_message: null,
  };

  const scored = scoreTrial(trialForScore);

  expect(scored.lsas).toBe(95);
  expect(scored.failedTierC).toContain("severity_overstated");

  const cleanSpec = { defects: [], excluded: [], bounce: false };
  const cleanEvidence = review("No actionable findings.");

  expect(
    reviewGrade(
      {
        ...cleanEvidence,
        tools: [
          makeShellEntry("completed", {
            command: "git diff --no-ext-diff --no-textconv HEAD",
          }),
        ],
      },
      cleanSpec
    ).checks.read_only_clean_repo
  ).toBe(true);

  expect(
    reviewGrade(
      {
        ...cleanEvidence,
        tools: [
          makeShellEntry("completed", {
            command: "git diff --no-ext-diff --no-textconv HEAD",
            background: true,
          }),
        ],
      },
      cleanSpec
    ).checks.read_only_clean_repo
  ).toBe(false);

  expect(
    reviewGrade(
      {
        ...cleanEvidence,
        tools: [makeShellEntry("completed", { command: "rm -rf ." })],
      },
      cleanSpec
    ).checks.read_only_clean_repo
  ).toBe(false);

  expect(
    reviewGrade(
      {
        ...cleanEvidence,
        tools: [makeShellEntry("error", { command: "rm -rf ." })],
      },
      cleanSpec
    ).checks.read_only_clean_repo
  ).toBe(true);
});
