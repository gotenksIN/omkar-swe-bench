import { computeParetoFrontier, shortModelLabel } from "./scoring.ts";
import type {
  BenchmarkSummary,
  FailureTier,
  ModelRoleSummary,
} from "./scoring.ts";

export interface GeneratedChart {
  readonly id: string;
  readonly filename: string;
  readonly title: string;
  readonly subtitle: string;
  readonly category: "coder" | "reviewer" | "pair" | "overview";
  readonly svg: string;
}

interface ScatterItem {
  readonly id: string;
  readonly label: string;
  readonly provider: string;
  readonly x: number;
  readonly y: number;
  readonly ringY?: number;
  readonly radius?: number;
  readonly tip: string;
}

interface PlacedLabel {
  readonly x: number;
  readonly y: number;
  readonly anchor: "start" | "middle" | "end";
  readonly leader: boolean;
}

interface Rect {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

const FONT_SANS =
  "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const FONT_MONO =
  "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

const BG = "#0b1120";
const CARD = "#0f172a";
const BORDER = "#1e293b";
const GRID = "#1e293b";
const AXIS = "#334155";
const TEXT = "#f8fafc";
const MUTED = "#94a3b8";
const SUBTLE = "#64748b";
const PARETO = "#38bdf8";

const providerColor = (provider: string): string => {
  switch (provider) {
    case "anthropic": {
      return "#f59e0b";
    }

    case "google": {
      return "#38bdf8";
    }

    case "openai": {
      return "#34d399";
    }

    case "deepseek": {
      return "#a78bfa";
    }

    default: {
      return "#f472b6";
    }
  }
};

const TIER_META: readonly {
  readonly key: FailureTier;
  readonly label: string;
  readonly color: string;
}[] = [
  { key: "clean_pass", label: "Clean first-shot pass", color: "#10b981" },
  {
    key: "self_healed_friction",
    label: "Self-healed friction",
    color: "#06b6d4",
  },
  { key: "hygiene_nudge", label: "Hygiene / lint nudge", color: "#f59e0b" },
  {
    key: "broken_deliverable",
    label: "Broken / stubborn refusal",
    color: "#ef4444",
  },
  { key: "timeout_crash", label: "Timeout / crash", color: "#475569" },
];

const TIER_COLORS: Readonly<Record<FailureTier, string>> = {
  clean_pass: "#10b981",
  self_healed_friction: "#06b6d4",
  hygiene_nudge: "#f59e0b",
  broken_deliverable: "#ef4444",
  timeout_crash: "#475569",
};

const esc = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const providerDisplay = (provider: string): string => {
  switch (provider) {
    case "anthropic": {
      return "Anthropic";
    }

    case "google": {
      return "Google";
    }

    case "openai": {
      return "OpenAI";
    }

    case "deepseek": {
      return "DeepSeek";
    }

    default: {
      return provider;
    }
  }
};

const markerPath = (
  provider: string,
  cx: number,
  cy: number,
  radius: number
): string => {
  const color = providerColor(provider);

  if (provider === "anthropic") {
    const r = radius * 1.18;

    return `<polygon points="${cx.toFixed(1)},${(cy - r).toFixed(1)} ${(cx + r).toFixed(1)},${cy.toFixed(1)} ${cx.toFixed(1)},${(cy + r).toFixed(1)} ${(cx - r).toFixed(1)},${cy.toFixed(1)}" fill="${color}" stroke="${BG}" stroke-width="1.5"/>`;
  }

  if (provider === "openai") {
    const half = radius * 0.92;

    return `<rect x="${(cx - half).toFixed(1)}" y="${(cy - half).toFixed(1)}" width="${(half * 2).toFixed(1)}" height="${(half * 2).toFixed(1)}" rx="2" fill="${color}" stroke="${BG}" stroke-width="1.5"/>`;
  }

  if (provider === "deepseek") {
    const r = radius * 1.15;

    return `<polygon points="${cx.toFixed(1)},${(cy - r).toFixed(1)} ${(cx + r).toFixed(1)},${(cy + r * 0.82).toFixed(1)} ${(cx - r).toFixed(1)},${(cy + r * 0.82).toFixed(1)}" fill="${color}" stroke="${BG}" stroke-width="1.5"/>`;
  }

  return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${radius.toFixed(1)}" fill="${color}" stroke="${BG}" stroke-width="1.5"/>`;
};

const svgHeader = (
  width: number,
  height: number,
  title: string,
  subtitle: string
): string =>
  [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(title)}">`,
    `<title>${esc(title)}</title>`,
    `<desc>${esc(subtitle)}</desc>`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${BG}"/>`,
    `<rect x="12" y="12" width="${width - 24}" height="${height - 24}" rx="12" fill="${CARD}" stroke="${BORDER}" stroke-width="1"/>`,
    `<text x="32" y="42" fill="${TEXT}" font-family="${FONT_SANS}" font-size="18" font-weight="700">${esc(title)}</text>`,
    `<text x="32" y="62" fill="${MUTED}" font-family="${FONT_SANS}" font-size="12">${esc(subtitle)}</text>`,
  ].join("\n");

const rectsOverlap = (a: Rect, b: Rect): boolean =>
  a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;

const labelRect = (
  x: number,
  y: number,
  anchor: "start" | "middle" | "end",
  textWidth: number
): Rect => {
  let x1 = x - textWidth / 2;

  if (anchor === "start") {
    x1 = x;
  } else if (anchor === "end") {
    x1 = x - textWidth;
  }

  return { x1: x1 - 3, y1: y - 12, x2: x1 + textWidth + 3, y2: y + 4 };
};

const placeLabels = (
  coords: readonly {
    readonly cx: number;
    readonly cy: number;
    readonly r: number;
    readonly label: string;
  }[],
  bounds: Rect
): readonly PlacedLabel[] => {
  const placed: Rect[] = [];

  for (const point of coords) {
    placed.push({
      x1: point.cx - point.r - 3,
      y1: point.cy - point.r - 3,
      x2: point.cx + point.r + 3,
      y2: point.cy + point.r + 3,
    });
  }

  const results: PlacedLabel[] = [];

  for (const point of coords) {
    const textWidth = point.label.length * 6.7 + 6;
    const gap = point.r + 7;

    const candidates: readonly {
      readonly x: number;
      readonly y: number;
      readonly anchor: "start" | "middle" | "end";
      readonly dist: number;
    }[] = [
      { x: point.cx + gap, y: point.cy + 4, anchor: "start", dist: 1 },
      { x: point.cx - gap, y: point.cy + 4, anchor: "end", dist: 1.1 },
      { x: point.cx, y: point.cy - gap - 2, anchor: "middle", dist: 1.2 },
      { x: point.cx, y: point.cy + gap + 11, anchor: "middle", dist: 1.3 },
      { x: point.cx + gap, y: point.cy - gap, anchor: "start", dist: 1.6 },
      { x: point.cx - gap, y: point.cy - gap, anchor: "end", dist: 1.7 },
      { x: point.cx + gap, y: point.cy + gap + 10, anchor: "start", dist: 1.8 },
      { x: point.cx - gap, y: point.cy + gap + 10, anchor: "end", dist: 1.9 },
      { x: point.cx + gap + 14, y: point.cy - 18, anchor: "start", dist: 3 },
      { x: point.cx - gap - 14, y: point.cy - 18, anchor: "end", dist: 3.1 },
      { x: point.cx + gap + 14, y: point.cy + 24, anchor: "start", dist: 3.2 },
      { x: point.cx - gap - 14, y: point.cy + 24, anchor: "end", dist: 3.3 },
      { x: point.cx, y: point.cy - gap - 20, anchor: "middle", dist: 3.5 },
      { x: point.cx, y: point.cy + gap + 28, anchor: "middle", dist: 3.6 },
    ];

    let best = candidates[0] ?? {
      x: point.cx + gap,
      y: point.cy + 4,
      anchor: "start" as const,
      dist: 1,
    };

    let bestCost = Infinity;

    for (const candidate of candidates) {
      const box = labelRect(
        candidate.x,
        candidate.y,
        candidate.anchor,
        textWidth
      );

      let cost = candidate.dist;

      if (box.x1 < bounds.x1) {
        cost += 50 + (bounds.x1 - box.x1);
      }

      if (box.x2 > bounds.x2) {
        cost += 50 + (box.x2 - bounds.x2);
      }

      if (box.y1 < bounds.y1) {
        cost += 50 + (bounds.y1 - box.y1);
      }

      if (box.y2 > bounds.y2) {
        cost += 50 + (box.y2 - bounds.y2);
      }

      for (const existing of placed) {
        if (rectsOverlap(box, existing)) {
          cost += 40;
        }
      }

      if (cost < bestCost) {
        bestCost = cost;
        best = candidate;
      }
    }

    placed.push(labelRect(best.x, best.y, best.anchor, textWidth));
    results.push({
      x: best.x,
      y: best.y,
      anchor: best.anchor,
      leader: best.dist >= 2.8,
    });
  }

  return results;
};

const providerLegend = (
  providers: readonly string[],
  startX: number,
  y: number
): string => {
  const parts: string[] = [];
  let cursor = startX;

  for (const provider of providers) {
    parts.push(markerPath(provider, cursor, y - 4, 5));
    const label = providerDisplay(provider);
    parts.push(
      `<text x="${(cursor + 10).toFixed(1)}" y="${y}" fill="${MUTED}" font-family="${FONT_SANS}" font-size="11">${esc(label)}</text>`
    );
    cursor += label.length * 6.8 + 26;
  }

  return parts.join("\n");
};

const logTicks = (minVal: number, maxVal: number): readonly number[] => {
  const candidates = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50];
  const ticks: number[] = [];

  for (const tick of candidates) {
    if (tick >= minVal * 0.99 && tick <= maxVal * 1.01) {
      ticks.push(tick);
    }
  }

  return ticks.length >= 2
    ? ticks
    : [minVal, Math.sqrt(minVal * maxVal), maxVal];
};

const niceStepFactor = (scaled: number): number => {
  if (scaled <= 1) {
    return 1;
  }

  if (scaled <= 2) {
    return 2;
  }

  if (scaled <= 5) {
    return 5;
  }

  return 10;
};

const linearTicks = (
  minVal: number,
  maxVal: number,
  count = 5
): readonly number[] => {
  const span = Math.max(1e-6, maxVal - minVal);
  const rawStep = span / Math.max(1, count - 1);
  const power = 10 ** Math.floor(Math.log10(rawStep));
  const scaled = rawStep / power;
  const step = niceStepFactor(scaled) * power;
  const start = Math.ceil(minVal / step) * step;
  const ticks: number[] = [];

  for (let val = start; val <= maxVal + step * 0.001; val += step) {
    ticks.push(Math.round(val * 1000) / 1000);
  }

  return ticks;
};

interface ParetoChartOptions {
  readonly title: string;
  readonly subtitle: string;
  readonly xLabel: string;
  readonly yLabel: string;
  readonly logX: boolean;
  readonly formatX: (value: number) => string;
  readonly items: readonly ScatterItem[];
}

const renderParetoStepPath = (
  frontier: readonly ScatterItem[],
  scaleX: (value: number) => number,
  scaleY: (value: number) => number
): string | null => {
  if (frontier.length < 2) {
    return null;
  }

  const pathPts: string[] = [];

  for (let i = 0; i < frontier.length; i += 1) {
    const point = frontier[i];

    if (point === undefined) {
      continue;
    }

    const px = scaleX(point.x);
    const py = scaleY(point.y);

    if (i === 0) {
      pathPts.push(`M ${px.toFixed(1)} ${py.toFixed(1)}`);
    } else {
      const prev = frontier[i - 1];

      if (prev !== undefined) {
        pathPts.push(`L ${px.toFixed(1)} ${scaleY(prev.y).toFixed(1)}`);
      }

      pathPts.push(`L ${px.toFixed(1)} ${py.toFixed(1)}`);
    }
  }

  return `<path d="${pathPts.join(" ")}" fill="none" stroke="${PARETO}" stroke-width="1.8" stroke-dasharray="6 4" opacity="0.85"/>`;
};

const renderParetoScatter = (options: ParetoChartOptions): string => {
  const width = 920;
  const height = 520;
  const left = 78;
  const right = width - 40;
  const top = 96;
  const bottom = height - 66;
  const plotW = right - left;
  const plotH = bottom - top;

  const xs = options.items.map((item) =>
    Math.max(item.x, options.logX ? 0.05 : 0)
  );

  const ys = options.items.map((item) => item.y);
  const minXRaw = Math.min(...xs);
  const maxXRaw = Math.max(...xs);

  const minX = options.logX
    ? Math.max(0.05, minXRaw * 0.72)
    : Math.max(0, minXRaw * 0.85);

  const maxX = options.logX
    ? maxXRaw * 1.35
    : Math.max(minX + 1, maxXRaw * 1.12);

  const minYRaw = Math.min(...ys);
  const minY = Math.max(0, Math.floor((minYRaw - 4) / 5) * 5);
  const maxY = 101;

  const scaleX = (value: number): number => {
    const clamped = Math.max(minX, Math.min(maxX, value));

    if (options.logX) {
      return (
        left +
        ((Math.log10(clamped) - Math.log10(minX)) /
          Math.max(1e-6, Math.log10(maxX) - Math.log10(minX))) *
          plotW
      );
    }

    return left + ((clamped - minX) / Math.max(1e-6, maxX - minX)) * plotW;
  };

  const scaleY = (value: number): number =>
    bottom - ((value - minY) / Math.max(1e-6, maxY - minY)) * plotH;

  const parts: string[] = [
    svgHeader(width, height, options.title, options.subtitle),
  ];

  // Gridlines and Y ticks.
  for (const yTick of linearTicks(minY, 100, 6)) {
    const py = scaleY(yTick);
    parts.push(
      `<line x1="${left}" y1="${py.toFixed(1)}" x2="${right}" y2="${py.toFixed(1)}" stroke="${GRID}" stroke-width="1"/>`,
      `<text x="${left - 10}" y="${(py + 4).toFixed(1)}" text-anchor="end" fill="${MUTED}" font-family="${FONT_MONO}" font-size="11">${yTick.toFixed(0)}</text>`
    );
  }

  // X ticks.
  const xTicks = options.logX
    ? logTicks(minX, maxX)
    : linearTicks(minX, maxX, 6);

  for (const xTick of xTicks) {
    const px = scaleX(xTick);

    if (px < left - 2 || px > right + 2) {
      continue;
    }

    parts.push(
      `<line x1="${px.toFixed(1)}" y1="${top}" x2="${px.toFixed(1)}" y2="${bottom}" stroke="${GRID}" stroke-width="1"/>`,
      `<text x="${px.toFixed(1)}" y="${bottom + 20}" text-anchor="middle" fill="${MUTED}" font-family="${FONT_MONO}" font-size="11">${esc(options.formatX(xTick))}</text>`
    );
  }

  // Axes and directional hints.
  parts.push(
    `<line x1="${left}" y1="${top}" x2="${left}" y2="${bottom}" stroke="${AXIS}" stroke-width="1.2"/>`,
    `<line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="${AXIS}" stroke-width="1.2"/>`,
    `<text x="${(left + right) / 2}" y="${height - 24}" text-anchor="middle" fill="${MUTED}" font-family="${FONT_SANS}" font-size="12">${esc(options.xLabel)}</text>`,
    `<text x="26" y="${(top + bottom) / 2}" text-anchor="middle" fill="${MUTED}" font-family="${FONT_SANS}" font-size="12" transform="rotate(-90 26 ${(top + bottom) / 2})">${esc(options.yLabel)}</text>`
  );

  if (minY > 0) {
    parts.push(
      `<text x="${left + 8}" y="${bottom - 8}" fill="${SUBTLE}" font-family="${FONT_SANS}" font-size="10">Y-axis starts at ${minY} (zoomed)</text>`
    );
  }

  parts.push(
    `<text x="${left + 8}" y="${top + 16}" fill="${PARETO}" font-family="${FONT_SANS}" font-size="11" font-weight="600">↖ Better (Higher autonomy, lower ${options.logX ? "cost" : "wall time"})</text>`
  );

  // Pareto frontier step-line.
  const frontier = computeParetoFrontier(options.items);
  const stepPath = renderParetoStepPath(frontier, scaleX, scaleY);

  if (stepPath !== null) {
    parts.push(stepPath);
  }

  const frontierIds = new Set(frontier.map((item) => item.id));

  // Plot points and labels.
  const coords = options.items.map((item) => ({
    item,
    cx: scaleX(Math.max(item.x, options.logX ? 0.05 : 0)),
    cy: scaleY(item.y),
    r: item.radius ?? (frontierIds.has(item.id) ? 7.5 : 6),
    label: item.label,
  }));

  const labels = placeLabels(coords, {
    x1: left + 6,
    y1: top + 20,
    x2: right - 6,
    y2: bottom - 12,
  });

  for (let i = 0; i < coords.length; i += 1) {
    const point = coords[i];
    const placed = labels[i];

    if (point === undefined || placed === undefined) {
      continue;
    }

    if (placed.leader) {
      parts.push(
        `<line x1="${point.cx.toFixed(1)}" y1="${point.cy.toFixed(1)}" x2="${placed.x.toFixed(1)}" y2="${(placed.y - 4).toFixed(1)}" stroke="${SUBTLE}" stroke-width="0.9" stroke-dasharray="2 2"/>`
      );
    }

    const halo = frontierIds.has(point.item.id)
      ? `<circle cx="${point.cx.toFixed(1)}" cy="${point.cy.toFixed(1)}" r="${(point.r + 3.5).toFixed(1)}" fill="none" stroke="${PARETO}" stroke-width="1.3" opacity="0.7"/>`
      : "";

    parts.push(
      `<g class="chart-point" data-tip="${esc(point.item.tip)}">${halo}${markerPath(point.item.provider, point.cx, point.cy, point.r)}</g>`,
      `<text x="${placed.x.toFixed(1)}" y="${placed.y.toFixed(1)}" text-anchor="${placed.anchor}" fill="${frontierIds.has(point.item.id) ? TEXT : MUTED}" font-family="${FONT_SANS}" font-size="11.5" font-weight="${frontierIds.has(point.item.id) ? "600" : "400"}">${esc(point.label)}</text>`
    );
  }

  // Provider legend top-right.
  const providers = [
    ...new Set(options.items.map((item) => item.provider)),
  ].toSorted();

  const legendWidth =
    providers.reduce(
      (sum, provider) => sum + providerDisplay(provider).length * 6.8 + 26,
      0
    ) + 115;

  const legendStart = Math.max(left, right - legendWidth);

  parts.push(
    providerLegend(providers, legendStart, 82),
    `<line x1="${(right - 102).toFixed(1)}" y1="78" x2="${(right - 78).toFixed(1)}" y2="78" stroke="${PARETO}" stroke-width="1.8" stroke-dasharray="5 3"/>`,
    `<text x="${(right - 72).toFixed(1)}" y="82" fill="${MUTED}" font-family="${FONT_SANS}" font-size="11">Pareto frontier</text>`,
    "</svg>"
  );

  return parts.join("\n");
};

const renderReviewerCalibration = (
  rows: readonly ModelRoleSummary[],
  excludedTasks: readonly string[]
): string => {
  const width = 920;
  const height = 520;
  const left = 78;
  const right = width - 44;
  const top = 96;
  const bottom = height - 66;
  const plotW = right - left;
  const plotH = bottom - top;

  const maxAlarms = Math.max(
    4,
    ...rows.map((row) => row.weightedFalseAlarms + 1)
  );

  const minRecall = Math.max(
    0,
    Math.floor(
      (Math.min(...rows.map((row) => (row.defectRecall ?? 1) * 100)) - 10) / 10
    ) * 10
  );

  const maxWall = Math.max(10, ...rows.map((row) => row.medianWallS));

  // Right = 0 false alarms (higher restraint); Left = more false alarms.
  const scaleX = (alarms: number): number =>
    left + ((maxAlarms - alarms) / maxAlarms) * plotW;

  const scaleY = (recallPct: number): number =>
    bottom - ((recallPct - minRecall) / Math.max(10, 102 - minRecall)) * plotH;

  const scaleR = (wallS: number): number => 6 + Math.sqrt(wallS / maxWall) * 12;

  const subtitle =
    excludedTasks.length > 0
      ? `Seeded defect recall vs. false-alarm restraint (2× P0–P2 FP + 1× P3 nitpick) across calibrated tasks (excluding ${excludedTasks.join(", ")}); bubble size = median wall time`
      : "Seeded defect recall vs. false-alarm restraint (2× P0–P2 FP + 1× P3 nitpick); bubble size = median wall time";

  const parts: string[] = [
    svgHeader(width, height, "Code Reviewer Calibration Quadrant", subtitle),
  ];

  // Quadrant highlight for top-right (high recall >= 95%, <= 1 weighted false alarm).
  const qx = scaleX(1.5);
  const qy = scaleY(95);
  parts.push(
    `<rect x="${qx.toFixed(1)}" y="${top}" width="${(right - qx).toFixed(1)}" height="${(qy - top).toFixed(1)}" fill="#10b981" opacity="0.07"/>`,
    `<line x1="${qx.toFixed(1)}" y1="${top}" x2="${qx.toFixed(1)}" y2="${bottom}" stroke="${AXIS}" stroke-width="1" stroke-dasharray="4 4"/>`,
    `<line x1="${left}" y1="${qy.toFixed(1)}" x2="${right}" y2="${qy.toFixed(1)}" stroke="${AXIS}" stroke-width="1" stroke-dasharray="4 4"/>`,
    `<text x="${(right - 8).toFixed(1)}" y="${(top + 16).toFixed(1)}" text-anchor="end" fill="#34d399" font-family="${FONT_SANS}" font-size="11" font-weight="600">High Recall + High Restraint ↗</text>`,
    `<text x="${(left + 8).toFixed(1)}" y="${(top + 16).toFixed(1)}" fill="#f59e0b" font-family="${FONT_SANS}" font-size="11">High Recall, Noisy / Pedantic</text>`,
    `<text x="${(right - 8).toFixed(1)}" y="${(bottom - 10).toFixed(1)}" text-anchor="end" fill="${SUBTLE}" font-family="${FONT_SANS}" font-size="11">Clean but Under-Sensitive</text>`
  );

  for (const yTick of linearTicks(minRecall, 100, 5)) {
    const py = scaleY(yTick);
    parts.push(
      `<line x1="${left}" y1="${py.toFixed(1)}" x2="${right}" y2="${py.toFixed(1)}" stroke="${GRID}" stroke-width="1"/>`,
      `<text x="${left - 10}" y="${(py + 4).toFixed(1)}" text-anchor="end" fill="${MUTED}" font-family="${FONT_MONO}" font-size="11">${yTick.toFixed(0)}%</text>`
    );
  }

  for (let alarms = 0; alarms <= maxAlarms; alarms += 1) {
    const px = scaleX(alarms);
    parts.push(
      `<line x1="${px.toFixed(1)}" y1="${top}" x2="${px.toFixed(1)}" y2="${bottom}" stroke="${GRID}" stroke-width="1"/>`,
      `<text x="${px.toFixed(1)}" y="${bottom + 20}" text-anchor="middle" fill="${MUTED}" font-family="${FONT_MONO}" font-size="11">${alarms}</text>`
    );
  }

  parts.push(
    `<line x1="${left}" y1="${top}" x2="${left}" y2="${bottom}" stroke="${AXIS}" stroke-width="1.2"/>`,
    `<line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="${AXIS}" stroke-width="1.2"/>`,
    `<text x="${(left + right) / 2}" y="${height - 24}" text-anchor="middle" fill="${MUTED}" font-family="${FONT_SANS}" font-size="12">Weighted Unsolicited False Alarms (2× P0–P2 + 1× P3 — right is cleaner)</text>`,
    `<text x="26" y="${(top + bottom) / 2}" text-anchor="middle" fill="${MUTED}" font-family="${FONT_SANS}" font-size="12" transform="rotate(-90 26 ${(top + bottom) / 2})">Seeded Defect Recall (%)</text>`
  );

  // Small deterministic vertical jitter when multiple models tie at exact (0 alarms, 100% recall).
  const coords = rows.map((row, idx) => {
    const recallPct = (row.defectRecall ?? 1) * 100;

    const sameSpot = rows
      .slice(0, idx)
      .filter(
        (prev) =>
          prev.weightedFalseAlarms === row.weightedFalseAlarms &&
          Math.abs((prev.defectRecall ?? 1) * 100 - recallPct) < 0.1
      ).length;

    const cx = scaleX(row.weightedFalseAlarms) - sameSpot * 18;
    const cy = scaleY(recallPct) + sameSpot * 10;
    const r = scaleR(row.medianWallS);
    const tip = `${row.model} | LSAS ${row.lsas.toFixed(1)} | Recall ${recallPct.toFixed(1)}% | FP ${row.falsePositiveP0P2}, P3 ${row.nitpickP3} | Wall ${row.medianWallS.toFixed(1)}s | Cost $${row.totalCostUsd.toFixed(2)}`;

    return {
      row,
      cx,
      cy,
      r,
      label: `${shortModelLabel(row.model)} (${row.medianWallS.toFixed(0)}s)`,
      tip,
    };
  });

  const labels = placeLabels(coords, {
    x1: left + 6,
    y1: top + 22,
    x2: right - 6,
    y2: bottom - 18,
  });

  for (let i = 0; i < coords.length; i += 1) {
    const point = coords[i];
    const placed = labels[i];

    if (point === undefined || placed === undefined) {
      continue;
    }

    if (placed.leader) {
      parts.push(
        `<line x1="${point.cx.toFixed(1)}" y1="${point.cy.toFixed(1)}" x2="${placed.x.toFixed(1)}" y2="${(placed.y - 4).toFixed(1)}" stroke="${SUBTLE}" stroke-width="0.9" stroke-dasharray="2 2"/>`
      );
    }

    const color = providerColor(point.row.provider);
    parts.push(
      `<g class="chart-point" data-tip="${esc(point.tip)}"><circle cx="${point.cx.toFixed(1)}" cy="${point.cy.toFixed(1)}" r="${point.r.toFixed(1)}" fill="${color}" fill-opacity="0.32" stroke="${color}" stroke-width="2"/></g>`,
      `<text x="${placed.x.toFixed(1)}" y="${placed.y.toFixed(1)}" text-anchor="${placed.anchor}" fill="${TEXT}" font-family="${FONT_SANS}" font-size="11">${esc(point.label)}</text>`
    );
  }

  const providers = [...new Set(rows.map((row) => row.provider))].toSorted();
  parts.push(providerLegend(providers, left, 82), "</svg>");

  return parts.join("\n");
};

const renderFailureTaxonomy = (summary: BenchmarkSummary): string => {
  interface TaxonomyRow {
    readonly section: string;
    readonly label: string;
    readonly scoreLabel: string;
    readonly total: number;
    readonly counts: Readonly<Record<FailureTier, number>>;
  }

  const rows: TaxonomyRow[] = [];

  if (summary.combinedCoderRows.length > 0) {
    for (const row of summary.combinedCoderRows) {
      rows.push({
        section: "Coders (Solo + Pair)",
        label: shortModelLabel(row.model),
        scoreLabel: `ACI ${row.aci.toFixed(1)}`,
        total: row.totalTrials,
        counts: row.tierCounts,
      });
    }
  } else {
    for (const row of summary.coderRows) {
      rows.push({
        section: "Standalone Coders",
        label: shortModelLabel(row.model),
        scoreLabel: `LSAS ${row.lsas.toFixed(1)}`,
        total: row.trials,
        counts: row.tierCounts,
      });
    }
  }

  for (const row of summary.reviewerCalibratedRows) {
    rows.push({
      section:
        summary.excludedReviewerTasks.length > 0
          ? "Code Reviewers (Calibrated)"
          : "Code Reviewers",
      label: shortModelLabel(row.model),
      scoreLabel: `LSAS ${row.lsas.toFixed(1)}`,
      total: row.trials,
      counts: row.tierCounts,
    });
  }

  const width = 920;
  const rowH = 26;
  const sectionGap = 24;
  const sections = new Set(rows.map((row) => row.section)).size;
  const top = 104;
  const height = top + rows.length * rowH + sections * sectionGap + 36;
  const labelRight = 175;
  const barLeft = 188;
  const barRight = width - 110;
  const barW = barRight - barLeft;

  const parts: string[] = [
    svgHeader(
      width,
      height,
      "Low-Steering Babysitting & Failure Taxonomy",
      "Share of trials by outcome tier — separates clean passes and self-healed tool friction from human nudges, broken deliverables, and timeouts"
    ),
  ];

  // Legend row.
  let legendX = 32;

  for (const tier of TIER_META) {
    parts.push(
      `<rect x="${legendX}" y="76" width="11" height="11" rx="2" fill="${tier.color}"/>`,
      `<text x="${legendX + 16}" y="86" fill="${MUTED}" font-family="${FONT_SANS}" font-size="11">${esc(tier.label)}</text>`
    );
    legendX += tier.label.length * 6.4 + 30;
  }

  let cursorY = top;
  let lastSection = "";

  for (const row of rows) {
    if (row.section !== lastSection) {
      if (lastSection !== "") {
        cursorY += 10;
      }

      parts.push(
        `<text x="32" y="${cursorY + 12}" fill="${PARETO}" font-family="${FONT_SANS}" font-size="11.5" font-weight="700">${esc(row.section.toUpperCase())}</text>`
      );
      cursorY += sectionGap;
      lastSection = row.section;
    }

    parts.push(
      `<text x="${labelRight}" y="${cursorY + 15}" text-anchor="end" fill="${TEXT}" font-family="${FONT_SANS}" font-size="12">${esc(row.label)}</text>`
    );

    let segX = barLeft;

    for (const tier of TIER_META) {
      const count = row.counts[tier.key];

      if (count === 0) {
        continue;
      }

      const segW = (count / Math.max(1, row.total)) * barW;
      const tip = `${row.label} | ${tier.label}: ${count}/${row.total} (${((100 * count) / row.total).toFixed(1)}%)`;
      parts.push(
        `<rect class="chart-point" data-tip="${esc(tip)}" x="${segX.toFixed(1)}" y="${cursorY + 3}" width="${Math.max(1, segW - 1).toFixed(1)}" height="16" rx="2" fill="${tier.color}"/>`
      );

      if (segW >= 24) {
        parts.push(
          `<text x="${(segX + segW / 2).toFixed(1)}" y="${cursorY + 15}" text-anchor="middle" fill="${BG}" font-family="${FONT_MONO}" font-size="10.5" font-weight="700">${count}</text>`
        );
      }

      segX += segW;
    }

    parts.push(
      `<text x="${barRight + 10}" y="${cursorY + 15}" fill="${MUTED}" font-family="${FONT_MONO}" font-size="11">${esc(row.scoreLabel)}</text>`
    );
    cursorY += rowH;
  }

  parts.push("</svg>");

  return parts.join("\n");
};

const heatFill = (lsas: number): string => {
  if (lsas >= 99.5) {
    return "#065f46";
  }

  if (lsas >= 94) {
    return "#0f766e";
  }

  if (lsas >= 88) {
    return "#1e40af";
  }

  if (lsas >= 80) {
    return "#92400e";
  }

  return "#991b1b";
};

const renderPairSynergyMatrix = (summary: BenchmarkSummary): string => {
  const coders = summary.pairCoders;
  const reviewers = summary.pairReviewers;

  const cellMap = new Map(
    summary.pairMatrix.map((cell) => [
      `${cell.coderModel}\0${cell.reviewerModel}`,
      cell,
    ])
  );

  const width = Math.max(760, 260 + reviewers.length * 260);
  const rowH = 54;
  const colW = Math.floor((width - 260) / Math.max(1, reviewers.length));
  const top = 114;
  const height = top + coders.length * rowH + 64;

  const parts: string[] = [
    svgHeader(
      width,
      height,
      "Phase 3 Coder × Reviewer Synergy Matrix",
      "Cell color = Pair LSAS (0–100); displays LSAS, strict Pass@1, 4-task cost, and median wall time per coder → reviewer cell"
    ),
  ];

  // Column headers.
  for (let col = 0; col < reviewers.length; col += 1) {
    const reviewer = reviewers[col];

    if (reviewer === undefined) {
      continue;
    }

    const x = 228 + col * colW + colW / 2;
    parts.push(
      `<text x="${x.toFixed(1)}" y="96" text-anchor="middle" fill="${TEXT}" font-family="${FONT_SANS}" font-size="12.5" font-weight="700">Reviewer: ${esc(shortModelLabel(reviewer))}</text>`
    );
  }

  for (let row = 0; row < coders.length; row += 1) {
    const coder = coders[row];

    if (coder === undefined) {
      continue;
    }

    const y = top + row * rowH;
    parts.push(
      `<text x="214" y="${y + 31}" text-anchor="end" fill="${TEXT}" font-family="${FONT_SANS}" font-size="12" font-weight="600">${esc(shortModelLabel(coder))}</text>`
    );

    for (let col = 0; col < reviewers.length; col += 1) {
      const reviewer = reviewers[col];

      if (reviewer === undefined) {
        continue;
      }

      const cell = cellMap.get(`${coder}\0${reviewer}`);
      const x = 228 + col * colW;

      if (cell === undefined) {
        parts.push(
          `<rect x="${x + 4}" y="${y + 4}" width="${colW - 8}" height="${rowH - 8}" rx="6" fill="${BORDER}"/>`,
          `<text x="${(x + colW / 2).toFixed(1)}" y="${y + 31}" text-anchor="middle" fill="${SUBTLE}" font-family="${FONT_MONO}" font-size="11">—</text>`
        );
        continue;
      }

      const tip = `${coder} -> ${reviewer} | LSAS ${cell.lsas.toFixed(1)} | Pass ${cell.passedCount}/${cell.trials} | ZSDR ${(100 * cell.zsdrRate).toFixed(0)}% | Cost $${cell.totalCostUsd.toFixed(2)} | Med wall ${cell.medianWallS.toFixed(1)}s`;
      parts.push(
        `<g class="chart-point" data-tip="${esc(tip)}">`,
        `<rect x="${x + 4}" y="${y + 4}" width="${colW - 8}" height="${rowH - 8}" rx="6" fill="${heatFill(cell.lsas)}" stroke="${BORDER}" stroke-width="1"/>`,
        `<text x="${(x + colW / 2).toFixed(1)}" y="${y + 23}" text-anchor="middle" fill="${TEXT}" font-family="${FONT_MONO}" font-size="13" font-weight="700">LSAS ${cell.lsas.toFixed(1)} · ${cell.passedCount}/${cell.trials}</text>`,
        `<text x="${(x + colW / 2).toFixed(1)}" y="${y + 40}" text-anchor="middle" fill="#cbd5e1" font-family="${FONT_MONO}" font-size="10.5">$${cell.totalCostUsd.toFixed(2)} · med ${cell.medianWallS.toFixed(1)}s</text>`,
        "</g>"
      );
    }
  }

  // Footer totals per reviewer.
  const footerY = top + coders.length * rowH + 28;
  parts.push(
    `<text x="214" y="${footerY}" text-anchor="end" fill="${MUTED}" font-family="${FONT_SANS}" font-size="11.5" font-weight="600">Reviewer total</text>`
  );

  for (let col = 0; col < reviewers.length; col += 1) {
    const reviewer = reviewers[col];

    if (reviewer === undefined) {
      continue;
    }

    const cells = summary.pairMatrix.filter(
      (cell) => cell.reviewerModel === reviewer
    );

    const passed = cells.reduce((sum, cell) => sum + cell.passedCount, 0);
    const total = cells.reduce((sum, cell) => sum + cell.trials, 0);
    const cost = cells.reduce((sum, cell) => sum + cell.totalCostUsd, 0);
    const wall = cells.reduce((sum, cell) => sum + cell.totalWallS, 0);
    const x = 228 + col * colW + colW / 2;

    parts.push(
      `<text x="${x.toFixed(1)}" y="${footerY}" text-anchor="middle" fill="${PARETO}" font-family="${FONT_MONO}" font-size="11" font-weight="600">${passed}/${total} pass · $${cost.toFixed(2)} · ${Math.round(wall)}s total</text>`
    );
  }

  parts.push("</svg>");

  return parts.join("\n");
};

const renderTaskHeatmap = (summary: BenchmarkSummary): string => {
  interface Panel {
    readonly heading: string;
    readonly tasks: readonly string[];
    readonly models: readonly string[];
    readonly lookup: ReadonlyMap<
      string,
      {
        readonly tier: FailureTier;
        readonly wallS: number;
        readonly lsas: number;
        readonly passed: boolean;
      }
    >;
  }

  const panels: Panel[] = [];

  for (const [role, heading] of [
    ["coder", "Phase 1 — Standalone Coder (11 tasks)"],
    ["code-reviewer", "Phase 2 — Code Reviewer (11 tasks)"],
    ["pair", "Phase 3 — Pair Collaboration (4 tasks × 16 pairs)"],
  ] as const) {
    const cells = summary.taskCells.filter((cell) => cell.role === role);

    if (cells.length === 0) {
      continue;
    }

    const tasks = [...new Set(cells.map((cell) => cell.taskId))];

    let models: readonly string[];

    if (role === "coder") {
      models = summary.coderRows.map((row) => row.label);
    } else if (role === "code-reviewer") {
      models = summary.reviewerCalibratedRows.map((row) => row.label);
    } else {
      models = summary.pairRows.map((row) => row.label);
    }

    const lookup = new Map<
      string,
      {
        readonly tier: FailureTier;
        readonly wallS: number;
        readonly lsas: number;
        readonly passed: boolean;
      }
    >();

    for (const cell of cells) {
      lookup.set(`${cell.taskId}\0${cell.modelLabel}`, {
        tier: cell.tier,
        wallS: cell.wallS,
        lsas: cell.lsas,
        passed: cell.passed,
      });
    }

    panels.push({ heading, tasks, models, lookup });
  }

  const width = 1040;
  const labelW = 248;
  const rowH = 22;
  let totalH = 104;

  for (const panel of panels) {
    totalH += 36 + 52 + panel.tasks.length * rowH + 18;
  }

  const parts: string[] = [
    svgHeader(
      width,
      totalH,
      "Diagnostic Task × Model Outcome Heatmap",
      "Every trial colored by its 5-tier babysitting taxonomy and annotated with wall time (seconds)"
    ),
  ];

  // Compact legend.
  let legendX = 32;

  for (const tier of TIER_META) {
    parts.push(
      `<rect x="${legendX}" y="76" width="10" height="10" rx="2" fill="${tier.color}"/>`,
      `<text x="${legendX + 14}" y="85" fill="${MUTED}" font-family="${FONT_SANS}" font-size="10.5">${esc(tier.label)}</text>`
    );
    legendX += tier.label.length * 6.2 + 26;
  }

  let y = 108;

  for (const panel of panels) {
    parts.push(
      `<text x="32" y="${y + 14}" fill="${PARETO}" font-family="${FONT_SANS}" font-size="12.5" font-weight="700">${esc(panel.heading)}</text>`
    );
    y += 28;

    const colW = Math.min(
      82,
      Math.floor((width - labelW - 36) / Math.max(1, panel.models.length))
    );

    // Angled model column labels.
    for (let col = 0; col < panel.models.length; col += 1) {
      const model = panel.models[col];

      if (model === undefined) {
        continue;
      }

      const compact = model.includes(" -> ")
        ? model.split(" -> ").map(shortModelLabel).join("→")
        : shortModelLabel(model);

      const cx = labelW + col * colW + colW / 2;
      parts.push(
        `<text x="${cx.toFixed(1)}" y="${y + 44}" text-anchor="start" fill="${MUTED}" font-family="${FONT_SANS}" font-size="9.5" transform="rotate(-35 ${cx.toFixed(1)} ${y + 44})">${esc(compact)}</text>`
      );
    }

    y += 52;

    for (const taskId of panel.tasks) {
      parts.push(
        `<text x="${labelW - 8}" y="${y + 15}" text-anchor="end" fill="${TEXT}" font-family="${FONT_MONO}" font-size="10">${esc(taskId)}</text>`
      );

      for (let col = 0; col < panel.models.length; col += 1) {
        const model = panel.models[col];

        if (model === undefined) {
          continue;
        }

        const outcome = panel.lookup.get(`${taskId}\0${model}`);
        const cx = labelW + col * colW;

        if (outcome === undefined) {
          parts.push(
            `<rect x="${cx + 1}" y="${y + 1}" width="${colW - 2}" height="${rowH - 2}" rx="3" fill="${BORDER}"/>`
          );
          continue;
        }

        const fill = TIER_COLORS[outcome.tier];
        const tip = `${taskId} | ${model} | ${outcome.tier.replaceAll("_", " ")} | LSAS ${outcome.lsas.toFixed(1)} | ${outcome.wallS.toFixed(1)}s`;
        parts.push(
          `<g class="chart-point" data-tip="${esc(tip)}">`,
          `<rect x="${cx + 1}" y="${y + 1}" width="${colW - 2}" height="${rowH - 2}" rx="3" fill="${fill}" fill-opacity="0.82"/>`
        );

        if (colW >= 34) {
          parts.push(
            `<text x="${(cx + colW / 2).toFixed(1)}" y="${y + 14.5}" text-anchor="middle" fill="${BG}" font-family="${FONT_MONO}" font-size="9" font-weight="700">${Math.round(outcome.wallS)}s</text>`
          );
        }

        parts.push("</g>");
      }

      y += rowH;
    }

    y += 18;
  }

  parts.push("</svg>");

  return parts.join("\n");
};

const renderOverheadAndDiff = (summary: BenchmarkSummary): string => {
  const rows =
    summary.combinedCoderRows.length > 0
      ? summary.combinedCoderRows.map((row) => ({
          model: row.model,
          provider: row.provider,
          tokPerS: row.medianTotalTokPerS ?? 0,
          reasoningShare: row.medianReasoningShare,
          coldVisibleS: row.coldVisibleS,
          diffRatio: row.medianDiffRatio ?? 1,
        }))
      : summary.coderRows.map((row) => ({
          model: row.model,
          provider: row.provider,
          tokPerS: row.medianTotalTokPerS ?? 0,
          reasoningShare: row.medianReasoningShare,
          coldVisibleS: row.coldVisibleS,
          diffRatio: row.medianDiffRatio ?? 1,
        }));

  const width = 960;
  const rowH = 34;
  const top = 112;
  const height = top + rows.length * rowH + 54;
  const labelRight = 152;
  const leftBarStart = 166;
  const leftBarW = 310;
  const rightBarStart = 590;
  const rightBarW = 310;

  const maxTok = Math.max(50, ...rows.map((row) => row.tokPerS * 1.15));
  const maxDiff = Math.max(1.5, ...rows.map((row) => row.diffRatio * 1.15));

  const parts: string[] = [
    svgHeader(
      width,
      height,
      "Inference Overhead & Diff Discipline (Coders)",
      "Left: Active model throughput (total tok/s, shaded reasoning share, cold TTFT) · Right: Passing diff size relative to task median (1.0× = median)"
    ),
  ];

  parts.push(
    `<text x="${leftBarStart}" y="94" fill="${PARETO}" font-family="${FONT_SANS}" font-size="12" font-weight="700">Active Throughput (total tok/s) &amp; Reasoning Share</text>`,
    `<text x="${rightBarStart}" y="94" fill="${PARETO}" font-family="${FONT_SANS}" font-size="12" font-weight="700">Normalized Diff Size (added lines / task median)</text>`
  );

  // 1.0x reference line on right panel.
  const refX = rightBarStart + (1 / maxDiff) * rightBarW;
  parts.push(
    `<line x1="${refX.toFixed(1)}" y1="${top - 6}" x2="${refX.toFixed(1)}" y2="${top + rows.length * rowH}" stroke="${MUTED}" stroke-width="1.2" stroke-dasharray="4 3"/>`,
    `<text x="${refX.toFixed(1)}" y="${top + rows.length * rowH + 16}" text-anchor="middle" fill="${MUTED}" font-family="${FONT_MONO}" font-size="10">1.0× median</text>`
  );

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];

    if (row === undefined) {
      continue;
    }

    const y = top + i * rowH;
    const color = providerColor(row.provider);
    const barW = (row.tokPerS / maxTok) * leftBarW;
    const reasonW = barW * Math.min(1, Math.max(0, row.reasoningShare));

    const coldText =
      row.coldVisibleS === null ? "—" : `${row.coldVisibleS.toFixed(1)}s`;

    const leftTip = `${row.model} | ${Math.round(row.tokPerS)} total tok/s | Reasoning ${Math.round(row.reasoningShare * 100)}% | Cold TTFT ${coldText}`;

    parts.push(
      `<text x="${labelRight}" y="${y + 18}" text-anchor="end" fill="${TEXT}" font-family="${FONT_SANS}" font-size="12">${esc(shortModelLabel(row.model))}</text>`,
      `<g class="chart-point" data-tip="${esc(leftTip)}">`,
      `<rect x="${leftBarStart}" y="${y + 5}" width="${Math.max(2, barW).toFixed(1)}" height="18" rx="3" fill="${color}" fill-opacity="0.82"/>`,
      `<rect x="${leftBarStart}" y="${y + 5}" width="${Math.max(0, reasonW).toFixed(1)}" height="18" rx="3" fill="#0f172a" fill-opacity="0.42"/>`,
      `</g>`,
      `<text x="${(leftBarStart + barW + 6).toFixed(1)}" y="${y + 18}" fill="${MUTED}" font-family="${FONT_MONO}" font-size="10.5">${Math.round(row.tokPerS)} t/s (${Math.round(row.reasoningShare * 100)}% R · ${coldText})</text>`
    );

    const diffW = (row.diffRatio / maxDiff) * rightBarW;

    let diffColor = "#10b981";
    let diffTag = "balanced";

    if (row.diffRatio < 0.8) {
      diffColor = "#f59e0b";
      diffTag = "compressed";
    } else if (row.diffRatio > 1.2) {
      diffColor = "#ef4444";
      diffTag = "verbose";
    }

    const rightTip = `${row.model} | Median diff ${row.diffRatio.toFixed(2)}× task median (${diffTag})`;

    parts.push(
      `<g class="chart-point" data-tip="${esc(rightTip)}">`,
      `<rect x="${rightBarStart}" y="${y + 5}" width="${Math.max(2, diffW).toFixed(1)}" height="18" rx="3" fill="${diffColor}" fill-opacity="0.85"/>`,
      `</g>`,
      `<text x="${(rightBarStart + diffW + 6).toFixed(1)}" y="${y + 18}" fill="${MUTED}" font-family="${FONT_MONO}" font-size="10.5">${row.diffRatio.toFixed(2)}× (${diffTag})</text>`
    );
  }

  parts.push(
    `<text x="${leftBarStart}" y="${height - 18}" fill="${SUBTLE}" font-family="${FONT_SANS}" font-size="10">Darkened left bar portion = reasoning token share (R). Uses total_model_tok_per_s across providers.</text>`,
    "</svg>"
  );

  return parts.join("\n");
};

export const renderBenchmarkCharts = (
  summary: BenchmarkSummary
): readonly GeneratedChart[] => {
  const charts: GeneratedChart[] = [];

  if (summary.combinedCoderRows.length > 0) {
    const costItems: ScatterItem[] = summary.combinedCoderRows.map((row) => ({
      id: row.model,
      label: shortModelLabel(row.model),
      provider: row.provider,
      x: row.totalCostUsd,
      y: row.aci,
      tip: `${row.model} | ACI ${row.aci.toFixed(1)} (Solo ${row.solo.lsas.toFixed(1)}, Pair ${row.pair.lsas.toFixed(1)}) | Pass ${row.passedCount}/${row.totalTrials} | ZSDR ${(100 * row.zsdrRate).toFixed(1)}% | Cost $${row.totalCostUsd.toFixed(2)} | Wall ${Math.round(row.totalWallS)}s`,
    }));

    charts.push({
      id: "coder-cost-pareto",
      filename: "coder-cost-pareto.svg",
      title: "Coder Autonomy vs. Cost Pareto Frontier",
      subtitle:
        "Combined Autonomous Coder Index (ACI = 0.6× Solo LSAS + 0.4× Pair LSAS across 19 trials) vs. total suite API cost (USD, log scale)",
      category: "coder",
      svg: renderParetoScatter({
        title: "Coder Autonomy vs. Cost Pareto Frontier",
        subtitle:
          "Combined Autonomous Coder Index (ACI = 0.6× Solo LSAS + 0.4× Pair LSAS, 19 trials) vs. total suite cost (USD, log scale)",
        xLabel: "Total 19-Trial API Cost (USD, log scale)",
        yLabel: "Autonomous Coder Index (ACI, 0–100)",
        logX: true,
        formatX: (value) =>
          `$${value < 1 ? value.toFixed(2) : value.toFixed(value % 1 === 0 ? 0 : 1)}`,
        items: costItems,
      }),
    });

    const speedItems: ScatterItem[] = summary.combinedCoderRows.map((row) => ({
      id: row.model,
      label: shortModelLabel(row.model),
      provider: row.provider,
      x: row.totalWallS / 60,
      y: row.aci,
      tip: `${row.model} | ACI ${row.aci.toFixed(1)} | Total wall ${(row.totalWallS / 60).toFixed(1)} min (${Math.round(row.totalWallS)}s) | Med wall ${row.medianWallS.toFixed(1)}s | Cost $${row.totalCostUsd.toFixed(2)}`,
    }));

    charts.push({
      id: "coder-speed-pareto",
      filename: "coder-speed-pareto.svg",
      title: "Coder Autonomy vs. Wall-Clock Time Pareto Frontier",
      subtitle:
        "Combined Autonomous Coder Index (ACI, 19 trials) vs. total end-to-end wall-clock time (minutes)",
      category: "coder",
      svg: renderParetoScatter({
        title: "Coder Autonomy vs. Wall-Clock Time Pareto Frontier",
        subtitle:
          "Combined Autonomous Coder Index (ACI, 19 trials) vs. total end-to-end wall-clock time (minutes)",
        xLabel: "Total 19-Trial Wall-Clock Time (minutes)",
        yLabel: "Autonomous Coder Index (ACI, 0–100)",
        logX: false,
        formatX: (value) => `${value.toFixed(0)}m`,
        items: speedItems,
      }),
    });
  } else if (summary.coderRows.length > 0) {
    const costItems: ScatterItem[] = summary.coderRows.map((row) => ({
      id: row.label,
      label: shortModelLabel(row.model),
      provider: row.provider,
      x: row.totalCostUsd,
      y: row.lsas,
      tip: `${row.model} | Solo LSAS ${row.lsas.toFixed(1)} | Pass ${row.passedCount}/${row.trials} | ZSDR ${(100 * row.zsdrRate).toFixed(1)}% | Cost $${row.totalCostUsd.toFixed(2)} | Med wall ${row.medianWallS.toFixed(1)}s`,
    }));

    charts.push({
      id: "coder-cost-pareto",
      filename: "coder-cost-pareto.svg",
      title: "Standalone Coder Autonomy vs. Cost Pareto Frontier",
      subtitle:
        "Low-Steering Autonomy Score (LSAS) vs. total suite API cost (USD, log scale)",
      category: "coder",
      svg: renderParetoScatter({
        title: "Standalone Coder Autonomy vs. Cost Pareto Frontier",
        subtitle:
          "Low-Steering Autonomy Score (LSAS) vs. total suite API cost (USD, log scale)",
        xLabel: "Total Suite API Cost (USD, log scale)",
        yLabel: "Low-Steering Autonomy Score (LSAS, 0–100)",
        logX: true,
        formatX: (value) =>
          `$${value < 1 ? value.toFixed(2) : value.toFixed(1)}`,
        items: costItems,
      }),
    });
  }

  if (summary.reviewerCalibratedRows.length > 0) {
    const calNote =
      summary.excludedReviewerTasks.length > 0
        ? `calibrated ${summary.reviewerCalibratedRows[0]?.trials ?? 0} tasks (excluding ${summary.excludedReviewerTasks.join(", ")})`
        : `${summary.reviewerCalibratedRows[0]?.trials ?? 0} tasks`;

    const reviewerCostItems: ScatterItem[] = summary.reviewerCalibratedRows.map(
      (row) => ({
        id: row.label,
        label: shortModelLabel(row.model),
        provider: row.provider,
        x: row.totalCostUsd,
        y: row.lsas,
        tip: `${row.model} | Reviewer LSAS ${row.lsas.toFixed(1)} | Pass ${row.passedCount}/${row.trials} | FP ${row.falsePositiveP0P2}, P3 ${row.nitpickP3} | Cost $${row.totalCostUsd.toFixed(2)} | Med wall ${row.medianWallS.toFixed(1)}s`,
      })
    );

    charts.push(
      {
        id: "reviewer-cost-pareto",
        filename: "reviewer-cost-pareto.svg",
        title: "Code Reviewer Autonomy vs. Cost Pareto Frontier",
        subtitle: `Code Reviewer LSAS (${calNote}) vs. suite API cost (USD, log scale)`,
        category: "reviewer",
        svg: renderParetoScatter({
          title: "Code Reviewer Autonomy vs. Cost Pareto Frontier",
          subtitle: `Code Reviewer LSAS (${calNote}) vs. suite API cost (USD, log scale)`,
          xLabel: "Suite API Cost (USD, log scale)",
          yLabel: "Code Reviewer LSAS (0–100)",
          logX: true,
          formatX: (value) =>
            `$${value < 1 ? value.toFixed(2) : value.toFixed(1)}`,
          items: reviewerCostItems,
        }),
      },
      {
        id: "reviewer-calibration",
        filename: "reviewer-calibration.svg",
        title: "Code Reviewer Calibration Quadrant",
        subtitle: `Defect recall vs. false-alarm restraint (${calNote}); bubble size = median wall time`,
        category: "reviewer",
        svg: renderReviewerCalibration(
          summary.reviewerCalibratedRows,
          summary.excludedReviewerTasks
        ),
      }
    );
  }

  if (summary.coderRows.length > 0 || summary.reviewerRows.length > 0) {
    charts.push({
      id: "failure-taxonomy",
      filename: "failure-taxonomy.svg",
      title: "Low-Steering Babysitting & Failure Taxonomy",
      subtitle:
        "Breakdown of every model's trials from clean first-shot passes to self-healed friction, hygiene nudges, broken deliverables, and timeouts",
      category: "overview",
      svg: renderFailureTaxonomy(summary),
    });
  }

  if (summary.pairMatrix.length > 0) {
    charts.push({
      id: "pair-synergy-matrix",
      filename: "pair-synergy-matrix.svg",
      title: "Phase 3 Coder × Reviewer Synergy Matrix",
      subtitle:
        "Pair LSAS, Pass@1, cost, and median wall time across every coder → reviewer pairing",
      category: "pair",
      svg: renderPairSynergyMatrix(summary),
    });
  }

  if (summary.taskCells.length > 0) {
    charts.push({
      id: "task-heatmap",
      filename: "task-heatmap.svg",
      title: "Diagnostic Task × Model Outcome Heatmap",
      subtitle:
        "All trials colored by 5-tier babysitting taxonomy and annotated with wall time",
      category: "overview",
      svg: renderTaskHeatmap(summary),
    });
  }

  if (summary.coderRows.length > 0) {
    charts.push({
      id: "overhead-and-diff",
      filename: "overhead-and-diff.svg",
      title: "Inference Overhead & Diff Discipline (Coders)",
      subtitle:
        "Active model throughput (total_model_tok_per_s), reasoning token share, and passing diff size relative to task median",
      category: "coder",
      svg: renderOverheadAndDiff(summary),
    });
  }

  return charts;
};
