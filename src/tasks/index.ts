import type { EvalTask } from "./base.ts";
import { CODER_TASKS } from "./coder/index.ts";
import { PAIR_TASKS } from "./pair/index.ts";
import { REVIEWER_TASKS } from "./reviewer/index.ts";

const TASKS: readonly EvalTask[] = [
  ...CODER_TASKS,
  ...REVIEWER_TASKS,
  ...PAIR_TASKS,
];

export const TASKS_BY_ID: ReadonlyMap<string, EvalTask> = new Map(
  TASKS.map((task) => [task.id, task])
);

if (TASKS_BY_ID.size !== TASKS.length) {
  throw new Error("Duplicate benchmark task IDs.");
}

export const tasksForPhase = (
  phase: "all" | "coder" | "reviewer" | "pair"
): readonly EvalTask[] => {
  switch (phase) {
    case "all": {
      return TASKS;
    }

    case "coder": {
      return CODER_TASKS;
    }

    case "reviewer": {
      return REVIEWER_TASKS;
    }

    case "pair": {
      return PAIR_TASKS;
    }

    default: {
      const unreachable: never = phase;

      throw new Error(`Unknown phase: ${String(unreachable)}`);
    }
  }
};
