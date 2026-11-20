import { randomBytes } from "node:crypto";
import { cpSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import nodePath from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { parseModelSpec, validateModels } from "../config/models.ts";
import { buildTrialConfig, writeTrialConfig } from "../config/prompts.ts";
import type { TrialConfigOptions } from "../config/prompts.ts";
import {
  loadProviderConfig,
  writeProviderConfig,
} from "../config/providers.ts";
import type { ProviderConfigOptions } from "../config/providers.ts";
import { startOpenCodeServer } from "../driver/server.ts";
import type { ServerHandle } from "../driver/server.ts";
import {
  errorDiagnostic,
  isRetryableApiFailure,
  runSession,
  waitForLocationReady,
} from "../driver/session-runner.ts";
import type { SessionRunResult } from "../driver/session-runner.ts";
import { computeTelemetry } from "../driver/telemetry.ts";
import { captureGitState } from "../graders/git.ts";
import { extractSessionEvidence } from "../graders/trace.ts";
import { computeGradeResult } from "../graders/types.ts";
import type { GitState } from "../graders/types.ts";
import { buildTrialEnv } from "../sandbox/env.ts";
import { compileMountPlan, containsPath } from "../sandbox/mount-plan.ts";
import type { MountPlan } from "../sandbox/mount-plan.ts";
import {
  COMMIT_GUARD_PACKAGE,
  discoverHostToolDirs,
  discoverHostToolFiles,
  discoverOpenCodeCaches,
  discoverTsCompilerDirs,
  FORBIDDEN_HARNESS_MOUNT,
  linkHostTsNodeModules,
  prepareTrialTsBin,
  requireGlobalRuff,
} from "../sandbox/tools.ts";
import type { TsCompilerDir } from "../sandbox/tools.ts";
import type { TaskSetupResult } from "../tasks/base.ts";
import {
  actualReviewerModels,
  reviewHandoffs,
} from "../tasks/pair/handoffs.ts";
import { assertNoSymlinkBoundary, ensureDir0700 } from "../util/fs.ts";
import { serializeSeededDefects } from "./types.ts";
import type { RunConfig, TrialJob, TrialResult } from "./types.ts";

const stateDirs = ["repo", "home", "data", "state", "cache"];
const attemptDirs = [...stateDirs, "node_modules", "ts-bin", "config"];
const harnessRoot = nodePath.resolve(import.meta.dir, "../..");
const startupTimeoutMs = 10_000;
const interruptedMessage = "The trial was interrupted.";
const interruptedError = `AbortError: ${interruptedMessage}`;

const emptyRun = (exitCode = 0): SessionRunResult => ({
  rootSessionId: null,
  rootMessages: [],
  childMessagesBySessionId: new Map(),
  textStartedMsByMessageId: new Map(),
  scheduledRetries: 0,
  questionFormCount: 0,
  timedOut: false,
  interrupted: exitCode === 130,
  exitCode,
  errorDiagnostic: null,
});

const startupFailure = (
  cause: unknown,
  signal: AbortSignal
): SessionRunResult => {
  if (signal.aborted) {
    return emptyRun(130);
  }

  return { ...emptyRun(1), errorDiagnostic: errorDiagnostic(cause) };
};

const resetAttempt = (trialDir: string): void => {
  for (const name of [
    ...attemptDirs,
    ...readdirSync(trialDir).filter((entry) => entry.startsWith("session.db")),
  ]) {
    rmSync(nodePath.join(trialDir, name), { recursive: true, force: true });
  }
};

const unlinkProvider = (path: string | undefined): void => {
  if (path === undefined) {
    return;
  }

  try {
    unlinkSync(path);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
};

const backoff = async (
  attempt: number,
  retryAfterMs: number | null,
  signal: AbortSignal
): Promise<void> => {
  const jitteredMs =
    2 ** (attempt - 1) * 1000 + Math.floor(Math.random() * 500);

  try {
    await delay(
      Math.min(30_000, Math.max(jitteredMs, retryAfterMs ?? 0)),
      undefined,
      { signal }
    );
  } catch (error) {
    if (!signal.aborted) {
      throw error;
    }
  }
};

const summarizeGit = (state: GitState): string =>
  [
    ...[state.committed, state.staged, state.unstaged].map((diff, index) =>
      diff ? `## ${["Committed", "Staged", "Unstaged"][index]}\n${diff}` : ""
    ),
    ...state.untracked.map(
      ([path, digest]) => `Untracked: ${JSON.stringify(path)} (${digest})\n`
    ),
  ].join("");

const resolveHostToolDirs = (
  sandboxed: boolean,
  hostToolFilesCount: number,
  trialDir: string
): string[] => {
  if (!sandboxed) {
    return discoverHostToolDirs();
  }

  return hostToolFilesCount > 0 ? [nodePath.join(trialDir, "host-bin")] : [];
};

const resolveModelsCatalogPath = (
  sandboxed: boolean,
  opencodeModelsCacheFile: string | null,
  trialDir: string
): string | null => {
  if (opencodeModelsCacheFile === null) {
    return null;
  }

  return sandboxed
    ? nodePath.join(trialDir, "cache", "opencode", "models.json")
    : opencodeModelsCacheFile;
};

const formatRunError = (
  partial: boolean,
  diagnostic: SessionRunResult["errorDiagnostic"]
): string | null => {
  if (partial) {
    return interruptedError;
  }

  if (diagnostic === null) {
    return null;
  }

  const statusPrefix =
    diagnostic.status === null ? "" : `[status=${diagnostic.status}] `;

  return `${statusPrefix}${diagnostic.errorType}: ${diagnostic.message}`;
};

const mergeChildEvidence = (
  run: SessionRunResult,
  root: ReturnType<typeof extractSessionEvidence>
) => {
  const tools = [...root.tools];
  const shellRuns = [...root.shellRuns];

  for (const [sessionId, messages] of run.childMessagesBySessionId) {
    const child = extractSessionEvidence(messages, {
      timedOut: run.timedOut,
      sessionId,
      isSubagent: true,
    });

    const offset = tools.length;
    tools.push(
      ...child.tools.map((tool) => ({ ...tool, index: offset + tool.index }))
    );
    shellRuns.push(
      ...child.shellRuns.map((shell) => ({
        ...shell,
        index: offset + shell.index,
      }))
    );
  }

  return { tools, shellRuns };
};

const formatUnexpectedError = (
  cause: unknown,
  interrupted: boolean
): string => {
  if (interrupted) {
    return interruptedError;
  }

  const name = cause instanceof Error ? cause.name : "Error";
  const detail = cause instanceof Error ? cause.message : String(cause);

  return `${name}: ${detail}`;
};

const loadProvidersForTrial = (
  activeProviderIds: ReadonlySet<string>,
  dryRun: boolean,
  providersFile: string | undefined
) => {
  let providerOptions: ProviderConfigOptions = { activeProviderIds, dryRun };

  if (providersFile !== undefined) {
    providerOptions = { ...providerOptions, providersFile };
  }

  return loadProviderConfig(providerOptions);
};

const assertValidRunId = (runId: string): void => {
  if (
    nodePath.basename(runId) !== runId ||
    runId === "." ||
    runId === ".." ||
    !runId
  ) {
    throw new Error("Use a single directory name for the run ID.");
  }
};

const assertTrialPrerequisites = (
  task: TrialJob["task"],
  catalogSpecs: readonly string[] | undefined,
  dryRun: boolean,
  commitGuardCacheDir: string | null
): void => {
  if (catalogSpecs !== undefined || dryRun) {
    return;
  }

  if (task.needsRuff) {
    requireGlobalRuff();
  }

  if (task.commitGuard && commitGuardCacheDir === null) {
    throw new Error(
      `Cache ${COMMIT_GUARD_PACKAGE} in OpenCode before running commit-guard tasks.`
    );
  }
};

const validateMountIsolation = (
  plan: MountPlan,
  workspaceRoot: string,
  trialDir: string
): void => {
  for (const { source, target, isFile } of plan.binds) {
    if ([source, target].some((path) => FORBIDDEN_HARNESS_MOUNT.test(path))) {
      throw new Error(
        "The trial mount plan contains a harness lint or AST tool."
      );
    }

    if (
      (!isFile && containsPath(source, workspaceRoot)) ||
      (containsPath(workspaceRoot, source) && !containsPath(trialDir, source))
    ) {
      throw new Error(
        `Mount source ${source} would expose other trial workspaces.`
      );
    }
  }
};

export const runTrial = async (
  job: TrialJob,
  options: RunConfig
): Promise<TrialResult> => {
  const result = await runTrialLifecycle(job, options);

  if (result === null) {
    throw new Error("Trial did not return a result.");
  }

  return result;
};

export const validateTrialCatalog = async (
  job: TrialJob,
  options: RunConfig,
  specs: readonly string[]
): Promise<void> => {
  await runTrialLifecycle(job, { ...options, keepWorkspaces: false }, specs);
};

const runTrialLifecycle = async (
  job: TrialJob,
  options: RunConfig,
  catalogSpecs?: readonly string[]
): Promise<TrialResult | null> => {
  const { task, model, reviewerModel, repetition } = job;
  const { sandboxed, dryRun, signal, keepWorkspaces } = options;

  const { commitGuardCacheDir, opencodeBinCacheDir, opencodeModelsCacheFile } =
    discoverOpenCodeCaches();

  assertTrialPrerequisites(task, catalogSpecs, dryRun, commitGuardCacheDir);

  const startedAt = performance.now();
  const trialId = `trial_${randomBytes(12).toString("hex")}`;
  const workspaceRoot = nodePath.resolve(options.workspaceRoot);
  const runDir = nodePath.join(workspaceRoot, options.runId);
  const trialDir = nodePath.join(runDir, trialId);
  const repoDir = nodePath.join(trialDir, "repo");
  const modelSpecs = reviewerModel === null ? [model] : [model, reviewerModel];

  const activeProviderIds = new Set(
    modelSpecs.map((spec) => parseModelSpec(spec).providerID)
  );

  const tsCompilerDirs =
    catalogSpecs === undefined && task.needsTsCompiler
      ? discoverTsCompilerDirs(harnessRoot)
      : [];

  const hostToolFiles = sandboxed ? discoverHostToolFiles() : [];

  const resolvedHostToolDirs = resolveHostToolDirs(
    sandboxed,
    hostToolFiles.length,
    trialDir
  );

  const resolvedModelsCatalogPath = resolveModelsCatalogPath(
    sandboxed,
    opencodeModelsCacheFile,
    trialDir
  );

  const configDir = nodePath.join(trialDir, "config", "opencode");
  let providerPath: string | undefined;
  let setup: TaskSetupResult | undefined;

  let profile =
    options.agentsFile === undefined
      ? "neutral"
      : `file:${nodePath.basename(options.agentsFile)}`;

  let run = emptyRun();
  let spentRetryUsd = 0;
  let outerRetries = 0;

  const prepareFixture = async () => {
    for (const name of stateDirs) {
      ensureDir0700(nodePath.join(trialDir, name));
    }

    const fixture = await task.setupRepo(repoDir);
    setup = fixture;
    const beforeGit = await captureGitState(repoDir, fixture.baselineHead);

    if (task.needsTsCompiler) {
      prepareTrialTsBin(trialDir);
    }

    if (!sandboxed && !dryRun) {
      linkHostTsNodeModules(trialDir, tsCompilerDirs);

      for (const [source, target] of [
        [
          task.commitGuard ? commitGuardCacheDir : null,
          nodePath.join(
            trialDir,
            "cache",
            "opencode",
            "npm",
            COMMIT_GUARD_PACKAGE
          ),
        ],
        [
          opencodeBinCacheDir,
          nodePath.join(trialDir, "cache", "opencode", "bin"),
        ],
      ] satisfies [string | null, string][]) {
        if (source !== null) {
          cpSync(source, target, { recursive: true, verbatimSymlinks: true });
        }
      }
    }

    return { fixture, beforeGit };
  };

  const writeConfig = (taskSetup: TaskSetupResult | undefined): string => {
    let configOptions: TrialConfigOptions = {
      role: task.role,
      needsCommitGuard: catalogSpecs === undefined && task.commitGuard,
      reviewRequirements: taskSetup?.reviewRequirements ?? "",
      reviewerBrief: taskSetup?.reviewerBrief ?? "",
    };

    if (reviewerModel !== null) {
      configOptions = { ...configOptions, reviewerModel };
    }

    if (options.agentsFile !== undefined) {
      configOptions = { ...configOptions, agentsFile: options.agentsFile };
    }

    const { config, agent_profile } = buildTrialConfig(configOptions);
    writeTrialConfig(trialDir, config);

    return agent_profile;
  };

  assertValidRunId(options.runId);

  ensureDir0700(runDir);
  assertNoSymlinkBoundary(runDir);
  ensureDir0700(trialDir);

  const resultIdentity = () => ({
    task_id: task.id,
    role: task.role,
    category: task.category,
    model,
    reviewer_model: reviewerModel,
    repetition,
    repo_dir: repoDir,
    agent_profile: profile,
    session_id: run.rootSessionId,
    sandboxed,
    timed_out: run.timedOut,
    wall_s: (performance.now() - startedAt) / 1000,
    planted_brief: setup?.reviewerBrief ?? "",
    task_spec: setup?.prompt ?? "",
    seeded_defects: serializeSeededDefects(setup?.seededDefects ?? []),
    ...computeTelemetry(run, outerRetries, spentRetryUsd),
  });

  let isolateFailure = false;

  try {
    const providers = loadProvidersForTrial(
      activeProviderIds,
      dryRun,
      options.providersFile
    );

    const planTrialSandbox = (plan: {
      readonly readOnlyRepo: boolean;
      readonly tsDirs: readonly TsCompilerDir[];
      readonly guardDir: string | null;
      readonly persistDb: boolean;
    }) => {
      const mountPlan = compileMountPlan({
        trialDir,
        repoDir,
        hostHome: homedir(),
        hostToolFiles,
        tsCompilerDirs: plan.tsDirs,
        opencodeBinCacheDir,
        opencodeModelsCacheFile,
        readOnlyRepo: plan.readOnlyRepo,
        commitGuardCacheDir: plan.guardDir,
        extraRoFiles: providers.extraRoFiles,
      });

      validateMountIsolation(mountPlan, workspaceRoot, trialDir);

      const envVars = buildTrialEnv({
        trialDir,
        tsCompilerDirs: plan.tsDirs,
        resolvedHostToolDirs,
        keepWorkspaces: plan.persistDb,
        extraEnvNames: providers.extraEnvNames,
        modelsCatalogPath: resolvedModelsCatalogPath,
      });

      return { mountPlan, envVars };
    };

    const runCatalogCheck = async (specs: readonly string[]): Promise<void> => {
      for (const name of stateDirs) {
        ensureDir0700(nodePath.join(trialDir, name));
      }

      ensureDir0700(configDir);
      profile = writeConfig(undefined);
      providerPath = writeProviderConfig(trialDir, providers);

      const { mountPlan, envVars } = planTrialSandbox({
        readOnlyRepo: true,
        tsDirs: [],
        guardDir: null,
        persistDb: false,
      });

      let server: ServerHandle | undefined;

      try {
        try {
          server = await startOpenCodeServer({
            trialDir,
            repoDir,
            sandboxed,
            mountPlan,
            envVars,
            startupTimeoutMs,
            signal,
          });

          if (!signal.aborted) {
            await waitForLocationReady(
              server.client,
              repoDir,
              activeProviderIds,
              signal
            );

            const warnings = await validateModels(specs, {
              client: server.client,
              directory: repoDir,
            });

            for (const warning of warnings) {
              console.warn(warning);
            }
          }
        } catch (error_) {
          const diagnostic = errorDiagnostic(error_);

          if (!signal.aborted && isRetryableApiFailure(diagnostic)) {
            console.warn(
              "Could not query the isolated OpenCode catalog. Model and variant availability is unverified."
            );
          } else if (!signal.aborted) {
            throw error_;
          }
        }
      } finally {
        await server?.close();
      }
    };

    if (catalogSpecs !== undefined) {
      await runCatalogCheck(catalogSpecs);

      return null;
    }

    const prepareAttempt = async () => {
      const attempt = await prepareFixture();
      ensureDir0700(configDir);
      profile = writeConfig(attempt.fixture);
      providerPath = writeProviderConfig(trialDir, providers);

      return attempt;
    };

    const runSingleAttempt = async (
      fixture: TaskSetupResult
    ): Promise<SessionRunResult> => {
      const { mountPlan, envVars } = planTrialSandbox({
        readOnlyRepo: task.readOnlyRepo,
        tsDirs: tsCompilerDirs,
        guardDir: task.commitGuard ? commitGuardCacheDir : null,
        persistDb: keepWorkspaces,
      });

      if (dryRun) {
        return run;
      }

      let server: ServerHandle | undefined;
      let attemptRun = emptyRun();

      try {
        try {
          server = await startOpenCodeServer({
            trialDir,
            repoDir,
            sandboxed,
            mountPlan,
            envVars,
            startupTimeoutMs,
            signal,
          });
        } catch (error_) {
          attemptRun = startupFailure(error_, signal);
        }

        if (
          server !== undefined &&
          attemptRun.errorDiagnostic === null &&
          !signal.aborted
        ) {
          attemptRun = await runSession({
            client: server.client,
            exitPromise: server.exitPromise,
            repoDir,
            trialId,
            activeProviderIds,
            activeRole:
              task.role === "code-reviewer" ? "code-reviewer" : "coder",
            modelSpec: model,
            prompt: fixture.prompt,
            wallTimeoutMs: Math.round(
              task.timeoutSeconds * options.timeoutScale * 1000
            ),
            signal,
          });
        }
      } finally {
        await server?.close();
      }

      return attemptRun;
    };

    const executeWithRetries = async (
      attempt: number,
      current: { fixture: TaskSetupResult; beforeGit: GitState }
    ): Promise<{ fixture: TaskSetupResult; beforeGit: GitState }> => {
      let state = current;

      if (attempt > 0) {
        const { root_cost_usd, subagent_cost_usd } = computeTelemetry(run);
        const retryAfterMs = run.errorDiagnostic?.retryAfterMs ?? null;
        spentRetryUsd += root_cost_usd + subagent_cost_usd;
        outerRetries += 1;
        run = emptyRun();
        setup = undefined;
        resetAttempt(trialDir);
        state = await prepareAttempt();
        await backoff(attempt, retryAfterMs, signal);
      }

      if (signal.aborted) {
        run = emptyRun(130);

        return state;
      }

      run = await runSingleAttempt(state.fixture);

      if (
        dryRun ||
        signal.aborted ||
        attempt >= options.apiRetries ||
        run.errorDiagnostic === null ||
        !isRetryableApiFailure(run.errorDiagnostic)
      ) {
        return state;
      }

      return await executeWithRetries(attempt + 1, state);
    };

    const buildFinalResult = async (
      fixture: TaskSetupResult,
      beforeGit: GitState
    ): Promise<TrialResult> => {
      const fixtureReady = dryRun && !signal.aborted;
      isolateFailure = !dryRun;

      const afterGit = dryRun
        ? beforeGit
        : await captureFinalGit(
            trialDir,
            tsCompilerDirs,
            repoDir,
            fixture,
            signal,
            beforeGit
          );

      const root = extractSessionEvidence(run.rootMessages, {
        timedOut: run.timedOut,
        sessionId: run.rootSessionId ?? "",
      });

      const { tools, shellRuns } = mergeChildEvidence(run, root);

      const handoffs =
        task.role === "pair" && !signal.aborted
          ? await reviewHandoffs(
              repoDir,
              fixture.baselineHead,
              root.tools,
              root.shellRuns,
              run.childMessagesBySessionId,
              { timedOut: run.timedOut }
            )
          : [];

      const [firstHandoff] = handoffs;
      const reviewerText = firstHandoff?.reviewerFinalText ?? "";

      const reviewSpec =
        firstHandoff === undefined
          ? fixture.reviewSpecText
          : [firstHandoff.prompt, fixture.reviewRequirements]
              .filter(Boolean)
              .join("\n\n");

      const reviewerModels = actualReviewerModels(handoffs);

      const rawGrade =
        dryRun || signal.aborted
          ? computeGradeResult(
              fixtureReady ? { dry_run_fixture_ready: true } : {},
              {
                timedOut: false,
                reviewDiff: fixture.reviewDiff,
              }
            )
          : await task.grade(
              {
                ...root,
                repoDir,
                trialDir,
                tools,
                shellRuns,
                beforeGit,
                afterGit,
                baselineHead: fixture.baselineHead,
                reviewerText,
                reviewHandoffs: handoffs,
                actualReviewerModels: reviewerModels,
                timedOut: run.timedOut,
                questionFormCount: run.questionFormCount,
              },
              fixture
            );

      const partial = signal.aborted || run.interrupted;
      const exitCode = partial ? 130 : run.exitCode;

      const checks =
        !dryRun && task.role === "pair"
          ? {
              ...rawGrade.checks,
              reviewer_model_matched:
                reviewerModels.length > 0 &&
                reviewerModels.every((m) => m === reviewerModel),
            }
          : rawGrade.checks;

      const grade = computeGradeResult(checks, {
        ...rawGrade,
        timedOut: run.timedOut,
        exitCode,
        partial,
      });

      const error = formatRunError(partial, run.errorDiagnostic);

      return {
        ...resultIdentity(),
        exit_code: exitCode,
        partial,
        passed: grade.passed,
        score: grade.score,
        checks,
        notes: error === null ? grade.notes : [...grade.notes, error],
        pedantry_flags: grade.pedantryFlags,
        false_positive_p0_p2: grade.falsePositiveP0P2,
        nitpick_p3: grade.nitpickP3,
        severity_overstated: grade.severityOverstated,
        defect_recall: grade.defectRecall,
        precision: grade.precision,
        scope_bounced: grade.scopeBounced,
        blocker_disclosed: grade.blockerDisclosed,
        final_text: root.finalText,
        transcript_text: root.transcriptText,
        reviewer_text: reviewerText,
        review_spec: reviewSpec,
        review_diff: grade.reviewDiff,
        git_diff: summarizeGit(afterGit),
        error_message: error,
      };
    };

    const { fixture, beforeGit } = await executeWithRetries(
      0,
      await prepareAttempt()
    );

    return await buildFinalResult(fixture, beforeGit);
  } catch (error) {
    if (catalogSpecs !== undefined) {
      if (signal.aborted) {
        return null;
      }

      throw error;
    }

    if (!signal.aborted && !isolateFailure) {
      throw error;
    }

    const interrupted = signal.aborted;
    const message = formatUnexpectedError(error, interrupted);

    return {
      ...resultIdentity(),
      exit_code: interrupted ? 130 : 1,
      partial: interrupted,
      passed: false,
      score: 0,
      checks: {},
      notes: [message],
      pedantry_flags: 0,
      false_positive_p0_p2: 0,
      nitpick_p3: 0,
      severity_overstated: 0,
      defect_recall: null,
      precision: null,
      scope_bounced: false,
      blocker_disclosed: null,
      final_text: "",
      transcript_text: "",
      reviewer_text: "",
      review_spec: setup?.reviewSpecText ?? "",
      review_diff: setup?.reviewDiff ?? null,
      git_diff: "",
      error_message: message,
    };
  } finally {
    try {
      unlinkProvider(providerPath);
    } finally {
      if (!keepWorkspaces) {
        rmSync(trialDir, { recursive: true, force: true });
      }
    }
  }
};

const captureFinalGit = async (
  trialDir: string,
  tsCompilerDirs: ReturnType<typeof discoverTsCompilerDirs>,
  repoDir: string,
  setup: TaskSetupResult,
  signal: AbortSignal,
  beforeGit: GitState
): Promise<GitState> => {
  try {
    linkHostTsNodeModules(trialDir, tsCompilerDirs);

    return await captureGitState(repoDir, setup.baselineHead);
  } catch (error) {
    if (!signal.aborted) {
      throw error;
    }

    return beforeGit;
  }
};
