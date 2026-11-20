import {
  compactModelLabel,
  computeParetoFrontier,
  displayModelLabel,
} from "./scoring.ts";
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
  "Geist, Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const FONT_MONO =
  "'Geist Mono', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

const SVG_THEME_STYLE = `<style>
.omkar-chart {
  --c-bg: #fcfcfc;
  --c-card: #ffffff;
  --c-muted-bg: #f5f5f5;
  --c-border: #e5e5e5;
  --c-grid: #efefef;
  --c-axis: #d4d4d4;
  --c-text: #000000;
  --c-muted: #525252;
  --c-subtle: #737373;
  --c-frontier: #000000;
  --c-quadrant: #f5f5f5;
  --c-reason-overlay: rgba(0, 0, 0, 0.24);
  --p-anthropic: #d97706;
  --p-google: #2563eb;
  --p-openai: #09090b;
  --p-deepseek: #737373;
  --p-other: #525252;
  --t-clean: #18181b;
  --t-clean-ink: #ffffff;
  --t-friction: #3167f6;
  --t-friction-ink: #ffffff;
  --t-nudge: #f5a623;
  --t-nudge-ink: #000000;
  --t-broken: #e5484d;
  --t-broken-ink: #ffffff;
  --t-timeout: #a3a3a3;
  --t-timeout-ink: #000000;
  --m-top: #18181b;
  --m-high: #3167f6;
  --m-mid: #f5a623;
  --m-low: #e5484d;
  --d-balanced: #18181b;
  --d-compressed: #f5a623;
  --d-verbose: #e5484d;
}
@media (prefers-color-scheme: dark) {
  .omkar-chart {
    --c-bg: #000000;
    --c-card: #0a0a0a;
    --c-muted-bg: #171717;
    --c-border: #262626;
    --c-grid: #1a1a1a;
    --c-axis: #3a3a3a;
    --c-text: #ffffff;
    --c-muted: #a3a3a3;
    --c-subtle: #737373;
    --c-frontier: #ffffff;
    --c-quadrant: #171717;
    --c-reason-overlay: rgba(0, 0, 0, 0.45);
    --p-anthropic: #f5a623;
    --p-google: #3b82f6;
    --p-openai: #f5f5f5;
    --p-deepseek: #a3a3a3;
    --p-other: #737373;
    --t-clean: #e5e5e5;
    --t-clean-ink: #000000;
    --t-friction: #3b82f6;
    --t-friction-ink: #ffffff;
    --t-nudge: #f5a623;
    --t-nudge-ink: #000000;
    --t-broken: #f2555a;
    --t-broken-ink: #000000;
    --t-timeout: #525252;
    --t-timeout-ink: #ffffff;
    --m-top: #ffffff;
    --m-high: #3b82f6;
    --m-mid: #f5a623;
    --m-low: #f2555a;
    --d-balanced: #e5e5e5;
    --d-compressed: #f5a623;
    --d-verbose: #f2555a;
  }
}
</style>`;

const providerVar = (provider: string): string => {
  switch (provider) {
    case "anthropic": {
      return "var(--p-anthropic)";
    }

    case "google": {
      return "var(--p-google)";
    }

    case "openai": {
      return "var(--p-openai)";
    }

    case "deepseek": {
      return "var(--p-deepseek)";
    }

    default: {
      return "var(--p-other)";
    }
  }
};

const TIER_META: readonly {
  readonly key: FailureTier;
  readonly label: string;
  readonly fillVar: string;
  readonly inkVar: string;
}[] = [
  {
    key: "clean_pass",
    label: "Clean first-shot pass",
    fillVar: "var(--t-clean)",
    inkVar: "var(--t-clean-ink)",
  },
  {
    key: "self_healed_friction",
    label: "Self-healed friction",
    fillVar: "var(--t-friction)",
    inkVar: "var(--t-friction-ink)",
  },
  {
    key: "hygiene_nudge",
    label: "Hygiene / lint nudge",
    fillVar: "var(--t-nudge)",
    inkVar: "var(--t-nudge-ink)",
  },
  {
    key: "broken_deliverable",
    label: "Broken / stubborn refusal",
    fillVar: "var(--t-broken)",
    inkVar: "var(--t-broken-ink)",
  },
  {
    key: "timeout_crash",
    label: "Timeout / crash",
    fillVar: "var(--t-timeout)",
    inkVar: "var(--t-timeout-ink)",
  },
];

const TIER_BY_KEY: Readonly<
  Record<FailureTier, { readonly fillVar: string; readonly inkVar: string }>
> = {
  clean_pass: { fillVar: "var(--t-clean)", inkVar: "var(--t-clean-ink)" },
  self_healed_friction: {
    fillVar: "var(--t-friction)",
    inkVar: "var(--t-friction-ink)",
  },
  hygiene_nudge: { fillVar: "var(--t-nudge)", inkVar: "var(--t-nudge-ink)" },
  broken_deliverable: {
    fillVar: "var(--t-broken)",
    inkVar: "var(--t-broken-ink)",
  },
  timeout_crash: {
    fillVar: "var(--t-timeout)",
    inkVar: "var(--t-timeout-ink)",
  },
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
  const color = providerVar(provider);

  if (provider === "anthropic") {
    const r = radius * 1.18;

    return `<polygon points="${cx.toFixed(1)},${(cy - r).toFixed(1)} ${(cx + r).toFixed(1)},${cy.toFixed(1)} ${cx.toFixed(1)},${(cy + r).toFixed(1)} ${(cx - r).toFixed(1)},${cy.toFixed(1)}" fill="var(--c-card)" stroke="${color}" stroke-width="2.4"/>`;
  }

  if (provider === "openai") {
    const half = radius * 0.9;

    return `<rect x="${(cx - half).toFixed(1)}" y="${(cy - half).toFixed(1)}" width="${(half * 2).toFixed(1)}" height="${(half * 2).toFixed(1)}" rx="1.8" fill="var(--c-card)" stroke="${color}" stroke-width="2.4"/>`;
  }

  if (provider === "deepseek") {
    const r = radius * 1.12;

    return `<polygon points="${cx.toFixed(1)},${(cy - r).toFixed(1)} ${(cx + r).toFixed(1)},${(cy + r * 0.82).toFixed(1)} ${(cx - r).toFixed(1)},${(cy + r * 0.82).toFixed(1)}" fill="var(--c-card)" stroke="${color}" stroke-width="2.4"/>`;
  }

  return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${radius.toFixed(1)}" fill="var(--c-card)" stroke="${color}" stroke-width="2.4"/>`;
};

const svgHeader = (
  width: number,
  height: number,
  title: string,
  subtitle: string
): string =>
  [
    `<svg class="omkar-chart" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(title)}">`,
    `<title>${esc(title)}</title>`,
    `<desc>${esc(subtitle)}</desc>`,
    SVG_THEME_STYLE,
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10" fill="var(--c-card)" stroke="var(--c-border)" stroke-width="1"/>`,
    `<text x="28" y="36" fill="var(--c-text)" font-family="${FONT_SANS}" font-size="17" font-weight="600" letter-spacing="-0.02em">${esc(title)}</text>`,
    `<text x="28" y="56" fill="var(--c-muted)" font-family="${FONT_SANS}" font-size="12">${esc(subtitle)}</text>`,
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

  return { x1: x1 - 4, y1: y - 14, x2: x1 + textWidth + 4, y2: y + 6 };
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
  const pointBoxes: Rect[] = [];
  const labelBoxes: Rect[] = [];

  for (const point of coords) {
    pointBoxes.push({
      x1: point.cx - point.r - 5,
      y1: point.cy - point.r - 5,
      x2: point.cx + point.r + 5,
      y2: point.cy + point.r + 5,
    });
  }

  const results: PlacedLabel[] = [];

  for (const point of coords) {
    const textWidth = point.label.length * 6.4 + 10;
    const gap = point.r + 8;

    const candidates: readonly {
      readonly x: number;
      readonly y: number;
      readonly anchor: "start" | "middle" | "end";
      readonly dist: number;
    }[] = [
      { x: point.cx + gap, y: point.cy + 4, anchor: "start", dist: 1 },
      { x: point.cx - gap, y: point.cy + 4, anchor: "end", dist: 1.1 },
      { x: point.cx, y: point.cy - gap - 3, anchor: "middle", dist: 1.2 },
      { x: point.cx, y: point.cy + gap + 12, anchor: "middle", dist: 1.3 },
      { x: point.cx + gap, y: point.cy - gap, anchor: "start", dist: 1.6 },
      { x: point.cx - gap, y: point.cy - gap, anchor: "end", dist: 1.7 },
      { x: point.cx + gap, y: point.cy + gap + 11, anchor: "start", dist: 1.8 },
      { x: point.cx - gap, y: point.cy + gap + 11, anchor: "end", dist: 1.9 },
      { x: point.cx + gap + 14, y: point.cy - 20, anchor: "start", dist: 3 },
      { x: point.cx - gap - 14, y: point.cy - 20, anchor: "end", dist: 3.1 },
      { x: point.cx + gap + 14, y: point.cy + 26, anchor: "start", dist: 3.2 },
      { x: point.cx - gap - 14, y: point.cy + 26, anchor: "end", dist: 3.3 },
      { x: point.cx, y: point.cy - gap - 22, anchor: "middle", dist: 3.5 },
      { x: point.cx, y: point.cy + gap + 30, anchor: "middle", dist: 3.6 },
      { x: point.cx - gap - 18, y: point.cy + 44, anchor: "end", dist: 4.1 },
      { x: point.cx - gap - 18, y: point.cy - 36, anchor: "end", dist: 4.2 },
      { x: point.cx - gap - 38, y: point.cy + 4, anchor: "end", dist: 4.3 },
      { x: point.cx - gap - 38, y: point.cy - 18, anchor: "end", dist: 4.4 },
      { x: point.cx - gap - 38, y: point.cy + 26, anchor: "end", dist: 4.45 },
      { x: point.cx - gap - 18, y: point.cy + 62, anchor: "end", dist: 4.5 },
      { x: point.cx + gap + 18, y: point.cy + 44, anchor: "start", dist: 4.6 },
      { x: point.cx + gap + 18, y: point.cy - 36, anchor: "start", dist: 4.7 },
      { x: point.cx - gap - 22, y: point.cy + 80, anchor: "end", dist: 5 },
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
        cost += 60 + (bounds.x1 - box.x1);
      }

      if (box.x2 > bounds.x2) {
        cost += 60 + (box.x2 - bounds.x2);
      }

      if (box.y1 < bounds.y1) {
        cost += 60 + (bounds.y1 - box.y1);
      }

      if (box.y2 > bounds.y2) {
        cost += 60 + (box.y2 - bounds.y2);
      }

      for (const existing of pointBoxes) {
        if (rectsOverlap(box, existing)) {
          cost += 140;
        }
      }

      for (const existing of labelBoxes) {
        if (rectsOverlap(box, existing)) {
          cost += 60;
        }
      }

      if (cost < bestCost) {
        bestCost = cost;
        best = candidate;
      }
    }

    labelBoxes.push(labelRect(best.x, best.y, best.anchor, textWidth));
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
    parts.push(markerPath(provider, cursor, y - 4, 4.5));
    const label = providerDisplay(provider);
    parts.push(
      `<text x="${(cursor + 10).toFixed(1)}" y="${y}" fill="var(--c-muted)" font-family="${FONT_SANS}" font-size="11">${esc(label)}</text>`
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

  return `<path d="${pathPts.join(" ")}" fill="none" stroke="var(--c-frontier)" stroke-width="1.5" stroke-dasharray="5 4" opacity="0.65"/>`;
};

const renderParetoScatter = (options: ParetoChartOptions): string => {
  const width = 960;
  const height = 540;
  const left = 76;
  const right = width - 36;
  const top = 96;
  const bottom = height - 62;
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
    ? maxXRaw * 1.4
    : Math.max(minX + 1, maxXRaw * 1.14);

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

  // Horizontal gridlines and Y ticks.
  for (const yTick of linearTicks(minY, 100, 6)) {
    const py = scaleY(yTick);
    parts.push(
      `<line x1="${left}" y1="${py.toFixed(1)}" x2="${right}" y2="${py.toFixed(1)}" stroke="var(--c-grid)" stroke-width="1"/>`,
      `<text x="${left - 10}" y="${(py + 4).toFixed(1)}" text-anchor="end" fill="var(--c-muted)" font-family="${FONT_MONO}" font-size="11">${yTick.toFixed(0)}</text>`
    );
  }

  // Vertical gridlines and X ticks.
  const xTicks = options.logX
    ? logTicks(minX, maxX)
    : linearTicks(minX, maxX, 6);

  for (const xTick of xTicks) {
    const px = scaleX(xTick);

    if (px < left - 2 || px > right + 2) {
      continue;
    }

    parts.push(
      `<line x1="${px.toFixed(1)}" y1="${top}" x2="${px.toFixed(1)}" y2="${bottom}" stroke="var(--c-grid)" stroke-width="1"/>`,
      `<text x="${px.toFixed(1)}" y="${bottom + 20}" text-anchor="middle" fill="var(--c-muted)" font-family="${FONT_MONO}" font-size="11">${esc(options.formatX(xTick))}</text>`
    );
  }

  // Axes and directional hints.
  parts.push(
    `<line x1="${left}" y1="${top}" x2="${left}" y2="${bottom}" stroke="var(--c-axis)" stroke-width="1"/>`,
    `<line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="var(--c-axis)" stroke-width="1"/>`,
    `<text x="${(left + right) / 2}" y="${height - 20}" text-anchor="middle" fill="var(--c-muted)" font-family="${FONT_SANS}" font-size="12">${esc(options.xLabel)}</text>`,
    `<text x="22" y="${(top + bottom) / 2}" text-anchor="middle" fill="var(--c-muted)" font-family="${FONT_SANS}" font-size="12" transform="rotate(-90 22 ${(top + bottom) / 2})">${esc(options.yLabel)}</text>`
  );

  if (minY > 0) {
    parts.push(
      `<text x="${left + 8}" y="${bottom - 8}" fill="var(--c-subtle)" font-family="${FONT_SANS}" font-size="10">Y-axis starts at ${minY} (zoomed)</text>`
    );
  }

  parts.push(
    `<text x="${left + 8}" y="${top + 16}" fill="var(--c-text)" font-family="${FONT_SANS}" font-size="11" font-weight="600">↖ Better (Higher autonomy, lower ${options.logX ? "cost" : "wall time"})</text>`
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
    r: item.radius ?? (frontierIds.has(item.id) ? 6.5 : 5.5),
    label: item.label,
  }));

  const labels = placeLabels(coords, {
    x1: left + 6,
    y1: top + 22,
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
        `<line x1="${point.cx.toFixed(1)}" y1="${point.cy.toFixed(1)}" x2="${placed.x.toFixed(1)}" y2="${(placed.y - 4).toFixed(1)}" stroke="var(--c-subtle)" stroke-width="0.9" stroke-dasharray="2 2"/>`
      );
    }

    const isFrontier = frontierIds.has(point.item.id);

    const halo = isFrontier
      ? `<circle cx="${point.cx.toFixed(1)}" cy="${point.cy.toFixed(1)}" r="${(point.r + 4).toFixed(1)}" fill="none" stroke="var(--c-frontier)" stroke-width="1" opacity="0.35"/>`
      : "";

    parts.push(
      `<g class="chart-point" data-tip="${esc(point.item.tip)}">${halo}${markerPath(point.item.provider, point.cx, point.cy, point.r)}</g>`,
      `<text x="${placed.x.toFixed(1)}" y="${placed.y.toFixed(1)}" text-anchor="${placed.anchor}" fill="${isFrontier ? "var(--c-text)" : "var(--c-muted)"}" stroke="var(--c-card)" stroke-width="4" stroke-linejoin="round" paint-order="stroke" font-family="${FONT_SANS}" font-size="11" font-weight="${isFrontier ? "600" : "400"}">${esc(point.label)}</text>`
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
    providerLegend(providers, legendStart, 80),
    `<line x1="${(right - 102).toFixed(1)}" y1="76" x2="${(right - 78).toFixed(1)}" y2="76" stroke="var(--c-frontier)" stroke-width="1.5" stroke-dasharray="5 3" opacity="0.7"/>`,
    `<text x="${(right - 72).toFixed(1)}" y="80" fill="var(--c-muted)" font-family="${FONT_SANS}" font-size="11">Pareto frontier</text>`,
    "</svg>"
  );

  return parts.join("\n");
};

const renderReviewerCalibration = (
  rows: readonly ModelRoleSummary[],
  excludedTasks: readonly string[]
): string => {
  const width = 960;
  const height = 540;
  const left = 76;
  const right = width - 40;
  const top = 96;
  const bottom = height - 62;
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
    bottom - ((recallPct - minRecall) / Math.max(10, 106 - minRecall)) * plotH;

  const scaleR = (wallS: number): number => 6 + Math.sqrt(wallS / maxWall) * 11;

  const subtitle =
    excludedTasks.length > 0
      ? `Seeded defect recall vs. false-alarm restraint (2× P0–P2 FP + 1× P3 nitpick) across calibrated tasks (excluding ${excludedTasks.join(", ")}); bubble size = median wall time`
      : "Seeded defect recall vs. false-alarm restraint (2× P0–P2 FP + 1× P3 nitpick); bubble size = median wall time";

  const parts: string[] = [
    svgHeader(width, height, "Code Reviewer Calibration Quadrant", subtitle),
  ];

  // Top-right target quadrant highlight.
  const qx = scaleX(1.5);
  const qy = scaleY(95);
  parts.push(
    `<rect x="${qx.toFixed(1)}" y="${top}" width="${(right - qx).toFixed(1)}" height="${(qy - top).toFixed(1)}" fill="var(--c-quadrant)"/>`,
    `<line x1="${qx.toFixed(1)}" y1="${top}" x2="${qx.toFixed(1)}" y2="${bottom}" stroke="var(--c-axis)" stroke-width="1" stroke-dasharray="4 4"/>`,
    `<line x1="${left}" y1="${qy.toFixed(1)}" x2="${right}" y2="${qy.toFixed(1)}" stroke="var(--c-axis)" stroke-width="1" stroke-dasharray="4 4"/>`,
    `<text x="${(right - 8).toFixed(1)}" y="${(top + 16).toFixed(1)}" text-anchor="end" fill="var(--c-text)" font-family="${FONT_SANS}" font-size="11" font-weight="600">High Recall + High Restraint ↗</text>`,
    `<text x="${(left + 8).toFixed(1)}" y="${(top + 16).toFixed(1)}" fill="var(--c-muted)" font-family="${FONT_SANS}" font-size="11">High Recall, Noisy / Pedantic</text>`,
    `<text x="${(right - 8).toFixed(1)}" y="${(bottom - 10).toFixed(1)}" text-anchor="end" fill="var(--c-subtle)" font-family="${FONT_SANS}" font-size="11">Clean but Under-Sensitive</text>`
  );

  for (const yTick of linearTicks(minRecall, 100, 5)) {
    const py = scaleY(yTick);
    parts.push(
      `<line x1="${left}" y1="${py.toFixed(1)}" x2="${right}" y2="${py.toFixed(1)}" stroke="var(--c-grid)" stroke-width="1"/>`,
      `<text x="${left - 10}" y="${(py + 4).toFixed(1)}" text-anchor="end" fill="var(--c-muted)" font-family="${FONT_MONO}" font-size="11">${yTick.toFixed(0)}%</text>`
    );
  }

  for (let alarms = 0; alarms <= maxAlarms; alarms += 1) {
    const px = scaleX(alarms);
    parts.push(
      `<line x1="${px.toFixed(1)}" y1="${top}" x2="${px.toFixed(1)}" y2="${bottom}" stroke="var(--c-grid)" stroke-width="1"/>`,
      `<text x="${px.toFixed(1)}" y="${bottom + 20}" text-anchor="middle" fill="var(--c-muted)" font-family="${FONT_MONO}" font-size="11">${alarms}</text>`
    );
  }

  parts.push(
    `<line x1="${left}" y1="${top}" x2="${left}" y2="${bottom}" stroke="var(--c-axis)" stroke-width="1"/>`,
    `<line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="var(--c-axis)" stroke-width="1"/>`,
    `<text x="${(left + right) / 2}" y="${height - 20}" text-anchor="middle" fill="var(--c-muted)" font-family="${FONT_SANS}" font-size="12">Weighted Unsolicited False Alarms (2× P0–P2 + 1× P3 — right is cleaner)</text>`,
    `<text x="22" y="${(top + bottom) / 2}" text-anchor="middle" fill="var(--c-muted)" font-family="${FONT_SANS}" font-size="12" transform="rotate(-90 22 ${(top + bottom) / 2})">Seeded Defect Recall (%)</text>`
  );

  // Small deterministic jitter when multiple models tie at exact (0 alarms, 100% recall).
  const coords = rows.map((row, idx) => {
    const recallPct = (row.defectRecall ?? 1) * 100;

    const sameSpot = rows
      .slice(0, idx)
      .filter(
        (prev) =>
          prev.weightedFalseAlarms === row.weightedFalseAlarms &&
          Math.abs((prev.defectRecall ?? 1) * 100 - recallPct) < 0.1
      ).length;

    const cx = scaleX(row.weightedFalseAlarms) - sameSpot * 22;
    const cy = scaleY(recallPct) + sameSpot * 16;
    const r = scaleR(row.medianWallS);
    const displayName = displayModelLabel(row.model);
    const tip = `${displayName} | LSAS ${row.lsas.toFixed(1)} | Recall ${recallPct.toFixed(1)}% | FP ${row.falsePositiveP0P2}, P3 ${row.nitpickP3} | Wall ${row.medianWallS.toFixed(1)}s | Cost $${row.totalCostUsd.toFixed(2)}`;

    return {
      row,
      cx,
      cy,
      r,
      label: `${displayName} · ${row.medianWallS.toFixed(0)}s`,
      tip,
    };
  });

  const labels = placeLabels(coords, {
    x1: left + 6,
    y1: top + 24,
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
        `<line x1="${point.cx.toFixed(1)}" y1="${point.cy.toFixed(1)}" x2="${placed.x.toFixed(1)}" y2="${(placed.y - 4).toFixed(1)}" stroke="var(--c-subtle)" stroke-width="0.9" stroke-dasharray="2 2"/>`
      );
    }

    const color = providerVar(point.row.provider);
    parts.push(
      `<g class="chart-point" data-tip="${esc(point.tip)}"><circle cx="${point.cx.toFixed(1)}" cy="${point.cy.toFixed(1)}" r="${point.r.toFixed(1)}" fill="${color}" fill-opacity="0.16" stroke="${color}" stroke-width="2.2"/></g>`,
      `<text x="${placed.x.toFixed(1)}" y="${placed.y.toFixed(1)}" text-anchor="${placed.anchor}" fill="var(--c-text)" stroke="var(--c-card)" stroke-width="4" stroke-linejoin="round" paint-order="stroke" font-family="${FONT_SANS}" font-size="11">${esc(point.label)}</text>`
    );
  }

  const providers = [...new Set(rows.map((row) => row.provider))].toSorted();
  parts.push(providerLegend(providers, left, 80), "</svg>");

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
        label: displayModelLabel(row.model),
        scoreLabel: `ACI ${row.aci.toFixed(1)}`,
        total: row.totalTrials,
        counts: row.tierCounts,
      });
    }
  } else {
    for (const row of summary.coderRows) {
      rows.push({
        section: "Standalone Coders",
        label: displayModelLabel(row.model),
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
      label: displayModelLabel(row.model),
      scoreLabel: `LSAS ${row.lsas.toFixed(1)}`,
      total: row.trials,
      counts: row.tierCounts,
    });
  }

  const width = 960;
  const rowH = 32;
  const sectionGap = 28;
  const sections = new Set(rows.map((row) => row.section)).size;
  const top = 104;
  const height = top + rows.length * rowH + sections * sectionGap + 34;
  const labelRight = 220;
  const barLeft = 232;
  const barRight = width - 114;
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
  let legendX = 28;

  for (const tier of TIER_META) {
    parts.push(
      `<rect x="${legendX}" y="73" width="11" height="11" rx="2.5" fill="${tier.fillVar}"/>`,
      `<text x="${legendX + 16}" y="82.5" fill="var(--c-muted)" font-family="${FONT_SANS}" font-size="11">${esc(tier.label)}</text>`
    );
    legendX += tier.label.length * 6.3 + 30;
  }

  let cursorY = top;
  let lastSection = "";

  for (const row of rows) {
    if (row.section !== lastSection) {
      if (lastSection !== "") {
        cursorY += 10;
      }

      parts.push(
        `<text x="28" y="${cursorY + 12}" fill="var(--c-muted)" font-family="${FONT_SANS}" font-size="11" font-weight="600" letter-spacing="0.06em">${esc(row.section.toUpperCase())}</text>`
      );
      cursorY += sectionGap;
      lastSection = row.section;
    }

    parts.push(
      `<text x="${labelRight}" y="${cursorY + 16}" text-anchor="end" fill="var(--c-text)" font-family="${FONT_SANS}" font-size="11.5">${esc(row.label)}</text>`
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
        `<rect class="chart-point" data-tip="${esc(tip)}" x="${segX.toFixed(1)}" y="${cursorY + 3}" width="${Math.max(1, segW - 1.5).toFixed(1)}" height="18" rx="3" fill="${tier.fillVar}"/>`
      );

      if (segW >= 24) {
        parts.push(
          `<text x="${(segX + segW / 2).toFixed(1)}" y="${cursorY + 15.5}" text-anchor="middle" fill="${tier.inkVar}" font-family="${FONT_MONO}" font-size="10.5" font-weight="600">${count}</text>`
        );
      }

      segX += segW;
    }

    parts.push(
      `<text x="${barRight + 10}" y="${cursorY + 16}" fill="var(--c-muted)" font-family="${FONT_MONO}" font-size="11">${esc(row.scoreLabel)}</text>`
    );
    cursorY += rowH;
  }

  parts.push("</svg>");

  return parts.join("\n");
};

const matrixAccentVar = (lsas: number): string => {
  if (lsas >= 98) {
    return "var(--m-top)";
  }

  if (lsas >= 92) {
    return "var(--m-high)";
  }

  if (lsas >= 82) {
    return "var(--m-mid)";
  }

  return "var(--m-low)";
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

  const labelRight = 224;
  const colStart = 238;
  const width = Math.max(840, colStart + 24 + reviewers.length * 300);
  const rowH = 58;

  const colW = Math.floor(
    (width - colStart - 24) / Math.max(1, reviewers.length)
  );

  const top = 110;
  const height = top + coders.length * rowH + 56;

  const parts: string[] = [
    svgHeader(
      width,
      height,
      "Phase 3 Coder × Reviewer Synergy Matrix",
      "Status dot = Pair LSAS tier · Displays Pair LSAS, strict Pass@1, 4-task cost, and median wall time per coder → reviewer cell"
    ),
  ];

  // Column headers.
  for (let col = 0; col < reviewers.length; col += 1) {
    const reviewer = reviewers[col];

    if (reviewer === undefined) {
      continue;
    }

    const x = colStart + col * colW + colW / 2;
    parts.push(
      `<text x="${x.toFixed(1)}" y="92" text-anchor="middle" fill="var(--c-text)" font-family="${FONT_SANS}" font-size="12" font-weight="600">Reviewer: ${esc(displayModelLabel(reviewer))}</text>`
    );
  }

  for (let row = 0; row < coders.length; row += 1) {
    const coder = coders[row];

    if (coder === undefined) {
      continue;
    }

    const y = top + row * rowH;
    parts.push(
      `<text x="${labelRight}" y="${y + 33}" text-anchor="end" fill="var(--c-text)" font-family="${FONT_SANS}" font-size="11.5" font-weight="500">${esc(displayModelLabel(coder))}</text>`
    );

    for (let col = 0; col < reviewers.length; col += 1) {
      const reviewer = reviewers[col];

      if (reviewer === undefined) {
        continue;
      }

      const cell = cellMap.get(`${coder}\0${reviewer}`);
      const x = colStart + col * colW;

      if (cell === undefined) {
        parts.push(
          `<rect x="${x + 5}" y="${y + 5}" width="${colW - 10}" height="${rowH - 10}" rx="7" fill="var(--c-muted-bg)" stroke="var(--c-border)" stroke-width="1"/>`,
          `<text x="${(x + colW / 2).toFixed(1)}" y="${y + 33}" text-anchor="middle" fill="var(--c-subtle)" font-family="${FONT_MONO}" font-size="11">—</text>`
        );
        continue;
      }

      const accent = matrixAccentVar(cell.lsas);
      const tip = `${displayModelLabel(coder)} → ${displayModelLabel(reviewer)} | LSAS ${cell.lsas.toFixed(1)} | Pass ${cell.passedCount}/${cell.trials} | ZSDR ${(100 * cell.zsdrRate).toFixed(0)}% | Cost $${cell.totalCostUsd.toFixed(2)} | Med wall ${cell.medianWallS.toFixed(1)}s`;
      parts.push(
        `<g class="chart-point" data-tip="${esc(tip)}">`,
        `<rect x="${x + 5}" y="${y + 5}" width="${colW - 10}" height="${rowH - 10}" rx="8" fill="var(--c-muted-bg)" stroke="var(--c-border)" stroke-width="1"/>`,
        `<circle cx="${x + 18}" cy="${y + 21}" r="3.5" fill="${accent}"/>`,
        `<text x="${(x + colW / 2 + 4).toFixed(1)}" y="${y + 25}" text-anchor="middle" fill="var(--c-text)" font-family="${FONT_MONO}" font-size="12.5" font-weight="600">LSAS ${cell.lsas.toFixed(1)} · ${cell.passedCount}/${cell.trials}</text>`,
        `<text x="${(x + colW / 2 + 4).toFixed(1)}" y="${y + 42}" text-anchor="middle" fill="var(--c-muted)" font-family="${FONT_MONO}" font-size="10.5">$${cell.totalCostUsd.toFixed(2)} · med ${cell.medianWallS.toFixed(1)}s</text>`,
        "</g>"
      );
    }
  }

  // Footer totals per reviewer.
  const footerY = top + coders.length * rowH + 28;
  parts.push(
    `<text x="${labelRight}" y="${footerY}" text-anchor="end" fill="var(--c-muted)" font-family="${FONT_SANS}" font-size="11.5" font-weight="600">Reviewer total</text>`
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
    const x = colStart + col * colW + colW / 2;

    parts.push(
      `<text x="${x.toFixed(1)}" y="${footerY}" text-anchor="middle" fill="var(--c-text)" font-family="${FONT_MONO}" font-size="11" font-weight="600">${passed}/${total} pass · $${cost.toFixed(2)} · ${Math.round(wall)}s</text>`
    );
  }

  parts.push("</svg>");

  return parts.join("\n");
};

const renderTaskHeatmap = (summary: BenchmarkSummary): string => {
  interface Panel {
    readonly heading: string;
    readonly isPair: boolean;
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

    panels.push({ heading, isPair: role === "pair", tasks, models, lookup });
  }

  const width = 1080;
  const labelW = 248;
  const rowH = 26;
  let totalH = 104;

  for (const panel of panels) {
    const headerH = panel.isPair ? 114 : 84;
    totalH += 34 + headerH + panel.tasks.length * rowH + 20;
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
  let legendX = 28;

  for (const tier of TIER_META) {
    parts.push(
      `<rect x="${legendX}" y="73" width="10" height="10" rx="2.5" fill="${tier.fillVar}"/>`,
      `<text x="${legendX + 15}" y="82" fill="var(--c-muted)" font-family="${FONT_SANS}" font-size="10.5">${esc(tier.label)}</text>`
    );
    legendX += tier.label.length * 6.2 + 26;
  }

  let y = 108;

  for (const panel of panels) {
    const headerH = panel.isPair ? 114 : 84;
    parts.push(
      `<text x="28" y="${y + 14}" fill="var(--c-text)" font-family="${FONT_SANS}" font-size="12.5" font-weight="600">${esc(panel.heading)}</text>`
    );
    y += 28;

    const colW = Math.min(
      82,
      Math.floor((width - labelW - 110) / Math.max(1, panel.models.length))
    );

    // Angled model column labels.
    for (let col = 0; col < panel.models.length; col += 1) {
      const model = panel.models[col];

      if (model === undefined) {
        continue;
      }

      const headerLabel = panel.isPair
        ? compactModelLabel(model)
        : displayModelLabel(model);

      const cx = labelW + col * colW + colW / 2;
      const labelY = y + headerH - 8;
      parts.push(
        `<text x="${cx.toFixed(1)}" y="${labelY}" text-anchor="start" fill="var(--c-muted)" font-family="${FONT_SANS}" font-size="9.5" transform="rotate(-38 ${cx.toFixed(1)} ${labelY})">${esc(headerLabel)}</text>`
      );
    }

    y += headerH;

    for (const taskId of panel.tasks) {
      parts.push(
        `<text x="${labelW - 10}" y="${y + 15.5}" text-anchor="end" fill="var(--c-text)" font-family="${FONT_MONO}" font-size="10">${esc(taskId)}</text>`
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
            `<rect x="${cx + 1.5}" y="${y + 1.5}" width="${colW - 3}" height="${rowH - 3}" rx="3.5" fill="var(--c-muted-bg)" stroke="var(--c-border)" stroke-width="0.75"/>`
          );
          continue;
        }

        const tierColors = TIER_BY_KEY[outcome.tier];
        const tip = `${taskId} | ${displayModelLabel(model)} | ${outcome.tier.replaceAll("_", " ")} | LSAS ${outcome.lsas.toFixed(1)} | ${outcome.wallS.toFixed(1)}s`;
        parts.push(
          `<g class="chart-point" data-tip="${esc(tip)}">`,
          `<rect x="${cx + 1.5}" y="${y + 1.5}" width="${colW - 3}" height="${rowH - 3}" rx="3.5" fill="${tierColors.fillVar}"/>`
        );

        if (colW >= 34) {
          parts.push(
            `<text x="${(cx + colW / 2).toFixed(1)}" y="${y + 15}" text-anchor="middle" fill="${tierColors.inkVar}" font-family="${FONT_MONO}" font-size="9" font-weight="600">${Math.round(outcome.wallS)}s</text>`
          );
        }

        parts.push("</g>");
      }

      y += rowH;
    }

    y += 20;
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

  const width = 1040;
  const rowH = 34;
  const top = 110;
  const height = top + rows.length * rowH + 54;
  const labelRight = 210;
  const leftBarStart = 224;
  const leftBarW = 290;
  const rightBarStart = 668;
  const rightBarW = 240;

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
    `<text x="${leftBarStart}" y="92" fill="var(--c-text)" font-family="${FONT_SANS}" font-size="12" font-weight="600">Active Throughput (total tok/s) &amp; Reasoning Share</text>`,
    `<text x="${rightBarStart}" y="92" fill="var(--c-text)" font-family="${FONT_SANS}" font-size="12" font-weight="600">Normalized Diff Size (added lines / median)</text>`
  );

  // 1.0x reference line on right panel.
  const refX = rightBarStart + (1 / maxDiff) * rightBarW;
  parts.push(
    `<line x1="${refX.toFixed(1)}" y1="${top - 6}" x2="${refX.toFixed(1)}" y2="${top + rows.length * rowH}" stroke="var(--c-axis)" stroke-width="1.2" stroke-dasharray="4 3"/>`,
    `<text x="${refX.toFixed(1)}" y="${top + rows.length * rowH + 16}" text-anchor="middle" fill="var(--c-muted)" font-family="${FONT_MONO}" font-size="10">1.0× median</text>`
  );

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];

    if (row === undefined) {
      continue;
    }

    const y = top + i * rowH;
    const color = providerVar(row.provider);
    const barW = (row.tokPerS / maxTok) * leftBarW;
    const reasonW = barW * Math.min(1, Math.max(0, row.reasoningShare));
    const displayName = displayModelLabel(row.model);

    const coldText =
      row.coldVisibleS === null ? "—" : `${row.coldVisibleS.toFixed(1)}s`;

    const leftTip = `${displayName} | ${Math.round(row.tokPerS)} total tok/s | Reasoning ${Math.round(row.reasoningShare * 100)}% | Cold TTFT ${coldText}`;

    parts.push(
      `<text x="${labelRight}" y="${y + 18}" text-anchor="end" fill="var(--c-text)" font-family="${FONT_SANS}" font-size="11.5">${esc(displayName)}</text>`,
      `<g class="chart-point" data-tip="${esc(leftTip)}">`,
      `<rect x="${leftBarStart}" y="${y + 5}" width="${Math.max(2, barW).toFixed(1)}" height="18" rx="3.5" fill="${color}" fill-opacity="0.86"/>`,
      `<rect x="${leftBarStart}" y="${y + 5}" width="${Math.max(0, reasonW).toFixed(1)}" height="18" rx="3.5" fill="var(--c-reason-overlay)"/>`,
      `</g>`,
      `<text x="${(leftBarStart + barW + 8).toFixed(1)}" y="${y + 18}" fill="var(--c-muted)" font-family="${FONT_MONO}" font-size="10.5">${Math.round(row.tokPerS)} t/s (${Math.round(row.reasoningShare * 100)}% R · ${coldText})</text>`
    );

    const diffW = (row.diffRatio / maxDiff) * rightBarW;

    let diffColor = "var(--d-balanced)";
    let diffTag = "balanced";

    if (row.diffRatio < 0.8) {
      diffColor = "var(--d-compressed)";
      diffTag = "compressed";
    } else if (row.diffRatio > 1.2) {
      diffColor = "var(--d-verbose)";
      diffTag = "verbose";
    }

    const rightTip = `${displayName} | Median diff ${row.diffRatio.toFixed(2)}× task median (${diffTag})`;

    parts.push(
      `<g class="chart-point" data-tip="${esc(rightTip)}">`,
      `<rect x="${rightBarStart}" y="${y + 5}" width="${Math.max(2, diffW).toFixed(1)}" height="18" rx="3.5" fill="${diffColor}"/>`,
      `</g>`,
      `<text x="${(rightBarStart + diffW + 8).toFixed(1)}" y="${y + 18}" fill="var(--c-muted)" font-family="${FONT_MONO}" font-size="10.5">${row.diffRatio.toFixed(2)}× (${diffTag})</text>`
    );
  }

  parts.push(
    `<text x="${leftBarStart}" y="${height - 16}" fill="var(--c-subtle)" font-family="${FONT_SANS}" font-size="10">Shaded left bar portion = reasoning token share (R). Uses total_model_tok_per_s across providers.</text>`,
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
      label: displayModelLabel(row.model),
      provider: row.provider,
      x: row.totalCostUsd,
      y: row.aci,
      tip: `${displayModelLabel(row.model)} | ACI ${row.aci.toFixed(1)} (Solo ${row.solo.lsas.toFixed(1)}, Pair ${row.pair.lsas.toFixed(1)}) | Pass ${row.passedCount}/${row.totalTrials} | ZSDR ${(100 * row.zsdrRate).toFixed(1)}% | Cost $${row.totalCostUsd.toFixed(2)} | Wall ${Math.round(row.totalWallS)}s`,
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
      label: displayModelLabel(row.model),
      provider: row.provider,
      x: row.totalWallS / 60,
      y: row.aci,
      tip: `${displayModelLabel(row.model)} | ACI ${row.aci.toFixed(1)} | Total wall ${(row.totalWallS / 60).toFixed(1)} min (${Math.round(row.totalWallS)}s) | Med wall ${row.medianWallS.toFixed(1)}s | Cost $${row.totalCostUsd.toFixed(2)}`,
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
      label: displayModelLabel(row.model),
      provider: row.provider,
      x: row.totalCostUsd,
      y: row.lsas,
      tip: `${displayModelLabel(row.model)} | Solo LSAS ${row.lsas.toFixed(1)} | Pass ${row.passedCount}/${row.trials} | ZSDR ${(100 * row.zsdrRate).toFixed(1)}% | Cost $${row.totalCostUsd.toFixed(2)} | Med wall ${row.medianWallS.toFixed(1)}s`,
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
        label: displayModelLabel(row.model),
        provider: row.provider,
        x: row.totalCostUsd,
        y: row.lsas,
        tip: `${displayModelLabel(row.model)} | Reviewer LSAS ${row.lsas.toFixed(1)} | Pass ${row.passedCount}/${row.trials} | FP ${row.falsePositiveP0P2}, P3 ${row.nitpickP3} | Cost $${row.totalCostUsd.toFixed(2)} | Med wall ${row.medianWallS.toFixed(1)}s`,
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
