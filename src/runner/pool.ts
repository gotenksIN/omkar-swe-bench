import { parseModelSpec } from "../config/models.ts";
import type { EvalTask } from "../tasks/base.ts";
import type { TrialJob, TrialResult } from "./types.ts";

interface TrialMatrix {
  readonly tasks: readonly EvalTask[];
  readonly coderModels: readonly string[];
  readonly reviewerModels: readonly string[];
  readonly pairReviewerModels: readonly string[];
  readonly trialsPerCell: number;
}

export const scheduleTrials = (matrix: TrialMatrix): readonly TrialJob[] => {
  const {
    tasks,
    coderModels,
    reviewerModels,
    pairReviewerModels,
    trialsPerCell,
  } = matrix;

  const jobs: TrialJob[] = [];

  for (const task of tasks.toReversed()) {
    const models = task.role === "code-reviewer" ? reviewerModels : coderModels;
    const reviewers = task.role === "pair" ? pairReviewerModels : [null];

    for (const model of models) {
      for (const reviewerModel of reviewers) {
        for (let repetition = 1; repetition <= trialsPerCell; repetition += 1) {
          jobs.push({ task, model, reviewerModel, repetition });
        }
      }
    }
  }

  return jobs;
};

interface PoolOptions {
  readonly workers?: number;
  readonly maxPerProvider?: number;
  readonly signal: AbortSignal;
  readonly onResult?: (completed: readonly TrialResult[]) => void;
}

const jobProviders = (job: TrialJob): readonly string[] => {
  const providers = new Set([parseModelSpec(job.model).providerID]);

  if (job.reviewerModel !== null) {
    providers.add(parseModelSpec(job.reviewerModel).providerID);
  }

  return [...providers];
};

export const runPool = async (
  jobs: readonly TrialJob[],
  execute: (job: TrialJob, signal: AbortSignal) => Promise<TrialResult>,
  { workers = 4, maxPerProvider = 2, signal, onResult }: PoolOptions
): Promise<readonly TrialResult[]> => {
  if (!Number.isSafeInteger(workers) || workers < 1) {
    throw new RangeError("Set workers to a positive integer.");
  }

  if (!Number.isSafeInteger(maxPerProvider) || maxPerProvider < 1) {
    throw new RangeError("Set maxPerProvider to a positive integer.");
  }

  const results: (TrialResult | undefined)[] = Array.from({
    length: jobs.length,
  });

  const pending = jobs.map((job, index) => ({
    index,
    job,
    providers: jobProviders(job),
  }));

  const activeByProvider = new Map<string, number>();
  const inFlight = new Set<Promise<void>>();
  const done = Promise.withResolvers<undefined>();
  let activeTotal = 0;
  let hasError = false;
  let firstError: unknown;

  const completedResults = (): TrialResult[] =>
    results.flatMap((entry) => (entry === undefined ? [] : [entry]));

  const canRun = (providers: readonly string[]): boolean =>
    providers.every(
      (provider) => (activeByProvider.get(provider) ?? 0) < maxPerProvider
    );

  const launch = (entry: (typeof pending)[number]): void => {
    for (const provider of entry.providers) {
      activeByProvider.set(provider, (activeByProvider.get(provider) ?? 0) + 1);
    }

    const runEntry = async (): Promise<void> => {
      try {
        const result = await execute(entry.job, signal);
        results[entry.index] =
          signal.aborted && !result.partial
            ? { ...result, partial: true, passed: false, exit_code: 130 }
            : result;
        onResult?.(completedResults());
      } catch (error) {
        if (!hasError) {
          hasError = true;
          firstError = error;
        }
      } finally {
        activeTotal -= 1;

        for (const provider of entry.providers) {
          const remaining = (activeByProvider.get(provider) ?? 1) - 1;

          if (remaining <= 0) {
            activeByProvider.delete(provider);
          } else {
            activeByProvider.set(provider, remaining);
          }
        }

        inFlight.delete(task);
        dispatch();

        if (inFlight.size === 0) {
          done.resolve(undefined);
        }
      }
    };

    const task = runEntry();
    inFlight.add(task);
  };

  const dispatch = (): void => {
    if (hasError) {
      return;
    }

    while (!signal.aborted && activeTotal < workers) {
      const nextPos = pending.findIndex(({ providers }) => canRun(providers));

      if (nextPos === -1) {
        break;
      }

      const [entry] = pending.splice(nextPos, 1);

      if (entry === undefined) {
        break;
      }

      activeTotal += 1;
      launch(entry);
    }
  };

  dispatch();

  if (inFlight.size > 0) {
    await done.promise;
  }

  if (hasError) {
    throw firstError;
  }

  return completedResults();
};
