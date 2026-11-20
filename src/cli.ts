#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { CODER_MODELS, PAIR_REVIEWER_MODELS, parseModelSpec, REVIEWER_MODELS, validateModels } from "./config/models.ts";
import { exportBlindJudgePacket, validateBlindJudgeAnswers } from "./judge/blind.ts";
import { renderBenchmarkCharts } from "./report/charts.ts";
import { renderHtmlReport } from "./report/html.ts";
import { readResultsJson, renderDetailedReport, renderMarkdownReport, writeResultsJson } from "./report/markdown.ts";
import { summarizeBenchmark } from "./report/scoring.ts";
import { runPool, scheduleTrials } from "./runner/pool.ts";
import { runTrial, validateTrialCatalog } from "./runner/run-trial.ts";
import type { RunConfig, TrialJob, TrialResult } from "./runner/types.ts";
import { probeSandbox, RunController } from "./sandbox/process.ts";
import { COMMIT_GUARD_PACKAGE, discoverOpenCodeCaches, refreshOpenCodeModelsCache, requireGlobalRuff } from "./sandbox/tools.ts";
import { TASKS_BY_ID, tasksForPhase } from "./tasks/index.ts";
import { atomicWriteFile } from "./util/fs.ts";
import { parseJsonText } from "./util/json.ts";

function phase(value = "all") {
  if (value === "all" || value === "coder" || value === "reviewer" || value === "pair") return value;

  throw new Error("Set --phase to all, coder, reviewer, or pair.");
}

function list(args: string[]): number {
  const { values } = parseArgs({ args, options: { phase: { type: "string" }, json: { type: "boolean" } } });

  const tasks = tasksForPhase(phase(values.phase)).map(({ id, role, category, language, timeoutSeconds, commitGuard }) => ({
    id, role, category, language, timeoutSeconds, commitGuard,
  }));

  if (values.json) {
    console.log(JSON.stringify(tasks, null, 2));
  } else {
    console.log("ID\tRole\tCategory\tLanguage\tTimeout (s)\tCommit guard");

    for (const { id, role, category, language, timeoutSeconds, commitGuard } of tasks) {
      console.log([id, role, category, language, timeoutSeconds, commitGuard].join("\t"));
    }
  }

  return 0;
}

function integerFlag(value: string | undefined, fallback: number, minimum: number, name: string): number {
  if (value === undefined) return fallback;

  const number = Number(value);

  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(number) || number < minimum) {
    throw new Error(`Set --${name} to an integer of at least ${minimum}.`);
  }

  return number;
}

async function sandboxEnabled(mode = "require"): Promise<boolean> {
  if (mode === "off") return false;

  if (mode !== "require" && mode !== "auto") throw new Error("Set --sandbox to require, auto, or off.");

  const { available, reason } = await probeSandbox();

  if (available) return true;

  if (mode === "require") throw new Error(`Sandbox unavailable: ${reason}`);

  console.warn(`Sandbox unavailable. Run without isolation: ${reason}`);

  return false;
}

function progress(line: string): void {
  process.stderr.write(`${line}\n`);
}

function modelLabel(model: string, reviewerModel: string | null): string {
  return reviewerModel === null ? model : `${model} -> ${reviewerModel}`;
}

function failureDetail(result: TrialResult): string {
  if (result.error_message !== null) return ` (${result.error_message})`;

  const failed = Object.entries(result.checks).flatMap(([name, ok]) => ok ? [] : [name]);

  return failed.length > 0 ? ` (${failed.join(", ")})` : "";
}

async function preflightCatalogs(jobs: readonly TrialJob[], options: RunConfig): Promise<void> {
  const catalogs = Map.groupBy(jobs, ({ model, reviewerModel }) => {
    const specs = reviewerModel === null ? [model] : [model, reviewerModel];
    const providers = new Set(specs.map((spec) => parseModelSpec(spec).providerID));

    return JSON.stringify(Array.from(providers).sort());
  });

  let index = 0;

  for (const group of catalogs.values()) {
    const [job] = group;

    if (job === undefined || options.signal.aborted) break;

    index += 1;
    const specs = new Set(group.flatMap(({ model, reviewerModel }) => reviewerModel === null ? [model] : [model, reviewerModel]));
    const providers = Array.from(new Set([...specs].map((spec) => parseModelSpec(spec).providerID))).sort();
    progress(`Preflighting catalog ${index}/${catalogs.size} (${providers.join(", ")})...`);
    await validateTrialCatalog(job, options, [...specs]);
  }
}

async function run(args: string[]): Promise<number> {
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
    if (!TASKS_BY_ID.has(id)) throw new Error(`Unknown task ID: ${id}`);

    if (!phaseTasks.some((task) => task.id === id)) throw new Error(`Task ${id} does not match --phase.`);
  }

  const requested = new Set(values.task);
  const tasks = requested.size === 0 ? phaseTasks : phaseTasks.filter((task) => requested.has(task.id));
  const coderModels = values["coder-model"] ?? CODER_MODELS;
  const reviewerModels = values["reviewer-model"] ?? REVIEWER_MODELS;
  const pairReviewerModels = values["reviewer-model"] ?? (values["all-pairs"] ? reviewerModels : PAIR_REVIEWER_MODELS);
  const trialsPerCell = integerFlag(values["trials-per-cell"], 1, 1, "trials-per-cell");
  const workers = integerFlag(values.workers, 4, 1, "workers");
  const apiRetries = integerFlag(values["api-retries"], 3, 0, "api-retries");
  const timeoutScale = Number(values["timeout-scale"] ?? "1");
  const dryRun = values["dry-run"] ?? false;

  if (!Number.isFinite(timeoutScale) || timeoutScale <= 0 ||
    tasks.some((task) => {
      const ms = Math.round(task.timeoutSeconds * timeoutScale * 1_000);

      return ms < 1 || ms > 2_147_483_647;
    })) throw new Error("Set --timeout-scale to a positive factor within timer limits.");

  const jobs = scheduleTrials({ tasks, coderModels, reviewerModels, pairReviewerModels, trialsPerCell });
  const modelSpecs = new Set([...(values["coder-model"] ?? []), ...(values["reviewer-model"] ?? [])]);

  for (const { model, reviewerModel } of jobs) {
    modelSpecs.add(model);

    if (reviewerModel !== null) modelSpecs.add(reviewerModel);
  }

  const syntaxWarnings = await validateModels([...modelSpecs]);

  if (dryRun) {
    for (const warning of syntaxWarnings) console.warn(warning);
  }

  const controller = new RunController();
  const signal = controller.signal;

  try {
    const sandboxed = await sandboxEnabled(values.sandbox);

    if (!signal.aborted && !dryRun && values.sandbox === "auto" && !sandboxed &&
      tasks.some((task) => task.role !== "code-reviewer")) {
      throw new Error("Cannot grade coder or pair trials without bubblewrap. No model prompts were sent.");
    }

    if (!signal.aborted && !dryRun && tasks.some((task) => task.commitGuard) &&
      discoverOpenCodeCaches().commitGuardCacheDir === null) {
      throw new Error(`Cache ${COMMIT_GUARD_PACKAGE} in OpenCode before running commit-guard tasks.`);
    }

    if (!signal.aborted && !dryRun && tasks.some((task) => task.needsRuff)) {
      requireGlobalRuff();
    }

    const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
    const runId = `${timestamp}-${randomBytes(4).toString("hex")}`;
    const out = resolve(values.out ?? join("results", timestamp));

    let options: RunConfig = {
      runId, workspaceRoot: resolve(values["workspace-root"] ?? "/tmp/opencode/omkar-swe-bench"), sandboxed,
      timeoutScale, apiRetries, keepWorkspaces: values["keep-workspaces"] ?? false, dryRun, signal,
    };

    if (values["providers-file"] !== undefined) options = { ...options, providersFile: values["providers-file"] };

    if (values["agents-file"] !== undefined) options = { ...options, agentsFile: values["agents-file"] };

    if (!dryRun && !signal.aborted) {
      progress(`Starting ${jobs.length} trial(s) (${Math.min(workers, jobs.length)} workers) -> ${out}`);
      progress("Refreshing OpenCode models catalog...");
      await refreshOpenCodeModelsCache(signal);
      await preflightCatalogs(jobs, options);
    }

    mkdirSync(out, { recursive: true, mode: 0o700 });
    const resultsPath = join(out, "results.json");
    let started = 0;
    let finished = 0;

    const results = await runPool(jobs, async (job) => {
      if (!dryRun) {
        started += 1;
        progress(`[start ${started}/${jobs.length}] ${job.task.id} | ${modelLabel(job.model, job.reviewerModel)}`);
      }

      const result = await runTrial(job, options);

      if (!dryRun) {
        finished += 1;
        const status = result.timed_out ? "TIMEOUT" : result.passed ? "PASS" : "FAIL";
        const pct = `${Math.round(result.score * 100)}%`.padStart(4);

        progress(
          `[${finished}/${jobs.length}] ${status} ${pct} | ${result.task_id} | ${modelLabel(result.model, result.reviewer_model)}`
          + ` | ${result.wall_s.toFixed(1)}s | $${result.total_cost_usd.toFixed(4)}${failureDetail(result)}`,
        );
      }

      return result;
    }, {
      signal,
      workers,
      onResult: (completed) => writeResultsJson(resultsPath, completed),
    });

    const summaryPath = join(out, "summary.md");
    writeResultsJson(resultsPath, results);
    atomicWriteFile(summaryPath, renderMarkdownReport(results));

    if (!dryRun) {
      const passed = results.filter((entry) => entry.passed).length;
      const totalCost = results.reduce((sum, entry) => sum + entry.total_cost_usd, 0);
      progress(`Done: ${passed}/${results.length} passed | $${totalCost.toFixed(4)} | ${summaryPath}`);
    }

    return signal.aborted ? 130 : 0;
  } catch (cause) {
    if (!signal.aborted) throw cause;

    return 130;
  } finally {
    controller.shutdown();
  }
}

function output(text: string, path: string | undefined): void {
  if (path === undefined) {
    process.stdout.write(text);
  } else {
    const resolved = resolve(path);
    mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 });
    atomicWriteFile(resolved, text);
  }
}

function exportPng(svgPath: string, pngPath: string): void {
  const rsvg = Bun.which("rsvg-convert");
  const resvg = rsvg === null ? Bun.which("resvg") : null;

  const cmd = rsvg !== null
    ? [rsvg, "--background-color=#0b1120", "-o", pngPath, svgPath]
    : resvg !== null
      ? [resvg, svgPath, pngPath]
      : null;

  if (cmd === null) {
    throw new Error("PNG export requires host rsvg-convert or resvg on PATH.");
  }

  const proc = Bun.spawnSync(cmd, { stdout: "ignore", stderr: "pipe" });

  if (proc.exitCode !== 0) {
    throw new Error(`PNG export failed for ${svgPath}: ${proc.stderr.toString().trim()}`);
  }
}

function report(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      input: { type: "string", multiple: true },
      out: { type: "string" },
      "out-dir": { type: "string" },
      png: { type: "boolean" },
    },
  });

  const inputs = values.input ?? [];

  if (inputs.length === 0) throw new Error("Provide at least one --input <results.json>.");

  const results: TrialResult[] = [];

  for (const inputPath of inputs) {
    results.push(...readResultsJson(inputPath));
  }

  if (values["out-dir"] !== undefined) {
    const outDir = resolve(values["out-dir"]);
    const chartsDir = join(outDir, "charts");
    mkdirSync(chartsDir, { recursive: true, mode: 0o700 });

    const summary = summarizeBenchmark(results);
    const charts = renderBenchmarkCharts(summary);

    for (const chart of charts) {
      const svgPath = join(chartsDir, chart.filename);
      atomicWriteFile(svgPath, `${chart.svg}\n`);

      if (values.png) {
        exportPng(svgPath, join(chartsDir, chart.filename.replace(/\.svg$/u, ".png")));
      }
    }

    atomicWriteFile(join(outDir, "summary.md"), renderDetailedReport(results, charts, "charts"));
    atomicWriteFile(join(outDir, "report.html"), renderHtmlReport(summary, charts));
    progress(`Wrote ${charts.length} chart(s), summary.md, and report.html -> ${outDir}`);

    return 0;
  }

  output(renderMarkdownReport(results), values.out);

  return 0;
}

function judge(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: { input: { type: "string" }, out: { type: "string" }, answers: { type: "string" } },
  });

  if (!values.input) throw new Error("Provide --input <results.json>.");

  const packet = exportBlindJudgePacket(readResultsJson(values.input));

  const result = values.answers === undefined ? packet
    : validateBlindJudgeAnswers(packet, parseJsonText(readFileSync(values.answers, "utf8")));

  output(`${JSON.stringify(result, null, 2)}\n`, values.out);

  return 0;
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const [command, ...args] = argv;

  try {
    switch (command) {
      case "list": return list(args);
      case "run": return await run(args);
      case "report": return report(args);
      case "judge": return judge(args);
      default: throw new Error("Usage: omkar-swe-bench <list|run|report|judge> [options]");
    }
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));

    return 1;
  }
}

if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2));
