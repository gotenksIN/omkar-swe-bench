import type { CheckOutcomes, Defect } from "../graders/types.ts";
import type { EvalTask } from "../tasks/base.ts";

export interface SubagentTokenTotals {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly reasoning_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
}

export interface SeededDefectRecord {
  readonly id: string;
  readonly file: string;
  readonly line_range: readonly [number, number];
  readonly min_severity: 0 | 1 | 2 | 3;
  readonly concept_groups: readonly (readonly string[])[];
  readonly description: string;
}

export interface TrialResult {
  readonly task_id: string;
  readonly role: "coder" | "code-reviewer" | "pair";
  readonly category: string;
  readonly model: string;
  readonly agent_profile: string;
  readonly repo_dir: string;
  readonly repetition: number;
  readonly reviewer_model: string | null;
  readonly session_id: string | null;
  readonly exit_code: number;
  readonly timed_out: boolean;
  readonly partial: boolean;
  readonly sandboxed: boolean;
  readonly wall_s: number;
  readonly retries: number;
  readonly outer_retries: number;
  readonly first_ttfrt_s: number | null;
  readonly median_ttfrt_s: number | null;
  readonly first_ttfvt_s: number | null;
  readonly median_ttfvt_s: number | null;
  readonly output_decode_tok_per_s: number | null;
  readonly total_model_tok_per_s: number | null;
  readonly reasoning_share: number;
  readonly steps: number;
  readonly tool_calls: number;
  readonly tool_errors: number;
  readonly input_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
  readonly cache_hit_ratio: number;
  readonly output_tokens: number;
  readonly reasoning_tokens: number;
  readonly root_cost_usd: number;
  readonly subagent_cost_usd: number;
  readonly retry_cost_usd: number;
  readonly total_cost_usd: number;
  readonly subagent_tokens: SubagentTokenTotals;
  readonly subagent_tool_errors: number;
  readonly passed: boolean;
  readonly score: number;
  readonly checks: CheckOutcomes;
  readonly notes: readonly string[];
  readonly pedantry_flags: number;
  readonly false_positive_p0_p2: number;
  readonly nitpick_p3: number;
  readonly severity_overstated?: number;
  readonly defect_recall: number | null;
  readonly precision: number | null;
  readonly scope_bounced: boolean;
  readonly blocker_disclosed: boolean | null;
  readonly final_text: string;
  readonly transcript_text: string;
  readonly reviewer_text: string;
  readonly planted_brief: string;
  readonly review_spec: string;
  readonly review_diff: string | null;
  readonly repository_context?: Readonly<Record<string, string>>;
  readonly task_spec: string;
  readonly seeded_defects: readonly SeededDefectRecord[];
  readonly git_diff: string;
  readonly error_message: string | null;
}

export const serializeSeededDefects = (
  defects: readonly Defect[]
): readonly SeededDefectRecord[] =>
  defects.map(
    ({ id, file, lineRange, minSeverity, conceptGroups, description }) => ({
      id,
      file,
      line_range: lineRange,
      min_severity: minSeverity,
      concept_groups: conceptGroups,
      description,
    })
  );

export interface TrialJob {
  readonly task: EvalTask;
  readonly model: string;
  readonly reviewerModel: string | null;
  readonly repetition: number;
}

export interface RunConfig {
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly sandboxed: boolean;
  readonly providersFile?: string;
  readonly agentsFile?: string;
  readonly timeoutScale: number;
  readonly apiRetries: number;
  readonly keepWorkspaces: boolean;
  readonly dryRun: boolean;
  readonly signal: AbortSignal;
}
