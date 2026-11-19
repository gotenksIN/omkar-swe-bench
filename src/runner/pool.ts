import type { EvalTask } from "../tasks/base.ts";
import type { TrialJob, TrialResult } from "./types.ts";

interface TrialMatrix {
  readonly tasks: readonly EvalTask[];
  readonly coderModels: readonly string[];
  readonly reviewerModels: readonly string[];
  readonly pairReviewerModels: readonly string[];
  readonly trialsPerCell: number;
}

export function scheduleTrials(matrix: TrialMatrix): readonly TrialJob[] {
  const { tasks, coderModels, reviewerModels, pairReviewerModels, trialsPerCell } = matrix;
  const jobs: TrialJob[] = [];

  for (const task of tasks) {
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
}

interface PoolOptions {
  readonly workers?: number;
  readonly signal: AbortSignal;
  readonly onResult?: (completed: readonly TrialResult[]) => void;
}

export async function runPool(
  jobs: readonly TrialJob[],
  execute: (job: TrialJob, signal: AbortSignal) => Promise<TrialResult>,
  { workers = 4, signal, onResult }: PoolOptions,
): Promise<readonly TrialResult[]> {
  if (!Number.isSafeInteger(workers) || workers < 1) {
    throw new RangeError("Set workers to a positive integer.");
  }

  const results: (TrialResult | undefined)[] = Array.from({ length: jobs.length });
  let nextIndex = 0;
  let failed = false;

  function completedResults(): TrialResult[] {
    return results.flatMap((entry) => entry === undefined ? [] : [entry]);
  }

  async function work(): Promise<void> {
    while (!signal.aborted && !failed) {
      const index = nextIndex++;
      const job = jobs[index];

      if (job === undefined) return;

      try {
        const result = await execute(job, signal);
        results[index] = signal.aborted && !result.partial
          ? { ...result, partial: true, passed: false, exit_code: 130 }
          : result;
        onResult?.(completedResults());
      } catch (cause) {
        failed = true;
        throw cause;
      }
    }
  }

  const settled = await Promise.allSettled(Array.from({ length: Math.min(workers, jobs.length) }, work));
  const failure = settled.find((outcome) => outcome.status === "rejected");

  if (failure !== undefined) throw failure.reason;

  return completedResults();
}
