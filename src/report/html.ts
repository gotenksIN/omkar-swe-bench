import type { GeneratedChart } from "./charts.ts";
import {
  shortModelLabel, type BenchmarkSummary, type CombinedCoderSummary, type ModelRoleSummary,
} from "./scoring.ts";

function esc(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function pct(value: number, digits = 1): string {
  return `${(100 * value).toFixed(digits)}%`;
}

function usd(value: number | null, digits = 2): string {
  return value === null ? "—" : `$${value.toFixed(digits)}`;
}

function num(value: number | null, digits = 1, suffix = ""): string {
  return value === null ? "—" : `${value.toFixed(digits)}${suffix}`;
}

function providerClass(provider: string): string {
  switch (provider) {
    case "anthropic": return "p-anthropic";
    case "google": return "p-google";
    case "openai": return "p-openai";
    case "deepseek": return "p-deepseek";
    default: return "p-other";
  }
}

function renderCombinedCoderTable(rows: readonly CombinedCoderSummary[]): string {
  if (rows.length === 0) return "";

  const body = rows.map((row, index) => `
    <tr>
      <td class="mono dim">${index + 1}</td>
      <td><span class="badge ${providerClass(row.provider)}"></span><span class="model-name">${esc(row.model)}</span></td>
      <td class="mono strong">${row.aci.toFixed(1)}</td>
      <td class="mono">${row.solo.lsas.toFixed(1)}</td>
      <td class="mono">${row.pair.lsas.toFixed(1)}</td>
      <td class="mono">${pct(row.zsdrRate)} <span class="dim">(${row.zsdrCount}/${row.totalTrials})</span></td>
      <td class="mono">${pct(row.passRate)} <span class="dim">(${row.passedCount}/${row.totalTrials})</span></td>
      <td class="mono">${usd(row.totalCostUsd)}</td>
      <td class="mono">${usd(row.costPerCleanPassUsd, 3)}</td>
      <td class="mono">${Math.round(row.totalWallS)}s</td>
      <td class="mono">${num(row.medianTotalTokPerS, 0)}</td>
      <td class="mono">${num(row.medianDiffRatio, 2, "×")}</td>
    </tr>`).join("");

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th><th>Coder Model</th><th>ACI</th><th>Solo LSAS</th><th>Pair LSAS</th>
            <th>ZSDR</th><th>Pass@1</th><th>Total Cost</th><th>$/Clean Pass</th>
            <th>Total Wall</th><th>Active tok/s</th><th>Diff Ratio</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

function renderRoleTable(rows: readonly ModelRoleSummary[], isReviewer: boolean): string {
  if (rows.length === 0) return "";

  const body = rows.map((row, index) => `
    <tr>
      <td class="mono dim">${index + 1}</td>
      <td><span class="badge ${providerClass(row.provider)}"></span><span class="model-name">${esc(row.label)}</span></td>
      <td class="mono strong">${row.lsas.toFixed(1)}</td>
      <td class="mono">${pct(row.passRate)} <span class="dim">(${row.passedCount}/${row.trials})</span></td>
      ${isReviewer
        ? `<td class="mono">${row.defectRecall === null ? "—" : pct(row.defectRecall)}</td>
           <td class="mono">${row.falsePositiveP0P2}</td>
           <td class="mono">${row.nitpickP3}</td>`
        : `<td class="mono">${pct(row.zsdrRate)} <span class="dim">(${row.zsdrCount}/${row.trials})</span></td>
           <td class="mono">${pct(row.meanRawScore)}</td>
           <td class="mono">${num(row.medianDiffRatio, 2, "×")}</td>`}
      <td class="mono">${usd(row.totalCostUsd)}</td>
      <td class="mono">${num(row.medianWallS, 1, "s")}</td>
      <td class="mono">${num(row.coldVisibleS, 2, "s")}</td>
      <td class="mono">${num(row.medianTotalTokPerS, 0)}</td>
      <td class="mono">${pct(row.medianReasoningShare, 0)}</td>
    </tr>`).join("");

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th><th>Model</th><th>LSAS</th><th>Pass@1</th>
            ${isReviewer
              ? "<th>Defect Recall</th><th>P0–P2 FPs</th><th>P3 Nits</th>"
              : "<th>ZSDR</th><th>Mean Check</th><th>Diff Ratio</th>"}
            <th>Suite Cost</th><th>Med Wall</th><th>Cold TTFT</th><th>Active tok/s</th><th>Reasoning %</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

function chartBlock(chart: GeneratedChart | undefined): string {
  if (chart === undefined) return "";

  return `<div class="chart-card" data-chart-id="${esc(chart.id)}">${chart.svg}</div>`;
}

export function renderHtmlReport(summary: BenchmarkSummary, charts: readonly GeneratedChart[]): string {
  const byId = new Map(charts.map((chart) => [chart.id, chart]));
  const topCoder = summary.combinedCoderRows[0];
  const topSolo = summary.coderRows[0];
  const topReviewer = summary.reviewerCalibratedRows[0];
  const topPair = summary.pairRows[0];

  const kpis: readonly { readonly label: string; readonly value: string; readonly sub: string }[] = [
    {
      label: "Evaluated Trials",
      value: `${summary.totalPassed}/${summary.totalTrials}`,
      sub: `${pct(summary.totalTrials === 0 ? 0 : summary.totalPassed / summary.totalTrials)} strict Pass@1 · $${summary.totalCostUsd.toFixed(2)} total`,
    },
    ...(topCoder !== undefined
      ? [{
        label: "Top Autonomous Coder (ACI)",
        value: shortModelLabel(topCoder.model),
        sub: `ACI ${topCoder.aci.toFixed(1)} · ZSDR ${pct(topCoder.zsdrRate)} · $${topCoder.totalCostUsd.toFixed(2)}`,
      }]
      : topSolo !== undefined
        ? [{
          label: "Top Standalone Coder (LSAS)",
          value: shortModelLabel(topSolo.model),
          sub: `LSAS ${topSolo.lsas.toFixed(1)} · Pass ${topSolo.passedCount}/${topSolo.trials} · $${topSolo.totalCostUsd.toFixed(2)}`,
        }]
        : []),
    ...(topReviewer !== undefined
      ? [{
        label: "Top Code Reviewer (LSAS)",
        value: shortModelLabel(topReviewer.model),
        sub: `LSAS ${topReviewer.lsas.toFixed(1)} · ${topReviewer.passedCount}/${topReviewer.trials} pass · med ${topReviewer.medianWallS.toFixed(1)}s`,
      }]
      : []),
    ...(topPair !== undefined
      ? [{
        label: "Top Pair Cell",
        value: topPair.label.split(" -> ").map(shortModelLabel).join(" → "),
        sub: `LSAS ${topPair.lsas.toFixed(1)} · ${topPair.passedCount}/${topPair.trials} · med ${topPair.medianWallS.toFixed(1)}s`,
      }]
      : []),
  ];

  const kpiHtml = kpis.map((kpi) => `
    <div class="kpi">
      <div class="kpi-label">${esc(kpi.label)}</div>
      <div class="kpi-value">${esc(kpi.value)}</div>
      <div class="kpi-sub">${esc(kpi.sub)}</div>
    </div>`).join("");

  const hasCoders = summary.combinedCoderRows.length > 0 || summary.coderRows.length > 0;
  const hasReviewers = summary.reviewerRows.length > 0;
  const hasPairs = summary.pairRows.length > 0;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OmkarSWE Bench — Low-Steering Autonomy Report</title>
<style>
  :root {
    --bg: #0b1120; --card: #0f172a; --card-alt: #131c31; --border: #1e293b;
    --text: #f8fafc; --muted: #94a3b8; --dim: #64748b; --accent: #38bdf8;
    --sans: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--sans); line-height: 1.5; }
  .wrap { max-width: 1120px; margin: 0 auto; padding: 28px 20px 64px; }
  header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 20px; }
  h1 { margin: 0; font-size: 26px; letter-spacing: -0.02em; }
  h2 { margin: 28px 0 12px; font-size: 18px; color: var(--text); }
  .subtitle { color: var(--muted); font-size: 13.5px; margin: 4px 0 0; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-bottom: 22px; }
  .kpi { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }
  .kpi-label { font-size: 11.5px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .kpi-value { font-size: 20px; font-weight: 700; margin: 4px 0; color: var(--text); }
  .kpi-sub { font-size: 12px; color: var(--muted); font-family: var(--mono); }
  .tabs { display: flex; flex-wrap: wrap; gap: 8px; border-bottom: 1px solid var(--border); padding-bottom: 12px; margin-bottom: 20px; }
  .tab { background: var(--card); color: var(--muted); border: 1px solid var(--border); border-radius: 8px; padding: 7px 14px; font-size: 13px; font-weight: 600; cursor: pointer; }
  .tab.active { background: var(--accent); color: var(--bg); border-color: var(--accent); }
  .panel { display: none; }
  .panel.active { display: block; }
  .chart-card { margin: 16px 0; overflow-x: auto; border-radius: 12px; }
  .chart-card svg { display: block; max-width: 100%; height: auto; }
  .table-wrap { overflow-x: auto; background: var(--card); border: 1px solid var(--border); border-radius: 12px; margin: 14px 0 22px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th { color: var(--muted); font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.04em; background: var(--card-alt); }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: rgba(56, 189, 248, 0.05); }
  .mono { font-family: var(--mono); }
  .strong { font-weight: 700; color: var(--accent); }
  .dim { color: var(--dim); }
  .model-name { font-family: var(--mono); font-size: 12.5px; }
  .badge { display: inline-block; width: 9px; height: 9px; border-radius: 999px; margin-right: 8px; vertical-align: middle; }
  .p-anthropic { background: #f59e0b; } .p-google { background: #38bdf8; } .p-openai { background: #34d399; } .p-deepseek { background: #a78bfa; } .p-other { background: #f472b6; }
  .note { background: var(--card); border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: 8px; padding: 12px 14px; color: var(--muted); font-size: 12.5px; margin-top: 24px; }
  .chart-point { cursor: pointer; }
  #tooltip { position: fixed; pointer-events: none; z-index: 999; display: none; max-width: 420px; background: #020617; color: var(--text); border: 1px solid var(--accent); border-radius: 8px; padding: 8px 10px; font-family: var(--mono); font-size: 11.5px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>OmkarSWE Bench</h1>
      <p class="subtitle">Low-steering autonomy rankings, Pareto frontiers, and babysitting diagnostics across deterministic OpenCode evaluations.</p>
    </div>
  </header>

  <section class="kpis">${kpiHtml}</section>

  <nav class="tabs" role="tablist">
    <button class="tab active" data-tab="overview" role="tab">Overview</button>
    ${hasCoders ? '<button class="tab" data-tab="coders" role="tab">Coders</button>' : ""}
    ${hasReviewers ? '<button class="tab" data-tab="reviewers" role="tab">Code Reviewers</button>' : ""}
    ${hasPairs ? '<button class="tab" data-tab="pairs" role="tab">Pair Matrix</button>' : ""}
    <button class="tab" data-tab="diagnostics" role="tab">Task Heatmap</button>
  </nav>

  <section class="panel active" id="tab-overview">
    ${summary.combinedCoderRows.length > 0 ? `<h2>Combined Autonomous Coder Index (ACI — 19 trials)</h2>${renderCombinedCoderTable(summary.combinedCoderRows)}` : ""}
    ${chartBlock(byId.get("coder-cost-pareto"))}
    ${chartBlock(byId.get("reviewer-calibration"))}
    ${chartBlock(byId.get("failure-taxonomy"))}
  </section>

  ${hasCoders ? `
  <section class="panel" id="tab-coders">
    ${summary.combinedCoderRows.length > 0 ? `<h2>Combined Autonomous Coder Index (ACI = 0.6× Solo + 0.4× Pair)</h2>${renderCombinedCoderTable(summary.combinedCoderRows)}` : ""}
    ${chartBlock(byId.get("coder-cost-pareto"))}
    ${chartBlock(byId.get("coder-speed-pareto"))}
    ${chartBlock(byId.get("overhead-and-diff"))}
    <h2>Phase 1 — Standalone Coder Leaderboard</h2>
    ${renderRoleTable(summary.coderRows, false)}
  </section>` : ""}

  ${hasReviewers ? `
  <section class="panel" id="tab-reviewers">
    <h2>Phase 2 — Code Reviewer Leaderboard ${summary.excludedReviewerTasks.length > 0 ? `(Calibrated — excluding ${esc(summary.excludedReviewerTasks.join(", "))})` : ""}</h2>
    ${renderRoleTable(summary.reviewerCalibratedRows, true)}
    ${chartBlock(byId.get("reviewer-cost-pareto"))}
    ${chartBlock(byId.get("reviewer-calibration"))}
    ${summary.excludedReviewerTasks.length > 0 ? `<h2>All Phase 2 Tasks (Including 0%-Pass Bounce Fixture)</h2>${renderRoleTable(summary.reviewerRows, true)}` : ""}
  </section>` : ""}

  ${hasPairs ? `
  <section class="panel" id="tab-pairs">
    <h2>Phase 3 — Coder × Reviewer Synergy Matrix</h2>
    ${chartBlock(byId.get("pair-synergy-matrix"))}
    <h2>Full Pair Leaderboard</h2>
    ${renderRoleTable(summary.pairRows, false)}
  </section>` : ""}

  <section class="panel" id="tab-diagnostics">
    ${chartBlock(byId.get("task-heatmap"))}
    ${chartBlock(byId.get("failure-taxonomy"))}
  </section>

  <div class="note">
    <strong>Methodology:</strong> <strong>LSAS (Low-Steering Autonomy Score, 0–100)</strong> zeroes timeouts, crashes, and partial runs; caps broken deliverables or scope violations at ≤25; deducts 35 pts for static/test hygiene misses, 20 pts for skipped verification, and 8 pts for self-healed in-session friction (e.g., commit-guard rejections recovered autonomously). For Code Reviewers, LSAS starts at 100× recall (100 on clean diffs) minus 30 pts per blocking P0–P2 false alarm and 15 pts per P3 nitpick. <strong>ZSDR (Zero-Steering Deliverable Rate)</strong> is the share of trials requiring zero human intervention after the session ends. Cost and Wall Time are kept strictly on orthogonal Pareto axes.
  </div>
</div>
<div id="tooltip"></div>
<script>
(() => {
  const tabs = document.querySelectorAll(".tab");
  const panels = document.querySelectorAll(".panel");
  tabs.forEach((btn) => btn.addEventListener("click", () => {
    tabs.forEach((b) => b.classList.remove("active"));
    panels.forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    const target = document.getElementById("tab-" + btn.dataset.tab);
    if (target) target.classList.add("active");
  }));
  const tip = document.getElementById("tooltip");
  document.addEventListener("mousemove", (event) => {
    const el = event.target instanceof Element ? event.target.closest("[data-tip]") : null;
    if (!el || !tip) { if (tip) tip.style.display = "none"; return; }
    tip.textContent = el.getAttribute("data-tip") || "";
    tip.style.display = "block";
    const x = Math.min(window.innerWidth - tip.offsetWidth - 12, event.clientX + 14);
    const y = Math.min(window.innerHeight - tip.offsetHeight - 12, event.clientY + 14);
    tip.style.left = Math.max(8, x) + "px";
    tip.style.top = Math.max(8, y) + "px";
  });
})();
</script>
</body>
</html>
`;
}
