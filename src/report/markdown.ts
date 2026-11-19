import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { median } from "../driver/telemetry.ts";
import type { SeededDefectRecord, SubagentTokenTotals, TrialResult } from "../runner/types.ts";
import { atomicWriteFile } from "../util/fs.ts";
import { isJsonArray, isJsonObject, isString, parseJsonText, type JsonValue } from "../util/json.ts";

type Field = JsonValue | undefined;

function isBoolean(value: Field): boolean {
  return value === true || value === false;
}

function isNumber(value: Field): boolean {
  return Number.isFinite(value);
}

function isNullableNumber(value: Field): boolean {
  return value === null || isNumber(value);
}

function isNullableString(value: Field): boolean {
  return value === null || isString(value);
}

function isStringList(value: Field): boolean {
  return isJsonArray(value) && value.every(isString);
}

function hasFields<T>(value: Field, fields: { readonly [K in keyof T]: (field: Field) => boolean }): boolean {
  return isJsonObject(value) && Object.entries<(field: Field) => boolean>(fields).every(
    ([key, validate]) => Object.hasOwn(value, key) && validate(value[key]),
  );
}

const tokenFields = {
  input_tokens: isNumber, output_tokens: isNumber, reasoning_tokens: isNumber,
  cache_read_tokens: isNumber, cache_write_tokens: isNumber,
} satisfies { [K in keyof SubagentTokenTotals]: (value: Field) => boolean };

function isDefect(value: Field): boolean {
  return hasFields<SeededDefectRecord>(value, {
    id: isString, file: isString, description: isString,
    line_range: (line) => isJsonArray(line) && line.length === 2 && line.every(Number.isSafeInteger),
    min_severity: (severity) => severity === 0 || severity === 1 || severity === 2 || severity === 3,
    concept_groups: (groups) => isJsonArray(groups) && groups.every(isStringList),
  });
}

const roles = ["code-reviewer", "coder", "pair"] as const;

function isTrialResult(value: Field): value is Field & TrialResult {
  return hasFields<TrialResult>(value, {
    ...tokenFields,
    task_id: isString, role: (role) => roles.some((entry) => entry === role), category: isString, model: isString,
    agent_profile: isString, repo_dir: isString, repetition: isNumber, reviewer_model: isNullableString,
    session_id: isNullableString, exit_code: isNumber, timed_out: isBoolean, partial: isBoolean, sandboxed: isBoolean,
    wall_s: isNumber, retries: isNumber, outer_retries: isNumber, first_ttfrt_s: isNullableNumber,
    median_ttfrt_s: isNullableNumber, first_ttfvt_s: isNullableNumber, median_ttfvt_s: isNullableNumber,
    output_decode_tok_per_s: isNullableNumber, total_model_tok_per_s: isNullableNumber, reasoning_share: isNumber,
    steps: isNumber, tool_calls: isNumber, tool_errors: isNumber, cache_hit_ratio: isNumber, root_cost_usd: isNumber,
    subagent_cost_usd: isNumber, retry_cost_usd: isNumber, total_cost_usd: isNumber,
    subagent_tokens: (tokens) => hasFields<SubagentTokenTotals>(tokens, tokenFields),
    subagent_tool_errors: isNumber, passed: isBoolean, score: isNumber,
    checks: (checks) => isJsonObject(checks) && Object.values(checks).every(isBoolean), notes: isStringList,
    pedantry_flags: isNumber, false_positive_p0_p2: isNumber, nitpick_p3: isNumber, defect_recall: isNullableNumber,
    precision: isNullableNumber, scope_bounced: isBoolean, blocker_disclosed: (flag) => flag === null || isBoolean(flag),
    final_text: isString, transcript_text: isString, reviewer_text: isString, planted_brief: isString,
    review_spec: isString, review_diff: isNullableString, task_spec: isString,
    seeded_defects: (defects) => isJsonArray(defects) && defects.every(isDefect),
    git_diff: isString, error_message: isNullableString,
  });
}

export function writeResultsJson(outPath: string, results: readonly TrialResult[]): void {
  const resolved = resolve(outPath);
  mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 });
  atomicWriteFile(resolved, `${JSON.stringify(results, null, 2)}\n`);
}

export function readResultsJson(inputPath: string): readonly TrialResult[] {
  const value = parseJsonText(readFileSync(inputPath, "utf8"));

  if (!isJsonArray(value) || !value.every(isTrialResult)) {
    throw new Error("Expected an array of trial results in the input file.");
  }

  return value;
}

function modelLabel(trial: TrialResult): string {
  return trial.reviewer_model === null ? trial.model : `${trial.model} -> ${trial.reviewer_model}`;
}

function tableRow(cells: readonly string[]): string {
  return `| ${cells.map((cell) => cell.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll(/[\r\n]+/gu, " ")).join(" | ")} |`;
}

function tableHeader(columns: readonly string[]): string[] {
  return [tableRow(columns), tableRow(columns.map(() => "---"))];
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function metricMedian(trials: readonly TrialResult[], metric: (trial: TrialResult) => number | null): number | null {
  return median(trials.flatMap((trial) => {
    const value = metric(trial);

    return value === null ? [] : [value];
  }));
}

function percent(value: number, digits = 1): string {
  return `${(100 * value).toFixed(digits)}%`;
}

function format(value: number | null, digits: number, suffix = "", prefix = ""): string {
  return value === null ? "—" : `${prefix}${value.toFixed(digits)}${suffix}`;
}

function leaderboardRow(trials: readonly TrialResult[]) {
  const first = trials[0];

  if (first === undefined) throw new Error("Cannot summarize an empty model group.");

  const scores = trials.map((trial) => trial.score);
  const score = mean(scores);
  const medWall = metricMedian(trials, (trial) => trial.wall_s);

  return {
    score,
    medWall,
    row: tableRow([
      modelLabel(first), first.agent_profile, percent(mean(trials.map((trial) => Number(trial.passed)))),
      percent(score), percent(Math.sqrt(mean(scores.map((value) => (value - score) ** 2)))),
      format(metricMedian(trials, (trial) => trial.first_ttfvt_s), 2, "s"),
      format(metricMedian(trials, (trial) => trial.median_ttfvt_s), 2, "s"),
      format(metricMedian(trials, (trial) => trial.output_decode_tok_per_s), 0),
      format(metricMedian(trials, (trial) => trial.total_model_tok_per_s), 0),
      percent(metricMedian(trials, (trial) => trial.cache_hit_ratio) ?? 0, 0),
      format(medWall, 1, "s"), format(metricMedian(trials, (trial) => trial.total_cost_usd), 4, "", "$"),
    ]),
  };
}

export function renderMarkdownReport(results: readonly TrialResult[]): string {
  const lines = ["# OmkarSWE bench", ""];

  for (const role of roles) {
    const groups = Map.groupBy(results.values().filter((trial) => trial.role === role),
      (trial) => JSON.stringify([modelLabel(trial), trial.agent_profile]));

    if (groups.size === 0) continue;

    const rows = Array.from(groups.values(), leaderboardRow);
    rows.sort((a, b) => b.score - a.score || (a.medWall ?? 999) - (b.medWall ?? 999));
    lines.push(`## ${role} leaderboard`, "", ...tableHeader([
      "Model", "Profile", "Pass@1", "Mean score", "Score SD", "Cold visible", "Warm visible",
      "Decode tok/s", "Total tok/s", "Cache hit", "Wall", "Cost",
    ]));

    for (const { row } of rows) lines.push(row);

    lines.push("");
  }

  lines.push("## Per-trial breakdown", "", ...tableHeader([
    "Task", "Model", "Profile", "Rep", "Pass", "Score", "Wall", "Cold visible", "Notes",
  ]));

  for (const trial of results) {
    lines.push(tableRow([
      trial.task_id, modelLabel(trial), trial.agent_profile, String(trial.repetition), trial.passed ? "Yes" : "No",
      percent(trial.score), format(trial.wall_s, 1, "s"), format(trial.first_ttfvt_s, 2, "s"), trial.notes.join("; "),
    ]));
  }

  return `${lines.join("\n")}\n`;
}
