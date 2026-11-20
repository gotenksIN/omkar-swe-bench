import { lstatSync, mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import ultraciteOxfmt from "ultracite/oxfmt";
import antiSlop from "ultracite/oxlint/anti-slop";

import { median } from "../driver/telemetry.ts";
import type { TrialResult } from "../runner/types.ts";
import { requireGlobalRuff } from "../sandbox/tools.ts";
import type { EvalTask } from "../tasks/base.ts";
import { TASKS_BY_ID } from "../tasks/index.ts";
import { assertNoSymlinkBoundary } from "../util/fs.ts";
import {
  isFiniteNumber,
  isJsonArray,
  isJsonObject,
  isString,
  parseJsonText,
} from "../util/json.ts";

export interface CraftDiagnostic {
  readonly rule: string;
  readonly file: string;
  readonly line: number | null;
  readonly message: string;
}

export interface CodeCraftMetrics {
  readonly language: "python" | "typescript";
  readonly changedFiles: readonly string[];
  readonly prodFiles: readonly string[];
  readonly addedLines: number;
  readonly addedProdLines: number;
  readonly normalizedAddedProdLines: number;
  readonly rawFormatChurnLines: number;
  readonly rawFormatChurnRatio: number;
  readonly rawSpacingViolations: number;
  readonly rawCurlyViolations: number;
  readonly rawHygienePer100Loc: number;
  readonly normalizedDiff: string;
  readonly structuralViolationCount: number;
  readonly complexityViolations: number;
  readonly nestingViolations: number;
  readonly perfAndSlopViolations: number;
  readonly structuralViolations: readonly CraftDiagnostic[];
}

export interface TrialCraftReport {
  readonly taskId: string;
  readonly role: "coder" | "pair";
  readonly model: string;
  readonly reviewerModel: string | null;
  readonly passed: boolean;
  readonly metrics: CodeCraftMetrics;
  readonly taskMedianProdLines: number | null;
  readonly logDiffExpansionRatio: number | null;
}

export interface ModelCraftSummary {
  readonly model: string;
  readonly trials: number;
  readonly totalAddedProdLines: number;
  readonly pythonFormatChurnLines: number;
  readonly tsFormatChurnLines: number;
  readonly tsSpacingViolations: number;
  readonly tsCurlyViolations: number;
  readonly tsCurlyPer100Loc: number | null;
  readonly complexityViolations: number;
  readonly nestingViolations: number;
  readonly perfAndSlopViolations: number;
  readonly medianLogDiffExpansion: number | null;
}

export interface BatchCraftReport {
  readonly trials: readonly TrialCraftReport[];
  readonly models: readonly ModelCraftSummary[];
}

interface DiffStats {
  readonly changedFiles: readonly string[];
  readonly prodFiles: readonly string[];
  readonly addedLines: number;
  readonly addedProdLines: number;
  readonly touchedLinesByFile: ReadonlyMap<string, ReadonlySet<number>>;
}

interface HostProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const harnessRoot = nodePath.resolve(import.meta.dir, "../..");
const oxlintBin = nodePath.join(harnessRoot, "node_modules/.bin/oxlint");
const oxfmtBin = nodePath.join(harnessRoot, "node_modules/.bin/oxfmt");

const PYTHON_STRUCTURAL_RULES = "C901,PLR0911,PLR0912,PLR0915,PLR1702,PERF";
const RUFF_CONFIG_TOML = 'target-version = "py312"\nline-length = 100\n';

const DIFF_FILE_HEADER = /^diff --git a\/.+ b\/(?<file>.+)$/u;
const DIFF_HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(?<start>\d+)(?:,\d+)? @@/u;
const SECTION_HEADER = /^## (?:Committed|Staged|Unstaged)$/u;

const DISABLED_CATEGORIES = {
  correctness: "off",
  suspicious: "off",
  pedantic: "off",
  perf: "off",
  style: "off",
  restriction: "off",
  nursery: "off",
};

const isTestFile = (relPath: string): boolean =>
  /(?:^|\/)tests?\//u.test(relPath) ||
  /(?:^|\/)test_[^/]+\.py$/u.test(relPath) ||
  /\.test\.[cm]?[jt]sx?$/u.test(relPath);

const isLanguageFile = (
  relPath: string,
  language: "python" | "typescript"
): boolean =>
  language === "python"
    ? relPath.endsWith(".py")
    : /\.[cm]?tsx?$/u.test(relPath);

const isSafeRepoRelPath = (relPath: string): boolean => {
  if (
    relPath.length === 0 ||
    nodePath.isAbsolute(relPath) ||
    relPath.startsWith("-") ||
    relPath.startsWith("!")
  ) {
    return false;
  }

  return !relPath.split(/[\\/]/u).includes("..");
};

export const splitGitDiffSections = (rawDiff: string): readonly string[] => {
  const sections: string[] = [];
  let current: string[] = [];

  const flush = (): void => {
    const joined = current.join("\n").trim();

    if (joined.length > 0) {
      sections.push(`${joined}\n`);
    }

    current = [];
  };

  for (const line of rawDiff.split("\n")) {
    if (line.startsWith("Untracked: ")) {
      flush();
      continue;
    }

    if (SECTION_HEADER.test(line)) {
      flush();
      continue;
    }

    current.push(line);
  }

  flush();

  return sections;
};

const recordTouchedLine = (
  touchedLinesByFile: Map<string, Set<number>>,
  file: string,
  line: number
): void => {
  const touched = touchedLinesByFile.get(file) ?? new Set();
  touched.add(line);
  touchedLinesByFile.set(file, touched);
};

const matchDiffFile = (
  line: string,
  language: "python" | "typescript"
): { readonly file: string; readonly isProd: boolean } | null => {
  const nextFile = DIFF_FILE_HEADER.exec(line)?.groups?.file;

  if (nextFile === undefined || !isLanguageFile(nextFile, language)) {
    return null;
  }

  return { file: nextFile, isProd: !isTestFile(nextFile) };
};

const parseDiffStats = (
  diffText: string,
  language: "python" | "typescript"
): DiffStats => {
  const changed = new Set<string>();
  const prod = new Set<string>();
  const touchedLinesByFile = new Map<string, Set<number>>();
  let currentFile: string | null = null;
  let currentIsProd = false;
  let currentLine = 0;
  let addedLines = 0;
  let addedProdLines = 0;

  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const matched = matchDiffFile(line, language);
      currentFile = matched?.file ?? null;
      currentIsProd = matched?.isProd ?? false;
      currentLine = 0;

      if (matched !== null) {
        changed.add(matched.file);

        if (matched.isProd) {
          prod.add(matched.file);
        }
      }

      continue;
    }

    if (currentFile === null) {
      continue;
    }

    const start = DIFF_HUNK_HEADER.exec(line)?.groups?.start;

    if (start !== undefined) {
      currentLine = Number(start);
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      addedLines += 1;
      addedProdLines += currentIsProd ? 1 : 0;

      if (currentLine > 0) {
        recordTouchedLine(touchedLinesByFile, currentFile, currentLine);
        currentLine += 1;
      }
    } else if (
      currentLine > 0 &&
      !line.startsWith("-") &&
      !line.startsWith("\\")
    ) {
      currentLine += 1;
    }
  }

  return {
    changedFiles: [...changed],
    prodFiles: [...prod],
    addedLines,
    addedProdLines,
    touchedLinesByFile,
  };
};

const countDiffChurnLines = (diffText: string): number => {
  let count = 0;

  for (const line of diffText.split("\n")) {
    if (
      (line.startsWith("+") && !line.startsWith("+++")) ||
      (line.startsWith("-") && !line.startsWith("---"))
    ) {
      count += 1;
    }
  }

  return count;
};

const runHostProcess = async (
  command: readonly string[],
  cwd: string,
  stdinText?: string
): Promise<HostProcessResult> => {
  const proc = Bun.spawn([...command], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      NO_COLOR: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdin: stdinText === undefined ? "ignore" : new Blob([stdinText]),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
};

const runSnapshotGit = async (
  repoDir: string,
  args: readonly string[],
  stdinText?: string
): Promise<HostProcessResult> =>
  await runHostProcess(
    [
      "git",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "user.name=OmkarCraft",
      "-c",
      "user.email=craft@omkar.local",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    repoDir,
    stdinText
  );

const resolveSafeRegularFiles = (
  repoDir: string,
  relPaths: readonly string[]
): readonly string[] | null => {
  const files: string[] = [];

  for (const rel of relPaths) {
    if (!isSafeRepoRelPath(rel)) {
      return null;
    }

    const fullPath = nodePath.join(repoDir, rel);
    const entry = lstatSync(fullPath, { throwIfNoEntry: false });

    if (entry === undefined) {
      continue;
    }

    try {
      assertNoSymlinkBoundary(fullPath, repoDir);
    } catch {
      return null;
    }

    if (!entry.isFile()) {
      return null;
    }

    files.push(rel);
  }

  return files;
};

const hasSymlinkInWorkingTree = async (repoDir: string): Promise<boolean> => {
  const lsFiles = await runSnapshotGit(repoDir, ["ls-files", "-s"]);

  for (const line of lsFiles.stdout.split("\n")) {
    if (line.startsWith("120000 ")) {
      return true;
    }
  }

  return false;
};

const parseOxlintDiagnostics = (
  stdout: string,
  repoDir: string
): readonly CraftDiagnostic[] => {
  if (!stdout.trim()) {
    return [];
  }

  const parsed = parseJsonText(stdout);

  if (!isJsonObject(parsed) || !Array.isArray(parsed.diagnostics)) {
    return [];
  }

  const diagnostics: CraftDiagnostic[] = [];

  for (const item of parsed.diagnostics) {
    if (!isJsonObject(item) || !isString(item.code) || item.code.length === 0) {
      continue;
    }

    const rule = item.code;
    const rawFile = isString(item.filename) ? item.filename : "";

    const file = rawFile
      ? nodePath.relative(repoDir, nodePath.resolve(repoDir, rawFile))
      : "";

    const message = isString(item.message) ? item.message : "";
    let line: number | null = null;

    if (isJsonArray(item.labels)) {
      const [firstLabel] = item.labels;

      if (isJsonObject(firstLabel) && isJsonObject(firstLabel.span)) {
        const { line: spanLine } = firstLabel.span;

        if (isFiniteNumber(spanLine)) {
          line = spanLine;
        }
      }
    }

    diagnostics.push({ rule, file, line, message });
  }

  return diagnostics;
};

const parseRuffDiagnostics = (
  stdout: string,
  repoDir: string
): readonly CraftDiagnostic[] => {
  if (!stdout.trim()) {
    return [];
  }

  const parsed = parseJsonText(stdout);

  if (!Array.isArray(parsed)) {
    return [];
  }

  const diagnostics: CraftDiagnostic[] = [];

  for (const item of parsed) {
    if (!isJsonObject(item) || !isString(item.code) || item.code.length === 0) {
      continue;
    }

    const rule = item.code;
    const rawFile = isString(item.filename) ? item.filename : "";

    const file = rawFile
      ? nodePath.relative(repoDir, nodePath.resolve(repoDir, rawFile))
      : "";

    const message = isString(item.message) ? item.message : "";

    const line =
      isJsonObject(item.location) && isFiniteNumber(item.location.row)
        ? item.location.row
        : null;

    diagnostics.push({ rule, file, line, message });
  }

  return diagnostics;
};

const commitSnapshot = async (
  repoDir: string,
  message: string
): Promise<string | null> => {
  const addRun = await runSnapshotGit(repoDir, ["add", "-A"]);

  if (addRun.exitCode !== 0) {
    return null;
  }

  const commitRun = await runSnapshotGit(repoDir, [
    "commit",
    "--allow-empty",
    "-m",
    message,
  ]);

  if (commitRun.exitCode !== 0) {
    return null;
  }

  const revRun = await runSnapshotGit(repoDir, ["rev-parse", "HEAD"]);

  return revRun.exitCode === 0 ? revRun.stdout.trim() : null;
};

const checkoutSnapshot = async (
  repoDir: string,
  sha: string
): Promise<boolean> => {
  const checkoutRun = await runSnapshotGit(repoDir, [
    "checkout",
    "--force",
    "--detach",
    sha,
  ]);

  if (checkoutRun.exitCode !== 0) {
    return false;
  }

  const cleanRun = await runSnapshotGit(repoDir, ["clean", "-fd"]);

  return cleanRun.exitCode === 0;
};

interface LanguageAnalysisContext {
  readonly repoDir: string;
  readonly configDir: string;
  readonly preTrialSha: string;
  readonly stats: DiffStats;
  readonly existingFiles: readonly string[];
  readonly existingProdFiles: readonly string[];
}

const analyzePythonSnapshot = async (
  ctx: LanguageAnalysisContext
): Promise<Omit<CodeCraftMetrics, "changedFiles" | "prodFiles"> | null> => {
  const ruff = requireGlobalRuff();
  const ruffConfigPath = nodePath.join(ctx.configDir, "ruff.toml");
  await writeFile(ruffConfigPath, RUFF_CONFIG_TOML);

  let postFormatChurnLines = 0;

  if (ctx.existingFiles.length > 0) {
    // Step 1: Measure raw mechanical formatting churn before normalization.
    const diffRun = await runHostProcess(
      [
        ruff,
        "format",
        "--config",
        ruffConfigPath,
        "--diff",
        "--no-cache",
        "--",
        ...ctx.existingFiles,
      ],
      ctx.repoDir
    );

    postFormatChurnLines = countDiffChurnLines(diffRun.stdout);

    // Step 2: Normalize formatting in the isolated post-trial snapshot.
    await runHostProcess(
      [
        ruff,
        "format",
        "--config",
        ruffConfigPath,
        "--no-cache",
        "--",
        ...ctx.existingFiles,
      ],
      ctx.repoDir
    );
  }

  let structuralViolations: readonly CraftDiagnostic[] = [];

  if (ctx.existingProdFiles.length > 0) {
    // Step 3: Measure structural complexity & performance on normalized production files.
    const checkRun = await runHostProcess(
      [
        ruff,
        "check",
        "--config",
        ruffConfigPath,
        "--no-cache",
        "--preview",
        "--output-format",
        "json",
        `--select=${PYTHON_STRUCTURAL_RULES}`,
        "--",
        ...ctx.existingProdFiles,
      ],
      ctx.repoDir
    );

    structuralViolations = parseRuffDiagnostics(checkRun.stdout, ctx.repoDir);
  }

  const postNormSha = await commitSnapshot(ctx.repoDir, "post-normalized");

  if (
    postNormSha === null ||
    !(await checkoutSnapshot(ctx.repoDir, ctx.preTrialSha))
  ) {
    return null;
  }

  const baselineFiles = resolveSafeRegularFiles(
    ctx.repoDir,
    ctx.stats.changedFiles
  );

  if (baselineFiles === null) {
    return null;
  }

  let baselineFormatChurnLines = 0;

  if (baselineFiles.length > 0) {
    const baseDiffRun = await runHostProcess(
      [
        ruff,
        "format",
        "--config",
        ruffConfigPath,
        "--diff",
        "--no-cache",
        "--",
        ...baselineFiles,
      ],
      ctx.repoDir
    );

    baselineFormatChurnLines = countDiffChurnLines(baseDiffRun.stdout);

    await runHostProcess(
      [
        ruff,
        "format",
        "--config",
        ruffConfigPath,
        "--no-cache",
        "--",
        ...baselineFiles,
      ],
      ctx.repoDir
    );
  }

  const preNormSha = await commitSnapshot(ctx.repoDir, "pre-normalized");

  if (preNormSha === null) {
    return null;
  }

  const normalizedDiffRun = await runSnapshotGit(ctx.repoDir, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    preNormSha,
    postNormSha,
    "--",
    ...ctx.stats.changedFiles,
  ]);

  const normalizedDiff = normalizedDiffRun.stdout;

  const normalizedAddedProdLines = parseDiffStats(
    normalizedDiff,
    "python"
  ).addedProdLines;

  let complexityViolations = 0;
  let nestingViolations = 0;
  let perfAndSlopViolations = 0;

  for (const diag of structuralViolations) {
    if (diag.rule === "PLR1702") {
      nestingViolations += 1;
    } else if (diag.rule.startsWith("PERF")) {
      perfAndSlopViolations += 1;
    } else {
      complexityViolations += 1;
    }
  }

  const rawFormatChurnLines = Math.max(
    0,
    postFormatChurnLines - baselineFormatChurnLines
  );

  const rawFormatChurnRatio =
    ctx.stats.addedLines > 0 ? rawFormatChurnLines / ctx.stats.addedLines : 0;

  return {
    language: "python",
    addedLines: ctx.stats.addedLines,
    addedProdLines: ctx.stats.addedProdLines,
    normalizedAddedProdLines,
    rawFormatChurnLines,
    rawFormatChurnRatio,
    rawSpacingViolations: 0,
    rawCurlyViolations: 0,
    rawHygienePer100Loc: rawFormatChurnRatio * 100,
    normalizedDiff,
    structuralViolationCount: structuralViolations.length,
    complexityViolations,
    nestingViolations,
    perfAndSlopViolations,
    structuralViolations,
  };
};

const isTouchedDiagnostic = (
  diag: CraftDiagnostic,
  touchedLinesByFile: ReadonlyMap<string, ReadonlySet<number>>
): boolean => {
  if (diag.line === null) {
    return true;
  }

  const touched = touchedLinesByFile.get(diag.file);

  return touched === undefined ? false : touched.has(diag.line);
};

const analyzeTypeScriptSnapshot = async (
  ctx: LanguageAnalysisContext
): Promise<Omit<CodeCraftMetrics, "changedFiles" | "prodFiles"> | null> => {
  const hygieneConfigPath = nodePath.join(ctx.configDir, "oxlint-hygiene.json");

  const spacingFixConfigPath = nodePath.join(
    ctx.configDir,
    "oxlint-spacing.json"
  );

  const structuralConfigPath = nodePath.join(
    ctx.configDir,
    "oxlint-structural.json"
  );

  const oxfmtConfigPath = nodePath.join(ctx.configDir, "oxfmt.json");

  await Promise.all([
    writeFile(
      oxfmtConfigPath,
      JSON.stringify({ ...ultraciteOxfmt, proseWrap: "preserve" })
    ),
    writeFile(
      hygieneConfigPath,
      JSON.stringify({
        jsPlugins: antiSlop.jsPlugins,
        categories: DISABLED_CATEGORIES,
        rules: {
          "anti-slop/require-readable-spacing": "error",
          "eslint/curly": "error",
        },
      })
    ),
    writeFile(
      spacingFixConfigPath,
      JSON.stringify({
        jsPlugins: antiSlop.jsPlugins,
        categories: DISABLED_CATEGORIES,
        rules: {
          "anti-slop/require-readable-spacing": "error",
        },
      })
    ),
    writeFile(
      structuralConfigPath,
      JSON.stringify({
        jsPlugins: antiSlop.jsPlugins,
        categories: DISABLED_CATEGORIES,
        rules: {
          "eslint/complexity": ["error", { max: 15 }],
          "eslint/max-depth": ["error", { max: 4 }],
          "oxc/no-accumulating-spread": "error",
          "anti-slop/no-array-filter-map": "error",
          "anti-slop/no-reduce-accumulator-copy": "error",
        },
      })
    ),
  ]);

  let rawSpacingViolations = 0;
  let rawCurlyViolations = 0;

  if (ctx.existingProdFiles.length > 0) {
    // Step 1: Measure raw mechanical hygiene on lines touched by the trial diff.
    const hygieneRun = await runHostProcess(
      [
        oxlintBin,
        "-c",
        hygieneConfigPath,
        "--disable-nested-config",
        "--format",
        "json",
        "--",
        ...ctx.existingProdFiles,
      ],
      ctx.repoDir
    );

    for (const diag of parseOxlintDiagnostics(hygieneRun.stdout, ctx.repoDir)) {
      if (!isTouchedDiagnostic(diag, ctx.stats.touchedLinesByFile)) {
        continue;
      }

      if (diag.rule === "anti-slop(require-readable-spacing)") {
        rawSpacingViolations += 1;
      } else if (diag.rule === "eslint(curly)") {
        rawCurlyViolations += 1;
      }
    }
  }

  let postFormatChurnLines = 0;

  if (ctx.existingFiles.length > 0) {
    // Step 2: Normalize formatting in the isolated post-trial snapshot.
    await runHostProcess(
      [
        oxfmtBin,
        "-c",
        oxfmtConfigPath,
        "--disable-nested-config",
        "--write",
        "--",
        ...ctx.existingFiles,
      ],
      ctx.repoDir
    );
    await runHostProcess(
      [
        oxlintBin,
        "-c",
        spacingFixConfigPath,
        "--disable-nested-config",
        "--fix",
        "--",
        ...ctx.existingFiles,
      ],
      ctx.repoDir
    );

    const churnDiffRun = await runSnapshotGit(ctx.repoDir, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--",
      ...ctx.existingFiles,
    ]);

    postFormatChurnLines = countDiffChurnLines(churnDiffRun.stdout);
  }

  let structuralViolations: readonly CraftDiagnostic[] = [];

  if (ctx.existingProdFiles.length > 0) {
    // Step 3: Measure structural complexity & anti-slop patterns on normalized production files.
    const structuralRun = await runHostProcess(
      [
        oxlintBin,
        "-c",
        structuralConfigPath,
        "--disable-nested-config",
        "--format",
        "json",
        "--",
        ...ctx.existingProdFiles,
      ],
      ctx.repoDir
    );

    structuralViolations = parseOxlintDiagnostics(
      structuralRun.stdout,
      ctx.repoDir
    );
  }

  const postNormSha = await commitSnapshot(ctx.repoDir, "post-normalized");

  if (
    postNormSha === null ||
    !(await checkoutSnapshot(ctx.repoDir, ctx.preTrialSha))
  ) {
    return null;
  }

  const baselineFiles = resolveSafeRegularFiles(
    ctx.repoDir,
    ctx.stats.changedFiles
  );

  if (baselineFiles === null) {
    return null;
  }

  let baselineFormatChurnLines = 0;

  if (baselineFiles.length > 0) {
    await runHostProcess(
      [
        oxfmtBin,
        "-c",
        oxfmtConfigPath,
        "--disable-nested-config",
        "--write",
        "--",
        ...baselineFiles,
      ],
      ctx.repoDir
    );
    await runHostProcess(
      [
        oxlintBin,
        "-c",
        spacingFixConfigPath,
        "--disable-nested-config",
        "--fix",
        "--",
        ...baselineFiles,
      ],
      ctx.repoDir
    );

    const baseChurnRun = await runSnapshotGit(ctx.repoDir, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--",
      ...baselineFiles,
    ]);

    baselineFormatChurnLines = countDiffChurnLines(baseChurnRun.stdout);
  }

  const preNormSha = await commitSnapshot(ctx.repoDir, "pre-normalized");

  if (preNormSha === null) {
    return null;
  }

  const normalizedDiffRun = await runSnapshotGit(ctx.repoDir, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    preNormSha,
    postNormSha,
    "--",
    ...ctx.stats.changedFiles,
  ]);

  const normalizedDiff = normalizedDiffRun.stdout;

  const normalizedAddedProdLines = parseDiffStats(
    normalizedDiff,
    "typescript"
  ).addedProdLines;

  let complexityViolations = 0;
  let nestingViolations = 0;
  let perfAndSlopViolations = 0;

  for (const diag of structuralViolations) {
    if (diag.rule === "eslint(complexity)") {
      complexityViolations += 1;
    } else if (diag.rule === "eslint(max-depth)") {
      nestingViolations += 1;
    } else {
      perfAndSlopViolations += 1;
    }
  }

  const rawFormatChurnLines = Math.max(
    0,
    postFormatChurnLines - baselineFormatChurnLines
  );

  const rawFormatChurnRatio =
    ctx.stats.addedLines > 0 ? rawFormatChurnLines / ctx.stats.addedLines : 0;

  const rawHygienePer100Loc =
    ctx.stats.addedProdLines > 0
      ? ((rawSpacingViolations + rawCurlyViolations) * 100) /
        ctx.stats.addedProdLines
      : 0;

  return {
    language: "typescript",
    addedLines: ctx.stats.addedLines,
    addedProdLines: ctx.stats.addedProdLines,
    normalizedAddedProdLines,
    rawFormatChurnLines,
    rawFormatChurnRatio,
    rawSpacingViolations,
    rawCurlyViolations,
    rawHygienePer100Loc,
    normalizedDiff,
    structuralViolationCount: structuralViolations.length,
    complexityViolations,
    nestingViolations,
    perfAndSlopViolations,
    structuralViolations,
  };
};

const resolveCraftLanguage = (
  taskLanguage: EvalTask["language"],
  diffText: string
): "python" | "typescript" | null => {
  if (taskLanguage === "python" || taskLanguage === "typescript") {
    return taskLanguage;
  }

  for (const line of diffText.split("\n")) {
    const match = DIFF_FILE_HEADER.exec(line);
    const file = match?.groups?.file;

    if (file === undefined) {
      continue;
    }

    if (file.endsWith(".py")) {
      return "python";
    }

    if (/\.[cm]?tsx?$/u.test(file)) {
      return "typescript";
    }
  }

  return null;
};

export const analyzeTrialCodeCraft = async (
  trial: TrialResult
): Promise<CodeCraftMetrics | null> => {
  if (
    (trial.role !== "coder" && trial.role !== "pair") ||
    trial.partial ||
    trial.checks.dry_run_fixture_ready === true ||
    trial.git_diff.trim().length === 0
  ) {
    return null;
  }

  const task = TASKS_BY_ID.get(trial.task_id);

  if (task === undefined) {
    return null;
  }

  const sections = splitGitDiffSections(trial.git_diff);

  if (sections.length === 0) {
    return null;
  }

  const language = resolveCraftLanguage(task.language, trial.git_diff);

  if (language === null) {
    return null;
  }

  mkdirSync("/tmp/opencode", { recursive: true });
  const tempRoot = await mkdtemp("/tmp/opencode/craft-");

  try {
    const repoDir = nodePath.join(tempRoot, "repo");
    const configDir = nodePath.join(tempRoot, "config");
    mkdirSync(configDir, { recursive: true });

    const setup = await task.setupRepo(repoDir);

    // Record the exact pre-trial working tree (including pre-seeded unstaged edits like NOTES.md).
    const preTrialSha = await commitSnapshot(repoDir, "pre-trial-snapshot");

    if (
      preTrialSha === null ||
      !(await checkoutSnapshot(repoDir, setup.baselineHead))
    ) {
      return null;
    }

    // Apply Committed, Staged, and Unstaged sections sequentially onto baselineHead.
    for (const section of sections) {
      // oxlint-disable-next-line no-await-in-loop -- Patch sections must apply sequentially in order.
      const applyRun = await runSnapshotGit(
        repoDir,
        ["apply", "--whitespace=nowarn", "-"],
        section
      );

      if (applyRun.exitCode !== 0) {
        return null;
      }
    }

    const postRawSha = await commitSnapshot(repoDir, "post-trial-raw");

    if (postRawSha === null || (await hasSymlinkInWorkingTree(repoDir))) {
      return null;
    }

    // Diff pre-trial working tree against post-trial raw tree so pre-seeded edits cancel out.
    const netRawDiffRun = await runSnapshotGit(repoDir, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      preTrialSha,
      postRawSha,
      "--",
    ]);

    const stats = parseDiffStats(netRawDiffRun.stdout, language);

    if (stats.changedFiles.length === 0) {
      return null;
    }

    const existingFiles = resolveSafeRegularFiles(repoDir, stats.changedFiles);
    const existingProdFiles = resolveSafeRegularFiles(repoDir, stats.prodFiles);

    if (existingFiles === null || existingProdFiles === null) {
      return null;
    }

    const ctx: LanguageAnalysisContext = {
      repoDir,
      configDir,
      preTrialSha,
      stats,
      existingFiles,
      existingProdFiles,
    };

    const result =
      language === "python"
        ? await analyzePythonSnapshot(ctx)
        : await analyzeTypeScriptSnapshot(ctx);

    if (result === null) {
      return null;
    }

    return {
      ...result,
      changedFiles: stats.changedFiles,
      prodFiles: stats.prodFiles,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};

const summarizeModelCraft = (
  model: string,
  modelTrials: readonly TrialCraftReport[]
): ModelCraftSummary => {
  let totalAddedProdLines = 0;
  let totalTsProdLines = 0;
  let pythonFormatChurnLines = 0;
  let tsFormatChurnLines = 0;
  let tsSpacingViolations = 0;
  let tsCurlyViolations = 0;
  let complexityViolations = 0;
  let nestingViolations = 0;
  let perfAndSlopViolations = 0;
  const logRatios: number[] = [];

  for (const item of modelTrials) {
    totalAddedProdLines += item.metrics.normalizedAddedProdLines;
    complexityViolations += item.metrics.complexityViolations;
    nestingViolations += item.metrics.nestingViolations;
    perfAndSlopViolations += item.metrics.perfAndSlopViolations;

    if (item.metrics.language === "python") {
      pythonFormatChurnLines += item.metrics.rawFormatChurnLines;
    } else {
      totalTsProdLines += item.metrics.addedProdLines;
      tsFormatChurnLines += item.metrics.rawFormatChurnLines;
      tsSpacingViolations += item.metrics.rawSpacingViolations;
      tsCurlyViolations += item.metrics.rawCurlyViolations;
    }

    if (item.logDiffExpansionRatio !== null) {
      logRatios.push(item.logDiffExpansionRatio);
    }
  }

  return {
    model,
    trials: modelTrials.length,
    totalAddedProdLines,
    pythonFormatChurnLines,
    tsFormatChurnLines,
    tsSpacingViolations,
    tsCurlyViolations,
    tsCurlyPer100Loc:
      totalTsProdLines > 0
        ? (tsCurlyViolations * 100) / totalTsProdLines
        : null,
    complexityViolations,
    nestingViolations,
    perfAndSlopViolations,
    medianLogDiffExpansion: median(logRatios),
  };
};

const aggregateModelCraftSummaries = (
  trials: readonly TrialCraftReport[]
): readonly ModelCraftSummary[] => {
  const byModel = new Map<string, TrialCraftReport[]>();

  for (const report of trials) {
    const bucket = byModel.get(report.model) ?? [];
    bucket.push(report);
    byModel.set(report.model, bucket);
  }

  const models: ModelCraftSummary[] = [];

  for (const [model, modelTrials] of byModel) {
    models.push(summarizeModelCraft(model, modelTrials));
  }

  models.sort((left, right) => {
    const leftTotal =
      left.complexityViolations +
      left.nestingViolations +
      left.perfAndSlopViolations;

    const rightTotal =
      right.complexityViolations +
      right.nestingViolations +
      right.perfAndSlopViolations;

    if (leftTotal !== rightTotal) {
      return leftTotal - rightTotal;
    }

    return left.model.localeCompare(right.model);
  });

  return models;
};

const computeMedianProdByTask = (
  rawReports: readonly {
    readonly trial: TrialResult;
    readonly metrics: CodeCraftMetrics;
  }[]
): ReadonlyMap<string, number> => {
  const prodLinesByTask = new Map<string, number[]>();

  for (const { trial, metrics } of rawReports) {
    if (trial.passed && metrics.normalizedAddedProdLines > 0) {
      const bucket = prodLinesByTask.get(trial.task_id) ?? [];
      bucket.push(metrics.normalizedAddedProdLines);
      prodLinesByTask.set(trial.task_id, bucket);
    }
  }

  const medianProdByTask = new Map<string, number>();

  for (const [taskId, values] of prodLinesByTask) {
    const med = median(values);

    if (med !== null && med > 0) {
      medianProdByTask.set(taskId, med);
    }
  }

  return medianProdByTask;
};

export const analyzeTrialsCodeCraft = async (
  results: readonly TrialResult[],
  options?: { readonly passingOnly?: boolean }
): Promise<BatchCraftReport> => {
  const passingOnly = options?.passingOnly ?? true;

  const rawReports: {
    readonly trial: TrialResult;
    readonly metrics: CodeCraftMetrics;
  }[] = [];

  for (const trial of results) {
    if (passingOnly && !trial.passed) {
      continue;
    }

    // oxlint-disable-next-line no-await-in-loop -- Analyze trial snapshots sequentially to keep host subprocess concurrency bounded.
    const metrics = await analyzeTrialCodeCraft(trial);

    if (metrics !== null) {
      rawReports.push({ trial, metrics });
    }
  }

  // Compute task-median normalized production lines from passing trials only.
  const medianProdByTask = computeMedianProdByTask(rawReports);

  const trials: TrialCraftReport[] = [];

  for (const { trial, metrics } of rawReports) {
    if (trial.role !== "coder" && trial.role !== "pair") {
      continue;
    }

    const taskMedianProdLines = medianProdByTask.get(trial.task_id) ?? null;

    const logDiffExpansionRatio =
      taskMedianProdLines !== null &&
      taskMedianProdLines > 0 &&
      metrics.normalizedAddedProdLines > 0
        ? Math.log(metrics.normalizedAddedProdLines / taskMedianProdLines)
        : null;

    trials.push({
      taskId: trial.task_id,
      role: trial.role,
      model: trial.model,
      reviewerModel: trial.reviewer_model,
      passed: trial.passed,
      metrics,
      taskMedianProdLines,
      logDiffExpansionRatio,
    });
  }

  return { trials, models: aggregateModelCraftSummaries(trials) };
};

export const renderCraftMarkdown = (report: BatchCraftReport): string => {
  const lines = [
    "# Host-Side Code Craft Summary",
    "",
    "| Model | Trials | Norm Prod +LOC | Py Format Churn | TS Spacing | TS Curly | TS Curly / 100 LOC | Complexity | Nesting | Perf / Anti-Slop | Med Log Diff Ratio |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];

  for (const row of report.models) {
    const curlyRate =
      row.tsCurlyPer100Loc === null ? "—" : row.tsCurlyPer100Loc.toFixed(1);

    const logRatio =
      row.medianLogDiffExpansion === null
        ? "—"
        : row.medianLogDiffExpansion.toFixed(2);

    lines.push(
      `| \`${row.model}\` | ${row.trials} | ${row.totalAddedProdLines} | ${row.pythonFormatChurnLines} | ${row.tsSpacingViolations} | ${row.tsCurlyViolations} | ${curlyRate} | ${row.complexityViolations} | ${row.nestingViolations} | ${row.perfAndSlopViolations} | ${logRatio} |`
    );
  }

  return `${lines.join("\n")}\n`;
};
