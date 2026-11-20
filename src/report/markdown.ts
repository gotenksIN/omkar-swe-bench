import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { median } from "../driver/telemetry.ts";
import type {
  SeededDefectRecord,
  SubagentTokenTotals,
  TrialResult,
} from "../runner/types.ts";
import { atomicWriteFile } from "../util/fs.ts";
import {
  isJsonArray,
  isJsonObject,
  isString,
  parseJsonText,
} from "../util/json.ts";
import type { JsonValue } from "../util/json.ts";
import type { GeneratedChart } from "./charts.ts";
import {
  computeParetoFrontier,
  displayModelLabel,
  summarizeBenchmark,
} from "./scoring.ts";
import type { BenchmarkSummary, ModelRoleSummary } from "./scoring.ts";

type Field = JsonValue | undefined;

const isBoolean = (value: Field): boolean => value === true || value === false;

const isNumber = (value: Field): boolean => Number.isFinite(value);

const isNullableNumber = (value: Field): boolean =>
  value === null || isNumber(value);

const isNullableString = (value: Field): boolean =>
  value === null || isString(value);

const isStringList = (value: Field): boolean =>
  isJsonArray(value) && value.every(isString);

const hasFields = (
  value: Field,
  fields: { readonly [key: string]: (field: Field) => boolean }
): boolean =>
  isJsonObject(value) &&
  Object.entries(fields).every(
    ([key, validate]) => Object.hasOwn(value, key) && validate(value[key])
  );

const tokenFields = {
  input_tokens: isNumber,
  output_tokens: isNumber,
  reasoning_tokens: isNumber,
  cache_read_tokens: isNumber,
  cache_write_tokens: isNumber,
} satisfies { [K in keyof SubagentTokenTotals]: (value: Field) => boolean };

const defectFields = {
  id: isString,
  file: isString,
  description: isString,
  line_range: (line: Field) =>
    isJsonArray(line) && line.length === 2 && line.every(Number.isSafeInteger),
  min_severity: (severity: Field) =>
    severity === 0 || severity === 1 || severity === 2 || severity === 3,
  concept_groups: (groups: Field) =>
    isJsonArray(groups) && groups.every(isStringList),
} satisfies {
  readonly [K in keyof SeededDefectRecord]: (value: Field) => boolean;
};

const isDefect = (value: Field): boolean => hasFields(value, defectFields);

const roles = ["code-reviewer", "coder", "pair"] as const;

const trialResultFields = {
  ...tokenFields,
  task_id: isString,
  role: (role: Field) => roles.some((entry) => entry === role),
  category: isString,
  model: isString,
  agent_profile: isString,
  repo_dir: isString,
  repetition: isNumber,
  reviewer_model: isNullableString,
  session_id: isNullableString,
  exit_code: isNumber,
  timed_out: isBoolean,
  partial: isBoolean,
  sandboxed: isBoolean,
  wall_s: isNumber,
  retries: isNumber,
  outer_retries: isNumber,
  first_ttfrt_s: isNullableNumber,
  median_ttfrt_s: isNullableNumber,
  first_ttfvt_s: isNullableNumber,
  median_ttfvt_s: isNullableNumber,
  output_decode_tok_per_s: isNullableNumber,
  total_model_tok_per_s: isNullableNumber,
  reasoning_share: isNumber,
  steps: isNumber,
  tool_calls: isNumber,
  tool_errors: isNumber,
  cache_hit_ratio: isNumber,
  root_cost_usd: isNumber,
  subagent_cost_usd: isNumber,
  retry_cost_usd: isNumber,
  total_cost_usd: isNumber,
  subagent_tokens: (tokens: Field) => hasFields(tokens, tokenFields),
  subagent_tool_errors: isNumber,
  passed: isBoolean,
  score: isNumber,
  checks: (checks: Field) =>
    isJsonObject(checks) && Object.values(checks).every(isBoolean),
  notes: isStringList,
  pedantry_flags: isNumber,
  false_positive_p0_p2: isNumber,
  nitpick_p3: isNumber,
  defect_recall: isNullableNumber,
  precision: isNullableNumber,
  scope_bounced: isBoolean,
  blocker_disclosed: (flag: Field) => flag === null || isBoolean(flag),
  final_text: isString,
  transcript_text: isString,
  reviewer_text: isString,
  planted_brief: isString,
  review_spec: isString,
  review_diff: isNullableString,
  task_spec: isString,
  seeded_defects: (defects: Field) =>
    isJsonArray(defects) && defects.every(isDefect),
  git_diff: isString,
  error_message: isNullableString,
} satisfies { readonly [K in keyof TrialResult]: (value: Field) => boolean };

const isTrialResult = (value: Field): value is Field & TrialResult =>
  hasFields(value, trialResultFields);

export const writeResultsJson = (
  outPath: string,
  results: readonly TrialResult[]
): void => {
  const resolved = path.resolve(outPath);
  mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  atomicWriteFile(resolved, `${JSON.stringify(results, null, 2)}\n`);
};

export const readResultsJson = (inputPath: string): readonly TrialResult[] => {
  const value = parseJsonText(readFileSync(inputPath, "utf-8"));

  if (!isJsonArray(value) || !value.every(isTrialResult)) {
    throw new Error("Expected an array of trial results in the input file.");
  }

  return value;
};

const modelLabel = (trial: TrialResult): string =>
  trial.reviewer_model === null
    ? trial.model
    : `${trial.model} -> ${trial.reviewer_model}`;

const tableRow = (cells: readonly string[]): string =>
  `| ${cells
    .map((cell) =>
      cell
        .replaceAll("\\", "\\\\")
        .replaceAll("|", "\\|")
        .replaceAll(/[\r\n]+/gu, " ")
    )
    .join(" | ")} |`;

type Alignment = "left" | "right" | "center";

const alignMarker = (align: Alignment): string => {
  if (align === "right") {
    return "---:";
  }

  if (align === "center") {
    return ":---:";
  }

  return ":---";
};

const tableHeader = (
  columns: readonly string[],
  alignments?: readonly Alignment[]
): string[] => [
  tableRow(columns),
  tableRow(
    columns.map((_, idx) =>
      alignments === undefined ? "---" : alignMarker(alignments[idx] ?? "left")
    )
  ),
];

const detailsBlock = (title: string, body: readonly string[]): string[] => [
  "<details>",
  `<summary>${title}</summary>`,
  "",
  ...body,
  "",
  "</details>",
  "",
];

const formatMinutes = (seconds: number): string =>
  seconds >= 120 ? `${(seconds / 60).toFixed(1)}m` : `${Math.round(seconds)}s`;

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

const metricMedian = (
  trials: readonly TrialResult[],
  metric: (trial: TrialResult) => number | null
): number | null =>
  median(
    trials.flatMap((trial) => {
      const value = metric(trial);

      return value === null ? [] : [value];
    })
  );

const percent = (value: number, digits = 1): string =>
  `${(100 * value).toFixed(digits)}%`;

const format = (
  value: number | null,
  digits: number,
  suffix = "",
  prefix = ""
): string =>
  value === null ? "—" : `${prefix}${value.toFixed(digits)}${suffix}`;

const leaderboardRow = (trials: readonly TrialResult[]) => {
  const [first] = trials;

  if (first === undefined) {
    throw new Error("Cannot summarize an empty model group.");
  }

  const scores = trials.map((trial) => trial.score);
  const score = mean(scores);
  const medWall = metricMedian(trials, (trial) => trial.wall_s);

  return {
    score,
    medWall,
    row: tableRow([
      modelLabel(first),
      first.agent_profile,
      percent(mean(trials.map((trial) => Number(trial.passed)))),
      percent(score),
      percent(Math.sqrt(mean(scores.map((value) => (value - score) ** 2)))),
      format(
        metricMedian(trials, (trial) => trial.first_ttfvt_s),
        2,
        "s"
      ),
      format(
        metricMedian(trials, (trial) => trial.median_ttfvt_s),
        2,
        "s"
      ),
      format(
        metricMedian(trials, (trial) => trial.output_decode_tok_per_s),
        0
      ),
      format(
        metricMedian(trials, (trial) => trial.total_model_tok_per_s),
        0
      ),
      percent(metricMedian(trials, (trial) => trial.cache_hit_ratio) ?? 0, 0),
      format(medWall, 1, "s"),
      format(
        metricMedian(trials, (trial) => trial.total_cost_usd),
        4,
        "",
        "$"
      ),
    ]),
  };
};

export const renderMarkdownReport = (
  results: readonly TrialResult[]
): string => {
  const lines = ["# OmkarSWE bench", ""];

  for (const role of roles) {
    const groups = Map.groupBy(
      results.values().filter((trial) => trial.role === role),
      (trial) => JSON.stringify([modelLabel(trial), trial.agent_profile])
    );

    if (groups.size === 0) {
      continue;
    }

    const rows = Array.from(groups.values(), leaderboardRow);
    rows.sort(
      (a, b) => b.score - a.score || (a.medWall ?? 999) - (b.medWall ?? 999)
    );
    lines.push(
      `## ${role} leaderboard`,
      "",
      ...tableHeader([
        "Model",
        "Profile",
        "Pass@1",
        "Mean score",
        "Score SD",
        "Cold visible",
        "Warm visible",
        "Decode tok/s",
        "Total tok/s",
        "Cache hit",
        "Wall",
        "Cost",
      ])
    );

    for (const { row } of rows) {
      lines.push(row);
    }

    lines.push("");
  }

  lines.push(
    "## Per-trial breakdown",
    "",
    ...tableHeader([
      "Task",
      "Model",
      "Profile",
      "Rep",
      "Pass",
      "Score",
      "Wall",
      "Cold visible",
      "Notes",
    ])
  );

  for (const trial of results) {
    lines.push(
      tableRow([
        trial.task_id,
        modelLabel(trial),
        trial.agent_profile,
        String(trial.repetition),
        trial.passed ? "Yes" : "No",
        percent(trial.score),
        format(trial.wall_s, 1, "s"),
        format(trial.first_ttfvt_s, 2, "s"),
        trial.notes.join("; "),
      ])
    );
  }

  return `${lines.join("\n")}\n`;
};

const compactRoleTableLines = (
  rows: readonly ModelRoleSummary[],
  isReviewer: boolean
): string[] => {
  if (isReviewer) {
    const lines = [
      ...tableHeader(
        ["Rank", "Model", "LSAS", "Recall", "Alarms", "Cost"],
        ["right", "left", "right", "right", "right", "right"]
      ),
    ];

    for (const [index, row] of rows.entries()) {
      const alarms =
        row.falsePositiveP0P2 === 0 && row.nitpickP3 === 0
          ? "0"
          : `${row.falsePositiveP0P2} FP · ${row.nitpickP3} P3`;

      lines.push(
        tableRow([
          String(index + 1),
          displayModelLabel(row.label),
          row.lsas.toFixed(1),
          row.defectRecall === null ? "—" : percent(row.defectRecall, 0),
          alarms,
          format(row.totalCostUsd, 2, "", "$"),
        ])
      );
    }

    return lines;
  }

  const lines = [
    ...tableHeader(
      ["Rank", "Model", "LSAS", "Pass@1", "Cost · Wall"],
      ["right", "left", "right", "right", "right"]
    ),
  ];

  for (const [index, row] of rows.entries()) {
    lines.push(
      tableRow([
        String(index + 1),
        displayModelLabel(row.label),
        row.lsas.toFixed(1),
        `${row.passedCount}/${row.trials} (${percent(row.passRate, 0)})`,
        `${format(row.totalCostUsd, 2, "", "$")} · ${format(row.medianWallS, 0, "s")}`,
      ])
    );
  }

  return lines;
};

const fullRoleTableLines = (
  rows: readonly ModelRoleSummary[],
  isReviewer: boolean
): string[] => {
  const header = isReviewer
    ? [
        "Rank",
        "Model",
        "LSAS",
        "Pass@1",
        "Passed",
        "Defect recall",
        "P0–P2 FPs",
        "P3 nits",
        "Suite cost",
        "Med wall",
        "Cold TTFT",
        "Active tok/s",
        "Reasoning %",
      ]
    : [
        "Rank",
        "Model",
        "LSAS",
        "ZSDR",
        "Pass@1",
        "Passed",
        "Mean check",
        "Diff ratio",
        "Suite cost",
        "Med wall",
        "Cold TTFT",
        "Active tok/s",
        "Reasoning %",
      ];

  const alignments: Alignment[] = [
    "right",
    "left",
    "right",
    "right",
    "right",
    "right",
    "right",
    "right",
    "right",
    "right",
    "right",
    "right",
    "right",
  ];

  const lines = [...tableHeader(header, alignments)];

  for (const [index, row] of rows.entries()) {
    lines.push(
      tableRow(
        isReviewer
          ? [
              String(index + 1),
              `\`${row.label}\``,
              row.lsas.toFixed(1),
              percent(row.passRate),
              `${row.passedCount}/${row.trials}`,
              row.defectRecall === null ? "—" : percent(row.defectRecall),
              String(row.falsePositiveP0P2),
              String(row.nitpickP3),
              format(row.totalCostUsd, 2, "", "$"),
              format(row.medianWallS, 1, "s"),
              format(row.coldVisibleS, 2, "s"),
              format(row.medianTotalTokPerS, 0),
              percent(row.medianReasoningShare, 0),
            ]
          : [
              String(index + 1),
              `\`${row.label}\``,
              row.lsas.toFixed(1),
              percent(row.zsdrRate),
              percent(row.passRate),
              `${row.passedCount}/${row.trials}`,
              percent(row.meanRawScore),
              format(row.medianDiffRatio, 2, "×"),
              format(row.totalCostUsd, 2, "", "$"),
              format(row.medianWallS, 1, "s"),
              format(row.coldVisibleS, 2, "s"),
              format(row.medianTotalTokPerS, 0),
              percent(row.medianReasoningShare, 0),
            ]
      )
    );
  }

  return lines;
};

const highlightRows = (summary: BenchmarkSummary): string[] => {
  const items: string[][] = [];

  if (summary.combinedCoderRows.length > 0) {
    const [topCoder] = summary.combinedCoderRows;

    if (topCoder !== undefined) {
      items.push([
        "Best Overall Coder",
        displayModelLabel(topCoder.model),
        `ACI ${topCoder.aci.toFixed(1)}`,
        `$${topCoder.totalCostUsd.toFixed(2)} · ${formatMinutes(topCoder.totalWallS)}`,
      ]);
    }

    const costFrontier = computeParetoFrontier(
      summary.combinedCoderRows.map((row) => ({
        id: row.model,
        row,
        x: row.totalCostUsd,
        y: row.aci,
      }))
    );

    const bestValue = costFrontier.find(
      (entry) => entry.row.model !== topCoder?.model && entry.row.aci >= 90
    );

    if (bestValue !== undefined) {
      items.push([
        "Best Value Coder",
        displayModelLabel(bestValue.row.model),
        `ACI ${bestValue.row.aci.toFixed(1)}`,
        `$${bestValue.row.totalCostUsd.toFixed(2)} · ${formatMinutes(bestValue.row.totalWallS)}`,
      ]);
    }

    const speedFrontier = computeParetoFrontier(
      summary.combinedCoderRows.map((row) => ({
        id: row.model,
        row,
        x: row.totalWallS,
        y: row.aci,
      }))
    );

    const fastest = speedFrontier.find(
      (entry) =>
        entry.row.model !== topCoder?.model &&
        entry.row.model !== bestValue?.row.model &&
        entry.row.aci >= 90
    );

    if (fastest !== undefined) {
      items.push([
        "Fastest Pareto Coder",
        displayModelLabel(fastest.row.model),
        `ACI ${fastest.row.aci.toFixed(1)}`,
        `${formatMinutes(fastest.row.totalWallS)} · $${fastest.row.totalCostUsd.toFixed(2)}`,
      ]);
    }
  }

  const [topReviewer] = summary.reviewerCalibratedRows;

  if (topReviewer !== undefined) {
    items.push([
      "Top Code Reviewer",
      displayModelLabel(topReviewer.model),
      `LSAS ${topReviewer.lsas.toFixed(1)}`,
      `$${topReviewer.totalCostUsd.toFixed(2)} · med ${topReviewer.medianWallS.toFixed(0)}s`,
    ]);
  }

  if (items.length === 0) {
    return [];
  }

  return [
    "## Highlights",
    "",
    ...tableHeader(
      ["Category", "Model", "Score", "Cost · Speed"],
      ["left", "left", "right", "right"]
    ),
    ...items.map(tableRow),
    "",
  ];
};

export const renderDetailedReport = (
  results: readonly TrialResult[],
  charts: readonly GeneratedChart[] = [],
  chartPrefix = "charts"
): string => {
  const summary = summarizeBenchmark(results);
  const byId = new Map(charts.map((chart) => [chart.id, chart]));

  const embed = (id: string): string[] => {
    const chart = byId.get(id);

    return chart === undefined
      ? []
      : [`![${chart.title}](${chartPrefix}/${chart.filename})`, ""];
  };

  const passPct = percent(
    summary.totalTrials === 0 ? 0 : summary.totalPassed / summary.totalTrials
  );

  const lines: string[] = [
    "# OmkarSWE bench — Evaluation Report",
    "",
    `**${summary.totalTrials} trials** · **${summary.totalPassed}/${summary.totalTrials}** strict Pass@1 (${passPct}) · **$${summary.totalCostUsd.toFixed(2)}** total API cost`,
    "",
    "Open [`report.html`](report.html) for interactive hover tooltips and phase tabs, or read [`craft.md`](craft.md) for host-side code craft metrics.",
    "",
    ...highlightRows(summary),
    ...detailsBlock("Scoring methodology (LSAS, ZSDR, ACI)", [
      "- **LSAS (Low-Steering Autonomy Score, 0–100):** Zeroes timeouts, crashes, and partial runs. Caps broken deliverables or scope violations at `<= 25`. Passing deliverables start at `100` minus `-35` per static/test hygiene miss, `-20` per skipped verification check, `-8` per self-healed in-session friction item (such as a commit-guard rejection recovered autonomously), and `-2` per root tool error (capped at `-8`). For code reviewers, LSAS starts at `100 × recall` (`100` on clean diffs) minus `-30` per blocking `P0–P2` false alarm and `-15` per `P3` nitpick.",
      "- **ZSDR (Zero-Steering Deliverable Rate):** Share of trials needing zero human intervention after the session ends.",
      "- **ACI (Autonomous Coder Index):** `0.6 × Solo LSAS + 0.4 × Pair LSAS` across all solo and pair coder trials (Phases 1 and 3).",
      "- **Cost and Wall Time:** Reported on orthogonal Pareto axes rather than blended into capability scores.",
    ]),
  ];

  if (summary.combinedCoderRows.length > 0) {
    const compactCombined: string[] = [
      ...tableHeader(
        ["Rank", "Coder", "ACI", "Pass@1", "Cost · Wall"],
        ["right", "left", "right", "right", "right"]
      ),
    ];

    const fullCombined: string[] = [
      ...tableHeader(
        [
          "Rank",
          "Coder",
          "ACI",
          "Solo LSAS",
          "Pair LSAS",
          "ZSDR",
          "Pass@1",
          "Suite cost",
          "$/clean pass",
          "Total wall",
          "Active tok/s",
          "Diff ratio",
        ],
        [
          "right",
          "left",
          "right",
          "right",
          "right",
          "right",
          "right",
          "right",
          "right",
          "right",
          "right",
          "right",
        ]
      ),
    ];

    for (const [index, row] of summary.combinedCoderRows.entries()) {
      compactCombined.push(
        tableRow([
          String(index + 1),
          displayModelLabel(row.model),
          row.aci.toFixed(1),
          `${row.passedCount}/${row.totalTrials} (${percent(row.passRate, 0)})`,
          `${format(row.totalCostUsd, 2, "", "$")} · ${formatMinutes(row.totalWallS)}`,
        ])
      );

      fullCombined.push(
        tableRow([
          String(index + 1),
          `\`${row.model}\``,
          row.aci.toFixed(1),
          row.solo.lsas.toFixed(1),
          row.pair.lsas.toFixed(1),
          `${percent(row.zsdrRate)} (${row.zsdrCount}/${row.totalTrials})`,
          `${percent(row.passRate)} (${row.passedCount}/${row.totalTrials})`,
          format(row.totalCostUsd, 2, "", "$"),
          format(row.costPerCleanPassUsd, 3, "", "$"),
          `${Math.round(row.totalWallS)}s`,
          format(row.medianTotalTokPerS, 0),
          format(row.medianDiffRatio, 2, "×"),
        ])
      );
    }

    lines.push(
      "## Combined Autonomous Coder Index (Phases 1 + 3)",
      "",
      ...compactCombined,
      "",
      ...embed("coder-cost-pareto"),
      ...embed("coder-speed-pareto"),
      ...embed("overhead-and-diff"),
      ...detailsBlock(
        "Full coder telemetry (12 metrics, Phases 1 + 3)",
        fullCombined
      )
    );
  }

  if (summary.coderRows.length > 0) {
    lines.push(
      "## Phase 1 — Standalone coder leaderboard",
      "",
      ...compactRoleTableLines(summary.coderRows, false),
      "",
      ...detailsBlock(
        "Full Phase 1 telemetry (13 metrics)",
        fullRoleTableLines(summary.coderRows, false)
      )
    );
  }

  if (summary.reviewerCalibratedRows.length > 0) {
    const heading =
      summary.excludedReviewerTasks.length > 0
        ? `## Phase 2 — Code reviewer leaderboard (calibrated)`
        : "## Phase 2 — Code reviewer leaderboard";

    lines.push(heading, "");

    if (summary.excludedReviewerTasks.length > 0) {
      lines.push(
        `Excludes uncalibrated bounce fixture: \`${summary.excludedReviewerTasks.join("`, `")}\`.`,
        ""
      );
    }

    lines.push(
      ...compactRoleTableLines(summary.reviewerCalibratedRows, true),
      "",
      ...embed("reviewer-cost-pareto"),
      ...embed("reviewer-calibration"),
      ...detailsBlock(
        "Full Phase 2 telemetry (13 metrics, calibrated)",
        fullRoleTableLines(summary.reviewerCalibratedRows, true)
      )
    );

    if (summary.excludedReviewerTasks.length > 0) {
      lines.push(
        ...detailsBlock(
          "All Phase 2 tasks (including uncalibrated bounce fixture)",
          fullRoleTableLines(summary.reviewerRows, true)
        )
      );
    }
  }

  if (summary.pairRows.length > 0) {
    lines.push(
      "## Phase 3 — Pair collaboration leaderboard",
      "",
      ...embed("pair-synergy-matrix"),
      ...compactRoleTableLines(summary.pairRows, false),
      "",
      ...detailsBlock(
        "Full Phase 3 telemetry (13 metrics)",
        fullRoleTableLines(summary.pairRows, false)
      )
    );
  }

  const trialRows: string[] = [
    ...tableHeader(
      [
        "Task",
        "Role",
        "Model",
        "Tier",
        "LSAS",
        "Pass",
        "Raw score",
        "Wall",
        "Cost",
        "Notes",
      ],
      [
        "left",
        "left",
        "left",
        "left",
        "right",
        "center",
        "right",
        "right",
        "right",
        "left",
      ]
    ),
  ];

  for (const item of summary.scoredTrials) {
    const { trial } = item;

    const failed = [
      ...item.failedTierA,
      ...item.failedTierB,
      ...item.failedTierC,
    ];

    const detail = [
      ...(failed.length > 0 ? [`failed: ${failed.join(", ")}`] : []),
      ...trial.notes,
    ].join("; ");

    trialRows.push(
      tableRow([
        trial.task_id,
        trial.role,
        modelLabel(trial),
        item.tier,
        item.lsas.toFixed(1),
        trial.passed ? "Yes" : "No",
        percent(trial.score),
        format(trial.wall_s, 1, "s"),
        format(trial.total_cost_usd, 4, "", "$"),
        detail,
      ])
    );
  }

  lines.push(
    "## Diagnostics",
    "",
    ...embed("failure-taxonomy"),
    ...embed("task-heatmap"),
    ...detailsBlock(
      `Per-trial breakdown (${summary.scoredTrials.length} trials)`,
      trialRows
    )
  );

  return `${lines.join("\n")}\n`;
};
