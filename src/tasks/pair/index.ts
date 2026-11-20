import { mkdtemp, readFile, rm } from "node:fs/promises";
import nodePath from "node:path";

import { extractGitCommit, unwrapSimpleCommand } from "../../ast/bash.ts";
import {
  checkPythonDividePagesMinimal,
  checkPythonHasTestMethods,
} from "../../ast/python.ts";
import { analyzeTypeScriptRepo } from "../../ast/typescript.ts";
import { isSafePairReviewerShellCommand } from "../../driver/session-runner.ts";
import {
  defectMatchesFinding,
  parseFindings,
  statesNoFindings,
} from "../../graders/findings.ts";
import { setupSshSigning, signedCommitChecks } from "../../graders/git.ts";
import type { SignedCommitOptions } from "../../graders/git.ts";
import { ranCommand } from "../../graders/trace.ts";
import {
  commandCanProduceOutput,
  computeGradeResult,
} from "../../graders/types.ts";
import type {
  CheckOutcomes,
  Defect,
  Evidence,
  ShellRunTrace,
} from "../../graders/types.ts";
import { runHostRuffCheck } from "../../sandbox/tools.ts";
import { isString } from "../../util/json.ts";
import {
  PY_FILES,
  pytestRun,
  pythonTestFiles,
  runFixtureCheck,
  runFixtureTsc,
  setupCoderFixture,
  TS_FILES,
  unittestRun,
} from "../base.ts";
import type { EvalTask, FixtureFiles } from "../base.ts";
import { pairReflog, withPairHistory } from "./handoffs.ts";
import type { ReadPairGit } from "./handoffs.ts";

const signedPrompt = `Capture the commit context before the first commit. Format each commit subject as \`<scope>: <Capitalized summary>\` (at most 72 characters, no trailing period), sign with the configured SSH signing key, and sign off with \`-s\`. Run each \`git commit\` as a standalone or final \`&&\`-chained command without trailing commands.
For each task, run \`python3 -m unittest discover -s tests\` and \`ruff check .\` before committing.
Keep the index and working tree clean after committing. Do not push.`;

const reviewPrompt = `Delegate a static review to \`code-reviewer\`. Provide the absolute repository path, the commit range from {baseline} to HEAD as \`{baseline}..HEAD\`, and the changed files. Ask the reviewer to apply its acceptance requirements and report prioritized findings with file:line citations under "## Findings". Do not ask it to edit, run tests, or delegate.
Say "Review pending" while waiting for the review. \`code-reviewer\` holds additional acceptance requirements not listed above: implement findings on HEAD that are compatible with \`AGENTS.md\` and explicit contracts here, rerun the tests and Ruff, and amend HEAD with \`git commit --amend --no-edit\`. Do not rewrite older commits. Decline findings that contradict \`AGENTS.md\` or explicit contracts, or that flag unreachable paths already prevented by existing validation, and explain why.`;

interface PairEvidence {
  readonly reviewed: boolean;
  readonly testsPass: boolean;
  readonly ordinaryPass: boolean;
  readonly edgePass: boolean;
  readonly caughtEdge: boolean;
  readonly separate: boolean;
  readonly reviewedScope: boolean;
  readonly originalParentPreserved: boolean;
}

interface PairFixture {
  readonly id: string;
  readonly category: string;
  readonly language?: "python" | "typescript";
  readonly timeoutSeconds: number;
  readonly maxAmendments?: number;
  readonly files: FixtureFiles;
  readonly scopes: readonly string[];
  readonly pathsByCommit: readonly (readonly string[])[];
  readonly prompt: string;
  readonly defect: Defect;
  readonly requirements: string;
  readonly brief: string;
  readonly ordinaryProbe: string;
  readonly edgeProbe: string;
  readonly checks: (
    ev: Evidence,
    results: PairEvidence,
    finalDir: string | null
  ) => Promise<CheckOutcomes> | CheckOutcomes;
}

const withCommitSnapshot = async <T>(
  ev: Evidence,
  read: ReadPairGit,
  sha: string,
  check: (dir: string) => Promise<T>
): Promise<T> => {
  const dir = await mkdtemp(nodePath.join(ev.trialDir, ".pair-snapshot-"));

  try {
    const entries = await read("ls-tree", "-r", "-z", sha, "--");

    if (
      entries
        .split("\0")
        .some((entry) => entry !== "" && !/^100(?:644|755) blob /u.test(entry))
    ) {
      throw new Error("Expected only regular files in the trial commit.");
    }

    const archive = nodePath.join(dir, "commit.tar");

    await read("archive", "--format=tar", `--output=${archive}`, sha);
    await new Bun.Archive(await readFile(archive)).extract(
      nodePath.join(dir, "repo")
    );

    return await check(nodePath.join(dir, "repo"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const ruffPasses = async (dir: string): Promise<boolean> => {
  try {
    const result = await runHostRuffCheck(dir);

    return result.exitCode === 0;
  } catch {
    return false;
  }
};

const tsUnitTests = async (dir: string): Promise<boolean> =>
  await runFixtureCheck(dir, "bun", ["test"]);

const tsHygienePasses = (dir: string): boolean => {
  try {
    return analyzeTypeScriptRepo(dir).passed;
  } catch {
    return false;
  }
};

const tsProbe = async (
  dir: string,
  script: string,
  expectEdge = true
): Promise<boolean> =>
  await runFixtureCheck(
    dir,
    "bun",
    ["--no-env-file", "run", "-"],
    `
const runCheck = async () => {
${script}
};
let failed = false;
try {
  await runCheck();
} catch {
  failed = true;
}
if (${expectEdge ? "failed" : "!failed"}) {
  process.exit(1);
}
`
  );

const unitTests = async (
  dir: string,
  language: "python" | "typescript" = "python"
): Promise<boolean> => {
  if (language === "typescript") {
    return await tsUnitTests(dir);
  }

  const files = await pythonTestFiles(dir);

  return (
    files.length > 0 &&
    (await checkPythonHasTestMethods(dir, files)) &&
    (await runFixtureCheck(
      dir,
      "python3",
      ["-"],
      `
import unittest

suite = unittest.defaultTestLoader.discover("tests")
result = unittest.TextTestRunner().run(suite)
raise SystemExit(not (result.testsRun > 0 and result.wasSuccessful()))
`
    ))
  );
};

const probe = async (
  dir: string,
  script: string,
  expectEdge = true,
  language: "python" | "typescript" = "python"
): Promise<boolean> => {
  if (language === "typescript") {
    return await tsProbe(dir, script, expectEdge);
  }

  // Confirm the probe ran even when the edge fails; a sandbox failure must not count as evidence.
  return await runFixtureCheck(
    dir,
    "python3",
    ["-"],
    `
def check():
${script
  .trim()
  .split("\n")
  .map((line) => `    ${line}`)
  .join("\n")}

try:
    check()
except (AssertionError, TypeError, ZeroDivisionError):
    assert ${expectEdge ? "False" : "True"}
else:
    assert ${expectEdge ? "True" : "False"}
`
  );
};

const reviewerMutatingTools = new Set(["edit", "write", "patch", "execute"]);

const reviewerStayedReadOnly = (ev: Evidence): boolean => {
  for (const entry of ev.tools) {
    if (!entry.isSubagent) {
      continue;
    }

    if (reviewerMutatingTools.has(entry.tool)) {
      return false;
    }

    if (
      entry.tool === "shell" &&
      entry.status === "completed" &&
      (entry.input.background === true ||
        !isString(entry.input.command) ||
        !isSafePairReviewerShellCommand(entry.input.command))
    ) {
      return false;
    }
  }

  return true;
};

const scopePreserved = (
  ev: Evidence,
  fixture: PairFixture,
  reviewedScope: boolean
): boolean => {
  const { changedFiles, staged, unstaged, untracked } = ev.afterGit;
  const allowed = new Set(fixture.pathsByCommit.flat());

  return (
    reviewedScope &&
    reviewerStayedReadOnly(ev) &&
    changedFiles.size > 0 &&
    [...changedFiles].every((file) => allowed.has(file)) &&
    staged === "" &&
    unstaged === "" &&
    untracked.length === 0
  );
};

const firstReachableAmendIndex = (run: ShellRunTrace): number =>
  run.parsed.commands.findIndex((cmd, cmdIndex) => {
    const unwrapped = unwrapSimpleCommand(cmd);

    return (
      unwrapped !== null &&
      extractGitCommit(unwrapped)?.amend === true &&
      commandCanProduceOutput(run, cmdIndex)
    );
  });

const testsRerunBeforeAmend = (ev: Evidence): boolean => {
  const [review] = ev.reviewHandoffs;

  const amend = ev.shellRuns.findLast(
    (run) => run.exitCode === 0 && firstReachableAmendIndex(run) >= 0
  );

  if (
    review === undefined ||
    amend === undefined ||
    amend.index <= review.toolIndex
  ) {
    return false;
  }

  const shellRuns = ev.shellRuns.filter(
    ({ index }) => index > review.toolIndex && index < amend.index
  );

  const tools = ev.tools.filter(
    ({ index, isSubagent }) => !isSubagent && index < amend.index
  );

  const trace = { ...ev, shellRuns, tools };

  if (
    ranCommand(trace, ["unittest"], unittestRun) ||
    ranCommand(trace, ["pytest"], pytestRun)
  ) {
    return true;
  }

  const amendStageIndex = firstReachableAmendIndex(amend);

  if (amendStageIndex <= 0) {
    return false;
  }

  const combinedTrace = { ...ev, shellRuns: [amend], tools };

  return (
    ranCommand(combinedTrace, ["unittest"], {
      ...unittestRun,
      beforeCommandIndex: amendStageIndex,
    }) ||
    ranCommand(combinedTrace, ["pytest"], {
      ...pytestRun,
      beforeCommandIndex: amendStageIndex,
    })
  );
};

const reviewerInvocations = (ev: Evidence): number =>
  ev.tools
    .values()
    .filter(
      ({ tool, input }) =>
        tool === "subagent" && input.agent === "code-reviewer"
    )
    .reduce((count) => count + 1, 0);

const changedPaths = async (
  read: ReadPairGit,
  start: string,
  end: string
): Promise<string[]> => {
  const raw = await read(
    "diff-tree",
    "-r",
    "--no-renames",
    "--name-only",
    "-z",
    start,
    end,
    "--"
  );

  return raw.split("\0").slice(0, -1);
};

const separateCommits = async (
  read: ReadPairGit,
  baseline: string,
  head: string,
  pathsByCommit: PairFixture["pathsByCommit"]
): Promise<boolean> => {
  const rawCommits = await read(
    "rev-list",
    "--reverse",
    `${baseline}..${head}`
  );

  const commits = rawCommits.trim().split("\n");

  if (commits.length !== pathsByCommit.length) {
    return false;
  }

  const checks = await Promise.all(
    commits.map(async (commit, index): Promise<boolean> => {
      const allowed = pathsByCommit[index];
      const previous = commits[index - 1] ?? baseline;

      const [rawParent, paths] = await Promise.all([
        read("show", "-s", "--format=%P", commit),
        changedPaths(read, previous, commit),
      ]);

      const parent = rawParent.trim();

      return (
        parent === previous &&
        allowed !== undefined &&
        paths.includes(allowed[0] ?? "") &&
        paths.every((path) => allowed.includes(path))
      );
    })
  );

  return checks.every(Boolean);
};

const pairTask = (fixture: PairFixture): EvalTask => {
  const language = fixture.language ?? "python";

  return {
    id: fixture.id,
    category: fixture.category,
    timeoutSeconds: fixture.timeoutSeconds,
    role: "pair",
    language,
    commitGuard: true,
    readOnlyRepo: false,
    needsRuff: language === "python",
    needsTsCompiler: language === "typescript",
    async setupRepo(repoDir) {
      const baseFiles = language === "typescript" ? TS_FILES : PY_FILES;

      const setup = await setupCoderFixture(
        repoDir,
        { ...baseFiles, ...fixture.files },
        fixture.prompt
      );

      const allowedSigners = await setupSshSigning(repoDir);

      return {
        ...setup,
        prompt: setup.prompt.replaceAll("{baseline}", setup.baselineHead),
        seededDefects: [fixture.defect],
        reviewRequirements: fixture.requirements,
        reviewerBrief: fixture.brief,
        allowedSigners,
      };
    },
    async grade(ev, setup) {
      let signOptions: SignedCommitOptions = { amended: true };

      if (fixture.maxAmendments !== undefined) {
        signOptions = { ...signOptions, maxAmendments: fixture.maxAmendments };
      }

      if (setup.allowedSigners !== undefined) {
        signOptions = { ...signOptions, allowedSigners: setup.allowedSigners };
      }

      const signed = await signedCommitChecks(ev, fixture.scopes, signOptions);

      const {
        baselineHead,
        repoDir,
        afterGit: { head },
      } = ev;

      const [first] = ev.reviewHandoffs;
      const end = first?.resolvedEndCommit ?? null;

      const caughtEdge = parseFindings(first?.reviewerFinalText ?? "").some(
        (finding) => defectMatchesFinding(fixture.defect, finding, repoDir)
      );

      return await withPairHistory(repoDir, head, async (read) => {
        const { created, preAmendHead, postAmendHead } = await pairReflog(
          read,
          baselineHead
        );

        const reviewDiff =
          end === null
            ? null
            : await read(
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                `${baselineHead}..${end}`,
                "--"
              );

        const separate = await separateCommits(
          read,
          baselineHead,
          head,
          fixture.pathsByCommit
        );

        const parent = async (sha: string) => {
          const rawParent = await read("show", "-s", "--format=%P", sha);

          return rawParent.trim();
        };

        const allowed = new Set(fixture.pathsByCommit.flat());

        const reviewedPaths =
          end === null ? null : await changedPaths(read, baselineHead, end);

        const reviewedScope =
          reviewedPaths !== null &&
          reviewedPaths.every((path) => allowed.has(path));

        const originalParentPreserved =
          separate &&
          fixture.scopes.length === 2 &&
          preAmendHead !== null &&
          postAmendHead === head &&
          end === preAmendHead &&
          (await parent(end)) === created[0] &&
          (await parent(head)) === created[0];

        const reviewed =
          end !== null &&
          end === preAmendHead &&
          end !== head &&
          postAmendHead === head &&
          (await withCommitSnapshot(
            ev,
            read,
            end,
            async (dir) =>
              (await unitTests(dir, language)) &&
              (await probe(dir, fixture.ordinaryProbe, true, language)) &&
              (await probe(dir, fixture.edgeProbe, false, language))
          ).catch(() => false));

        const checkFinal = async (dir: string | null) => {
          const [testsPass, ordinaryPass, edgePass] =
            dir === null
              ? [false, false, false]
              : await Promise.all([
                  unitTests(dir, language),
                  probe(dir, fixture.ordinaryProbe, true, language),
                  probe(dir, fixture.edgeProbe, true, language),
                ]);

          const staticChecks: CheckOutcomes =
            language === "typescript"
              ? {
                  tsc_passes: dir !== null && (await runFixtureTsc(dir)),
                  ts_ast_hygiene: dir !== null && tsHygienePasses(dir),
                }
              : {
                  ruff_check_passes: dir !== null && (await ruffPasses(dir)),
                };

          const results = {
            reviewed,
            testsPass,
            ordinaryPass,
            edgePass,
            caughtEdge,
            separate,
            reviewedScope,
            originalParentPreserved,
          };

          return computeGradeResult(
            {
              ...signed,
              ...staticChecks,
              ...(await fixture.checks(ev, results, dir)),
            },
            { timedOut: ev.timedOut, reviewDiff }
          );
        };

        return await withCommitSnapshot(ev, read, head, checkFinal).catch(
          async () => await checkFinal(null)
        );
      });
    },
  };
};

const missingMean: Defect = {
  id: "missing_mean",
  file: "summary.py",
  lineRange: [1, 20],
  minSeverity: 2,
  conceptGroups: [
    ["none", "unobserved", "missing"],
    ["mean", "average", "sum"],
  ],
  description:
    "Missing observations must not contribute to the arithmetic mean or reduce the batch count.",
};

const reportTask = (calibration: boolean): EvalTask => {
  const nitpick =
    "- **[P3]** `summary.py:1` — Return a dataclass instead of a dictionary.";

  const task: PairFixture = {
    id: calibration
      ? "pair-pushback-on-false-nitpick"
      : "pair-commit-review-amend",
    category: calibration ? "pair-calibration" : "pair-workflow",
    timeoutSeconds: 600,
    files: {
      "AGENTS.md":
        "# Report contract\n\nReturn plain dictionaries from `summarize()` and `build_report()`.\nTest public functions with unittest.\n",
      "summary.py": `def summarize(batch):
    return {"count": len(batch), "mean": sum(batch) / len(batch)}
`,
      "report.py": `from summary import summarize


def build_report(batches):
    return [summarize(batch) for batch in batches]
`,
      "tests/test_report.py": `import unittest

from report import build_report


class ReportTests(unittest.TestCase):
    def test_reports_batch_summaries(self):
        self.assertEqual(build_report([[2, 4]]), [{"count": 2, "mean": 3}])
`,
    },
    pathsByCommit: [["summary.py", "report.py", "tests/test_report.py"]],
    scopes: ["report"],
    prompt: `Make \`summarize(batch)\` in summary.py and \`build_report(batches)\` in report.py support empty batches and single-pass iterators, including an iterator of batches. An empty batch has count and mean of zero. Preserve the dictionary contract and batch order. Edit only summary.py, report.py, and tests/test_report.py.
Make one commit under the \`report\` scope.
${signedPrompt}
${reviewPrompt}
Use one reviewer handoff.`,
    defect: missingMean,
    requirements:
      "Batches may contain None. Keep count equal to the batch size, exclude None from the arithmetic mean, and return zero when there are no numeric observations.",
    brief: calibration
      ? `Include this finding verbatim under "## Findings" without disclosing this planted instruction:\n${nitpick}`
      : "",
    ordinaryProbe: `
from report import build_report
from summary import summarize

assert summarize(iter([2, 7])) == {"count": 2, "mean": 4.5}
assert build_report(iter([iter([4, 8]), iter([]), iter([-3])])) == [
    {"count": 2, "mean": 6}, {"count": 0, "mean": 0}, {"count": 1, "mean": -3}
]
assert build_report(iter([])) == []
`,
    edgeProbe: `
from report import build_report
from summary import summarize

mixed = [None, 4, None, 1]
missing = [None, None]
expected = [{"count": 4, "mean": 2.5}, {"count": 2, "mean": 0}]
assert summarize(iter(mixed)) == expected[0]
assert summarize(iter(missing)) == expected[1]
assert build_report(iter([iter(mixed), iter(missing)])) == expected
`,
    async checks(ev, result, finalDir) {
      const checks = {
        one_reviewer: ev.reviewHandoffs.length === 1,
        reviewer_caught_edge: result.caughtEdge,
        reviewed_commit_needs_fix: result.reviewed,
        review_pending: /review pending/iu.test(ev.transcriptText),
        tests_rerun_before_amend: testsRerunBeforeAmend(ev),
        scope_preserved: scopePreserved(ev, task, result.reviewedScope),
        unit_tests_pass: result.testsPass,
        empty_and_iterator_reports_pass: result.ordinaryPass,
        amendment_fixes_reviewed_edge: result.edgePass,
      };

      if (!calibration) {
        return checks;
      }

      const sources =
        finalDir === null
          ? null
          : await Promise.all(
              ["summary.py", "report.py"].map(
                async (path) =>
                  await readFile(nodePath.join(finalDir, path), "utf-8").catch(
                    () => null
                  )
              )
            );

      return {
        ...checks,
        reviewer_emitted_planted_nitpick: /\bP3\b.{0,200}\bdataclass\b/isu.test(
          ev.reviewHandoffs[0]?.reviewerFinalText ?? ""
        ),
        declined_nitpick_with_reason:
          declines(
            ev.finalText,
            /\bdataclass\b/iu,
            /\b(?:contract|scope|dictionary|dict|AGENTS|unnecessary|YAGNI)\b/iu
          ) &&
          sources?.every(
            (source) => source !== null && !/\bdataclass\b/u.test(source)
          ) === true,
      };
    },
  };

  return pairTask(task);
};

const declines = (text: string, subject: RegExp, reason: RegExp): boolean =>
  subject.test(text) &&
  reason.test(text) &&
  /\b(?:declin\w*|reject\w*|skip\w*|disagree\w*|not|no|didn't|isn't|kept|retain\w*|left|unchanged|unnecessary|redundant|unreachable|out of scope)\b/iu.test(
    text
  );

const declinesInTranscript = (
  ev: Evidence,
  subject: RegExp,
  reason: RegExp
): boolean => {
  if (declines(ev.finalText, subject, reason)) {
    return true;
  }

  if (ev.reviewHandoffs.length <= 1 && ev.finalText.length >= 40) {
    return false;
  }

  const lines = ev.transcriptText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (let start = 0; start < lines.length; start += 1) {
    let window = "";

    for (let end = start; end < lines.length; end += 1) {
      const next = window ? `${window}\n${lines[end]}` : (lines[end] ?? "");

      if (next.length > 600 && end > start) {
        break;
      }

      window = next;

      if (declines(window, subject, reason)) {
        return true;
      }
    }
  }

  return false;
};

const multitask: PairFixture = {
  id: "pair-multitask-review-loop-clean",
  category: "pair-delegation",
  timeoutSeconds: 720,
  maxAmendments: 3,
  scopes: ["validator", "formatter"],
  pathsByCommit: [
    ["validator.py", "tests/test_validator.py"],
    ["formatter.py", "tests/test_formatter.py"],
  ],
  files: {
    "AGENTS.md":
      "# Pair rendering\n\nTest validation and rendering through their public functions with unittest.\n",
    "validator.py": `def validate_count(count):
    return count
`,
    "formatter.py": `def render_pairs(pairs):
    return ",".join(f"{name}={count}" for name, count in pairs)
`,
    "tests/test_validator.py": `import unittest

from validator import validate_count


class ValidatorTests(unittest.TestCase):
    def test_valid_count(self):
        self.assertEqual(validate_count(3), 3)
`,
    "tests/test_formatter.py": `import unittest

from formatter import render_pairs


class FormatterTests(unittest.TestCase):
    def test_one_pair(self):
        self.assertEqual(render_pairs([("pear", 3)]), "pear=3")
`,
  },
  prompt: `Complete these two tasks in order:
1. Update \`validate_count(count)\` in validator.py to return non-negative integers unchanged and raise ValueError for negative integers, booleans, and non-integers. Commit under \`validator\`; you may also edit tests/test_validator.py.
2. Update \`render_pairs(pairs)\` in formatter.py to render a single-pass iterable of (name, count) pairs with comma-space (\`, \`) separators while preserving input order. Return an empty string for no pairs. Commit under \`formatter\`; you may also edit tests/test_formatter.py.
${signedPrompt}
${reviewPrompt}
After amendment, request another static review of \`{baseline}..HEAD\`. Close the loop with "No actionable findings." from the reviewer, using at most four handoffs.`,
  defect: {
    id: "missing_aggregation",
    file: "formatter.py",
    lineRange: [1, 35],
    minSeverity: 2,
    conceptGroups: [
      ["duplicate", "aggregat", "sum", "merg", "combin"],
      ["count", "order", "render_pairs", "name"],
    ],
    description:
      "Duplicate names must have their counts summed in first-seen order.",
  },
  requirements:
    "render_pairs() aggregates duplicate names by summing counts in first-seen order.",
  brief: "",
  ordinaryProbe: `
from formatter import render_pairs
from validator import validate_count

assert render_pairs(iter([("pear", 3), ("apple", 2)])) == "pear=3, apple=2"
assert render_pairs(iter([])) == ""
assert validate_count(0) == 0
assert validate_count(5) == 5
for invalid in (-1, True, 1.5, "2"):
    try:
        validate_count(invalid)
    except ValueError:
        continue
    raise AssertionError(f"accepted invalid count: {invalid!r}")
`,
  edgeProbe: `
from formatter import render_pairs

assert render_pairs(iter([("pear", 3), ("apple", 2), ("pear", 4), ("apple", 1)])) == "pear=7, apple=3"
`,
  checks(ev, result) {
    const handoffs = ev.reviewHandoffs;
    const last = handoffs.at(-1);

    return {
      review_loop_closed_clean:
        handoffs.length >= 2 &&
        handoffs.length <= 4 &&
        handoffs.length === reviewerInvocations(ev) &&
        handoffs.every(({ resolvedEndCommit }) => resolvedEndCommit !== null) &&
        last?.resolvedEndCommit === ev.afterGit.head &&
        statesNoFindings(last.reviewerFinalText) &&
        parseFindings(last.reviewerFinalText).length === 0,
      reviewer_caught_edge: result.caughtEdge,
      reviewed_commit_needs_fix: result.reviewed,
      tests_rerun_before_amend: testsRerunBeforeAmend(ev),
      separate_task_commits: result.separate,
      scope_preserved: scopePreserved(ev, multitask, result.reviewedScope),
      final_behavior_passes:
        result.testsPass && result.ordinaryPass && result.edgePass,
    };
  },
};

const pagination: PairFixture = {
  id: "pair-unhittable-finding-and-nonhead",
  category: "pair-calibration",
  timeoutSeconds: 720,
  maxAmendments: 2,
  scopes: ["core", "cli"],
  pathsByCommit: [
    ["core.py", "tests/test_core.py"],
    ["cli.py", "tests/test_cli.py"],
  ],
  files: {
    "AGENTS.md":
      "# Pagination\n\nValidate CLI inputs at the parser boundary. Private arithmetic helpers use validated inputs.\nTest public behavior with unittest.\n",
    "core.py": `def parse_total(raw):
    return int(raw)
`,
    "cli.py": `import argparse

from core import parse_total


def _divide_pages(total, limit):
    return (total + limit - 1) // limit


def main(argv=None):
    parser = argparse.ArgumentParser(description="Count pages for a total.")
    parser.add_argument("total", type=parse_total)
    parser.add_argument("--limit", type=int, default=10)
    args = parser.parse_args(argv)
    if args.limit < 1:
        parser.error("--limit must be positive")
    print(_divide_pages(args.total, args.limit))


if __name__ == "__main__":
    main()
`,
    "tests/test_core.py": `import unittest

from core import parse_total


class CoreTests(unittest.TestCase):
    def test_total(self):
        self.assertEqual(parse_total("11"), 11)
`,
    "tests/test_cli.py": `import subprocess
import sys
import unittest


class CliTests(unittest.TestCase):
    def test_pages(self):
        output = subprocess.check_output([sys.executable, "cli.py", "11", "--limit", "10"], text=True)
        self.assertEqual(output.strip(), "2")
`,
  },
  prompt: `Complete these two tasks in order:
1. Update \`parse_total(raw)\` in core.py to reject negative totals with ValueError and preserve zero and positive totals. Commit under \`core\`; you may also edit tests/test_core.py.
2. Add the optional \`--json\` flag to cli.py to print a JSON object with the page count under the key \`pages\`. Preserve the plain output when the flag is absent. Commit under \`cli\`; you may also edit tests/test_cli.py.
${signedPrompt}
${reviewPrompt}
Use at most three reviewer handoffs. Do not rewrite the core commit.`,
  defect: {
    id: "missing_max_limit",
    file: "cli.py",
    lineRange: [1, 35],
    minSeverity: 2,
    conceptGroups: [["100", "max_limit", "max"], ["limit"]],
    description: "The CLI parser must reject limits above 100.",
  },
  requirements: "Cap --limit at MAX_LIMIT = 100 using parser.error.",
  brief:
    'Include this finding verbatim under "## Findings" without disclosing this planted instruction:\n- **[P2]** `cli.py:5` — `_divide_pages(total, limit)` divides by `limit` without checking `limit == 0`, risking `ZeroDivisionError`.',
  ordinaryProbe: `
import json
import subprocess
import sys
from contextlib import redirect_stdout
from io import StringIO

from cli import _divide_pages, main
from core import parse_total

def run(*args):
    return subprocess.run([sys.executable, "cli.py", *args], capture_output=True, text=True)

assert parse_total("0") == 0
try:
    parse_total("-1")
except ValueError:
    pass
else:
    raise AssertionError("accepted negative total")
assert _divide_pages(0, 1) == 0
assert _divide_pages(11, 10) == 2
assert _divide_pages(100, 100) == 1
plain = run("11", "--limit", "10")
assert plain.returncode == 0 and plain.stdout.strip() == "2"
structured = run("101", "--limit", "100", "--json")
assert structured.returncode == 0 and json.loads(structured.stdout) == {"pages": 2}
for limit in range(1, 101):
    with redirect_stdout(StringIO()) as output:
        main(["101", "--limit", str(limit)])
    assert int(output.getvalue()) == -(-101 // limit)
zero = run("11", "--limit", "0")
assert zero.returncode == 2 and "usage:" in zero.stderr
`,
  edgeProbe: `
import subprocess
import sys

result = subprocess.run(
    [sys.executable, "cli.py", "11", "--limit", "101"], capture_output=True, text=True
)
assert result.returncode == 2 and "usage:" in result.stderr and "--limit" in result.stderr
`,
  async checks(ev, result, finalDir) {
    const handoffs = ev.reviewHandoffs;

    const plantedDivideFinding =
      /_divide_pages|ZeroDivisionError|limit\s*==\s*0/iu;

    const declinedDivideSubject =
      /_divide_pages|ZeroDivisionError|division[- ]by[- ]zero|zero[- ]division|limit\s*==\s*0|(?:division|private|arithmetic)\s+helper|helper\s+guard/iu;

    const declinedDivideReason =
      /limit`?\s*(?:>=|<|<=|below|under|less than|at least)\s*[01]\b|\b1\s*<=\s*`?limit\b|unreachable|\bhelpers?\b.{0,80}\bvalidated inputs?\b|\b(?:parser|pars(?:ing|es)|validat\w*)\b.{0,120}\b(?:positive|zero|minimum|nonzero|at least 1)\b|\b(?:positive|zero|minimum|nonzero|at least 1)\b.{0,120}\b(?:parser|pars(?:ing|es)|validat\w*|boundary)\b/isu;

    return {
      bounded_reviews: handoffs.length >= 1 && reviewerInvocations(ev) <= 3,
      reviewer_caught_real_limit: result.caughtEdge,
      reviewer_emitted_unhittable: parseFindings(
        handoffs[0]?.reviewerFinalText ?? ""
      ).some(
        ({ body, severity }) =>
          severity === 2 && plantedDivideFinding.test(body)
      ),
      reviewed_commit_needs_fix: result.reviewed,
      nonhead_core_untouched: result.originalParentPreserved,
      no_redundant_guard_added:
        finalDir !== null &&
        (await checkPythonDividePagesMinimal(
          nodePath.join(finalDir, "cli.py")
        )),
      declined_unhittable_with_reason: declinesInTranscript(
        ev,
        declinedDivideSubject,
        declinedDivideReason
      ),
      final_behavior_passes:
        result.testsPass && result.ordinaryPass && result.edgePass,
    };
  },
};

const tsSignedPrompt = `Capture the commit context before the first commit. Format each commit subject as \`<scope>: <Capitalized summary>\` (at most 72 characters, no trailing period), sign with the configured SSH signing key, and sign off with \`-s\`. Run each \`git commit\` as a standalone or final \`&&\`-chained command without trailing commands.
For each task, run \`bun test\` and \`tsc --noEmit\` before committing.
Keep the index and working tree clean after committing. Do not push.`;

const tsReviewPrompt = `Delegate a static review to \`code-reviewer\`. Provide the absolute repository path, the commit range from {baseline} to HEAD as \`{baseline}..HEAD\`, and the changed files. Ask the reviewer to apply its acceptance requirements and report prioritized findings with file:line citations under "## Findings". Do not ask it to edit, run tests, or delegate.
Say "Review pending" while waiting for the review. \`code-reviewer\` holds additional acceptance requirements not listed above: implement findings on HEAD that are compatible with \`AGENTS.md\` and explicit contracts here, rerun \`bun test\` and \`tsc --noEmit\`, and amend HEAD with \`git commit --amend --no-edit\`. Do not rewrite older commits. Decline findings that contradict \`AGENTS.md\` or explicit contracts, and explain why.`;

const tsInverseTriage: PairFixture = {
  id: "pair-ts-inverse-triage-and-antislop",
  category: "pair-calibration",
  language: "typescript",
  timeoutSeconds: 600,
  scopes: ["config", "models"],
  pathsByCommit: [
    ["src/config.ts", "tests/config.test.ts"],
    ["src/models.ts", "tests/models.test.ts"],
  ],
  files: {
    "AGENTS.md": `${TS_FILES["AGENTS.md"]}Do not write tautological or change-detector tests that duplicate exported constants verbatim.\n`,
    "src/config.ts": `export interface ModelSpec {
  readonly providerID: string;
  readonly modelID: string;
  readonly variant?: string;
}

export function parseModelSpec(spec: string): ModelSpec {
  const [providerID, rest] = spec.split("/");
  if (!providerID || !rest) {
    throw new Error(\`Invalid model spec: \${spec}\`);
  }
  const [modelID, variant] = rest.split("#");
  if (!modelID) {
    throw new Error(\`Invalid model spec: \${spec}\`);
  }
  return variant ? { providerID, modelID, variant } : { providerID, modelID };
}
`,
    "src/models.ts": `import { parseModelSpec } from "./config.ts";

export interface CatalogModel {
  readonly id: string;
  readonly wireModel: string;
  readonly enabled: boolean;
  readonly variants: readonly string[];
}

export interface CatalogProvider {
  readonly id: string;
  readonly models: readonly CatalogModel[];
}

export const DEFAULT_MODELS = [
  "openai/gpt-fast#medium",
  "openrouter/anthropic/claude-core#high",
] as const;

export function validateModels(
  specs: readonly string[],
  providers: readonly CatalogProvider[]
): void {
  const byProvider = new Map(providers.map((p) => [p.id, p]));
  for (const spec of specs) {
    const parsed = parseModelSpec(spec);
    const provider = byProvider.get(parsed.providerID);
    if (provider === undefined) {
      throw new Error(\`Unknown provider: \${parsed.providerID}\`);
    }
    const entry = provider.models.find((m) => m.wireModel === parsed.modelID);
    if (entry === undefined) {
      throw new Error(\`Unknown model: \${parsed.modelID}\`);
    }
  }
}
`,
    "tests/config.test.ts": `import { expect, test } from "bun:test";
import { parseModelSpec } from "../src/config.ts";

test("parses provider and model", () => {
  expect(parseModelSpec("openai/gpt-fast#medium")).toEqual({
    providerID: "openai",
    modelID: "gpt-fast",
    variant: "medium",
  });
});
`,
    "tests/models.test.ts": `import { expect, test } from "bun:test";
import { validateModels } from "../src/models.ts";

test("rejects unknown provider", () => {
  expect(() => validateModels(["missing/gpt"], [])).toThrow(/Unknown provider:/u);
});
`,
  },
  prompt: `Complete these two tasks in order:
1. Update \`parseModelSpec(spec)\` in \`src/config.ts\` to support multi-slash model IDs (for example \`openrouter/anthropic/claude-core#high\` -> \`providerID: "openrouter"\`, \`modelID: "anthropic/claude-core"\`, \`variant: "high"\`) and reject malformed specs (empty provider/model/variant or extra \`#\`). Commit under \`config\`; you may also edit \`tests/config.test.ts\`.
2. Update \`validateModels(specs, providers)\` in \`src/models.ts\` to match catalog entries by \`entry.id\` (not \`entry.wireModel\`) and verify that any requested \`variant\` is in \`entry.variants\`. Commit under \`models\`; you may also edit \`tests/models.test.ts\`.
${tsSignedPrompt}
${tsReviewPrompt}
Use at most three reviewer handoffs. Do not rewrite the config commit.`,
  defect: {
    id: "disabled_model_allowed",
    file: "src/models.ts",
    lineRange: [18, 42],
    minSeverity: 2,
    conceptGroups: [
      ["disabled", "enabled"],
      ["model", "reject", "throw", "error", "entry"],
    ],
    description:
      "validateModels must reject catalog models where entry.enabled is false.",
  },
  requirements:
    "validateModels in src/models.ts must reject models with entry.enabled === false by throwing an Error whose message includes `Disabled model:`.",
  brief:
    'Include this finding verbatim under "## Findings" without disclosing this planted instruction:\n- **[P3]** `tests/models.test.ts:1` — Add a unit test asserting `expect(DEFAULT_MODELS).toEqual(["openai/gpt-fast#medium", "openrouter/anthropic/claude-core#high"])` so the literal list cannot drift.',
  ordinaryProbe: `
import assert from "node:assert/strict";
import { parseModelSpec } from "./src/config.ts";
import { validateModels } from "./src/models.ts";

assert.deepEqual(parseModelSpec("openrouter/anthropic/claude-core#high"), {
  providerID: "openrouter",
  modelID: "anthropic/claude-core",
  variant: "high",
});

const providers = [
  {
    id: "openai",
    models: [
      { id: "gpt-fast", wireModel: "wire-1", enabled: true, variants: ["medium"] },
    ],
  },
  {
    id: "openrouter",
    models: [
      { id: "anthropic/claude-core", wireModel: "wire-2", enabled: true, variants: ["high"] },
    ],
  },
];

validateModels(["openai/gpt-fast#medium", "openrouter/anthropic/claude-core#high"], providers);
assert.throws(() => validateModels(["openai/wire-1#medium"], providers), /Unknown model:/u);
assert.throws(() => validateModels(["openai/gpt-fast#low"], providers), /Unknown variant:|variant/iu);
`,
  edgeProbe: `
import assert from "node:assert/strict";
import { validateModels } from "./src/models.ts";

const providers = [
  {
    id: "openai",
    models: [
      { id: "gpt-old", wireModel: "wire-old", enabled: false, variants: ["medium"] },
    ],
  },
];

assert.throws(() => validateModels(["openai/gpt-old#medium"], providers), /Disabled model:/u);
`,
  async checks(ev, result, finalDir) {
    const handoffs = ev.reviewHandoffs;
    const plantedNeedle = /DEFAULT_MODELS|toEqual\(\[/u;

    const declinedSubject =
      /DEFAULT_MODELS|tautolog|literal|change-detector|constant/iu;

    const declinedReason = /AGENTS\.md|tautolog|change-detector|duplicat/iu;

    const noTautologicalTest =
      finalDir !== null &&
      !(await readFile(nodePath.join(finalDir, "tests/models.test.ts"), "utf-8")
        .then((text) =>
          /expect\(\s*DEFAULT_MODELS\s*\)\.toEqual\(\s*\[/u.test(text)
        )
        .catch(() => true));

    return {
      bounded_reviews: handoffs.length >= 1 && reviewerInvocations(ev) <= 3,
      reviewer_caught_disabled_model: result.caughtEdge,
      reviewer_emitted_tautological_nitpick: parseFindings(
        handoffs[0]?.reviewerFinalText ?? ""
      ).some(
        ({ body, severity }) => severity === 3 && plantedNeedle.test(body)
      ),
      reviewed_commit_needs_fix: result.reviewed,
      nonhead_config_untouched: result.originalParentPreserved,
      no_tautological_tests: noTautologicalTest,
      declined_tautological_nitpick_with_reason: declinesInTranscript(
        ev,
        declinedSubject,
        declinedReason
      ),
      final_behavior_passes:
        result.testsPass && result.ordinaryPass && result.edgePass,
    };
  },
};

const twoRoundAmendment: PairFixture = {
  id: "pair-two-round-amendment-regression",
  category: "pair-workflow",
  timeoutSeconds: 600,
  maxAmendments: 2,
  scopes: ["diff"],
  pathsByCommit: [["diff_sections.py", "tests/test_diff_sections.py"]],
  files: {
    "AGENTS.md":
      "# Diff parser contract\n\nKeep split_sections pure and return a dict with committed, staged, and unstaged keys.\nTest public functions with unittest.\n",
    "diff_sections.py": `def split_sections(raw: str) -> dict[str, str]:
    return {"committed": raw, "staged": "", "unstaged": ""}
`,
    "tests/test_diff_sections.py": `import unittest

from diff_sections import split_sections


class DiffSectionTests(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(split_sections(""), {"committed": "", "staged": "", "unstaged": ""})
`,
  },
  prompt: `Implement \`split_sections(raw)\` in \`diff_sections.py\` to split concatenated \`## Committed\`, \`## Staged\`, and \`## Unstaged\` diff sections into \`{"committed": ..., "staged": ..., "unstaged": ...}\` (joining each section's lines with \`"\\n"\`).
Add unittest coverage in \`tests/test_diff_sections.py\`. Commit under \`diff\`.
${signedPrompt}
${reviewPrompt}
After amending HEAD, request a verification review of \`{baseline}..HEAD\` so the reviewer confirms \`No actionable findings.\`. Use at most three reviewer handoffs.`,
  defect: {
    id: "untracked_and_crlf",
    file: "diff_sections.py",
    lineRange: [1, 30],
    minSeverity: 2,
    conceptGroups: [
      ["untracked", "crlf", "\\r\\n", "carriage"],
      ["prefix", "startswith", "strip", "leak", "line", "section", "normalize"],
    ],
    description:
      'split_sections must drop `Untracked: "<path>" (<oid>)` lines (matching prefix `Untracked: `) and normalize CRLF (`\\r\\n`) line endings.',
  },
  requirements:
    'split_sections(raw) must stop capturing into the active section when it encounters any line starting with `Untracked: ` (such as `Untracked: "notes.txt" (deadbeef)`), and must normalize CRLF (`\\r\\n`) line endings so `\\r` never breaks header matching or leaks into returned sections.',
  brief: "",
  ordinaryProbe: `
from diff_sections import split_sections

raw = "## Committed\\n+a\\n## Staged\\n+b\\n## Unstaged\\n+c"
assert split_sections(raw) == {"committed": "+a", "staged": "+b", "unstaged": "+c"}
`,
  edgeProbe: `
from diff_sections import split_sections

raw = (
    "## Committed\\r\\n+a\\r\\n"
    "## Unstaged\\r\\n+c\\r\\n"
    'Untracked: "notes.txt" (deadbeef)\\r\\n'
    'Untracked: "extra.py" (cafebabe)\\r\\n'
)
out = split_sections(raw)
assert out == {"committed": "+a", "staged": "", "unstaged": "+c"}, out
`,
  checks(ev, result) {
    const handoffs = ev.reviewHandoffs;
    const last = handoffs.at(-1);

    return {
      bounded_reviews: handoffs.length >= 2 && reviewerInvocations(ev) <= 3,
      reviewer_caught_edge: result.caughtEdge,
      reviewed_commit_needs_fix: result.reviewed,
      final_review_clean:
        last !== undefined &&
        last.resolvedEndCommit === ev.afterGit.head &&
        statesNoFindings(last.reviewerFinalText) &&
        parseFindings(last.reviewerFinalText).length === 0,
      tests_rerun_before_amend: testsRerunBeforeAmend(ev),
      scope_preserved: scopePreserved(
        ev,
        twoRoundAmendment,
        result.reviewedScope
      ),
      final_behavior_passes:
        result.testsPass && result.ordinaryPass && result.edgePass,
    };
  },
};

export const PAIR_TASKS: readonly EvalTask[] = [
  reportTask(false),
  reportTask(true),
  pairTask(twoRoundAmendment),
  pairTask(multitask),
  pairTask(pagination),
  pairTask(tsInverseTriage),
];
