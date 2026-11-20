#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";
import { parseArgs } from "node:util";

import {
  CODER_MODELS,
  PAIR_REVIEWER_MODELS,
  parseModelSpec,
  REVIEWER_MODELS,
  validateModels,
} from "./config/models.ts";
import {
  analyzeTrialsCodeCraft,
  renderCraftMarkdown,
} from "./graders/craft.ts";
import {
  exportBlindJudgePacket,
  exportCoderDiffJudgePacket,
  validateBlindJudgeAnswers,
} from "./judge/blind.ts";
import { renderBenchmarkCharts } from "./report/charts.ts";
import { renderHtmlReport } from "./report/html.ts";
import {
  readResultsJson,
  renderDetailedReport,
  renderMarkdownReport,
  writeResultsJson,
} from "./report/markdown.ts";
import { summarizeBenchmark } from "./report/scoring.ts";
import { runPool, scheduleTrials } from "./runner/pool.ts";
import { runTrial, validateTrialCatalog } from "./runner/run-trial.ts";
import type { RunConfig, TrialJob, TrialResult } from "./runner/types.ts";
import { probeSandbox, RunController } from "./sandbox/process.ts";
import {
  COMMIT_GUARD_PACKAGE,
  discoverOpenCodeCaches,
  refreshOpenCodeModelsCache,
  requireGlobalRuff,
} from "./sandbox/tools.ts";
import type { EvalTask } from "./tasks/base.ts";
import { TASKS_BY_ID, tasksForPhase } from "./tasks/index.ts";
import { atomicWriteFile } from "./util/fs.ts";
import { parseJsonText } from "./util/json.ts";

const phase = (value = "all") => {
  if (
    value === "all" ||
    value === "coder" ||
    value === "reviewer" ||
    value === "pair"
  ) {
    return value;
  }

  throw new Error("Set --phase to all, coder, reviewer, or pair.");
};

const list = (args: string[]): number => {
  const { values } = parseArgs({
    args,
    options: { phase: { type: "string" }, json: { type: "boolean" } },
  });

  const tasks = tasksForPhase(phase(values.phase)).map(
    ({ id, role, category, language, timeoutSeconds, commitGuard }) => ({
      id,
      role,
      category,
      language,
      timeoutSeconds,
      commitGuard,
    })
  );

  if (values.json === true) {
    console.log(JSON.stringify(tasks, null, 2));
  } else {
    console.log("ID\tRole\tCategory\tLanguage\tTimeout (s)\tCommit guard");

    for (const {
      id,
      role,
      category,
      language,
      timeoutSeconds,
      commitGuard,
    } of tasks) {
      console.log(
        [id, role, category, language, timeoutSeconds, commitGuard].join("\t")
      );
    }
  }

  return 0;
};

const integerFlag = (
  value: string | undefined,
  fallback: number,
  minimum: number,
  name: string
): number => {
  if (value === undefined) {
    return fallback;
  }

  const number = Number(value);

  if (
    !/^\d+$/u.test(value) ||
    !Number.isSafeInteger(number) ||
    number < minimum
  ) {
    throw new Error(`Set --${name} to an integer of at least ${minimum}.`);
  }

  return number;
};

const sandboxEnabled = async (mode = "require"): Promise<boolean> => {
  if (mode === "off") {
    return false;
  }

  if (mode !== "require" && mode !== "auto") {
    throw new Error("Set --sandbox to require, auto, or off.");
  }

  const { available, reason } = await probeSandbox();

  if (available) {
    return true;
  }

  if (mode === "require") {
    throw new Error(`Sandbox unavailable: ${reason}`);
  }

  console.warn(`Sandbox unavailable. Run without isolation: ${reason}`);

  return false;
};

const progress = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

const modelLabel = (model: string, reviewerModel: string | null): string =>
  reviewerModel === null ? model : `${model} -> ${reviewerModel}`;

const formatDuration = (seconds: number): string => {
  const totalTenths = Math.max(0, Math.round(seconds * 10));
  const hours = Math.floor(totalTenths / 36_000);
  const minutes = Math.floor((totalTenths % 36_000) / 600);
  const secs = ((totalTenths % 600) / 10).toFixed(1);

  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }

  return `${secs}s`;
};

const failureDetail = (result: TrialResult): string => {
  if (result.error_message !== null) {
    return ` (${result.error_message})`;
  }

  const failed = Object.entries(result.checks).flatMap(([name, ok]) =>
    ok ? [] : [name]
  );

  return failed.length > 0 ? ` (${failed.join(", ")})` : "";
};

const preflightCatalogs = async (
  jobs: readonly TrialJob[],
  options: RunConfig
): Promise<void> => {
  const catalogs = Map.groupBy(jobs, ({ model, reviewerModel }) => {
    const specs = reviewerModel === null ? [model] : [model, reviewerModel];

    const providers = new Set(
      specs.map((spec) => parseModelSpec(spec).providerID)
    );

    return JSON.stringify([...providers].toSorted());
  });

  const groups = [...catalogs.values()];

  for (const [index, group] of groups.entries()) {
    const [job] = group;

    if (job === undefined || options.signal.aborted) {
      break;
    }

    const specs = new Set(
      group.flatMap(({ model, reviewerModel }) =>
        reviewerModel === null ? [model] : [model, reviewerModel]
      )
    );

    const providers = [
      ...new Set([...specs].map((spec) => parseModelSpec(spec).providerID)),
    ].toSorted();

    progress(
      `Preflighting catalog ${index + 1}/${groups.length} (${providers.join(", ")})...`
    );
    // oxlint-disable-next-line no-await-in-loop -- Preflight provider catalogs sequentially so early failures do not leak concurrent detached servers.
    await validateTrialCatalog(job, options, [...specs]);
  }
};

const formatTrialStatus = (result: TrialResult): string => {
  if (result.timed_out) {
    return "TIMEOUT";
  }

  return result.passed ? "PASS" : "FAIL";
};

const validateRunPrerequisites = (
  tasks: readonly EvalTask[],
  sandboxMode: string | undefined,
  sandboxed: boolean,
  dryRun: boolean,
  aborted: boolean
): void => {
  if (aborted || dryRun) {
    return;
  }

  if (
    sandboxMode === "auto" &&
    !sandboxed &&
    tasks.some((task) => task.role !== "code-reviewer")
  ) {
    throw new Error(
      "Cannot grade coder or pair trials without bubblewrap. No model prompts were sent."
    );
  }

  if (
    tasks.some((task) => task.commitGuard) &&
    discoverOpenCodeCaches().commitGuardCacheDir === null
  ) {
    throw new Error(
      `Cache ${COMMIT_GUARD_PACKAGE} in OpenCode before running commit-guard tasks.`
    );
  }

  if (tasks.some((task) => task.needsRuff)) {
    requireGlobalRuff();
  }
};

const buildRunConfig = (
  runId: string,
  sandboxed: boolean,
  timeoutScale: number,
  apiRetries: number,
  dryRun: boolean,
  signal: AbortSignal,
  values: {
    readonly "workspace-root"?: string;
    readonly "keep-workspaces"?: boolean;
    readonly "providers-file"?: string;
    readonly "agents-file"?: string;
  }
): RunConfig => {
  let options: RunConfig = {
    runId,
    workspaceRoot: nodePath.resolve(
      values["workspace-root"] ?? "/tmp/opencode/omkar-swe-bench"
    ),
    sandboxed,
    timeoutScale,
    apiRetries,
    keepWorkspaces: values["keep-workspaces"] ?? false,
    dryRun,
    signal,
  };

  if (values["providers-file"] !== undefined) {
    options = { ...options, providersFile: values["providers-file"] };
  }

  if (values["agents-file"] !== undefined) {
    options = { ...options, agentsFile: values["agents-file"] };
  }

  return options;
};

const collectModelSpecs = (
  jobs: readonly TrialJob[],
  explicitCoders: readonly string[] | undefined,
  explicitReviewers: readonly string[] | undefined
): string[] => {
  const modelSpecs = new Set([
    ...(explicitCoders ?? []),
    ...(explicitReviewers ?? []),
  ]);

  for (const { model, reviewerModel } of jobs) {
    modelSpecs.add(model);

    if (reviewerModel !== null) {
      modelSpecs.add(reviewerModel);
    }
  }

  return [...modelSpecs];
};

const validateTimeoutScale = (
  raw: string | undefined,
  tasks: readonly EvalTask[]
): number => {
  const timeoutScale = Number(raw ?? "1");

  if (
    !Number.isFinite(timeoutScale) ||
    timeoutScale <= 0 ||
    tasks.some((task) => {
      const ms = Math.round(task.timeoutSeconds * timeoutScale * 1000);

      return ms < 1 || ms > 2_147_483_647;
    })
  ) {
    throw new Error(
      "Set --timeout-scale to a positive factor within timer limits."
    );
  }

  return timeoutScale;
};

const run = async (args: string[]): Promise<number> => {
  const { values } = parseArgs({
    args,
    options: {
      phase: { type: "string" },
      task: { type: "string", multiple: true },
      "coder-model": { type: "string", multiple: true },
      "reviewer-model": { type: "string", multiple: true },
      "all-pairs": { type: "boolean" },
      "trials-per-cell": { type: "string" },
      workers: { type: "string" },
      "api-retries": { type: "string" },
      sandbox: { type: "string" },
      "providers-file": { type: "string" },
      "agents-file": { type: "string" },
      out: { type: "string" },
      "workspace-root": { type: "string" },
      "timeout-scale": { type: "string" },
      "keep-workspaces": { type: "boolean" },
      "dry-run": { type: "boolean" },
    },
  });

  const phaseTasks = tasksForPhase(phase(values.phase));

  for (const id of values.task ?? []) {
    if (!TASKS_BY_ID.has(id)) {
      throw new Error(`Unknown task ID: ${id}`);
    }

    if (!phaseTasks.some((task) => task.id === id)) {
      throw new Error(`Task ${id} does not match --phase.`);
    }
  }

  const requested = new Set(values.task);

  const tasks =
    requested.size === 0
      ? phaseTasks
      : phaseTasks.filter((task) => requested.has(task.id));

  const coderModels = values["coder-model"] ?? CODER_MODELS;
  const reviewerModels = values["reviewer-model"] ?? REVIEWER_MODELS;

  const pairReviewerModels =
    values["reviewer-model"] ??
    (values["all-pairs"] === true ? reviewerModels : PAIR_REVIEWER_MODELS);

  const trialsPerCell = integerFlag(
    values["trials-per-cell"],
    1,
    1,
    "trials-per-cell"
  );

  const workers = integerFlag(values.workers, 4, 1, "workers");
  const apiRetries = integerFlag(values["api-retries"], 3, 0, "api-retries");
  const timeoutScale = validateTimeoutScale(values["timeout-scale"], tasks);
  const dryRun = values["dry-run"] ?? false;

  const jobs = scheduleTrials({
    tasks,
    coderModels,
    reviewerModels,
    pairReviewerModels,
    trialsPerCell,
  });

  const modelSpecs = collectModelSpecs(
    jobs,
    values["coder-model"],
    values["reviewer-model"]
  );

  const syntaxWarnings = await validateModels(modelSpecs);

  if (dryRun) {
    for (const warning of syntaxWarnings) {
      console.warn(warning);
    }
  }

  const controller = new RunController();
  const { signal } = controller;

  try {
    const sandboxed = await sandboxEnabled(values.sandbox);
    validateRunPrerequisites(
      tasks,
      values.sandbox,
      sandboxed,
      dryRun,
      signal.aborted
    );

    const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
    const runId = `${timestamp}-${randomBytes(4).toString("hex")}`;

    const out = nodePath.resolve(
      values.out ?? nodePath.join("artifacts", timestamp)
    );

    const options = buildRunConfig(
      runId,
      sandboxed,
      timeoutScale,
      apiRetries,
      dryRun,
      signal,
      values
    );

    const runStartedAt = performance.now();

    if (!dryRun && !signal.aborted) {
      progress(
        `Starting ${jobs.length} trial(s) (${Math.min(workers, jobs.length)} workers) -> ${out}`
      );
      progress("Refreshing OpenCode models catalog...");
      await refreshOpenCodeModelsCache(signal);
      await preflightCatalogs(jobs, options);
    }

    mkdirSync(out, { recursive: true, mode: 0o700 });
    const resultsPath = nodePath.join(out, "results.json");
    let started = 0;
    let finished = 0;

    const results = await runPool(
      jobs,
      async (job) => {
        if (!dryRun) {
          started += 1;
          progress(
            `[start ${started}/${jobs.length}] ${job.task.id} | ${modelLabel(job.model, job.reviewerModel)}`
          );
        }

        const result = await runTrial(job, options);

        if (!dryRun) {
          finished += 1;

          const status = formatTrialStatus(result);

          const pct = `${Math.round(result.score * 100)}%`.padStart(4);

          progress(
            `[${finished}/${jobs.length}] ${status} ${pct} | ${result.task_id} | ${modelLabel(result.model, result.reviewer_model)}` +
              ` | ${result.wall_s.toFixed(1)}s | $${result.total_cost_usd.toFixed(4)}${failureDetail(result)}`
          );
        }

        return result;
      },
      {
        signal,
        workers,
        onResult: (completed) => {
          writeResultsJson(resultsPath, completed);
        },
      }
    );

    const summaryPath = nodePath.join(out, "summary.md");
    writeResultsJson(resultsPath, results);
    atomicWriteFile(summaryPath, renderMarkdownReport(results));

    if (!dryRun) {
      const passed = results.filter((entry) => entry.passed).length;

      const totalCost = results.reduce(
        (sum, entry) => sum + entry.total_cost_usd,
        0
      );

      const elapsed = formatDuration((performance.now() - runStartedAt) / 1000);

      progress(
        `Done: ${passed}/${results.length} passed | ${elapsed} | $${totalCost.toFixed(4)} | ${summaryPath}`
      );
    }

    return signal.aborted ? 130 : 0;
  } catch (error) {
    if (!signal.aborted) {
      throw error;
    }

    return 130;
  } finally {
    controller.shutdown();
  }
};

const output = (text: string, path: string | undefined): void => {
  if (path === undefined) {
    process.stdout.write(text);
  } else {
    const resolved = nodePath.resolve(path);
    mkdirSync(nodePath.dirname(resolved), { recursive: true, mode: 0o700 });
    atomicWriteFile(resolved, text);
  }
};

const resolvePngCommand = (svgPath: string, pngPath: string): string[] => {
  const rsvg = Bun.which("rsvg-convert");

  if (rsvg !== null) {
    return [rsvg, "--background-color=#0b1120", "-o", pngPath, svgPath];
  }

  const resvg = Bun.which("resvg");

  if (resvg !== null) {
    return [resvg, svgPath, pngPath];
  }

  throw new Error("PNG export requires host rsvg-convert or resvg on PATH.");
};

const exportPng = (svgPath: string, pngPath: string): void => {
  const cmd = resolvePngCommand(svgPath, pngPath);
  const proc = Bun.spawnSync(cmd, { stdout: "ignore", stderr: "pipe" });

  if (proc.exitCode !== 0) {
    throw new Error(
      `PNG export failed for ${svgPath}: ${proc.stderr.toString().trim()}`
    );
  }
};

const report = (args: string[]): number => {
  const { values } = parseArgs({
    args,
    options: {
      input: { type: "string", multiple: true },
      out: { type: "string" },
      "out-dir": { type: "string" },
      png: { type: "boolean" },
    },
  });

  const results = readInputResults(values.input ?? []);

  if (values["out-dir"] !== undefined) {
    const outDir = nodePath.resolve(values["out-dir"]);
    const chartsDir = nodePath.join(outDir, "charts");
    mkdirSync(chartsDir, { recursive: true, mode: 0o700 });

    const summary = summarizeBenchmark(results);
    const charts = renderBenchmarkCharts(summary);

    for (const chart of charts) {
      const svgPath = nodePath.join(chartsDir, chart.filename);
      atomicWriteFile(svgPath, `${chart.svg}\n`);

      if (values.png === true) {
        exportPng(
          svgPath,
          nodePath.join(chartsDir, chart.filename.replace(/\.svg$/u, ".png"))
        );
      }
    }

    atomicWriteFile(
      nodePath.join(outDir, "summary.md"),
      renderDetailedReport(results, charts, "charts")
    );
    atomicWriteFile(
      nodePath.join(outDir, "report.html"),
      renderHtmlReport(summary, charts)
    );
    progress(
      `Wrote ${charts.length} chart(s), summary.md, and report.html -> ${outDir}`
    );

    return 0;
  }

  output(renderMarkdownReport(results), values.out);

  return 0;
};

const readInputResults = (inputs: readonly string[]): TrialResult[] => {
  if (inputs.length === 0) {
    throw new Error("Provide at least one --input <results.json>.");
  }

  const results: TrialResult[] = [];

  for (const inputPath of inputs) {
    results.push(...readResultsJson(inputPath));
  }

  return results;
};

const judge = async (args: string[]): Promise<number> => {
  const { values } = parseArgs({
    args,
    options: {
      input: { type: "string", multiple: true },
      out: { type: "string" },
      answers: { type: "string" },
      target: { type: "string" },
      "no-normalize": { type: "boolean" },
    },
  });

  const target = values.target ?? "reviewer";

  if (target !== "reviewer" && target !== "coder") {
    throw new Error("Set --target to reviewer or coder.");
  }

  const results = readInputResults(values.input ?? []);

  const packet =
    target === "coder"
      ? await exportCoderDiffJudgePacket(results, {
          normalize: values["no-normalize"] !== true,
        })
      : exportBlindJudgePacket(results);

  const result =
    values.answers === undefined
      ? packet
      : validateBlindJudgeAnswers(
          packet,
          parseJsonText(readFileSync(values.answers, "utf-8"))
        );

  output(`${JSON.stringify(result, null, 2)}\n`, values.out);

  return 0;
};

const craft = async (args: string[]): Promise<number> => {
  const { values } = parseArgs({
    args,
    options: {
      input: { type: "string", multiple: true },
      out: { type: "string" },
      markdown: { type: "boolean" },
      all: { type: "boolean" },
    },
  });

  const results = readInputResults(values.input ?? []);

  const craftReport = await analyzeTrialsCodeCraft(results, {
    passingOnly: values.all !== true,
  });

  const rendered =
    values.markdown === true
      ? renderCraftMarkdown(craftReport)
      : `${JSON.stringify(craftReport, null, 2)}\n`;

  output(rendered, values.out);

  return 0;
};

export const runCli = async (argv: readonly string[]): Promise<number> => {
  const [command, ...args] = argv;

  try {
    if (command === undefined) {
      throw new Error(
        "Usage: omkar-swe-bench <list|run|report|judge|craft> [options]"
      );
    }

    switch (command) {
      case "list": {
        return list(args);
      }

      case "run": {
        return await run(args);
      }

      case "report": {
        return report(args);
      }

      case "judge": {
        return await judge(args);
      }

      case "craft": {
        return await craft(args);
      }

      default: {
        throw new Error(
          "Usage: omkar-swe-bench <list|run|report|judge|craft> [options]"
        );
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));

    return 1;
  }
};

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
