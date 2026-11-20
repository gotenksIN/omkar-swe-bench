import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { captureGitState } from "../../src/graders/git.ts";
import type {
  Evidence,
  FindingSeverity,
  TaskLanguage,
} from "../../src/graders/types.ts";
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
    id: "rev-clean-personal-script",
    language: "python",
    committed: ["journal.py"],
    dirty: [],
    defects: [],
  },
  {
    id: "rev-soft-commit-range-no-filelist",
    language: "python",
    commits: 3,
    excluded: "AGENTS.md",
    committed: ["README.md", "modules/export.py", "modules/media.py"],
    dirty: ["AGENTS.md"],
    defects: [
      {
        id: "swapped_indices",
        file: "modules/media.py",
        range: [9, 25],
        severity: 1,
        needles: ["playback_index = 2", "duration_index = 1"],
        finding:
          "[P1] `modules/media.py:10` — The swapped indices sort by duration instead of playback order.",
      },
    ],
  },
  {
    id: "rev-missing-scope-true-bounce",
    language: "python",
    bounce: true,
    commits: 4,
    committed: ["cache.py", "http_retry.py", "parser.py", "table.py"],
    dirty: ["storage.py"],
    defects: [],
  },
  {
    id: "rev-ts-redirect-leak-and-antislop",
    language: "typescript",
    excluded: "src/legacy_openai.ts",
    committed: ["src/google.ts", "src/legacy_openai.ts", "src/types.ts"],
    dirty: [],
    defects: [
      {
        id: "redirect_policy",
        file: "src/google.ts",
        range: [11, 14],
        severity: 1,
        needles: ['redirect: "follow"'],
        finding:
          "[P1] `src/google.ts:13` — Following redirects forwards the API key header to a different origin.",
      },
      {
        id: "decoder_standards_cast",
        file: "src/types.ts",
        range: [3, 6],
        severity: 3,
        needles: ["as SearchResponse"],
        finding:
          "[P3] `src/types.ts:4` — The unannotated `as SearchResponse` cast violates AGENTS.md.",
      },
      {
        id: "decoder_standards_typeof",
        file: "src/types.ts",
        range: [5, 10],
        severity: 3,
        needles: ["typeof title"],
        finding:
          "[P3] `src/types.ts:6` — The runtime `typeof` check violates AGENTS.md.",
      },
    ],
  },
  {
    id: "rev-py-cache-discard-and-monkeypatch",
    language: "python",
    committed: ["modules/gemini.py", "tests/test_e2e_pipeline.py"],
    dirty: [],
    defects: [
      {
        id: "cache_discard",
        file: "modules/gemini.py",
        range: [23, 28],
        severity: 2,
        needles: ["except (OSError, json.JSONDecodeError):", "cache.unlink("],
        finding:
          "[P2] `modules/gemini.py:24` — A read error can cause recovery to delete a valid cache.",
      },
      {
        id: "internal_monkeypatch",
        file: "tests/test_e2e_pipeline.py",
        range: [22, 23],
        severity: 2,
        needles: ['with patch("modules.gemini._call_model"'],
        finding:
          "[P2] `tests/test_e2e_pipeline.py:22` — The test patches internal `_call_model` instead of faking the transport.",
      },
    ],
  },
  {
    id: "rev-py-ytdlp-thread-leak-and-ratelimit",
    language: "python",
    committed: ["app/main.py", "app/preview.py"],
    dirty: [],
    defects: [
      {
        id: "thread_timeout",
        file: "app/preview.py",
        range: [5, 10],
        severity: 2,
        needles: [
          "asyncio.wait_for(asyncio.to_thread(_extract_title, video_id), timeout=3)",
        ],
        finding:
          "[P2] `app/preview.py:8` — The worker thread keeps running after the asyncio timeout.",
      },
      {
        id: "quota_before_validation",
        file: "app/main.py",
        range: [22, 27],
        severity: 2,
        needles: [
          "if not quota.take_slot(now):\n        return 429\n    if len(text) > MAX_INPUT:",
        ],
        finding:
          "[P2] `app/main.py:23` — Oversized requests use a quota slot before validation rejects them.",
      },
    ],
  },
  {
    id: "rev-mixed-committed-plus-worktree",
    language: "mixed",
    includeWorktree: true,
    committed: ["build.py", "output.json"],
    dirty: ["index.html", "output.json"],
    defects: [
      {
        id: "manifest_bytes",
        file: "output.json",
        range: [1, 4],
        severity: 1,
        needles: ['{\n  "assets": ['],
        finding:
          "[P1] `output.json:2` — Pretty formatting changes the working tree bytes relative to the committed manifest.",
      },
    ],
  },
  {
    id: "rev-calibration-trap-clean-idiomatic",
    language: "python",
    committed: [
      "CONTEXT.md",
      "modules/cli.py",
      "modules/media.py",
      "tests/test_media.py",
    ],
    dirty: [],
    defects: [],
  },
  {
    id: "rev-py-denylist-bandaid-rewrite",
    language: "python",
    committed: ["app/git_preview.py"],
    dirty: [],
    defects: [
      {
        id: "denylist_shell_rewrite",
        file: "app/git_preview.py",
        range: [3, 18],
        severity: 1,
        needles: [
          'BLOCKED = (";", "&&", "||", "|", "`", "$(", ">", "<", "--output", "--ext-diff")',
        ],
        finding:
          "[P1] `app/git_preview.py:3` — Extending the substring denylist on a `shell=True` command is still bypassable via newlines or flags like `--no-index`; replace it with strict revision allowlisting and an argument list with `shell=False`.",
      },
    ],
  },
  {
    id: "rev-ts-tautological-and-inverted-test",
    language: "typescript",
    committed: ["src/models.ts", "tests/models.test.ts"],
    dirty: [],
    defects: [
      {
        id: "catalog_id_mismatch",
        file: "src/models.ts",
        range: [44, 54],
        severity: 1,
        needles: ["entry.wireModel === parsed.modelID"],
        finding:
          "[P1] `src/models.ts:49` — `validateCatalogSpecs` matches `entry.wireModel` instead of `entry.id`, which conflicts with `toSessionModel`.",
      },
      {
        id: "tautological_literal_test",
        file: "tests/models.test.ts",
        range: [15, 28],
        severity: 3,
        needles: ["expect(DEFAULT_MODELS).toEqual(["],
        finding:
          "[P3] `tests/models.test.ts:18` — The test suite duplicates `DEFAULT_MODELS` verbatim as a tautological assertion violating AGENTS.md.",
      },
      {
        id: "inverted_wiremodel_test",
        file: "tests/models.test.ts",
        range: [28, 38],
        severity: 3,
        needles: [
          'validateCatalogSpecs(["openai/gpt-wire-v1#medium"], providers)',
        ],
        finding:
          "[P2] `tests/models.test.ts:34` — The test enshrines the inverted `wireModel` bug instead of asserting the public contract.",
      },
    ],
  },
  {
    id: "rev-py-clean-security-rewrite-restraint",
    language: "python",
    committed: ["app/git_preview.py", "tests/test_git_preview.py"],
    dirty: [],
    defects: [],
  },
  {
    id: "rev-ts-snapshot-formatter-rce-and-sections",
    language: "typescript",
    committed: [
      "src/craft-runner.ts",
      "src/diagnostics.ts",
      "tests/craft-runner.test.ts",
    ],
    dirty: [],
    defects: [
      {
        id: "formatter_rce_and_symlink",
        file: "src/craft-runner.ts",
        range: [32, 44],
        severity: 1,
        needles: ["existsSync(", 'return [oxfmtBin, "--write", ...existing]'],
        finding:
          "[P1] `src/craft-runner.ts:35` — Invoking oxfmt without `--disable-nested-config` or `--` and using `existsSync` allows nested-config RCE, flag injection, and symlink overwrites.",
      },
      {
        id: "untracked_section_prefix",
        file: "src/craft-runner.ts",
        range: [9, 30],
        severity: 2,
        needles: ['else if (line === "Untracked:")'],
        finding:
          '[P2] `src/craft-runner.ts:20` — Checking `line === "Untracked:"` instead of `startsWith` leaves `git-summary.ts` untracked lines in the unstaged patch and breaks `git apply`.',
      },
      {
        id: "diagnostics_relative_cwd",
        file: "src/diagnostics.ts",
        range: [8, 16],
        severity: 2,
        needles: ["nodePath.relative(repoDir, issue.filename)"],
        finding:
          "[P2] `src/diagnostics.ts:12` — `nodePath.relative(repoDir, issue.filename)` resolves relative diagnostic filenames against host `process.cwd()` instead of `repoDir`.",
      },
    ],
  },
  {
    id: "rev-ts-quiescence-deadlock-and-preflight-leak",
    language: "typescript",
    committed: ["src/poller.ts", "src/preflight.ts", "tests/poller.test.ts"],
    dirty: [],
    defects: [
      {
        id: "preflight_daemon_leak",
        file: "src/preflight.ts",
        range: [7, 19],
        severity: 2,
        needles: ["await Promise.all("],
        finding:
          "[P1] `src/preflight.ts:8` — `Promise.all` leaks sibling detached daemon processes and token files on early rejection because `controller.shutdown()` never aborts `signal`.",
      },
      {
        id: "quiescence_deadlock",
        file: "src/poller.ts",
        range: [17, 25],
        severity: 1,
        needles: ["ctx.state.inboxPendingAt = ctx.state.generation;"],
        finding:
          "[P1] `src/poller.ts:20` — Setting `inboxPendingAt = generation` while `active` holds causes a permanent quiescence deadlock after `activeSessions` clears without incrementing `generation`.",
      },
      {
        id: "async_poll_recursion",
        file: "src/poller.ts",
        range: [26, 44],
        severity: 3,
        needles: ["return await waitForQuiescence(ctx, deadlineMs, signal);"],
        finding:
          "[P3] `src/poller.ts:43` — Recursive `return await waitForQuiescence(...)` retains O(N) async stack frames instead of using an iterative loop.",
      },
    ],
  },
  {
    id: "rev-ts-sandbox-mount-and-transitive-types",
    language: "typescript",
    committed: ["src/mounts.ts", "src/ts-fixture.ts", "tests/mounts.test.ts"],
    dirty: [],
    defects: [
      {
        id: "missing_bun_types_mount",
        file: "src/mounts.ts",
        range: [1, 5],
        severity: 1,
        needles: ['"@types/bun"'],
        finding:
          '[P1] `src/mounts.ts:3` — Mounting `@types/bun` without transitive `bun-types` breaks `tsc` when `src/ts-fixture.ts` sets `types: ["bun"]`.',
      },
      {
        id: "forbidden_mount_regex_gap",
        file: "src/mounts.ts",
        range: [6, 9],
        severity: 2,
        needles: ["/(?:^|\\/)(?:oxlint|oxfmt|@oxlint|ultracite)(?:\\/|$)/u"],
        finding:
          "[P2] `src/mounts.ts:7` — The segment-bounded `FORBIDDEN_HARNESS_MOUNT` regex misses `oxlint.config.ts` and scoped `@oxfmt/*` / `@oxlint-tsgolint/*` packages.",
      },
    ],
  },
  {
    id: "rev-py-zsh-path-tie-and-empty-pdf-cache",
    language: "mixed",
    committed: [
      "archive/sync.py",
      "scripts/fetch_archive.zsh",
      "tests/test_sync.py",
    ],
    dirty: [],
    defects: [
      {
        id: "zsh_path_clobber",
        file: "scripts/fetch_archive.zsh",
        range: [4, 12],
        severity: 1,
        needles: ["for path in "],
        finding:
          "[P1] `scripts/fetch_archive.zsh:5` — Using `for path in ...` in zsh overwrites the tied `path`/`PATH` array and breaks `python3` with command not found.",
      },
      {
        id: "empty_pdf_clobber",
        file: "archive/sync.py",
        range: [6, 24],
        severity: 1,
        needles: [
          'content_type != "application/pdf"',
          "os.replace(tmp_name, dest)",
        ],
        finding:
          "[P1] `archive/sync.py:12` — Replacing cached PDFs without checking `%PDF-` magic bytes and non-zero size clobbers valid cached files with 0-byte or HTML bodies.",
      },
    ],
  },
  {
    id: "rev-ts-multi-module-clean-restraint",
    language: "typescript",
    committed: [
      "src/git-guard.ts",
      "src/parser.ts",
      "src/runner.ts",
      "src/span.ts",
      "tests/runner.test.ts",
    ],
    dirty: [],
    defects: [],
  },
  {
    id: "rev-py-four-commit-net-diff-and-iter-mutation",
    language: "python",
    commits: 4,
    committed: ["store/evict.py", "store/tx.py", "tests/test_store.py"],
    dirty: [],
    defects: [
      {
        id: "tx_partial_rollback",
        file: "store/tx.py",
        range: [1, 6],
        severity: 1,
        needles: ["entries[key] = value"],
        finding:
          "[P1] `store/tx.py:5` — Mutating `entries` in place without rollback leaves partial writes behind when a later update raises `ValueError`.",
      },
      {
        id: "evict_dict_mutation",
        file: "store/evict.py",
        range: [4, 15],
        severity: 1,
        needles: ["del cache.entries[key]"],
        finding:
          "[P1] `store/evict.py:8` — Deleting from `cache.entries` during dict iteration raises `RuntimeError: dictionary changed size during iteration`.",
      },
    ],
  },
];

const cleanReview = "## Findings\n\nNo actionable findings.";

const scopeRequest =
  "Scope needed\n\nPlease provide the commit range or a file list.";

const diff = ["diff", "--no-ext-diff", "--no-textconv"];

const baseChecks = [
  "precision_no_false_alarms",
  "exclusion_respected",
  "bounce_correctness",
  "read_only_clean_repo",
];

const verifySeededDefectsInDiff = async (
  repoDir: string,
  layer: string,
  defects: readonly (typeof cases)[number]["defects"][number][]
): Promise<void> => {
  await Promise.all(
    defects.map(async ({ file, range: [start, end], needles }) => {
      const [text, fileDiff] = await Promise.all([
        readFile(path.join(repoDir, file), "utf-8"),
        runTaskGit(repoDir, ...diff, "--unified=0", layer, "--", file),
      ]);

      const citedLines = text
        .split("\n")
        .slice(start - 1, end)
        .join("\n");

      const hunks = [
        ...fileDiff.matchAll(
          /^@@ -\d+(?:,\d+)? \+(?<first>\d+)(?:,(?<count>\d+))? @@/gmu
        ),
      ];

      let defectChanged = false;

      for (const needle of needles) {
        const offset = citedLines.indexOf(needle);

        expect(offset).toBeGreaterThanOrEqual(0);

        const firstLine =
          start + citedLines.slice(0, offset).split("\n").length - 1;

        const lastLine = firstLine + needle.split("\n").length - 1;

        if (
          hunks.some((match) => {
            const hunkStart = Number(match.groups?.first);
            const addedLines = Number(match.groups?.count ?? 1);

            return (
              addedLines > 0 &&
              hunkStart <= lastLine &&
              hunkStart + addedLines - 1 >= firstLine
            );
          })
        ) {
          defectChanged = true;
        }
      }

      expect(defectChanged).toBe(true);
    })
  );
};

const expectedReviewText = (
  reference: (typeof cases)[number],
  findings: string
): string => {
  if (reference.bounce) {
    return scopeRequest;
  }

  return reference.defects.length > 0 ? findings : cleanReview;
};

const expectedSpecialChecks = (reference: (typeof cases)[number]): string[] => {
  if (reference.bounce) {
    return ["lists_missing_inputs"];
  }

  return reference.defects.length > 0
    ? reference.defects.map(({ id }) => `caught_${id}`)
    : ["states_no_findings"];
};

const casesById = new Map(cases.map((entry) => [entry.id, entry]));

for (const task of REVIEWER_TASKS) {
  test(`${task.id}: seeds the review scope and grades review responses`, async () => {
    const reference = casesById.get(task.id);

    if (!reference) {
      throw new Error(`Missing review test case: ${task.id}`);
    }

    expect(task.readOnlyRepo).toBe(true);

    const trialDir = await mkdtemp("/tmp/opencode/reviewer-test-");
    const repoDir = path.join(trialDir, "repo");

    try {
      const setup = await task.setupRepo(repoDir);
      const { baselineHead, prompt, reviewDiff, seededDefects } = setup;

      const [history, beforeGit] = await Promise.all([
        runTaskGit(repoDir, "rev-list", "--reverse", "HEAD"),
        captureGitState(repoDir, baselineHead),
      ]);

      const commits = history.trim().split("\n");
      const [base] = commits;
      const range = `${base}..${baselineHead}`;

      expect(commits).toHaveLength((reference.commits ?? 1) + 1);
      expect(beforeGit.head).toBe(baselineHead);
      expect(beforeGit.committed).toBe("");
      expect(beforeGit.staged).toBe("");
      expect(beforeGit.untracked).toEqual([]);
      expect([...beforeGit.changedFiles]).toEqual([...reference.dirty]);

      const changedNames = await runTaskGit(
        repoDir,
        ...diff,
        "--name-only",
        range
      );

      expect(changedNames.trim().split("\n")).toEqual([...reference.committed]);
      expect(setup.reviewSpecText).not.toBe("");
      expect(setup.reviewRequirements).toBe("");
      expect(setup.reviewerBrief).toBe("");

      if (reference.bounce) {
        expect(prompt).toBe(
          `Review my refactor in ${repoDir} for regressions.`
        );
        expect(reviewDiff).toBe("");
      } else {
        const committedDiff = await runTaskGit(repoDir, ...diff, range);

        const worktreeDiff = reference.includeWorktree
          ? await runTaskGit(repoDir, ...diff, baselineHead)
          : "";

        expect(prompt).toContain(repoDir);
        expect(prompt).toContain(range);
        expect(reviewDiff).not.toBe("");
        expect(reviewDiff).toBe(committedDiff + worktreeDiff);
      }

      if (reference.commits === 3) {
        for (const file of reference.committed) {
          expect(prompt).not.toContain(file);
        }
      }

      expect(
        seededDefects.map(({ id, file, lineRange, minSeverity }) => ({
          id,
          file,
          range: lineRange,
          severity: minSeverity,
        }))
      ).toEqual(
        reference.defects.map(({ id, file, range: defectRange, severity }) => ({
          id,
          file,
          range: defectRange,
          severity,
        }))
      );

      await verifySeededDefectsInDiff(
        repoDir,
        reference.includeWorktree ? baselineHead : range,
        reference.defects
      );

      if (reference.includeWorktree) {
        const committed = await runTaskGit(
          repoDir,
          "show",
          `${baselineHead}:output.json`
        );

        const worktree = await readFile(
          path.join(repoDir, "output.json"),
          "utf-8"
        );

        expect(committed).toBe('{"assets":["styles.css","index.html"]}\n');
        expect(worktree).not.toBe(committed);
        expect(JSON.parse(worktree)).toEqual(JSON.parse(committed));
      }

      const findings = `## Findings\n\n${reference.defects.map(({ finding }) => `- ${finding}`).join("\n")}`;
      const finalText = expectedReviewText(reference, findings);

      const ev: Evidence = {
        repoDir,
        trialDir,
        baselineHead,
        beforeGit,
        afterGit: beforeGit,
        tools: [],
        shellRuns: [],
        questionFormCount: 0,
        finalText,
        transcriptText: finalText,
        reviewerText: "",
        reviewHandoffs: [],
        actualReviewerModels: [],
        timedOut: false,
      };

      const gold = await task.grade(ev, setup);
      const specialChecks = expectedSpecialChecks(reference);

      expect(Object.keys(gold.checks).toSorted()).toEqual(
        [...baseChecks, ...specialChecks].toSorted()
      );
      expect(gold.score).toBe(1);
      expect(gold.passed).toBe(true);
      expect(gold.defectRecall).toBe(reference.defects.length ? 1 : null);
      expect(gold.pedantryFlags).toBe(0);
      expect(gold.scopeBounced).toBe(reference.bounce ?? false);
      expect(gold.reviewDiff).toBe(reviewDiff);

      if (reference.excluded !== undefined && reference.excluded.length > 0) {
        expect(prompt).toContain(reference.excluded);

        const excludedFinding = await task.grade(
          {
            ...ev,
            finalText: `${finalText}\n- [P2] \`${reference.excluded}:1\` — Change this excluded file.`,
          },
          setup
        );

        expect(excludedFinding.passed).toBe(false);
        expect(excludedFinding.checks.exclusion_respected).toBe(false);
      }

      if (reference.id === "rev-py-denylist-bandaid-rewrite") {
        const symptomPatchOnly = await task.grade(
          {
            ...ev,
            finalText:
              "## Findings\n\n- [P1] `app/git_preview.py:3` — Add newline and `--no-index` to `BLOCKED` so they are blocked too.",
          },
          setup
        );

        const expandedDenylistReplace = await task.grade(
          {
            ...ev,
            finalText:
              "## Findings\n\n- [P1] `app/git_preview.py:3` — Replace `BLOCKED` with an expanded denylist to block `--no-index` and newline bypasses.",
          },
          setup
        );

        expect(symptomPatchOnly.passed).toBe(false);
        expect(symptomPatchOnly.checks.caught_denylist_shell_rewrite).toBe(
          false
        );
        expect(expandedDenylistReplace.passed).toBe(false);
        expect(
          expandedDenylistReplace.checks.caught_denylist_shell_rewrite
        ).toBe(false);
      }

      if (reference.id === "rev-ts-sandbox-mount-and-transitive-types") {
        const unscopedFinding = await task.grade(
          {
            ...ev,
            finalText:
              "## Findings\n\n- [P2] `src/mounts.ts:7` — `FORBIDDEN_HARNESS_MOUNT` misses `oxlint-tsgolint` and `.oxlintrc.json` due to whole-segment regex matching.",
          },
          setup
        );

        expect(unscopedFinding.checks.caught_forbidden_mount_regex_gap).toBe(
          true
        );
      }

      if (reference.id === "rev-ts-tautological-and-inverted-test") {
        const missedTests = await task.grade(
          {
            ...ev,
            finalText:
              "## Findings\n\n- [P1] `src/models.ts:49` — `validateCatalogSpecs` matches `entry.wireModel` instead of `entry.id`, diverging from `toSessionModel`.",
          },
          setup
        );

        const splitTestFindings = await task.grade(
          {
            ...ev,
            finalText: [
              "## Findings",
              "",
              "- [P1] `src/models.ts:49` — `validateCatalogSpecs` matches `entry.wireModel` instead of `entry.id`, diverging from `toSessionModel`.",
              "- [P3] `tests/models.test.ts:18` — Duplicating `DEFAULT_MODELS` verbatim is a tautological test forbidden by AGENTS.md.",
              "- [P2] `tests/models.test.ts:34` — The test asserts the inverted `wireModel` behavior instead of the public catalog contract.",
            ].join("\n"),
          },
          setup
        );

        expect(missedTests.passed).toBe(false);
        expect(missedTests.checks.caught_catalog_id_mismatch).toBe(true);
        expect(missedTests.checks.caught_tautological_literal_test).toBe(false);
        expect(missedTests.checks.caught_inverted_wiremodel_test).toBe(false);
        expect(splitTestFindings.passed).toBe(true);
        expect(splitTestFindings.pedantryFlags).toBe(0);
      }
    } finally {
      await rm(trialDir, { recursive: true, force: true });
    }
  });
}
