import { randomBytes } from "node:crypto";
import { cpSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { parseModelSpec, validateModels } from "../config/models.ts";
import { buildTrialConfig, writeTrialConfig, type TrialConfigOptions } from "../config/prompts.ts";
import { loadProviderConfig, writeProviderConfig, type ProviderConfigOptions } from "../config/providers.ts";
import { startOpenCodeServer, type ServerHandle } from "../driver/server.ts";
import {
  errorDiagnostic, isRetryableApiFailure, runSession, waitForLocationReady, type SessionRunResult,
} from "../driver/session-runner.ts";
import { computeTelemetry } from "../driver/telemetry.ts";
import { captureGitState } from "../graders/git.ts";
import { extractSessionEvidence } from "../graders/trace.ts";
import { computeGradeResult, type GitState } from "../graders/types.ts";
import { buildTrialEnv } from "../sandbox/env.ts";
import { compileMountPlan, containsPath, type MountPlan } from "../sandbox/mount-plan.ts";
import {
  COMMIT_GUARD_PACKAGE, discoverHostToolDirs, discoverHostToolFiles, discoverOpenCodeCaches, discoverTsCompilerDirs,
  FORBIDDEN_HARNESS_MOUNT, linkHostTsNodeModules, prepareTrialTsBin, requireGlobalRuff, type TsCompilerDir,
} from "../sandbox/tools.ts";
import type { TaskSetupResult } from "../tasks/base.ts";
import { actualReviewerModels, reviewHandoffs } from "../tasks/pair/handoffs.ts";
import { assertNoSymlinkBoundary, ensureDir0700 } from "../util/fs.ts";
import { serializeSeededDefects, type RunConfig, type TrialJob, type TrialResult } from "./types.ts";

const stateDirs = ["repo", "home", "data", "state", "cache"];
const attemptDirs = [...stateDirs, "node_modules", "ts-bin", "config"];
const harnessRoot = resolve(import.meta.dir, "../..");
const startupTimeoutMs = 10_000;
const interruptedMessage = "The trial was interrupted.";
const interruptedError = `AbortError: ${interruptedMessage}`;

function emptyRun(exitCode = 0): SessionRunResult {
  return {
    rootSessionId: null, rootMessages: [], childMessagesBySessionId: new Map(),
    textStartedMsByMessageId: new Map(), scheduledRetries: 0, questionFormCount: 0,
    timedOut: false, interrupted: exitCode === 130, exitCode, errorDiagnostic: null,
  };
}

function startupFailure(cause: unknown, signal: AbortSignal): SessionRunResult {
  if (signal.aborted) return emptyRun(130);

  return { ...emptyRun(1), errorDiagnostic: errorDiagnostic(cause) };
}

function resetAttempt(trialDir: string): void {
  for (const name of [...attemptDirs, ...readdirSync(trialDir).filter((entry) => entry.startsWith("session.db"))]) {
    rmSync(join(trialDir, name), { recursive: true, force: true });
  }
}

function unlinkProvider(path: string | undefined): void {
  if (path === undefined) return;

  try {
    unlinkSync(path);
  } catch (cause) {
    if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") throw cause;
  }
}

async function backoff(attempt: number, retryAfterMs: number | null, signal: AbortSignal): Promise<void> {
  const jitteredMs = 2 ** (attempt - 1) * 1_000 + Math.floor(Math.random() * 500);

  try {
    await delay(Math.min(30_000, Math.max(jitteredMs, retryAfterMs ?? 0)), undefined, { signal });
  } catch (cause) {
    if (!signal.aborted) throw cause;
  }
}

function summarizeGit(state: GitState): string {
  return [state.committed, state.staged, state.unstaged]
    .map((diff, index) => diff ? `## ${["Committed", "Staged", "Unstaged"][index]}\n${diff}` : "")
    .concat(state.untracked.map(([path, digest]) => `Untracked: ${JSON.stringify(path)} (${digest})\n`))
    .join("");
}

function validateMountIsolation(plan: MountPlan, workspaceRoot: string, trialDir: string): void {
  for (const { source, target, isFile } of plan.binds) {
    if ([source, target].some((path) => FORBIDDEN_HARNESS_MOUNT.test(path))) {
      throw new Error("The trial mount plan contains a harness lint or AST tool.");
    }

    if ((!isFile && containsPath(source, workspaceRoot)) ||
      (containsPath(workspaceRoot, source) && !containsPath(trialDir, source))) {
      throw new Error(`Mount source ${source} would expose other trial workspaces.`);
    }
  }
}

export async function runTrial(job: TrialJob, options: RunConfig): Promise<TrialResult> {
  const result = await runTrialLifecycle(job, options);

  if (result === null) throw new Error("Trial did not return a result.");

  return result;
}

export async function validateTrialCatalog(
  job: TrialJob, options: RunConfig, specs: readonly string[],
): Promise<void> {
  await runTrialLifecycle(job, { ...options, keepWorkspaces: false }, specs);
}

async function runTrialLifecycle(
  job: TrialJob, options: RunConfig, catalogSpecs?: readonly string[],
): Promise<TrialResult | null> {
  const { task, model, reviewerModel, repetition } = job;
  const { sandboxed, dryRun, signal, keepWorkspaces } = options;

  if (catalogSpecs === undefined && task.needsRuff && !dryRun) {
    requireGlobalRuff();
  }

  const startedAt = performance.now();
  const trialId = `trial_${randomBytes(12).toString("hex")}`;
  const workspaceRoot = resolve(options.workspaceRoot);
  const runDir = join(workspaceRoot, options.runId);
  const trialDir = join(runDir, trialId);
  const repoDir = join(trialDir, "repo");
  const modelSpecs = reviewerModel === null ? [model] : [model, reviewerModel];
  const activeProviderIds = new Set(modelSpecs.map((spec) => parseModelSpec(spec).providerID));
  const tsCompilerDirs = catalogSpecs === undefined && task.needsTsCompiler ? discoverTsCompilerDirs(harnessRoot) : [];
  const hostToolFiles = sandboxed ? discoverHostToolFiles() : [];

  const resolvedHostToolDirs = sandboxed
    ? (hostToolFiles.length > 0 ? [join(trialDir, "host-bin")] : [])
    : discoverHostToolDirs();

  const { commitGuardCacheDir, opencodeBinCacheDir } = discoverOpenCodeCaches();

  if (catalogSpecs === undefined && task.commitGuard && !dryRun && commitGuardCacheDir === null) {
    throw new Error(`Cache ${COMMIT_GUARD_PACKAGE} in OpenCode before running commit-guard tasks.`);
  }

  const configDir = join(trialDir, "config", "opencode");
  let providerPath: string | undefined;
  let setup: TaskSetupResult | undefined;
  let profile = options.agentsFile === undefined ? "neutral" : `file:${basename(options.agentsFile)}`;
  let run = emptyRun();
  let spentRetryUsd = 0;
  let outerRetries = 0;

  async function prepareFixture() {
    for (const name of stateDirs) ensureDir0700(join(trialDir, name));

    const fixture = await task.setupRepo(repoDir);
    setup = fixture;
    const beforeGit = await captureGitState(repoDir, fixture.baselineHead);

    if (task.needsTsCompiler) prepareTrialTsBin(trialDir);

    if (!sandboxed && !dryRun) {
      linkHostTsNodeModules(trialDir, tsCompilerDirs);

      for (const [source, target] of [
        [task.commitGuard ? commitGuardCacheDir : null, join(trialDir, "cache", "opencode", "npm", COMMIT_GUARD_PACKAGE)],
        [opencodeBinCacheDir, join(trialDir, "cache", "opencode", "bin")],
      ] satisfies [string | null, string][]) {
        if (source !== null) cpSync(source, target, { recursive: true, verbatimSymlinks: true });
      }
    }

    return { fixture, beforeGit };
  }

  function writeConfig(setup: TaskSetupResult | undefined): string {
    let configOptions: TrialConfigOptions = {
      role: task.role,
      needsCommitGuard: catalogSpecs === undefined && task.commitGuard,
      reviewRequirements: setup?.reviewRequirements ?? "",
      reviewerBrief: setup?.reviewerBrief ?? "",
    };

    if (reviewerModel !== null) configOptions = { ...configOptions, reviewerModel };

    if (options.agentsFile !== undefined) configOptions = { ...configOptions, agentsFile: options.agentsFile };

    const { config, agent_profile } = buildTrialConfig(configOptions);
    writeTrialConfig(trialDir, config);

    return agent_profile;
  }

  if (basename(options.runId) !== options.runId || options.runId === "." || options.runId === ".." || !options.runId) {
    throw new Error("Use a single directory name for the run ID.");
  }

  ensureDir0700(runDir);
  assertNoSymlinkBoundary(runDir);
  ensureDir0700(trialDir);

  function resultIdentity() {
    return {
      task_id: task.id, role: task.role, category: task.category, model, reviewer_model: reviewerModel,
      repetition, repo_dir: repoDir, agent_profile: profile, session_id: run.rootSessionId, sandboxed,
      timed_out: run.timedOut, wall_s: (performance.now() - startedAt) / 1_000,
      planted_brief: setup?.reviewerBrief ?? "", task_spec: setup?.prompt ?? "",
      seeded_defects: serializeSeededDefects(setup?.seededDefects ?? []),
      ...computeTelemetry(run, outerRetries, spentRetryUsd),
    };
  }

  let isolateFailure = false;

  try {
    let providerOptions: ProviderConfigOptions = { activeProviderIds, dryRun };

    if (options.providersFile !== undefined) providerOptions = { ...providerOptions, providersFile: options.providersFile };

    const providers = loadProviderConfig(providerOptions);

    function planTrialSandbox(plan: {
      readonly readOnlyRepo: boolean;
      readonly tsDirs: readonly TsCompilerDir[];
      readonly guardDir: string | null;
      readonly persistDb: boolean;
    }) {
      const mountPlan = compileMountPlan({
        trialDir, repoDir, hostHome: homedir(), hostToolFiles, tsCompilerDirs: plan.tsDirs,
        opencodeBinCacheDir, readOnlyRepo: plan.readOnlyRepo,
        commitGuardCacheDir: plan.guardDir, extraRoFiles: providers.extraRoFiles,
      });

      validateMountIsolation(mountPlan, workspaceRoot, trialDir);

      const envVars = buildTrialEnv({
        trialDir, tsCompilerDirs: plan.tsDirs, resolvedHostToolDirs,
        keepWorkspaces: plan.persistDb, extraEnvNames: providers.extraEnvNames,
      });

      return { mountPlan, envVars };
    }

    if (catalogSpecs !== undefined) {
      for (const name of stateDirs) ensureDir0700(join(trialDir, name));

      ensureDir0700(configDir);
      profile = writeConfig(undefined);
      providerPath = writeProviderConfig(trialDir, providers);

      const { mountPlan, envVars } = planTrialSandbox({
        readOnlyRepo: true, tsDirs: [], guardDir: null, persistDb: false,
      });

      let server: ServerHandle | undefined;

      try {
        try {
          server = await startOpenCodeServer({ trialDir, repoDir, sandboxed, mountPlan, envVars, startupTimeoutMs, signal });

          if (!signal.aborted) {
            await waitForLocationReady(server.client, repoDir, activeProviderIds, signal);
            const warnings = await validateModels(catalogSpecs, { client: server.client, directory: repoDir });

            for (const warning of warnings) console.warn(warning);
          }
        } catch (cause) {
          const diagnostic = errorDiagnostic(cause);

          if (!signal.aborted && isRetryableApiFailure(diagnostic)) {
            console.warn("Could not query the isolated OpenCode catalog. Model and variant availability is unverified.");
          } else if (!signal.aborted) {
            throw cause;
          }
        }
      } finally {
        await server?.close();
      }

      return null;
    }

    async function prepareAttempt() {
      const attempt = await prepareFixture();
      ensureDir0700(configDir);
      profile = writeConfig(attempt.fixture);
      providerPath = writeProviderConfig(trialDir, providers);

      return attempt;
    }

    let { fixture, beforeGit } = await prepareAttempt();

    for (let attempt = 0; ; attempt += 1) {
      if (attempt > 0) {
        const { root_cost_usd, subagent_cost_usd } = computeTelemetry(run);
        const retryAfterMs = run.errorDiagnostic?.retryAfterMs ?? null;
        spentRetryUsd += root_cost_usd + subagent_cost_usd;
        outerRetries += 1;
        run = emptyRun();
        setup = undefined;
        resetAttempt(trialDir);
        ({ fixture, beforeGit } = await prepareAttempt());
        await backoff(attempt, retryAfterMs, signal);
      }

      if (signal.aborted) {
        run = emptyRun(130);
        break;
      }

      const { mountPlan, envVars } = planTrialSandbox({
        readOnlyRepo: task.readOnlyRepo, tsDirs: tsCompilerDirs,
        guardDir: task.commitGuard ? commitGuardCacheDir : null, persistDb: keepWorkspaces,
      });

      if (dryRun) break;

      let server: ServerHandle | undefined;

      try {
        try {
          server = await startOpenCodeServer({ trialDir, repoDir, sandboxed, mountPlan, envVars, startupTimeoutMs, signal });
        } catch (cause) {
          run = startupFailure(cause, signal);
        }

        if (server !== undefined && run.errorDiagnostic === null && !signal.aborted) {
          run = await runSession({
            client: server.client, exitPromise: server.exitPromise, repoDir, trialId, activeProviderIds,
            activeRole: task.role === "code-reviewer" ? "code-reviewer" : "coder",
            modelSpec: model, prompt: fixture.prompt, wallTimeoutMs: Math.round(task.timeoutSeconds * options.timeoutScale * 1_000),
            signal,
          });
        }
      } finally {
        await server?.close();
      }

      if (signal.aborted || attempt >= options.apiRetries || run.errorDiagnostic === null ||
        !isRetryableApiFailure(run.errorDiagnostic)) break;

      // Only the discarded run's cost and retry hint survive the next fixture reset.
    }

    const fixtureReady = dryRun && !signal.aborted;
    isolateFailure = !dryRun;
    const afterGit = dryRun ? beforeGit : await captureFinalGit(trialDir, tsCompilerDirs, repoDir, fixture, signal, beforeGit);
    const root = extractSessionEvidence(run.rootMessages, { timedOut: run.timedOut, sessionId: run.rootSessionId ?? "" });
    const tools = [...root.tools];
    const shellRuns = [...root.shellRuns];

    for (const [sessionId, messages] of run.childMessagesBySessionId) {
      const child = extractSessionEvidence(messages, { timedOut: run.timedOut, sessionId, isSubagent: true });
      const offset = tools.length;
      tools.push(...child.tools.map((tool) => ({ ...tool, index: offset + tool.index })));
      shellRuns.push(...child.shellRuns.map((shell) => ({ ...shell, index: offset + shell.index })));
    }

    const handoffs = task.role === "pair" && !signal.aborted
      ? await reviewHandoffs(repoDir, fixture.baselineHead, root.tools, root.shellRuns, run.childMessagesBySessionId) : [];

    const firstHandoff = handoffs[0];
    const reviewerText = firstHandoff?.reviewerFinalText ?? "";

    const reviewSpec = firstHandoff === undefined ? fixture.reviewSpecText
      : [firstHandoff.prompt, fixture.reviewRequirements].filter(Boolean).join("\n\n");

    const reviewerModels = actualReviewerModels(handoffs);

    const rawGrade = dryRun || signal.aborted ? computeGradeResult(fixtureReady ? { dry_run_fixture_ready: true } : {}, {
      timedOut: false, reviewDiff: fixture.reviewDiff,
    }) : await task.grade({
      ...root, repoDir, trialDir, tools, shellRuns, beforeGit, afterGit, baselineHead: fixture.baselineHead,
      reviewerText, reviewHandoffs: handoffs, actualReviewerModels: reviewerModels,
      timedOut: run.timedOut, questionFormCount: run.questionFormCount,
    }, fixture);

    const partial = signal.aborted || run.interrupted;
    const exitCode = partial ? 130 : run.exitCode;

    const checks = !dryRun && task.role === "pair" ? {
      ...rawGrade.checks, reviewer_model_matched: reviewerModels.length > 0 && reviewerModels.every((m) => m === reviewerModel),
    } : rawGrade.checks;

    const grade = computeGradeResult(checks, { ...rawGrade, timedOut: run.timedOut, exitCode, partial });
    const diagnostic = run.errorDiagnostic;

    const error = partial ? interruptedError : diagnostic === null ? null :
      `${diagnostic.status === null ? "" : `[status=${diagnostic.status}] `}${diagnostic.errorType}: ${diagnostic.message}`;

    return {
      ...resultIdentity(), exit_code: exitCode, partial,
      passed: grade.passed, score: grade.score, checks, notes: error === null ? grade.notes : [...grade.notes, error],
      pedantry_flags: grade.pedantryFlags, false_positive_p0_p2: grade.falsePositiveP0P2, nitpick_p3: grade.nitpickP3,
      defect_recall: grade.defectRecall, precision: grade.precision, scope_bounced: grade.scopeBounced,
      blocker_disclosed: grade.blockerDisclosed, final_text: root.finalText, transcript_text: root.transcriptText,
      reviewer_text: reviewerText, review_spec: reviewSpec, review_diff: grade.reviewDiff,
      git_diff: summarizeGit(afterGit), error_message: error,
    };
  } catch (cause) {
    if (catalogSpecs !== undefined) {
      if (signal.aborted) return null;

      throw cause;
    }

    if (!signal.aborted && !isolateFailure) throw cause;

    const interrupted = signal.aborted;
    const message = interrupted ? interruptedError : `${cause instanceof Error ? cause.name : "Error"}: ${cause instanceof Error ? cause.message : String(cause)}`;

    return {
      ...resultIdentity(), exit_code: interrupted ? 130 : 1, partial: interrupted, passed: false, score: 0, checks: {},
      notes: [message], pedantry_flags: 0, false_positive_p0_p2: 0, nitpick_p3: 0,
      defect_recall: null, precision: null, scope_bounced: false, blocker_disclosed: null,
      final_text: "", transcript_text: "", reviewer_text: "", review_spec: setup?.reviewSpecText ?? "",
      review_diff: setup?.reviewDiff ?? null, git_diff: "", error_message: message,
    };
  } finally {
    try {
      unlinkProvider(providerPath);
    } finally {
      if (!keepWorkspaces) rmSync(trialDir, { recursive: true, force: true });
    }
  }
}

async function captureFinalGit(
  trialDir: string, tsCompilerDirs: ReturnType<typeof discoverTsCompilerDirs>, repoDir: string,
  setup: TaskSetupResult, signal: AbortSignal, beforeGit: GitState,
): Promise<GitState> {
  try {
    linkHostTsNodeModules(trialDir, tsCompilerDirs);

    return await captureGitState(repoDir, setup.baselineHead);
  } catch (cause) {
    if (!signal.aborted) throw cause;

    return beforeGit;
  }
}
