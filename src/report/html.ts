import type { GeneratedChart } from "./charts.ts";
import { displayModelLabel } from "./scoring.ts";
import type {
  BenchmarkSummary,
  CombinedCoderSummary,
  ModelRoleSummary,
} from "./scoring.ts";

const esc = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const pct = (value: number, digits = 1): string =>
  `${(100 * value).toFixed(digits)}%`;

const usd = (value: number | null, digits = 2): string =>
  value === null ? "—" : `$${value.toFixed(digits)}`;

const num = (value: number | null, digits = 1, suffix = ""): string =>
  value === null ? "—" : `${value.toFixed(digits)}${suffix}`;

const providerClass = (provider: string): string => {
  switch (provider) {
    case "anthropic": {
      return "p-anthropic";
    }

    case "google": {
      return "p-google";
    }

    case "openai": {
      return "p-openai";
    }

    case "deepseek": {
      return "p-deepseek";
    }

    default: {
      return "p-other";
    }
  }
};

const renderCombinedCoderTable = (
  rows: readonly CombinedCoderSummary[]
): string => {
  if (rows.length === 0) {
    return "";
  }

  const body = rows
    .map(
      (row, index) => `
    <tr>
      <td class="mono dim">${index + 1}</td>
      <td><span class="badge ${providerClass(row.provider)}"></span><span class="model-name" title="${esc(row.model)}">${esc(displayModelLabel(row.model))}</span></td>
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
    </tr>`
    )
    .join("");

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
};

const renderRoleTable = (
  rows: readonly ModelRoleSummary[],
  isReviewer: boolean
): string => {
  if (rows.length === 0) {
    return "";
  }

  const body = rows
    .map(
      (row, index) => `
    <tr>
      <td class="mono dim">${index + 1}</td>
      <td><span class="badge ${providerClass(row.provider)}"></span><span class="model-name" title="${esc(row.label)}">${esc(displayModelLabel(row.label))}</span></td>
      <td class="mono strong">${row.lsas.toFixed(1)}</td>
      <td class="mono">${pct(row.passRate)} <span class="dim">(${row.passedCount}/${row.trials})</span></td>
      ${
        isReviewer
          ? `<td class="mono">${row.defectRecall === null ? "—" : pct(row.defectRecall)}</td>
           <td class="mono">${row.falsePositiveP0P2}</td>
           <td class="mono">${row.nitpickP3}</td>`
          : `<td class="mono">${pct(row.zsdrRate)} <span class="dim">(${row.zsdrCount}/${row.trials})</span></td>
           <td class="mono">${pct(row.meanRawScore)}</td>
           <td class="mono">${num(row.medianDiffRatio, 2, "×")}</td>`
      }
      <td class="mono">${usd(row.totalCostUsd)}</td>
      <td class="mono">${num(row.medianWallS, 1, "s")}</td>
      <td class="mono">${num(row.coldVisibleS, 2, "s")}</td>
      <td class="mono">${num(row.medianTotalTokPerS, 0)}</td>
      <td class="mono">${pct(row.medianReasoningShare, 0)}</td>
    </tr>`
    )
    .join("");

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th><th>Model</th><th>LSAS</th><th>Pass@1</th>
            ${
              isReviewer
                ? "<th>Defect Recall</th><th>P0–P2 FPs</th><th>P3 Nits</th>"
                : "<th>ZSDR</th><th>Mean Check</th><th>Diff Ratio</th>"
            }
            <th>Suite Cost</th><th>Med Wall</th><th>Cold TTFT</th><th>Active tok/s</th><th>Reasoning %</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
};

const chartBlock = (chart: GeneratedChart | undefined): string => {
  if (chart === undefined) {
    return "";
  }

  return `<div class="chart-card" data-chart-id="${esc(chart.id)}">${chart.svg}</div>`;
};

const HTML_STYLES = `
  :root {
    color-scheme: light dark;
    --bg: #fcfcfc;
    --card: #ffffff;
    --card-subtle: #fafafa;
    --muted-bg: #f5f5f5;
    --secondary: #ebebeb;
    --border: #e5e5e5;
    --text: #000000;
    --muted: #525252;
    --dim: #737373;
    --primary: #000000;
    --primary-fg: #ffffff;
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
    --p-anthropic: #d97706;
    --p-google: #2563eb;
    --p-openai: #09090b;
    --p-deepseek: #737373;
    --p-other: #525252;
    --sans: Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --mono: "Geist Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #000000;
      --card: #0a0a0a;
      --card-subtle: #111111;
      --muted-bg: #171717;
      --secondary: #222222;
      --border: #262626;
      --text: #ffffff;
      --muted: #a3a3a3;
      --dim: #737373;
      --primary: #ffffff;
      --primary-fg: #000000;
      --shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
      --p-anthropic: #f5a623;
      --p-google: #3b82f6;
      --p-openai: #f5f5f5;
      --p-deepseek: #a3a3a3;
      --p-other: #737373;
    }
  }
  html[data-theme="dark"] {
    color-scheme: dark;
    --bg: #000000;
    --card: #0a0a0a;
    --card-subtle: #111111;
    --muted-bg: #171717;
    --secondary: #222222;
    --border: #262626;
    --text: #ffffff;
    --muted: #a3a3a3;
    --dim: #737373;
    --primary: #ffffff;
    --primary-fg: #000000;
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
    --p-anthropic: #f5a623;
    --p-google: #3b82f6;
    --p-openai: #f5f5f5;
    --p-deepseek: #a3a3a3;
    --p-other: #737373;
  }
  html[data-theme="light"] {
    color-scheme: light;
  }
  html[data-theme="light"] .omkar-chart {
    --c-bg: #fcfcfc; --c-card: #ffffff; --c-muted-bg: #f5f5f5; --c-border: #e5e5e5;
    --c-grid: #efefef; --c-axis: #d4d4d4; --c-text: #000000; --c-muted: #525252;
    --c-subtle: #737373; --c-frontier: #000000; --c-quadrant: #f5f5f5;
    --c-reason-overlay: rgba(0, 0, 0, 0.24);
    --p-anthropic: #d97706; --p-google: #2563eb; --p-openai: #09090b; --p-deepseek: #737373; --p-other: #525252;
    --t-clean: #18181b; --t-clean-ink: #ffffff; --t-friction: #3167f6; --t-friction-ink: #ffffff;
    --t-nudge: #f5a623; --t-nudge-ink: #000000; --t-broken: #e5484d; --t-broken-ink: #ffffff;
    --t-timeout: #a3a3a3; --t-timeout-ink: #000000;
    --m-top: #18181b; --m-high: #3167f6; --m-mid: #f5a623; --m-low: #e5484d;
    --d-balanced: #18181b; --d-compressed: #f5a623; --d-verbose: #e5484d;
  }
  html[data-theme="dark"] .omkar-chart {
    --c-bg: #000000; --c-card: #0a0a0a; --c-muted-bg: #171717; --c-border: #262626;
    --c-grid: #1a1a1a; --c-axis: #3a3a3a; --c-text: #ffffff; --c-muted: #a3a3a3;
    --c-subtle: #737373; --c-frontier: #ffffff; --c-quadrant: #171717;
    --c-reason-overlay: rgba(0, 0, 0, 0.45);
    --p-anthropic: #f5a623; --p-google: #3b82f6; --p-openai: #f5f5f5; --p-deepseek: #a3a3a3; --p-other: #737373;
    --t-clean: #e5e5e5; --t-clean-ink: #000000; --t-friction: #3b82f6; --t-friction-ink: #ffffff;
    --t-nudge: #f5a623; --t-nudge-ink: #000000; --t-broken: #f2555a; --t-broken-ink: #000000;
    --t-timeout: #525252; --t-timeout-ink: #ffffff;
    --m-top: #ffffff; --m-high: #3b82f6; --m-mid: #f5a623; --m-low: #f2555a;
    --d-balanced: #e5e5e5; --d-compressed: #f5a623; --d-verbose: #f2555a;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--sans); line-height: 1.5; -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 1120px; margin: 0 auto; padding: 32px 24px 64px; }
  header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 24px; }
  h1 { margin: 0; font-size: 24px; font-weight: 600; letter-spacing: -0.025em; }
  h2 { margin: 28px 0 12px; font-size: 16px; font-weight: 600; letter-spacing: -0.015em; color: var(--text); }
  .subtitle { color: var(--muted); font-size: 13.5px; margin: 4px 0 0; }
  .theme-switch { display: inline-flex; background: var(--muted-bg); border: 1px solid var(--border); border-radius: 8px; padding: 3px; gap: 2px; }
  .theme-btn { background: transparent; color: var(--muted); border: none; border-radius: 6px; padding: 5px 10px; font-family: var(--sans); font-size: 12px; font-weight: 500; cursor: pointer; }
  .theme-btn.active { background: var(--card); color: var(--text); box-shadow: var(--shadow); }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .kpi { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; box-shadow: var(--shadow); }
  .kpi-label { font-size: 11px; font-weight: 500; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .kpi-value { font-size: 17px; font-weight: 600; letter-spacing: -0.015em; margin: 6px 0 4px; color: var(--text); }
  .kpi-sub { font-size: 12px; color: var(--muted); font-family: var(--mono); }
  .tabs { display: inline-flex; flex-wrap: wrap; gap: 4px; background: var(--muted-bg); border: 1px solid var(--border); border-radius: 9px; padding: 4px; margin-bottom: 20px; }
  .tab { background: transparent; color: var(--muted); border: none; border-radius: 6px; padding: 6px 13px; font-family: var(--sans); font-size: 13px; font-weight: 500; cursor: pointer; }
  .tab:hover { color: var(--text); }
  .tab.active { background: var(--primary); color: var(--primary-fg); }
  .panel { display: none; }
  .panel.active { display: block; }
  .chart-card { margin: 20px 0; overflow-x: auto; border-radius: 10px; }
  .chart-card svg { display: block; width: 100%; height: auto; }
  .table-wrap { overflow-x: auto; background: var(--card); border: 1px solid var(--border); border-radius: 10px; margin: 14px 0 22px; box-shadow: var(--shadow); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th { color: var(--muted); font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.04em; background: var(--card-subtle); }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: var(--muted-bg); }
  .mono { font-family: var(--mono); font-size: 12.5px; }
  .strong { font-weight: 600; color: var(--text); }
  .dim { color: var(--dim); }
  .model-name { font-weight: 500; font-size: 13px; }
  .badge { display: inline-block; width: 8px; height: 8px; border-radius: 999px; margin-right: 8px; vertical-align: middle; }
  .p-anthropic { background: var(--p-anthropic); } .p-google { background: var(--p-google); } .p-openai { background: var(--p-openai); } .p-deepseek { background: var(--p-deepseek); } .p-other { background: var(--p-other); }
  .note { background: var(--card-subtle); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; color: var(--muted); font-size: 13px; line-height: 1.6; margin-top: 28px; }
  .note-title { font-size: 13px; font-weight: 600; color: var(--text); margin: 0 0 10px; letter-spacing: -0.01em; }
  .note p { margin: 0 0 8px; }
  .note p:last-child { margin-bottom: 0; }
  .note strong { color: var(--text); font-weight: 600; }
  .chart-point { cursor: pointer; }
  #tooltip { position: fixed; pointer-events: none; z-index: 999; display: none; max-width: 440px; background: var(--primary); color: var(--primary-fg); border: 1px solid var(--border); border-radius: 7px; padding: 7px 10px; font-family: var(--mono); font-size: 11.5px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22); }
`;

export const renderHtmlReport = (
  summary: BenchmarkSummary,
  charts: readonly GeneratedChart[]
): string => {
  const byId = new Map(charts.map((chart) => [chart.id, chart]));
  const [topCoder] = summary.combinedCoderRows;
  const [topSolo] = summary.coderRows;
  const [topReviewer] = summary.reviewerCalibratedRows;
  const [topPair] = summary.pairRows;

  const kpis: {
    readonly label: string;
    readonly value: string;
    readonly sub: string;
  }[] = [
    {
      label: "Evaluated Trials",
      value: `${summary.totalPassed}/${summary.totalTrials}`,
      sub: `${pct(summary.totalTrials === 0 ? 0 : summary.totalPassed / summary.totalTrials)} strict Pass@1 · $${summary.totalCostUsd.toFixed(2)} total`,
    },
  ];

  if (topCoder !== undefined) {
    kpis.push({
      label: "Top Autonomous Coder (ACI)",
      value: displayModelLabel(topCoder.model),
      sub: `ACI ${topCoder.aci.toFixed(1)} · ZSDR ${pct(topCoder.zsdrRate)} · $${topCoder.totalCostUsd.toFixed(2)}`,
    });
  } else if (topSolo !== undefined) {
    kpis.push({
      label: "Top Standalone Coder (LSAS)",
      value: displayModelLabel(topSolo.model),
      sub: `LSAS ${topSolo.lsas.toFixed(1)} · Pass ${topSolo.passedCount}/${topSolo.trials} · $${topSolo.totalCostUsd.toFixed(2)}`,
    });
  }

  if (topReviewer !== undefined) {
    kpis.push({
      label: "Top Code Reviewer (LSAS)",
      value: displayModelLabel(topReviewer.model),
      sub: `LSAS ${topReviewer.lsas.toFixed(1)} · ${topReviewer.passedCount}/${topReviewer.trials} pass · med ${topReviewer.medianWallS.toFixed(1)}s`,
    });
  }

  if (topPair !== undefined) {
    kpis.push({
      label: "Top Pair Cell",
      value: displayModelLabel(topPair.label),
      sub: `LSAS ${topPair.lsas.toFixed(1)} · ${topPair.passedCount}/${topPair.trials} · med ${topPair.medianWallS.toFixed(1)}s`,
    });
  }

  const kpiHtml = kpis
    .map(
      (kpi) => `
    <div class="kpi">
      <div class="kpi-label">${esc(kpi.label)}</div>
      <div class="kpi-value">${esc(kpi.value)}</div>
      <div class="kpi-sub">${esc(kpi.sub)}</div>
    </div>`
    )
    .join("");

  const hasCoders =
    summary.combinedCoderRows.length > 0 || summary.coderRows.length > 0;

  const hasReviewers = summary.reviewerRows.length > 0;
  const hasPairs = summary.pairRows.length > 0;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OmkarSWE Bench — Low-Steering Autonomy Report</title>
<style>${HTML_STYLES}</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>OmkarSWE Bench</h1>
      <p class="subtitle">Low-steering autonomy rankings, Pareto frontiers, and babysitting diagnostics across deterministic OpenCode evaluations.</p>
    </div>
    <div class="theme-switch" role="group" aria-label="Color theme">
      <button class="theme-btn active" data-theme-set="system" type="button">System</button>
      <button class="theme-btn" data-theme-set="light" type="button">Light</button>
      <button class="theme-btn" data-theme-set="dark" type="button">Dark</button>
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

  ${
    hasCoders
      ? `
  <section class="panel" id="tab-coders">
    ${summary.combinedCoderRows.length > 0 ? `<h2>Combined Autonomous Coder Index (ACI = 0.6× Solo + 0.4× Pair)</h2>${renderCombinedCoderTable(summary.combinedCoderRows)}` : ""}
    ${chartBlock(byId.get("coder-cost-pareto"))}
    ${chartBlock(byId.get("coder-speed-pareto"))}
    ${chartBlock(byId.get("overhead-and-diff"))}
    <h2>Phase 1 — Standalone Coder Leaderboard</h2>
    ${renderRoleTable(summary.coderRows, false)}
  </section>`
      : ""
  }

  ${
    hasReviewers
      ? `
  <section class="panel" id="tab-reviewers">
    <h2>Phase 2 — Code Reviewer Leaderboard ${summary.excludedReviewerTasks.length > 0 ? `(Calibrated — excluding ${esc(summary.excludedReviewerTasks.join(", "))})` : ""}</h2>
    ${renderRoleTable(summary.reviewerCalibratedRows, true)}
    ${chartBlock(byId.get("reviewer-cost-pareto"))}
    ${chartBlock(byId.get("reviewer-calibration"))}
    ${summary.excludedReviewerTasks.length > 0 ? `<h2>All Phase 2 Tasks (Including 0%-Pass Bounce Fixture)</h2>${renderRoleTable(summary.reviewerRows, true)}` : ""}
  </section>`
      : ""
  }

  ${
    hasPairs
      ? `
  <section class="panel" id="tab-pairs">
    <h2>Phase 3 — Coder × Reviewer Synergy Matrix</h2>
    ${chartBlock(byId.get("pair-synergy-matrix"))}
    <h2>Full Pair Leaderboard</h2>
    ${renderRoleTable(summary.pairRows, false)}
  </section>`
      : ""
  }

  <section class="panel" id="tab-diagnostics">
    ${chartBlock(byId.get("task-heatmap"))}
    ${chartBlock(byId.get("failure-taxonomy"))}
  </section>

  <div class="note">
    <div class="note-title">Methodology</div>
    <p><strong>LSAS (Low-Steering Autonomy Score, 0–100)</strong><br>Zeroes timeouts, crashes, and partial runs; caps broken deliverables or scope violations at ≤25; deducts 35 pts for static/test hygiene misses, 20 pts for skipped verification, and 8 pts for self-healed in-session friction (such as commit-guard rejections recovered autonomously).</p>
    <p><strong>Code Reviewer LSAS</strong><br>Starts at 100× defect recall (100 on clean diffs), minus 30 pts per blocking P0–P2 false alarm and 15 pts per P3 nitpick.</p>
    <p><strong>ZSDR (Zero-Steering Deliverable Rate)</strong><br>Share of trials requiring zero human intervention after the session ends. Cost and Wall Time stay on orthogonal Pareto axes.</p>
  </div>
</div>
<div id="tooltip"></div>
<script>
(() => {
  const root = document.documentElement;
  const themeBtns = document.querySelectorAll("[data-theme-set]");
  const applyTheme = (mode) => {
    if (mode === "light" || mode === "dark") {
      root.setAttribute("data-theme", mode);
    } else {
      root.removeAttribute("data-theme");
    }
    themeBtns.forEach((b) => b.classList.toggle("active", b.dataset.themeSet === mode));
  };
  const saved = (() => { try { return localStorage.getItem("omkar-theme"); } catch { return null; } })();
  applyTheme(saved === "light" || saved === "dark" ? saved : "system");
  themeBtns.forEach((btn) => btn.addEventListener("click", () => {
    const mode = btn.dataset.themeSet || "system";
    applyTheme(mode);
    try { localStorage.setItem("omkar-theme", mode); } catch {}
  }));

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
};
