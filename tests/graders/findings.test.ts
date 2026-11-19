import { expect, test } from "bun:test";

import {
  defectMatchesFinding, parseFindings, reviewGrade, scopeNeeded,
} from "../../src/graders/findings.ts";
import { computeGradeResult, type Defect, type Evidence, type GitState, type ToolTraceEntry } from "../../src/graders/types.ts";

const clean: GitState = {
  head: "abc", committed: "", staged: "", unstaged: "", untracked: [], changedFiles: new Set(),
};

const defect: Defect = {
  id: "timeout", file: "src/job.ts", lineRange: [10, 15], minSeverity: 1,
  conceptGroups: [["timeout", "deadline"], ["worker", "thread"]], description: "The worker outlives the deadline.",
};

function review(finalText: string): Evidence {
  return {
    repoDir: "/tmp/opencode/review/repo", trialDir: "/tmp/opencode/review", baselineHead: clean.head,
    beforeGit: clean, afterGit: clean, tools: [], shellRuns: [], questionFormCount: 0,
    finalText, transcriptText: finalText, reviewerText: "", reviewHandoffs: [], actualReviewerModels: [],
    timedOut: false,
  };
}

test("parses findings sections and continuation lines, not fenced examples or summary bullets", () => {
  const markdown = [
    "```md", "## Findings", "- [P0] Fake opening", "```", "- Outside",
    "## fInDiNgS ##", "- **[P0]** First", "  Continued", "~~~markdown", "## Summary", "- [P1] Fake bullet",
    "```", "~~~", "1. **P1** Second", "2) [P2] Third", "### [P3] Fourth", "  Continued heading",
    "+ Unrated", "* No actionable findings.", "## Summary", "- [P0] Outside",
    "# Findings", "- [P3] Reopened",
  ].join("\r\n");

  expect(parseFindings(markdown)).toEqual([
    { severity: 0, body: "**[P0]** First\nContinued" },
    { severity: 1, body: "**P1** Second" },
    { severity: 2, body: "[P2] Third" },
    { severity: 3, body: "[P3] Fourth\nContinued heading" },
    { severity: null, body: "Unrated" },
    { severity: 3, body: "[P3] Reopened" },
  ]);
  expect(parseFindings("## Findings\n````\n```\n- [P1] Still fenced\n")).toEqual([]);
  expect(parseFindings("## Findings\n- ```md\n  - [P0] Fake\n  ```\n- [P1] Real")).toEqual([
    { severity: 1, body: "[P1] Real" },
  ]);
  expect(parseFindings("## Findings\n- **P1:** Colon bold\n- P2: Bare prefix")).toEqual([
    { severity: 1, body: "**P1:** Colon bold" },
    { severity: 2, body: "P2: Bare prefix" },
  ]);
});

test("requires sufficient severity, one in-range citation, and a match in each concept group", () => {
  expect(defectMatchesFinding(defect, { severity: 0, body: "THREAD outlives the DEADLINE (`./src/job.ts:5-8`)." })).toBe(true);
  expect(defectMatchesFinding(defect, {
    severity: 1, body: "Deadline ignored by worker in `wrong.ts:10`, not in /tmp/opencode/x/repo/src/job.ts:20:1.",
  })).toBe(true);
  expect(defectMatchesFinding(defect, { severity: 2, body: "Worker timeout at src/job.ts:10" })).toBe(false);
  expect(defectMatchesFinding(defect, { severity: null, body: "Worker timeout at src/job.ts:10" })).toBe(false);
  expect(defectMatchesFinding(defect, { severity: 1, body: "Worker timeout at src/job.ts:21" })).toBe(false);
  expect(defectMatchesFinding(defect, { severity: 1, body: "Worker timeout at other/src/job.ts:10" })).toBe(false);
  expect(defectMatchesFinding(defect, { severity: 1, body: "Unrelated timeout at src/job.ts:10" })).toBe(false);
  expect(defectMatchesFinding(defect, {
    severity: 1, body: "Worker timeout on `./src/my job.ts:10`",
  })).toBe(false);
  expect(defectMatchesFinding({ ...defect, file: "src/my job.ts" }, {
    severity: 1, body: "Worker timeout on `./src/my job.ts:10`",
  })).toBe(true);
  expect(defectMatchesFinding({ ...defect, file: "lib/repo/job.ts" }, {
    severity: 1, body: "Worker timeout at `./tmp/trial/repo/lib/repo/job.ts:10`",
  })).toBe(true);
  expect(defectMatchesFinding(defect, {
    severity: 1, body: "Worker timeout at `/home/work/run1/trial_a1b2c3/repo/src/job.ts:10`",
  })).toBe(true);
  expect(defectMatchesFinding(defect, {
    severity: 1, body: "Worker timeout at `/custom/workspace/repo/src/job.ts:10`",
  }, "/custom/workspace/repo")).toBe(true);
  expect(defectMatchesFinding({ ...defect, file: "job.ts" }, {
    severity: 1, body: "Worker timeout at `/home/trial/repo/job.ts:10`",
  })).toBe(false);
  expect(defectMatchesFinding({ ...defect, file: "job.ts" }, {
    severity: 1, body: "Worker timeout at `/tmp/opencode/repository/job.ts:10`",
  })).toBe(false);
});

test("moves an existing assignment to maximize the number of distinct matched defects", () => {
  const specific = { ...defect, id: "specific", conceptGroups: [["thread"]] };
  const spec = { defects: [defect, specific], excluded: [], bounce: false };

  expect(reviewGrade(
    review("## Findings\n- [P1] Thread timeout at src/job.ts:10\n- [P1] Worker timeout at src/job.ts:10"),
    spec,
  )).toMatchObject({
    passed: true, defectRecall: 1, checks: { caught_timeout: true, caught_specific: true },
  });
  expect(reviewGrade(review("## Findings\n- [P1] Thread timeout at src/job.ts:10"), spec)).toMatchObject({
    passed: false, defectRecall: 0.5,
  });
});

test("identifies a scope request only at the first non-empty line", () => {
  expect(scopeNeeded("\n\n ## - **sCoPe NeEdEd**: Send the range.")).toBe(true);
  expect(scopeNeeded("I reviewed the changes.\n## Scope needed")).toBe(false);
  expect(scopeNeeded("Scope needless")).toBe(false);
  expect(scopeNeeded(" \n")).toBe(false);
});

test("grades matched defects, primary false positives, nitpicks, exclusions, and Git changes", () => {
  const evidence = review([
    "## Findings", "- [P1] Worker ignores the timeout at src/job.ts:10", "- Unrated at `AGENTS.md:3`",
    "- [P3] Formatting at src/job.ts:25",
  ].join("\n"));

  const spec = { defects: [defect], excluded: ["/tmp/opencode/x/repo/AGENTS.md"], bounce: false };
  const result = reviewGrade(evidence, spec, "diff");

  expect(result).toMatchObject({
    passed: false, score: 3 / 5, falsePositiveP0P2: 1, nitpickP3: 1, pedantryFlags: 2, defectRecall: 1,
    precision: 1 / 3, reviewDiff: "diff", scopeBounced: false,
    checks: {
      caught_timeout: true, precision_no_false_alarms: false, exclusion_respected: false,
      bounce_correctness: true, read_only_clean_repo: true,
    },
  });
  expect(reviewGrade({ ...evidence, afterGit: { ...clean, staged: "change" } }, spec).checks.read_only_clean_repo).toBe(false);

  const duplicateMatch = review([
    "## Findings",
    "- **[P1]** `src/job.ts:10` — Worker ignores the timeout.",
    "- **[P1]** `src/job.ts:12` — Thread outlives the deadline.",
  ].join("\n"));

  expect(reviewGrade(duplicateMatch, { defects: [defect], excluded: [], bounce: false })).toMatchObject({
    passed: true, falsePositiveP0P2: 0, pedantryFlags: 0, precision: 1, defectRecall: 1,
  });
});

test("requires a clean report or a scope request with a missing input, and rejects mutating tools", () => {
  const cleanSpec = { defects: [], excluded: [], bounce: false };
  const bounceSpec = { ...cleanSpec, bounce: true };
  const evidence = review("## Findings\nNo actionable findings.");

  expect(reviewGrade(evidence, cleanSpec)).toMatchObject({ passed: true, score: 1, defectRecall: null, precision: null });
  expect(reviewGrade(evidence, bounceSpec)).toMatchObject({ passed: false, checks: { bounce_correctness: false } });
  expect(reviewGrade(review("Scope needed\nPlease provide a commit range or file list."), cleanSpec))
    .toMatchObject({ passed: false, checks: { bounce_correctness: false } });
  expect(reviewGrade(review("```\nNo actionable findings\n```"), cleanSpec).checks.states_no_findings).toBe(false);
  expect(reviewGrade({ ...evidence, timedOut: true }, cleanSpec)).toMatchObject({ passed: false, score: 1 });
  expect(reviewGrade(review("Scope needed\nPlease provide a commit range or file list."), bounceSpec))
    .toMatchObject({ passed: true, scopeBounced: true, checks: { lists_missing_inputs: true } });
  expect(reviewGrade(review("Scope needed\n```\ncommit range\n```"), bounceSpec).checks.lists_missing_inputs).toBe(false);
  expect(reviewGrade(review("Scope needed\nThe commit range and file list are present."), bounceSpec).checks.lists_missing_inputs)
    .toBe(false);
  expect(reviewGrade(review("Scope needed\n- Commit range\n- File list"), bounceSpec).checks.lists_missing_inputs).toBe(true);
  expect(reviewGrade(review("Scope needed\n## Findings\n- [P3] Whitespace"), bounceSpec).checks.precision_no_false_alarms).toBe(false);

  for (const tool of ["edit", "write", "patch", "execute"]) {
    const entry: ToolTraceEntry = {
      tool, status: "error", index: 0, input: {}, sessionId: "synthetic", isSubagent: false,
      textOutput: "", metadata: null, errorText: "Blocked",
    };

    expect(reviewGrade({ ...evidence, tools: [entry] }, cleanSpec).checks.read_only_clean_repo).toBe(false);
  }
});

test("scores checks independently of timeout, exit status, and partial results", () => {
  expect(computeGradeResult({}, { timedOut: false })).toMatchObject({ passed: false, score: 0 });
  expect(computeGradeResult({ a: true, b: false }, { timedOut: false })).toMatchObject({ passed: false, score: 0.5 });
  expect(computeGradeResult({ a: true }, { timedOut: false, exitCode: 0 })).toMatchObject({ passed: true, score: 1 });
  expect(computeGradeResult({ a: true }, { timedOut: false, exitCode: null })).toMatchObject({ passed: false, score: 1 });
  expect(computeGradeResult({ a: true }, { timedOut: false, exitCode: 1 })).toMatchObject({ passed: false, score: 1 });
  expect(computeGradeResult({ a: true }, { timedOut: false, partial: true })).toMatchObject({ passed: false, score: 1 });
});
