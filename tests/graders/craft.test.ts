import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import { runCli } from "../../src/cli.ts";
import {
  analyzeTrialCodeCraft,
  analyzeTrialsCodeCraft,
  renderCraftMarkdown,
  splitGitDiffSections,
} from "../../src/graders/craft.ts";
import { captureGitState } from "../../src/graders/git.ts";
import type { TrialResult } from "../../src/runner/types.ts";
import { runTaskGit } from "../../src/tasks/base.ts";
import { TASKS_BY_ID } from "../../src/tasks/index.ts";
import {
  isJsonArray,
  isJsonObject,
  parseJsonText,
} from "../../src/util/json.ts";

let workspace = "";

beforeAll(async () => {
  await mkdir("/tmp/opencode", { recursive: true });
  workspace = await mkdtemp("/tmp/opencode/craft-test-");
});

afterAll(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
  }
});

const zeroTokens = {
  input_tokens: 0,
  output_tokens: 0,
  reasoning_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
};

const makeTrial = (overrides: Partial<TrialResult> = {}): TrialResult => ({
  ...zeroTokens,
  task_id: "coder-ts-sse-chunk-crlf",
  role: "coder",
  category: "typescript",
  model: "openai/gpt-6.2-sol#medium",
  reviewer_model: null,
  repetition: 1,
  repo_dir: "/tmp/repo",
  agent_profile: "default",
  session_id: "ses_test",
  sandboxed: true,
  timed_out: false,
  wall_s: 12,
  subagent_tokens: zeroTokens,
  root_cost_usd: 0.05,
  subagent_cost_usd: 0,
  retry_cost_usd: 0,
  total_cost_usd: 0.05,
  steps: 2,
  first_ttfrt_s: 0.4,
  median_ttfrt_s: 0.4,
  first_ttfvt_s: 0.6,
  median_ttfvt_s: 0.6,
  output_decode_tok_per_s: 40,
  total_model_tok_per_s: 40,
  reasoning_share: 0,
  cache_hit_ratio: 0,
  tool_calls: 2,
  tool_errors: 0,
  subagent_tool_errors: 0,
  outer_retries: 0,
  retries: 0,
  exit_code: 0,
  partial: false,
  passed: true,
  score: 1,
  checks: { bun_tests_pass: true },
  notes: [],
  pedantry_flags: 0,
  false_positive_p0_p2: 0,
  nitpick_p3: 0,
  severity_overstated: 0,
  defect_recall: null,
  precision: null,
  scope_bounced: false,
  blocker_disclosed: null,
  final_text: "Done.",
  transcript_text: "Done.",
  reviewer_text: "",
  review_spec: "",
  review_diff: null,
  planted_brief: "",
  task_spec: "",
  seeded_defects: [],
  git_diff: "",
  error_message: null,
  ...overrides,
});

const buildTaskDiff = async (
  taskId: string,
  mutate: (repoDir: string) => Promise<void>
): Promise<string> => {
  const repoDir = await mkdtemp(nodePath.join(workspace, `${taskId}-`));
  const task = TASKS_BY_ID.get(taskId);

  if (task === undefined) {
    throw new Error(`Unknown task ${taskId}`);
  }

  try {
    const setup = await task.setupRepo(repoDir);
    await mutate(repoDir);
    const gitState = await captureGitState(repoDir, setup.baselineHead);
    const parts: string[] = [];

    if (gitState.committed.trim().length > 0) {
      parts.push(`## Committed\n${gitState.committed.trim()}`);
    }

    if (gitState.staged.trim().length > 0) {
      parts.push(`## Staged\n${gitState.staged.trim()}`);
    }

    if (gitState.unstaged.trim().length > 0) {
      parts.push(`## Unstaged\n${gitState.unstaged.trim()}`);
    }

    return `${parts.join("\n\n")}\n`;
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
};

test("splitGitDiffSections splits multi-stage diff sections and skips Untracked summaries", () => {
  const raw = [
    "## Committed",
    "diff --git a/a.py b/a.py",
    "@@ -1 +1 @@",
    "-x = 1",
    "+x = 2",
    "## Staged",
    "diff --git a/b.py b/b.py",
    "@@ -1 +1 @@",
    "-y = 1",
    "+y = 2",
    "## Unstaged",
    "diff --git a/c.py b/c.py",
    "@@ -1 +1 @@",
    "-z = 1",
    "+z = 2",
    "Untracked: tmp.txt",
    "diff --git a/d.py b/d.py",
  ].join("\n");

  const sections = splitGitDiffSections(raw);

  expect(sections).toHaveLength(4);
  expect(sections[0]).toContain("diff --git a/a.py b/a.py");
  expect(sections[1]).toContain("diff --git a/b.py b/b.py");
  expect(sections[2]).toContain("diff --git a/c.py b/c.py");
  expect(sections[2]).not.toContain("Untracked:");
  expect(sections[3]).toContain("diff --git a/d.py b/d.py");
});

test("analyzeTrialCodeCraft cancels pre-seeded unstaged edits and applies multi-stage Python diffs", async () => {
  const gitDiff = await buildTaskDiff(
    "coder-git-commit-guard-two-task",
    async (repoDir) => {
      await writeFile(
        nodePath.join(repoDir, "slug.py"),
        "def slugify(text: str) -> str:\n    return text.strip().lower().replace(' ', '-')\n"
      );
      await runTaskGit(repoDir, "add", "slug.py");
      await runTaskGit(
        repoDir,
        "commit",
        "-m",
        "slug: Normalize whitespace in slugify"
      );
      await writeFile(
        nodePath.join(repoDir, "slug.py"),
        "def slugify(text: str) -> str:\n    cleaned = '-'.join(text.strip().lower().split())\n    return cleaned\n"
      );
    }
  );

  expect(gitDiff).toContain("NOTES.md");

  const metrics = await analyzeTrialCodeCraft(
    makeTrial({
      task_id: "coder-git-commit-guard-two-task",
      category: "git",
      git_diff: gitDiff,
    })
  );

  expect(metrics).not.toBeNull();
  expect(metrics?.language).toBe("python");
  expect(metrics?.changedFiles).toEqual(["slug.py"]);
  expect(metrics?.prodFiles).toEqual(["slug.py"]);
  expect(metrics?.addedProdLines).toBeGreaterThan(0);
  expect(metrics?.normalizedAddedProdLines).toBeGreaterThan(0);
});

test("analyzeTrialCodeCraft scores touched TypeScript lines and rejects symlink patches", async () => {
  const tsDiff = await buildTaskDiff(
    "coder-ts-sse-chunk-crlf",
    async (repoDir) => {
      await writeFile(
        nodePath.join(repoDir, "src/merge.ts"),
        [
          "interface Part {",
          "  readonly index: number;",
          "  readonly text: string;",
          "}",
          "",
          "export function mergeChunk(parts: string[], chunk: readonly Part[]): void {",
          "  for (const part of chunk) parts[part.index] = part.text;",
          "}",
          "",
          "export function citedText(parts: readonly string[], part: number, start: number, end: number): string {",
          "  return parts[part]?.slice(start, end) ?? '';",
          "}",
          "",
        ].join("\n")
      );
      await writeFile(
        nodePath.join(repoDir, ".oxlintrc.json"),
        '{"rules":{"no-console":"off"}}\n'
      );
    }
  );

  const metrics = await analyzeTrialCodeCraft(
    makeTrial({
      task_id: "coder-ts-sse-chunk-crlf",
      git_diff: tsDiff,
    })
  );

  expect(metrics).not.toBeNull();
  expect(metrics?.language).toBe("typescript");
  expect(metrics?.prodFiles).toEqual(["src/merge.ts"]);
  expect(metrics?.rawCurlyViolations).toBeGreaterThan(0);
  expect(metrics?.rawFormatChurnLines).toBeGreaterThan(0);

  const symlinkPatch = [
    "diff --git a/src/link.ts b/src/link.ts",
    "new file mode 120000",
    "index 0000000..1111111",
    "--- /dev/null",
    "+++ b/src/link.ts",
    "@@ -0,0 +1 @@",
    "+/etc/passwd",
    "\\ No newline at end of file",
  ].join("\n");

  expect(
    await analyzeTrialCodeCraft(
      makeTrial({
        task_id: "coder-ts-sse-chunk-crlf",
        git_diff: symlinkPatch,
      })
    )
  ).toBeNull();

  expect(
    await analyzeTrialCodeCraft(
      makeTrial({
        role: "code-reviewer",
        git_diff: tsDiff,
      })
    )
  ).toBeNull();

  expect(
    await analyzeTrialCodeCraft(
      makeTrial({
        partial: true,
        git_diff: tsDiff,
      })
    )
  ).toBeNull();

  expect(
    await analyzeTrialCodeCraft(
      makeTrial({
        checks: { dry_run_fixture_ready: true },
        git_diff: tsDiff,
      })
    )
  ).toBeNull();
});

test("analyzeTrialsCodeCraft and craft CLI filter passing trials by default and anchor medians to passing trials under --all", async () => {
  const shortDiff = await buildTaskDiff(
    "coder-ts-sse-chunk-crlf",
    async (repoDir) => {
      await writeFile(
        nodePath.join(repoDir, "src/merge.ts"),
        [
          "interface Part {",
          "  readonly index: number;",
          "  readonly text: string;",
          "}",
          "",
          "export function mergeChunk(parts: string[], chunk: readonly Part[]): void {",
          "  for (const part of chunk) {",
          "    parts[part.index] = part.text;",
          "  }",
          "}",
          "",
          "export function citedText(parts: readonly string[], part: number, start: number, end: number): string {",
          '  return parts[part]?.slice(start, end) ?? "";',
          "}",
          "",
        ].join("\n")
      );
    }
  );

  const longDiff = await buildTaskDiff(
    "coder-ts-sse-chunk-crlf",
    async (repoDir) => {
      await writeFile(
        nodePath.join(repoDir, "src/merge.ts"),
        [
          "interface Part {",
          "  readonly index: number;",
          "  readonly text: string;",
          "}",
          "",
          "export function mergeChunk(parts: string[], chunk: readonly Part[]): void {",
          "  for (const part of chunk) {",
          "    const target = part.index;",
          "    const value = part.text;",
          "    parts[target] = value;",
          "  }",
          "}",
          "",
          "export function citedText(parts: readonly string[], part: number, start: number, end: number): string {",
          "  const chunk = parts[part];",
          "  if (chunk === undefined) {",
          '    return "";',
          "  }",
          "  return chunk.slice(start, end);",
          "}",
          "",
        ].join("\n")
      );
    }
  );

  const trials: TrialResult[] = [
    makeTrial({
      model: "openai/gpt-6.2-sol#medium",
      passed: true,
      git_diff: shortDiff,
    }),
    makeTrial({
      model: "anthropic/claude-opus-5-5#medium",
      passed: false,
      git_diff: longDiff,
    }),
  ];

  const passingOnly = await analyzeTrialsCodeCraft(trials);

  expect(passingOnly.trials).toHaveLength(1);
  expect(passingOnly.trials[0]?.model).toBe("openai/gpt-6.2-sol#medium");

  const withFailing = await analyzeTrialsCodeCraft(trials, {
    passingOnly: false,
  });

  expect(withFailing.trials).toHaveLength(2);
  const passingEntry = withFailing.trials.find((entry) => entry.passed);
  const failingEntry = withFailing.trials.find((entry) => !entry.passed);

  expect(passingEntry?.taskMedianProdLines).toBe(
    passingEntry?.metrics.normalizedAddedProdLines
  );
  expect(failingEntry?.taskMedianProdLines).toBe(
    passingEntry?.taskMedianProdLines
  );
  expect(failingEntry?.logDiffExpansionRatio ?? 0).toBeGreaterThan(0);

  const markdown = renderCraftMarkdown(withFailing);

  expect(markdown).toContain("GPT-6.2 Sol (medium)");
  expect(markdown).toContain("Claude Opus 5.5 (medium)");

  const resultsPath = nodePath.join(workspace, "craft-results.json");
  const jsonOut = nodePath.join(workspace, "craft-out.json");
  const mdOut = nodePath.join(workspace, "craft-out.md");

  await writeFile(resultsPath, JSON.stringify(trials));

  expect(
    await runCli(["craft", "--input", resultsPath, "--out", jsonOut])
  ).toBe(0);
  const jsonReport = parseJsonText(await readFile(jsonOut, "utf-8"));
  expect(
    isJsonObject(jsonReport) && isJsonArray(jsonReport.trials)
      ? jsonReport.trials
      : []
  ).toHaveLength(1);

  expect(
    await runCli(["craft", "--input", resultsPath, "--all", "--out", mdOut])
  ).toBe(0);
  const mdOutput = await readFile(mdOut, "utf-8");
  expect(mdOutput).toContain("Claude Opus 5.5 (medium)");
});
