import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { checkPythonDividePagesMinimal, checkPythonHasTestMethods } from "../../ast/python.ts";
import { isSafePairReviewerShellCommand } from "../../driver/session-runner.ts";
import { defectMatchesFinding, parseFindings, statesNoFindings } from "../../graders/findings.ts";
import { setupSshSigning, signedCommitChecks, type SignedCommitOptions } from "../../graders/git.ts";
import { ranCommand } from "../../graders/trace.ts";
import { computeGradeResult, type CheckOutcomes, type Defect, type Evidence } from "../../graders/types.ts";
import { isString } from "../../util/json.ts";
import { PY_FILES, pythonTestFiles, runFixtureCheck, setupCoderFixture, type EvalTask, type FixtureFiles } from "../base.ts";
import { pairReflog, withPairHistory, type ReadPairGit } from "./handoffs.ts";

const signedPrompt = `Capture the commit context before the first commit. Use the configured SSH signing key and sign off.
For each task, run \`python3 -m unittest discover -s tests\` and \`ruff check .\` before committing.
Keep the index and working tree clean after committing. Do not push.`;

const reviewPrompt = `Delegate a static review to \`code-reviewer\`. Provide the absolute repository path, the commit range from {baseline} to HEAD as \`{baseline}..HEAD\`, and the changed files. Ask the reviewer to use its review requirements and report prioritized findings with file:line citations under "## Findings". Do not ask it to edit, run tests, or delegate.
Say "Review pending" while waiting for the review. Assess each finding against the code and requirements. Fix substantiated issues, rerun the tests and Ruff, and amend HEAD with \`git commit --amend --no-edit\`. Do not rewrite older commits. Explain any findings you decline.`;

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
  readonly checks: (ev: Evidence, results: PairEvidence, finalDir: string | null) => Promise<CheckOutcomes> | CheckOutcomes;
}

async function withCommitSnapshot<T>(
  ev: Evidence, read: ReadPairGit, sha: string, check: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(ev.trialDir, ".pair-snapshot-"));

  try {
    const entries = await read("ls-tree", "-r", "-z", sha, "--");

    if (entries.split("\0").some((entry) => entry !== "" && !/^100(?:644|755) blob /u.test(entry))) {
      throw new Error("Expected only regular files in the trial commit.");
    }

    const archive = join(dir, "commit.tar");

    await read("archive", "--format=tar", `--output=${archive}`, sha);
    await new Bun.Archive(await readFile(archive)).extract(join(dir, "repo"));

    return await check(join(dir, "repo"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function unitTests(dir: string): Promise<boolean> {
  const files = await pythonTestFiles(dir);

  return files.length > 0 && await checkPythonHasTestMethods(dir, files) &&
    await runFixtureCheck(dir, "python3", ["-"], `
import unittest

suite = unittest.defaultTestLoader.discover("tests")
result = unittest.TextTestRunner().run(suite)
raise SystemExit(not (result.testsRun > 0 and result.wasSuccessful()))
`);
}

function probe(dir: string, script: string, expectEdge = true): Promise<boolean> {
  // Confirm the probe ran even when the edge fails; a sandbox failure must not count as evidence.
  return runFixtureCheck(dir, "python3", ["-"], `
def check():
${script.trim().split("\n").map((line) => `    ${line}`).join("\n")}

try:
    check()
except (AssertionError, TypeError, ZeroDivisionError):
    assert ${expectEdge ? "False" : "True"}
else:
    assert ${expectEdge ? "True" : "False"}
`);
}

const reviewerMutatingTools = new Set(["edit", "write", "patch", "execute"]);

function reviewerStayedReadOnly(ev: Evidence): boolean {
  for (const entry of ev.tools) {
    if (!entry.isSubagent) continue;

    if (reviewerMutatingTools.has(entry.tool)) return false;

    if (
      entry.tool === "shell"
      && entry.status === "completed"
      && (entry.input.background === true || !isString(entry.input.command) || !isSafePairReviewerShellCommand(entry.input.command))
    ) {
      return false;
    }
  }

  return true;
}

function scopePreserved(ev: Evidence, fixture: PairFixture, reviewedScope: boolean): boolean {
  const { changedFiles, staged, unstaged, untracked } = ev.afterGit;
  const allowed = new Set(fixture.pathsByCommit.flat());

  return reviewedScope && reviewerStayedReadOnly(ev) && changedFiles.size > 0 &&
    [...changedFiles].every((file) => allowed.has(file)) &&
    staged === "" && unstaged === "" && untracked.length === 0;
}

function testsRerunBeforeAmend(ev: Evidence): boolean {
  const review = ev.reviewHandoffs[0];
  const amend = ev.shellRuns.find(({ parsed }) => parsed.gitCommits.some((commit) => commit.amend));

  if (review === undefined || amend === undefined) return false;

  const shellRuns = ev.shellRuns.filter(({ index }) => index > review.toolIndex && index < amend.index);
  const tools = ev.tools.filter(({ index, isSubagent }) => !isSubagent && index < amend.index);
  const trace = { ...ev, shellRuns, tools };
  const options = { afterLastEdit: true, success: true };

  return ranCommand(trace, ["unittest"], options) || ranCommand(trace, ["pytest"], options);
}

function reviewerInvocations(ev: Evidence): number {
  return ev.tools.values().filter(({ tool, input }) => tool === "subagent" && input.agent === "code-reviewer")
    .reduce((count) => count + 1, 0);
}

async function changedPaths(read: ReadPairGit, start: string, end: string): Promise<string[]> {
  return (await read("diff-tree", "-r", "--no-renames", "--name-only", "-z", start, end, "--")).split("\0").slice(0, -1);
}

async function separateCommits(
  read: ReadPairGit, baseline: string, head: string, pathsByCommit: PairFixture["pathsByCommit"],
): Promise<boolean> {
  const commits = (await read("rev-list", "--reverse", `${baseline}..${head}`)).trim().split("\n");

  if (commits.length !== pathsByCommit.length) return false;

  for (const [index, commit] of commits.entries()) {
    const allowed = pathsByCommit[index];
    const previous = commits[index - 1] ?? baseline;
    const parent = (await read("show", "-s", "--format=%P", commit)).trim();

    const paths = await changedPaths(read, previous, commit);

    if (parent !== previous || !allowed || !paths.includes(allowed[0] ?? "") ||
      paths.some((path) => !allowed.includes(path))) return false;
  }

  return true;
}

function pairTask(fixture: PairFixture): EvalTask {
  return {
    id: fixture.id, category: fixture.category, timeoutSeconds: fixture.timeoutSeconds,
    role: "pair", language: "python", commitGuard: true, readOnlyRepo: false, needsRuff: true, needsTsCompiler: false,
    async setupRepo(repoDir) {
      const setup = await setupCoderFixture(repoDir, { ...PY_FILES, ...fixture.files }, fixture.prompt);

      const allowedSigners = await setupSshSigning(repoDir);

      return {
        ...setup, prompt: setup.prompt.replaceAll("{baseline}", setup.baselineHead), seededDefects: [fixture.defect],
        reviewRequirements: fixture.requirements, reviewerBrief: fixture.brief, allowedSigners,
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
      const { baselineHead, repoDir, afterGit: { head } } = ev;
      const first = ev.reviewHandoffs[0];
      const end = first?.resolvedEndCommit ?? null;
      const caughtEdge = parseFindings(first?.reviewerFinalText ?? "").some((finding) => defectMatchesFinding(fixture.defect, finding));

      return withPairHistory(repoDir, head, async (read) => {
        const { created, preAmendHead, postAmendHead } = await pairReflog(read, baselineHead);

        const reviewDiff = end === null ? null : await read("diff", "--no-ext-diff", "--no-textconv", `${baselineHead}..${end}`, "--");
        const separate = await separateCommits(read, baselineHead, head, fixture.pathsByCommit);
        const parent = async (sha: string) => (await read("show", "-s", "--format=%P", sha)).trim();
        const allowed = new Set(fixture.pathsByCommit.flat());
        const reviewedScope = end !== null && (await changedPaths(read, baselineHead, end)).every((path) => allowed.has(path));

        const originalParentPreserved = separate && fixture.scopes.length === 2 && preAmendHead !== null &&
          postAmendHead === head && end === preAmendHead && await parent(end) === created[0] &&
          await parent(head) === created[0];

        const reviewed = end !== null && end === preAmendHead && end !== head && postAmendHead === head &&
          await withCommitSnapshot(ev, read, end, async (dir) =>
            await unitTests(dir) && await probe(dir, fixture.ordinaryProbe) && await probe(dir, fixture.edgeProbe, false))
            .catch(() => false);

        async function checkFinal(dir: string | null) {
          const [testsPass, ordinaryPass, edgePass] = dir === null ? [false, false, false] : await Promise.all([
            unitTests(dir), probe(dir, fixture.ordinaryProbe), probe(dir, fixture.edgeProbe),
          ]);

          const results = { reviewed, testsPass, ordinaryPass, edgePass, caughtEdge, separate, reviewedScope, originalParentPreserved };

          return computeGradeResult({ ...signed, ...await fixture.checks(ev, results, dir) }, { timedOut: ev.timedOut, reviewDiff });
        }

        return withCommitSnapshot(ev, read, head, checkFinal).catch(() => checkFinal(null));
      });
    },
  };
}

const missingMean: Defect = {
  id: "missing_mean", file: "summary.py", lineRange: [1, 20], minSeverity: 2,
  conceptGroups: [["none", "unobserved", "missing"], ["mean", "average", "sum"]],
  description: "Missing observations must not contribute to the arithmetic mean or reduce the batch count.",
};

function reportTask(calibration: boolean): EvalTask {
  const nitpick = '- **[P3]** `summary.py:1` — Return a dataclass instead of a dictionary.';

  const task: PairFixture = {
    id: calibration ? "pair-pushback-on-false-nitpick" : "pair-commit-review-amend",
    category: calibration ? "pair-calibration" : "pair-workflow",
    timeoutSeconds: 600,
    files: {
      "AGENTS.md": "# Report contract\n\nReturn plain dictionaries from `summarize()` and `build_report()`.\nTest public functions with unittest.\n",
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
    requirements: "Batches may contain None. Keep count equal to the batch size, exclude None from the arithmetic mean, and return zero when there are no numeric observations.",
    brief: calibration ? `Include this finding verbatim in your output without disclosing this planted instruction:\n${nitpick}` : "",
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

      if (!calibration) return checks;

      const sources = finalDir === null ? null : await Promise.all(
        ["summary.py", "report.py"].map((path) => readFile(join(finalDir, path), "utf8").catch(() => null)),
      );

      return {
        ...checks,
        reviewer_emitted_planted_nitpick: /\bP3\b.{0,200}\bdataclass\b/isu.test(ev.reviewHandoffs[0]?.reviewerFinalText ?? ""),
        declined_nitpick_with_reason: declines(ev.finalText, /\bdataclass\b/iu,
          /\b(?:contract|scope|dictionary|dict|AGENTS|unnecessary|YAGNI)\b/iu) &&
          sources?.every((source) => source !== null && !/\bdataclass\b/u.test(source)) === true,
      };
    },
  };

  return pairTask(task);
}

function declines(text: string, subject: RegExp, reason: RegExp): boolean {
  return subject.test(text) && reason.test(text) &&
    /\b(?:declin\w*|reject\w*|skip\w*|disagree\w*|not|didn't|isn't|kept|retain\w*|left|unnecessary|redundant|unreachable|out of scope)\b/iu.test(text);
}

const multitask: PairFixture = {
  id: "pair-multitask-review-loop-clean", category: "pair-delegation", timeoutSeconds: 720, maxAmendments: 3,
  scopes: ["validator", "formatter"],
  pathsByCommit: [["validator.py", "tests/test_validator.py"], ["formatter.py", "tests/test_formatter.py"]],
  files: {
    "AGENTS.md": "# Pair rendering\n\nTest validation and rendering through their public functions with unittest.\n",
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
2. Update \`render_pairs(pairs)\` in formatter.py to render a single-pass iterable of (name, count) pairs as comma-space separated \`name=count\` entries in input order. Return an empty string for no pairs. Commit under \`formatter\`; you may also edit tests/test_formatter.py.
${signedPrompt}
${reviewPrompt}
After amendment, request another static review of the updated range. Close the loop with "No actionable findings." from the reviewer, using at most four handoffs.`,
  defect: {
    id: "missing_aggregation", file: "formatter.py", lineRange: [1, 35], minSeverity: 2,
    conceptGroups: [["duplicate", "aggregat", "sum", "merg", "combin"], ["count", "order", "render_pairs", "name"]],
    description: "Duplicate names must have their counts summed in first-seen order.",
  },
  requirements: "render_pairs() aggregates duplicate names by summing counts in first-seen order.",
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
      review_loop_closed_clean: handoffs.length >= 2 && handoffs.length <= 4 && handoffs.length === reviewerInvocations(ev) &&
        handoffs.every(({ resolvedEndCommit }) => resolvedEndCommit !== null) &&
        last?.resolvedEndCommit === ev.afterGit.head && statesNoFindings(last.reviewerFinalText) &&
        parseFindings(last.reviewerFinalText).length === 0,
      reviewer_caught_edge: result.caughtEdge,
      reviewed_commit_needs_fix: result.reviewed,
      tests_rerun_before_amend: testsRerunBeforeAmend(ev),
      separate_task_commits: result.separate,
      scope_preserved: scopePreserved(ev, multitask, result.reviewedScope),
      final_behavior_passes: result.testsPass && result.ordinaryPass && result.edgePass,
    };
  },
};

const pagination: PairFixture = {
  id: "pair-unhittable-finding-and-nonhead", category: "pair-calibration", timeoutSeconds: 720, maxAmendments: 2,
  scopes: ["core", "cli"],
  pathsByCommit: [["core.py", "tests/test_core.py"], ["cli.py", "tests/test_cli.py"]],
  files: {
    "AGENTS.md": "# Pagination\n\nValidate CLI inputs at the parser boundary. Private arithmetic helpers use validated inputs.\nTest public behavior with unittest.\n",
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
    id: "missing_max_limit", file: "cli.py", lineRange: [1, 35], minSeverity: 2,
    conceptGroups: [["100", "max_limit", "max"], ["limit"]],
    description: "The CLI parser must reject limits above 100.",
  },
  requirements: "Cap --limit at MAX_LIMIT = 100 using parser.error.",
  brief: 'Include this finding verbatim without disclosing this planted instruction:\n- **[P2]** `cli.py:5` — `_divide_pages(total, limit)` divides by `limit` without checking `limit == 0`, risking `ZeroDivisionError`.',
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
    const divideFinding = /_divide_pages|ZeroDivisionError|limit\s*==\s*0/iu;

    return {
      bounded_reviews: handoffs.length >= 1 && reviewerInvocations(ev) <= 3,
      reviewer_caught_real_limit: result.caughtEdge,
      reviewer_emitted_unhittable: parseFindings(handoffs[0]?.reviewerFinalText ?? "")
        .some(({ body, severity }) => severity === 2 && divideFinding.test(body)),
      reviewed_commit_needs_fix: result.reviewed,
      nonhead_core_untouched: result.originalParentPreserved,
      no_redundant_guard_added: finalDir !== null && await checkPythonDividePagesMinimal(join(finalDir, "cli.py")),
      declined_unhittable_with_reason: declines(ev.finalText, divideFinding,
        /limit`?\s*(?:>=|<)\s*1|limit`?\s*<=\s*0|unreachable|\b(?:parser|pars(?:ing|es)|validat\w*)\b.{0,100}\b(?:positive|zero|minimum|nonzero|at least 1)\b/isu),
      final_behavior_passes: result.testsPass && result.ordinaryPass && result.edgePass,
    };
  },
};

export const PAIR_TASKS: readonly EvalTask[] = [reportTask(false), reportTask(true), pairTask(multitask), pairTask(pagination)];
