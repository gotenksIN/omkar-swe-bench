import { median } from "../driver/telemetry.ts";
import type { TaskRole } from "../graders/types.ts";
import type { TrialResult } from "../runner/types.ts";

export type FailureTier =
  | "clean_pass"
  | "self_healed_friction"
  | "hygiene_nudge"
  | "broken_deliverable"
  | "timeout_crash";

export interface DiffMetrics {
  readonly addedLines: number;
  readonly removedLines: number;
}

export interface TrialAutonomyScore {
  readonly trial: TrialResult;
  readonly lsas: number;
  readonly zsdr: boolean;
  readonly tier: FailureTier;
  readonly rootToolErrors: number;
  readonly failedTierA: readonly string[];
  readonly failedTierB: readonly string[];
  readonly failedTierC: readonly string[];
  readonly diff: DiffMetrics;
}

export interface TierCounts {
  readonly clean_pass: number;
  readonly self_healed_friction: number;
  readonly hygiene_nudge: number;
  readonly broken_deliverable: number;
  readonly timeout_crash: number;
}

export interface ModelRoleSummary {
  readonly role: TaskRole;
  readonly label: string;
  readonly model: string;
  readonly reviewerModel: string | null;
  readonly provider: string;
  readonly agentProfile: string;
  readonly trials: number;
  readonly passedCount: number;
  readonly passRate: number;
  readonly zsdrCount: number;
  readonly zsdrRate: number;
  readonly lsas: number;
  readonly meanRawScore: number;
  readonly rawScoreSd: number;
  readonly totalCostUsd: number;
  readonly medianCostUsd: number;
  readonly costPerCleanPassUsd: number | null;
  readonly totalWallS: number;
  readonly medianWallS: number;
  readonly coldVisibleS: number | null;
  readonly warmVisibleS: number | null;
  readonly medianTotalTokPerS: number | null;
  readonly medianDecodeTokPerS: number | null;
  readonly medianReasoningShare: number;
  readonly medianCacheHitRatio: number;
  readonly tierCounts: TierCounts;
  readonly defectRecall: number | null;
  readonly falsePositiveP0P2: number;
  readonly nitpickP3: number;
  readonly weightedFalseAlarms: number;
  readonly medianDiffRatio: number | null;
}

export interface CombinedCoderSummary {
  readonly model: string;
  readonly provider: string;
  readonly agentProfile: string;
  readonly solo: ModelRoleSummary;
  readonly pair: ModelRoleSummary;
  readonly aci: number;
  readonly totalTrials: number;
  readonly passedCount: number;
  readonly passRate: number;
  readonly zsdrCount: number;
  readonly zsdrRate: number;
  readonly totalCostUsd: number;
  readonly costPerCleanPassUsd: number | null;
  readonly totalWallS: number;
  readonly medianWallS: number;
  readonly coldVisibleS: number | null;
  readonly medianTotalTokPerS: number | null;
  readonly medianReasoningShare: number;
  readonly medianDiffRatio: number | null;
  readonly tierCounts: TierCounts;
}

export interface PairCellSummary {
  readonly coderModel: string;
  readonly reviewerModel: string;
  readonly trials: number;
  readonly passedCount: number;
  readonly passRate: number;
  readonly zsdrRate: number;
  readonly lsas: number;
  readonly totalCostUsd: number;
  readonly totalWallS: number;
  readonly medianWallS: number;
}

export interface TaskCellOutcome {
  readonly taskId: string;
  readonly role: TaskRole;
  readonly modelLabel: string;
  readonly tier: FailureTier;
  readonly lsas: number;
  readonly passed: boolean;
  readonly wallS: number;
  readonly costUsd: number;
}

export interface BenchmarkSummary {
  readonly scoredTrials: readonly TrialAutonomyScore[];
  readonly coderRows: readonly ModelRoleSummary[];
  readonly reviewerRows: readonly ModelRoleSummary[];
  readonly reviewerCalibratedRows: readonly ModelRoleSummary[];
  readonly excludedReviewerTasks: readonly string[];
  readonly pairRows: readonly ModelRoleSummary[];
  readonly combinedCoderRows: readonly CombinedCoderSummary[];
  readonly pairMatrix: readonly PairCellSummary[];
  readonly pairCoders: readonly string[];
  readonly pairReviewers: readonly string[];
  readonly taskCells: readonly TaskCellOutcome[];
  readonly totalCostUsd: number;
  readonly totalPassed: number;
  readonly totalTrials: number;
}

export interface ParetoPoint {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

const TIER_B_HYGIENE = new Set([
  "ruff_check_passes",
  "tsc_passes",
  "ts_ast_hygiene",
  "no_internal_test_patches",
  "acyclic_imports",
  "no_tautological_tests",
  "tests_kill_mutants",
  "review_loop_closed_clean",
  "amendment_count",
  "no_commits_created",
  "bounded_reviews",
  "one_reviewer",
  "reviewer_model_matched",
  "reviewer_caught_edge",
  "reviewer_caught_real_limit",
  "reviewer_emitted_planted_nitpick",
  "reviewer_emitted_unhittable",
]);

const TIER_B_VERIFICATION = new Set([
  "unit_tests_executed",
  "ruff_check_executed",
  "bun_tests_executed",
  "tests_rerun_before_amend",
  "proceeds_without_question",
]);

const TIER_C_FRICTION = new Set([
  "no_rejected_commits",
  "commit_context_before_commit",
  "reviewed_commit_needs_fix",
  "review_pending",
]);

export function providerOf(spec: string): string {
  const slash = spec.indexOf("/");

  return slash > 0 ? spec.slice(0, slash) : "other";
}

export function shortModelLabel(spec: string): string {
  const slash = spec.indexOf("/");
  const trimmed = slash >= 0 ? spec.slice(slash + 1) : spec;

  return trimmed
    .replace(/^claude-/u, "")
    .replace(/^gemini-4-/u, "")
    .replace(/^gpt-6\.2-/u, "")
    .replace(/^deepseek-/u, "")
    .replace(/#xhigh$/u, "#xh")
    .replace(/#high$/u, "#h")
    .replace(/#medium$/u, "#m")
    .replace(/#low$/u, "#l");
}

export function modelLabelForTrial(trial: Pick<TrialResult, "model" | "reviewer_model">): string {
  return trial.reviewer_model === null ? trial.model : `${trial.model} -> ${trial.reviewer_model}`;
}

export function parseDiffMetrics(gitDiff: string): DiffMetrics {
  let addedLines = 0;
  let removedLines = 0;
  let inHunk = false;

  for (const line of gitDiff.split("\n")) {
    if (line.startsWith("@@ ")) {
      inHunk = true;
      continue;
    }

    if (line.startsWith("diff --git ") || line.startsWith("## ")) {
      inHunk = false;
      continue;
    }

    if (!inHunk) continue;

    if (line.startsWith("+") && !line.startsWith("+++")) {
      addedLines += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removedLines += 1;
    }
  }

  return { addedLines, removedLines };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function meanOf(values: readonly number[]): number {
  if (values.length === 0) return 0;

  let sum = 0;

  for (const value of values) sum += value;

  return sum / values.length;
}

function sdOf(values: readonly number[], avg: number): number {
  if (values.length === 0) return 0;

  let sumSq = 0;

  for (const value of values) sumSq += (value - avg) ** 2;

  return Math.sqrt(sumSq / values.length);
}

function scoreReviewerTrial(trial: TrialResult, rootToolErrors: number, diff: DiffMetrics): TrialAutonomyScore {
  const failedChecks: string[] = [];

  for (const [name, ok] of Object.entries(trial.checks)) {
    if (!ok) failedChecks.push(name);
  }

  if (trial.checks.read_only_clean_repo === false) {
    return {
      trial, lsas: 0, zsdr: false, tier: "broken_deliverable", rootToolErrors,
      failedTierA: ["read_only_clean_repo"], failedTierB: [], failedTierC: [], diff,
    };
  }

  const exclusionFailed = trial.checks.exclusion_respected === false;
  const bounceFailed = trial.checks.bounce_correctness === false;

  if (exclusionFailed || bounceFailed) {
    const failedA = [
      ...(exclusionFailed ? ["exclusion_respected"] : []),
      ...(bounceFailed ? ["bounce_correctness"] : []),
    ];

    const lsas = trial.false_positive_p0_p2 + trial.nitpick_p3 === 0 ? 15 : 0;

    return {
      trial, lsas, zsdr: false, tier: "broken_deliverable", rootToolErrors,
      failedTierA: failedA, failedTierB: [], failedTierC: [], diff,
    };
  }

  const isSeeded = trial.seeded_defects.length > 0;
  const recall = trial.defect_recall ?? (trial.passed ? 1 : 0);
  const base = isSeeded ? 100 * recall : 100;
  const fpPenalty = 30 * trial.false_positive_p0_p2;
  const nitPenalty = 15 * trial.nitpick_p3;
  const toolPenalty = Math.min(8, 2 * rootToolErrors);
  const lsas = round1(Math.max(0, base - fpPenalty - nitPenalty - toolPenalty));

  if (trial.passed) {
    return {
      trial, lsas, zsdr: true, tier: "clean_pass", rootToolErrors,
      failedTierA: [], failedTierB: [], failedTierC: [], diff,
    };
  }

  const missedDefect = isSeeded && recall < 1;

  if (missedDefect || trial.false_positive_p0_p2 > 0) {
    return {
      trial, lsas, zsdr: false, tier: "broken_deliverable", rootToolErrors,
      failedTierA: failedChecks, failedTierB: [], failedTierC: [], diff,
    };
  }

  return {
    trial, lsas, zsdr: false, tier: "hygiene_nudge", rootToolErrors,
    failedTierA: [], failedTierB: failedChecks, failedTierC: [], diff,
  };
}

export function scoreTrial(trial: TrialResult): TrialAutonomyScore {
  const rootToolErrors = Math.max(0, trial.tool_errors - trial.subagent_tool_errors);
  const diff = parseDiffMetrics(trial.git_diff);

  if (trial.timed_out || trial.exit_code !== 0 || trial.partial) {
    return {
      trial, lsas: 0, zsdr: false, tier: "timeout_crash", rootToolErrors,
      failedTierA: [], failedTierB: [], failedTierC: [], diff,
    };
  }

  if (trial.role === "code-reviewer") {
    return scoreReviewerTrial(trial, rootToolErrors, diff);
  }

  const failedTierA: string[] = [];
  const failedTierB: string[] = [];
  const failedTierC: string[] = [];
  let totalTierA = 0;
  let passedTierA = 0;
  let tierBPenalty = 0;
  let tierCPenalty = 0;

  for (const [name, ok] of Object.entries(trial.checks)) {
    if (TIER_C_FRICTION.has(name)) {
      if (!ok) {
        failedTierC.push(name);
        tierCPenalty += 8;
      }
    } else if (TIER_B_HYGIENE.has(name)) {
      if (!ok) {
        failedTierB.push(name);
        tierBPenalty += 35;
      }
    } else if (TIER_B_VERIFICATION.has(name)) {
      if (!ok) {
        failedTierB.push(name);
        tierBPenalty += 20;
      }
    } else {
      totalTierA += 1;

      if (ok) passedTierA += 1;
      else failedTierA.push(name);
    }
  }

  tierCPenalty += Math.min(8, 2 * rootToolErrors);

  if (failedTierA.length > 0) {
    const ratio = totalTierA === 0 ? 0 : passedTierA / totalTierA;

    return {
      trial, lsas: round1(25 * ratio), zsdr: false, tier: "broken_deliverable", rootToolErrors,
      failedTierA, failedTierB, failedTierC, diff,
    };
  }

  if (failedTierB.length > 0) {
    const lsas = round1(Math.max(25, 100 - tierBPenalty - tierCPenalty));

    return {
      trial, lsas, zsdr: false, tier: "hygiene_nudge", rootToolErrors,
      failedTierA, failedTierB, failedTierC, diff,
    };
  }

  const lsas = round1(Math.max(25, 100 - tierCPenalty));

  if (trial.passed) {
    return {
      trial, lsas, zsdr: true, tier: "clean_pass", rootToolErrors,
      failedTierA, failedTierB, failedTierC, diff,
    };
  }

  return {
    trial, lsas, zsdr: true, tier: "self_healed_friction", rootToolErrors,
    failedTierA, failedTierB, failedTierC, diff,
  };
}

function emptyTierCounts() {
  return {
    clean_pass: 0,
    self_healed_friction: 0,
    hygiene_nudge: 0,
    broken_deliverable: 0,
    timeout_crash: 0,
  };
}

function addTierCounts(left: TierCounts, right: TierCounts): TierCounts {
  return {
    clean_pass: left.clean_pass + right.clean_pass,
    self_healed_friction: left.self_healed_friction + right.self_healed_friction,
    hygiene_nudge: left.hygiene_nudge + right.hygiene_nudge,
    broken_deliverable: left.broken_deliverable + right.broken_deliverable,
    timeout_crash: left.timeout_crash + right.timeout_crash,
  };
}

function taskMedianAddedLines(scored: readonly TrialAutonomyScore[]): ReadonlyMap<string, number> {
  const byTask = new Map<string, number[]>();

  for (const item of scored) {
    if (item.trial.role === "code-reviewer" || !item.trial.passed || item.diff.addedLines <= 0) continue;

    const list = byTask.get(item.trial.task_id) ?? [];
    list.push(item.diff.addedLines);
    byTask.set(item.trial.task_id, list);
  }

  const medians = new Map<string, number>();

  for (const [taskId, lines] of byTask) {
    const med = median(lines);

    if (med !== null && med > 0) medians.set(taskId, med);
  }

  return medians;
}

function summarizeGroup(
  role: TaskRole,
  label: string,
  model: string,
  reviewerModel: string | null,
  agentProfile: string,
  items: readonly TrialAutonomyScore[],
  taskDiffMedians: ReadonlyMap<string, number>,
): ModelRoleSummary {
  const counts = emptyTierCounts();
  const lsasValues: number[] = [];
  const rawScores: number[] = [];
  const walls: number[] = [];
  const costs: number[] = [];
  const coldVisibles: number[] = [];
  const warmVisibles: number[] = [];
  const totalToks: number[] = [];
  const decodeToks: number[] = [];
  const reasoningShares: number[] = [];
  const cacheHits: number[] = [];
  const recalls: number[] = [];
  const diffRatios: number[] = [];
  let passedCount = 0;
  let zsdrCount = 0;
  let totalCostUsd = 0;
  let totalWallS = 0;
  let falsePositiveP0P2 = 0;
  let nitpickP3 = 0;

  for (const item of items) {
    const { trial } = item;

    counts[item.tier] += 1;
    lsasValues.push(item.lsas);
    rawScores.push(trial.score);
    walls.push(trial.wall_s);
    costs.push(trial.total_cost_usd);
    reasoningShares.push(trial.reasoning_share);
    cacheHits.push(trial.cache_hit_ratio);

    if (trial.first_ttfvt_s !== null) coldVisibles.push(trial.first_ttfvt_s);

    if (trial.median_ttfvt_s !== null) warmVisibles.push(trial.median_ttfvt_s);

    if (trial.total_model_tok_per_s !== null) totalToks.push(trial.total_model_tok_per_s);

    if (trial.output_decode_tok_per_s !== null) decodeToks.push(trial.output_decode_tok_per_s);

    if (trial.defect_recall !== null) recalls.push(trial.defect_recall);

    if (trial.passed) passedCount += 1;

    if (item.zsdr) zsdrCount += 1;

    totalCostUsd += trial.total_cost_usd;
    totalWallS += trial.wall_s;
    falsePositiveP0P2 += trial.false_positive_p0_p2;
    nitpickP3 += trial.nitpick_p3;

    const baselineAdded = taskDiffMedians.get(trial.task_id);

    if (trial.passed && baselineAdded !== undefined && item.diff.addedLines > 0) {
      diffRatios.push(item.diff.addedLines / baselineAdded);
    }
  }

  const meanRaw = meanOf(rawScores);

  return {
    role,
    label,
    model,
    reviewerModel,
    provider: providerOf(model),
    agentProfile,
    trials: items.length,
    passedCount,
    passRate: items.length === 0 ? 0 : passedCount / items.length,
    zsdrCount,
    zsdrRate: items.length === 0 ? 0 : zsdrCount / items.length,
    lsas: round1(meanOf(lsasValues)),
    meanRawScore: meanRaw,
    rawScoreSd: sdOf(rawScores, meanRaw),
    totalCostUsd,
    medianCostUsd: median(costs) ?? 0,
    costPerCleanPassUsd: passedCount === 0 ? null : totalCostUsd / passedCount,
    totalWallS,
    medianWallS: median(walls) ?? 0,
    coldVisibleS: median(coldVisibles),
    warmVisibleS: median(warmVisibles),
    medianTotalTokPerS: median(totalToks),
    medianDecodeTokPerS: median(decodeToks),
    medianReasoningShare: median(reasoningShares) ?? 0,
    medianCacheHitRatio: median(cacheHits) ?? 0,
    tierCounts: counts,
    defectRecall: recalls.length === 0 ? null : meanOf(recalls),
    falsePositiveP0P2,
    nitpickP3,
    weightedFalseAlarms: 2 * falsePositiveP0P2 + nitpickP3,
    medianDiffRatio: median(diffRatios),
  };
}

function compareRoleSummaries(left: ModelRoleSummary, right: ModelRoleSummary): number {
  return right.lsas - left.lsas
    || right.passRate - left.passRate
    || right.zsdrRate - left.zsdrRate
    || left.medianWallS - right.medianWallS
    || left.totalCostUsd - right.totalCostUsd
    || left.label.localeCompare(right.label);
}

function buildRoleRows(
  role: TaskRole,
  scored: readonly TrialAutonomyScore[],
  taskDiffMedians: ReadonlyMap<string, number>,
  excludedTaskIds: ReadonlySet<string> = new Set(),
): readonly ModelRoleSummary[] {
  const groups = new Map<string, TrialAutonomyScore[]>();

  for (const item of scored) {
    if (item.trial.role !== role || excludedTaskIds.has(item.trial.task_id)) continue;

    const label = modelLabelForTrial(item.trial);
    const key = JSON.stringify([label, item.trial.agent_profile]);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }

  const rows: ModelRoleSummary[] = [];

  for (const items of groups.values()) {
    const first = items[0];

    if (first === undefined) continue;

    rows.push(summarizeGroup(
      role,
      modelLabelForTrial(first.trial),
      first.trial.model,
      first.trial.reviewer_model,
      first.trial.agent_profile,
      items,
      taskDiffMedians,
    ));
  }

  return rows.sort(compareRoleSummaries);
}

/**
 * Compute upper-left Pareto frontier where lower X (cost or wall time) and higher Y (LSAS / ACI) are better.
 */
export function computeParetoFrontier<T extends ParetoPoint>(points: readonly T[]): readonly T[] {
  const sorted = [...points].sort((left, right) => left.x - right.x || right.y - left.y);
  const frontier: T[] = [];
  let bestY = -Infinity;

  for (const point of sorted) {
    if (point.y > bestY) {
      frontier.push(point);
      bestY = point.y;
    }
  }

  return frontier;
}

export function summarizeBenchmark(results: readonly TrialResult[]): BenchmarkSummary {
  const scoredTrials = results.map(scoreTrial);
  const taskDiffMedians = taskMedianAddedLines(scoredTrials);
  const coderRows = buildRoleRows("coder", scoredTrials, taskDiffMedians);
  const reviewerRows = buildRoleRows("code-reviewer", scoredTrials, taskDiffMedians);
  const pairRows = buildRoleRows("pair", scoredTrials, taskDiffMedians);

  // Identify reviewer tasks where 0/N models passed (e.g. ambiguous bounce fixture) for a calibrated companion view.
  const reviewerTaskTotals = new Map<string, { passed: number; total: number }>();

  for (const item of scoredTrials) {
    if (item.trial.role !== "code-reviewer") continue;

    const entry = reviewerTaskTotals.get(item.trial.task_id) ?? { passed: 0, total: 0 };
    entry.total += 1;

    if (item.trial.passed) entry.passed += 1;

    reviewerTaskTotals.set(item.trial.task_id, entry);
  }

  const excludedReviewerTasks: string[] = [];

  for (const [taskId, stats] of reviewerTaskTotals) {
    if (stats.total >= 3 && stats.passed === 0) excludedReviewerTasks.push(taskId);
  }

  excludedReviewerTasks.sort();

  const reviewerCalibratedRows = excludedReviewerTasks.length > 0
    ? buildRoleRows("code-reviewer", scoredTrials, taskDiffMedians, new Set(excludedReviewerTasks))
    : reviewerRows;

  // Build marginal pair rows grouped by coder model (across all paired reviewers) for Combined Coder ACI.
  const pairByCoder = new Map<string, TrialAutonomyScore[]>();

  for (const item of scoredTrials) {
    if (item.trial.role !== "pair") continue;

    const key = JSON.stringify([item.trial.model, item.trial.agent_profile]);
    const list = pairByCoder.get(key) ?? [];
    list.push(item);
    pairByCoder.set(key, list);
  }

  const combinedCoderRows: CombinedCoderSummary[] = [];

  for (const solo of coderRows) {
    const key = JSON.stringify([solo.model, solo.agentProfile]);
    const pairItems = pairByCoder.get(key);

    if (pairItems === undefined || pairItems.length === 0) continue;

    const pair = summarizeGroup("pair", solo.model, solo.model, null, solo.agentProfile, pairItems, taskDiffMedians);
    const totalTrials = solo.trials + pair.trials;
    const passedCount = solo.passedCount + pair.passedCount;
    const zsdrCount = solo.zsdrCount + pair.zsdrCount;
    const totalCostUsd = solo.totalCostUsd + pair.totalCostUsd;
    const totalWallS = solo.totalWallS + pair.totalWallS;

    const allItems: TrialAutonomyScore[] = [];

    for (const item of scoredTrials) {
      if ((item.trial.role === "coder" || item.trial.role === "pair")
        && item.trial.model === solo.model
        && item.trial.agent_profile === solo.agentProfile) {
        allItems.push(item);
      }
    }

    const combinedMetrics = summarizeGroup("coder", solo.model, solo.model, null, solo.agentProfile, allItems, taskDiffMedians);
    const aci = round1(0.6 * solo.lsas + 0.4 * pair.lsas);

    combinedCoderRows.push({
      model: solo.model,
      provider: solo.provider,
      agentProfile: solo.agentProfile,
      solo,
      pair,
      aci,
      totalTrials,
      passedCount,
      passRate: passedCount / totalTrials,
      zsdrCount,
      zsdrRate: zsdrCount / totalTrials,
      totalCostUsd,
      costPerCleanPassUsd: passedCount === 0 ? null : totalCostUsd / passedCount,
      totalWallS,
      medianWallS: combinedMetrics.medianWallS,
      coldVisibleS: combinedMetrics.coldVisibleS,
      medianTotalTokPerS: combinedMetrics.medianTotalTokPerS,
      medianReasoningShare: combinedMetrics.medianReasoningShare,
      medianDiffRatio: combinedMetrics.medianDiffRatio,
      tierCounts: addTierCounts(solo.tierCounts, pair.tierCounts),
    });
  }

  combinedCoderRows.sort((left, right) =>
    right.aci - left.aci
    || right.zsdrRate - left.zsdrRate
    || right.passRate - left.passRate
    || left.totalWallS - right.totalWallS
    || left.totalCostUsd - right.totalCostUsd,
  );

  // Pair Coder × Reviewer synergy matrix.
  const pairCells = new Map<string, TrialAutonomyScore[]>();
  const pairCoderSet = new Set<string>();
  const pairReviewerSet = new Set<string>();

  for (const item of scoredTrials) {
    if (item.trial.role !== "pair" || item.trial.reviewer_model === null) continue;

    pairCoderSet.add(item.trial.model);
    pairReviewerSet.add(item.trial.reviewer_model);
    const key = JSON.stringify([item.trial.model, item.trial.reviewer_model]);
    const list = pairCells.get(key) ?? [];
    list.push(item);
    pairCells.set(key, list);
  }

  const pairMatrix: PairCellSummary[] = [];

  for (const items of pairCells.values()) {
    const first = items[0];

    if (first === undefined || first.trial.reviewer_model === null) continue;

    const group = summarizeGroup(
      "pair",
      modelLabelForTrial(first.trial),
      first.trial.model,
      first.trial.reviewer_model,
      first.trial.agent_profile,
      items,
      taskDiffMedians,
    );

    pairMatrix.push({
      coderModel: first.trial.model,
      reviewerModel: first.trial.reviewer_model,
      trials: group.trials,
      passedCount: group.passedCount,
      passRate: group.passRate,
      zsdrRate: group.zsdrRate,
      lsas: group.lsas,
      totalCostUsd: group.totalCostUsd,
      totalWallS: group.totalWallS,
      medianWallS: group.medianWallS,
    });
  }

  const aciOrder = new Map(combinedCoderRows.map((row, index) => [row.model, index]));

  const pairCoders = Array.from(pairCoderSet).sort((left, right) => {
    const leftIndex = aciOrder.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = aciOrder.get(right) ?? Number.MAX_SAFE_INTEGER;

    return leftIndex - rightIndex || left.localeCompare(right);
  });

  const pairReviewers = Array.from(pairReviewerSet).sort();

  const taskCells: TaskCellOutcome[] = scoredTrials.map((item) => ({
    taskId: item.trial.task_id,
    role: item.trial.role,
    modelLabel: modelLabelForTrial(item.trial),
    tier: item.tier,
    lsas: item.lsas,
    passed: item.trial.passed,
    wallS: item.trial.wall_s,
    costUsd: item.trial.total_cost_usd,
  }));

  let totalCostUsd = 0;
  let totalPassed = 0;

  for (const item of scoredTrials) {
    totalCostUsd += item.trial.total_cost_usd;

    if (item.trial.passed) totalPassed += 1;
  }

  return {
    scoredTrials,
    coderRows,
    reviewerRows,
    reviewerCalibratedRows,
    excludedReviewerTasks,
    pairRows,
    combinedCoderRows,
    pairMatrix,
    pairCoders,
    pairReviewers,
    taskCells,
    totalCostUsd,
    totalPassed,
    totalTrials: scoredTrials.length,
  };
}
