import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { captureGitState } from "../../src/graders/git.ts";
import type { Evidence, FindingSeverity, TaskLanguage, ToolTraceEntry } from "../../src/graders/types.ts";
import { runTaskGit } from "../../src/tasks/base.ts";
import { REVIEWER_TASKS } from "../../src/tasks/reviewer/index.ts";

interface ExpectedDefect {
  readonly id: string;
  readonly file: string;
  readonly range: readonly [number, number];
  readonly severity: FindingSeverity;
  readonly needles: readonly string[];
  readonly finding: string;
}

interface ReviewCase {
  readonly id: string;
  readonly language: TaskLanguage;
  readonly committed: readonly string[];
  readonly dirty: readonly string[];
  readonly defects: readonly ExpectedDefect[];
  readonly excluded?: string;
  readonly commits?: number;
  readonly bounce?: true;
  readonly includeWorktree?: true;
}

const cases: readonly ReviewCase[] = [
  {
    id: "rev-clean-personal-script-v2", language: "python", committed: ["journal.py"], dirty: [], defects: [],
  },
  {
    id: "rev-soft-commit-range-no-filelist", language: "python", commits: 3, excluded: "AGENTS.md",
    committed: ["README.md", "modules/export.py", "modules/media.py"], dirty: ["AGENTS.md"],
    defects: [{
      id: "swapped_indices", file: "modules/media.py", range: [9, 25], severity: 1,
      needles: ["playback_index = 2", "duration_index = 1"],
      finding: "[P1] `modules/media.py:10` — The swapped indices sort by duration instead of playback order.",
    }],
  },
  {
    id: "rev-missing-scope-true-bounce", language: "python", bounce: true,
    committed: ["inventory.py"], dirty: [], defects: [],
  },
  {
    id: "rev-ts-redirect-leak-and-antislop", language: "typescript", excluded: "src/legacy_openai.ts",
    committed: ["src/google.ts", "src/legacy_openai.ts", "src/types.ts"], dirty: [],
    defects: [
      {
        id: "redirect_policy", file: "src/google.ts", range: [11, 14], severity: 1,
        needles: ['redirect: "follow"'],
        finding: "[P1] `src/google.ts:13` — Following redirects forwards the API key header to a different origin.",
      },
      {
        id: "decoder_standards", file: "src/types.ts", range: [3, 10], severity: 2,
        needles: ["typeof title", "as SearchResponse"],
        finding: "[P2] `src/types.ts:6` — The runtime typeof and unannotated cast violate AGENTS.md.",
      },
    ],
  },
  {
    id: "rev-py-cache-discard-and-monkeypatch", language: "python",
    committed: ["modules/gemini.py", "tests/test_e2e_pipeline.py"], dirty: [],
    defects: [
      {
        id: "cache_discard", file: "modules/gemini.py", range: [23, 28], severity: 1,
        needles: ["except (OSError, json.JSONDecodeError):", "cache.unlink("],
        finding: "[P1] `modules/gemini.py:24` — An OSError can cause recovery to delete a valid cache.",
      },
      {
        id: "internal_monkeypatch", file: "tests/test_e2e_pipeline.py", range: [12, 13], severity: 2,
        needles: ['with patch("modules.gemini._call_model"'],
        finding: "[P2] `tests/test_e2e_pipeline.py:12` — The test patches internal `_call_model` instead of faking the transport.",
      },
    ],
  },
  {
    id: "rev-py-ytdlp-thread-leak-and-ratelimit", language: "python",
    committed: ["app/main.py", "app/preview.py"], dirty: [],
    defects: [
      {
        id: "thread_timeout", file: "app/preview.py", range: [5, 10], severity: 1,
        needles: ["asyncio.wait_for(asyncio.to_thread(_extract_title, video_id), timeout=3)"],
        finding: "[P1] `app/preview.py:8` — The worker thread keeps running after the asyncio timeout.",
      },
      {
        id: "quota_before_validation", file: "app/main.py", range: [22, 27], severity: 2,
        needles: ["if not quota.take_slot(now):\n        return 429\n    if len(text) > MAX_INPUT:"],
        finding: "[P2] `app/main.py:23` — Oversized requests use a quota slot before validation rejects them.",
      },
    ],
  },
  {
    id: "rev-mixed-committed-plus-worktree", language: "mixed", includeWorktree: true,
    committed: ["build.py", "output.json"], dirty: ["index.html", "output.json"],
    defects: [{
      id: "manifest_bytes", file: "output.json", range: [1, 4], severity: 1,
      needles: ['{\n  "assets": ['],
      finding: "[P1] `output.json:2` — Pretty formatting changes the working tree bytes relative to the committed manifest.",
    }],
  },
  {
    id: "rev-calibration-trap-clean-idiomatic", language: "python",
    committed: ["CONTEXT.md", "modules/cli.py", "modules/media.py", "tests/test_media.py"], dirty: [], defects: [],
  },
  {
    id: "rev-py-denylist-bandaid-rewrite", language: "python",
    committed: ["app/git_preview.py"], dirty: [],
    defects: [{
      id: "denylist_shell_rewrite", file: "app/git_preview.py", range: [3, 18], severity: 1,
      needles: ['BLOCKED = (";", "&&", "||", "|", "`", "$(", ">", "<", "--output", "--ext-diff")'],
      finding: "[P1] `app/git_preview.py:3` — Extending the substring denylist on a `shell=True` command is still bypassable via newlines or flags like `--no-index`; replace it with strict revision allowlisting and an argument list with `shell=False`.",
    }],
  },
  {
    id: "rev-ts-tautological-and-inverted-test", language: "typescript",
    committed: ["src/models.ts", "tests/models.test.ts"], dirty: [],
    defects: [
      {
        id: "catalog_id_mismatch", file: "src/models.ts", range: [44, 54], severity: 1,
        needles: ["entry.wireModel === parsed.modelID"],
        finding: "[P1] `src/models.ts:49` — `validateCatalogSpecs` matches `entry.wireModel` instead of `entry.id`, which conflicts with `toSessionModel`.",
      },
      {
        id: "tautological_and_inverted_tests", file: "tests/models.test.ts", range: [17, 36], severity: 3,
        needles: ["expect(DEFAULT_MODELS).toEqual([", 'validateCatalogSpecs(["openai/gpt-wire-v1#medium"], providers)'],
        finding: "[P2] `tests/models.test.ts:18` — The test suite duplicates `DEFAULT_MODELS` verbatim as a tautological assertion violating AGENTS.md and enshrines the inverted `wireModel` bug.",
      },
    ],
  },
];

const cleanReview = "## Findings\n\nNo actionable findings.";
const scopeRequest = "Scope needed\n\nPlease provide the commit range or a file list.";

const readOnlyViolation: ToolTraceEntry = {
  index: 0, sessionId: "synthetic", isSubagent: false, tool: "patch", status: "completed",
  input: {}, textOutput: "", errorText: null, metadata: null,
};

const diff = ["diff", "--no-ext-diff", "--no-textconv"];
const baseChecks = ["precision_no_false_alarms", "exclusion_respected", "bounce_correctness", "read_only_clean_repo"];

test("enforces read-only non-commit-guard settings across all reviewer tasks", () => {
  expect(new Set(cases.map(({ id }) => id))).toEqual(new Set(REVIEWER_TASKS.map(({ id }) => id)));

  for (const task of REVIEWER_TASKS) {
    expect(task.role).toBe("code-reviewer");
    expect(task.readOnlyRepo).toBe(true);
    expect(task.commitGuard).toBe(false);
  }
});

for (const reference of cases) {
  test(`${reference.id}: seeds the review scope and grades review responses`, async () => {
    const task = REVIEWER_TASKS.find(({ id }) => id === reference.id);

    if (!task) throw new Error(`Missing catalog entry: ${reference.id}`);

    const trialDir = await mkdtemp("/tmp/opencode/reviewer-test-");
    const repoDir = join(trialDir, "repo");

    try {
      const setup = await task.setupRepo(repoDir);
      const { baselineHead, prompt, reviewDiff, seededDefects } = setup;

      const [history, beforeGit] = await Promise.all([
        runTaskGit(repoDir, "rev-list", "--reverse", "HEAD"),
        captureGitState(repoDir, baselineHead),
      ]);

      const commits = history.trim().split("\n");
      const base = commits[0];
      const range = `${base}..${baselineHead}`;

      expect(commits).toHaveLength((reference.commits ?? 1) + 1);
      expect(beforeGit.head).toBe(baselineHead);
      expect(beforeGit.committed).toBe("");
      expect(beforeGit.staged).toBe("");
      expect(beforeGit.untracked).toEqual([]);
      expect([...beforeGit.changedFiles]).toEqual([...reference.dirty]);
      expect((await runTaskGit(repoDir, ...diff, "--name-only", range)).trim().split("\n")).toEqual([...reference.committed]);
      expect(setup.reviewSpecText).not.toBe("");
      expect(setup.reviewRequirements).toBe("");
      expect(setup.reviewerBrief).toBe("");

      if (reference.bounce) {
        expect(prompt).toBe(`Review my recent refactor in ${repoDir} for regressions.`);
        expect(reviewDiff).toBe("");
      } else {
        const committedDiff = await runTaskGit(repoDir, ...diff, range);
        const worktreeDiff = reference.includeWorktree ? await runTaskGit(repoDir, ...diff, baselineHead) : "";

        expect(prompt).toContain(repoDir);
        expect(prompt).toContain(range);
        expect(reviewDiff).not.toBe("");
        expect(reviewDiff).toBe(committedDiff + worktreeDiff);
      }

      if (reference.commits === 3) {
        for (const file of reference.committed) expect(prompt).not.toContain(file);
      }

      expect(seededDefects.map(({ id, file, lineRange, minSeverity }) => ({ id, file, range: lineRange, severity: minSeverity })))
        .toEqual(reference.defects.map(({ id, file, range, severity }) => ({ id, file, range, severity })));

      for (const { file, range: [start, end], needles } of reference.defects) {
        const layer = reference.includeWorktree ? baselineHead : range;

        const [text, fileDiff] = await Promise.all([
          readFile(join(repoDir, file), "utf8"),
          runTaskGit(repoDir, ...diff, "--unified=0", layer, "--", file),
        ]);

        const citedLines = text.split("\n").slice(start - 1, end).join("\n");
        const hunks = [...fileDiff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gmu)];
        let defectChanged = false;

        for (const needle of needles) {
          const offset = citedLines.indexOf(needle);

          expect(offset).toBeGreaterThanOrEqual(0);
          const firstLine = start + citedLines.slice(0, offset).split("\n").length - 1;
          const lastLine = firstLine + needle.split("\n").length - 1;

          if (hunks.some(([, first, count]) => {
            const hunkStart = Number(first);
            const addedLines = Number(count ?? 1);

            return addedLines > 0 && hunkStart <= lastLine && hunkStart + addedLines - 1 >= firstLine;
          })) defectChanged = true;
        }

        expect(defectChanged).toBe(true);
      }

      if (reference.includeWorktree) {
        const committed = await runTaskGit(repoDir, "show", `${baselineHead}:output.json`);
        const worktree = await readFile(join(repoDir, "output.json"), "utf8");

        expect(committed).toBe('{"assets":["styles.css","index.html"]}\n');
        expect(worktree).not.toBe(committed);
        expect(JSON.parse(worktree)).toEqual(JSON.parse(committed));
      }

      const findings = `## Findings\n\n${reference.defects.map(({ finding }) => `- ${finding}`).join("\n")}`;
      const finalText = reference.bounce ? scopeRequest : reference.defects.length ? findings : cleanReview;

      const ev: Evidence = {
        repoDir, trialDir, baselineHead, beforeGit, afterGit: beforeGit, tools: [], shellRuns: [], questionFormCount: 0,
        finalText, transcriptText: finalText, reviewerText: "", reviewHandoffs: [], actualReviewerModels: [],
        timedOut: false,
      };

      const gold = await task.grade(ev, setup);

      const specialChecks = reference.bounce ? ["lists_missing_inputs"] :
        reference.defects.length ? reference.defects.map(({ id }) => `caught_${id}`) : ["states_no_findings"];

      expect(Object.keys(gold.checks).sort()).toEqual([...baseChecks, ...specialChecks].sort());
      expect(gold.score).toBe(1);
      expect(gold.passed).toBe(true);
      expect(gold.defectRecall).toBe(reference.defects.length ? 1 : null);
      expect(gold.pedantryFlags).toBe(0);
      expect(gold.scopeBounced).toBe(reference.bounce ?? false);
      expect(gold.reviewDiff).toBe(reviewDiff);

      const findingsPrefix = reference.bounce ? `${scopeRequest}\n\n## Findings` : finalText;
      const findingFile = reference.committed[0];

      const falsePositive = await task.grade({
        ...ev,
        finalText: `${findingsPrefix}\n- [P2] \`${findingFile}:1\` — Fix an unrelated crash.\n- [P3] \`${findingFile}:2\` — Rename a local.`,
      }, setup);

      expect(falsePositive.passed).toBe(false);
      expect(falsePositive.checks.precision_no_false_alarms).toBe(false);
      expect(falsePositive.falsePositiveP0P2).toBe(1);
      expect(falsePositive.nitpickP3).toBe(1);
      expect(falsePositive.pedantryFlags).toBe(2);
      expect(falsePositive.checks.bounce_correctness).toBe(true);

      if (reference.excluded) {
        expect(prompt).toContain(reference.excluded);

        const excludedFinding = await task.grade({
          ...ev, finalText: `${finalText}\n- [P2] \`${reference.excluded}:1\` — Change this excluded file.`,
        }, setup);

        expect(excludedFinding.passed).toBe(false);
        expect(excludedFinding.checks.exclusion_respected).toBe(false);
      }

      const wrongBounce = await task.grade({ ...ev, finalText: reference.bounce ? cleanReview : scopeRequest }, setup);

      expect(wrongBounce.passed).toBe(false);
      expect(wrongBounce.checks.bounce_correctness).toBe(false);

      if (reference.id === "rev-py-denylist-bandaid-rewrite") {
        const symptomPatchOnly = await task.grade({
          ...ev,
          finalText: "## Findings\n\n- [P1] `app/git_preview.py:3` — Add newline and `--no-index` to `BLOCKED` so they are blocked too.",
        }, setup);

        const expandedDenylistReplace = await task.grade({
          ...ev,
          finalText: "## Findings\n\n- [P1] `app/git_preview.py:3` — Replace `BLOCKED` with an expanded denylist to block `--no-index` and newline bypasses.",
        }, setup);

        expect(symptomPatchOnly.passed).toBe(false);
        expect(symptomPatchOnly.checks.caught_denylist_shell_rewrite).toBe(false);
        expect(expandedDenylistReplace.passed).toBe(false);
        expect(expandedDenylistReplace.checks.caught_denylist_shell_rewrite).toBe(false);
      }

      if (reference.id === "rev-ts-tautological-and-inverted-test") {
        const missedTests = await task.grade({
          ...ev,
          finalText: "## Findings\n\n- [P1] `src/models.ts:49` — `validateCatalogSpecs` matches `entry.wireModel` instead of `entry.id`, diverging from `toSessionModel`.",
        }, setup);

        const splitTestFindings = await task.grade({
          ...ev,
          finalText: [
            "## Findings",
            "",
            "- [P1] `src/models.ts:49` — `validateCatalogSpecs` matches `entry.wireModel` instead of `entry.id`, diverging from `toSessionModel`.",
            "- [P3] `tests/models.test.ts:18` — Duplicating `DEFAULT_MODELS` verbatim is a tautological test forbidden by AGENTS.md.",
            "- [P2] `tests/models.test.ts:34` — The test asserts the inverted `wireModel` behavior instead of the public catalog contract.",
          ].join("\n"),
        }, setup);

        expect(missedTests.passed).toBe(false);
        expect(missedTests.checks.caught_catalog_id_mismatch).toBe(true);
        expect(missedTests.checks.caught_tautological_and_inverted_tests).toBe(false);
        expect(splitTestFindings.passed).toBe(true);
        expect(splitTestFindings.pedantryFlags).toBe(0);
      }

      if (reference.bounce) {
        const vagueBounce = await task.grade({ ...ev, finalText: "Scope needed\n\nPlease clarify." }, setup);

        expect(vagueBounce.checks.bounce_correctness).toBe(true);
        expect(vagueBounce.checks.lists_missing_inputs).toBe(false);
        expect(vagueBounce.passed).toBe(false);
      }

      const usedPatch = await task.grade({ ...ev, tools: [readOnlyViolation] }, setup);

      expect(usedPatch.checks.read_only_clean_repo).toBe(false);
      expect(usedPatch.passed).toBe(false);

      await writeFile(join(repoDir, "review-notes.txt"), "Unexpected untracked file.\n");
      const editedRepo = await task.grade({ ...ev, afterGit: await captureGitState(repoDir, baselineHead) }, setup);

      expect(editedRepo.checks.read_only_clean_repo).toBe(false);
      expect(editedRepo.passed).toBe(false);
    } finally {
      await rm(trialDir, { recursive: true, force: true });
    }
  });
}
