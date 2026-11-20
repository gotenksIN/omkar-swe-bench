import { computeParetoFrontier, displayModelLabel } from "./scoring.ts";
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
  readonly keyMetric: string;
  readonly provider: string;
  readonly x: number;
  readonly y: number;
  readonly tip: string;
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
  --c-text: #09090b;
  --c-muted: #52525b;
  --c-subtle: #71717a;
  --c-frontier: #18181b;
  --c-quadrant: #f4f4f5;
  --c-reason-overlay: rgba(0, 0, 0, 0.24);
  --p-anthropic: #d97757;
  --p-google: #4285f4;
  --p-openai: #18181b;
  --p-deepseek: #4d6bfe;
  --p-other: #52525b;
  --p-badge-ink: #ffffff;
  --p-openai-ink: #ffffff;
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
    --c-text: #fafafa;
    --c-muted: #a1a1aa;
    --c-subtle: #71717a;
    --c-frontier: #fafafa;
    --c-quadrant: #141417;
    --c-reason-overlay: rgba(0, 0, 0, 0.45);
    --p-anthropic: #e88b6d;
    --p-google: #60a5fa;
    --p-openai: #f4f4f5;
    --p-deepseek: #738bff;
    --p-other: #71717a;
    --p-badge-ink: #ffffff;
    --p-openai-ink: #09090b;
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

const labIconPath = (provider: string): string | undefined => {
  switch (provider) {
    case "anthropic": {
      return "M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z";
    }

    case "google": {
      return "M5.988 1.622A8.539 8.539 0 003.45 8.446c.349 4.408 4.506 7.995 8.276 7.995 3.507 0 4.88-3.061 4.541-5.14a4.318 4.318 0 00-.95-2.073c.632.34 1.244.776 1.809 1.3 1.52 1.415 2.44 3.229 2.587 5.1C20.04 19.763 16.98 24 11.863 24c-1.695 0-3.48-.432-4.98-1.143C2.816 20.937 0 16.797 0 12.002 0 7.571 2.405 3.7 5.988 1.622zM12.136 0c1.696 0 3.481.432 4.98 1.143C21.186 3.063 24 7.203 24 11.998c0 4.431-2.405 8.303-5.988 10.38a8.539 8.539 0 002.538-6.824c-.349-4.408-4.506-7.995-8.276-7.995-3.507 0-4.88 3.061-4.541 5.14a4.3 4.3 0 00.953 2.073 8.723 8.723 0 01-1.81-1.3c-1.52-1.415-2.44-3.227-2.589-5.1C3.96 4.237 7.02 0 12.137 0z";
    }

    case "openai": {
      return "M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z";
    }

    case "deepseek": {
      return "M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z";
    }

    default: {
      return undefined;
    }
  }
};

const providerBadgeInk = (provider: string): string =>
  provider === "openai" ? "var(--p-openai-ink)" : "var(--p-badge-ink)";

const renderLabIcon = (
  provider: string,
  x: number,
  y: number,
  size: number
): string => {
  const pathData = labIconPath(provider);
  const color = providerVar(provider);

  if (pathData === undefined) {
    const r = size / 2;

    return `<circle cx="${(x + r).toFixed(1)}" cy="${(y + r).toFixed(1)}" r="${(r * 0.72).toFixed(1)}" fill="${color}"/>`;
  }

  const scale = size / 24;

  return `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${scale.toFixed(4)})"><path d="${pathData}" fill="${color}" fill-rule="evenodd"/></g>`;
};

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
    label: "Clean pass",
    fillVar: "var(--t-clean)",
    inkVar: "var(--t-clean-ink)",
  },
  {
    key: "self_healed_friction",
    label: "Self-healed",
    fillVar: "var(--t-friction)",
    inkVar: "var(--t-friction-ink)",
  },
  {
    key: "hygiene_nudge",
    label: "Hygiene nudge",
    fillVar: "var(--t-nudge)",
    inkVar: "var(--t-nudge-ink)",
  },
  {
    key: "broken_deliverable",
    label: "Broken / refusal",
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
      return "DeepMind";
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

const scatterModelLabel = (spec: string): string => {
  const full = displayModelLabel(spec);

  return full
    .replace(/^Gemini 4 /u, "")
    .replace(/^Claude /u, "")
    .replace(/^DeepSeek /u, "")
    .replace("(medium)", "(med)");
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
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" fill="var(--c-card)" stroke="var(--c-border)" stroke-width="1"/>`,
    `<text x="32" y="40" fill="var(--c-text)" font-family="${FONT_SANS}" font-size="18.5" font-weight="600" letter-spacing="-0.02em">${esc(title)}</text>`,
    `<text x="32" y="61" fill="var(--c-muted)" font-family="${FONT_SANS}" font-size="12.5">${esc(subtitle)}</text>`,
  ].join("\n");

interface SeparatedPoint {
  readonly origX: number;
  readonly origY: number;
  readonly x: number;
  readonly y: number;
}

const separatePoints = (
  points: readonly { readonly x: number; readonly y: number }[],
  bounds: {
    readonly x1: number;
    readonly y1: number;
    readonly x2: number;
    readonly y2: number;
  },
  minDist: number
): readonly SeparatedPoint[] => {
  const xs = points.map((pt) => pt.x);
  const ys = points.map((pt) => pt.y);

  for (let iter = 0; iter < 40; iter += 1) {
    let moved = false;

    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const ax = xs[i] ?? 0;
        const ay = ys[i] ?? 0;
        const bx = xs[j] ?? 0;
        const by = ys[j] ?? 0;
        let dx = bx - ax;
        let dy = by - ay;
        let dist = Math.hypot(dx, dy);

        if (dist >= minDist) {
          continue;
        }

        if (dist < 0.01) {
          // Deterministic angular nudge for exact ties.
          const angle = ((i + j) % 6) * (Math.PI / 3) - Math.PI / 4;
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          dist = 1;
        }

        const push = (minDist - dist) / 2 + 0.5;
        const nx = (dx / dist) * push;
        const ny = (dy / dist) * push;

        xs[i] = Math.max(bounds.x1, Math.min(bounds.x2, ax - nx));
        ys[i] = Math.max(bounds.y1, Math.min(bounds.y2, ay - ny));
        xs[j] = Math.max(bounds.x1, Math.min(bounds.x2, bx + nx));
        ys[j] = Math.max(bounds.y1, Math.min(bounds.y2, by + ny));
        moved = true;
      }
    }

    if (!moved) {
      break;
    }
  }

  return points.map((pt, idx) => ({
    origX: pt.x,
    origY: pt.y,
    x: xs[idx] ?? pt.x,
    y: ys[idx] ?? pt.y,
  }));
};

const renderNumberedBadge = (
  cx: number,
  cy: number,
  rank: number,
  provider: string,
  radius: number,
  isFrontier: boolean
): string => {
  const fill = providerVar(provider);
  const ink = providerBadgeInk(provider);

  const frontierRing = isFrontier
    ? `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(radius + 3.5).toFixed(1)}" fill="none" stroke="var(--c-frontier)" stroke-width="1.35" stroke-dasharray="3 2" opacity="0.55"/>`
    : "";

  const fontSize = rank >= 10 ? "10" : "11";

  return [
    frontierRing,
    `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${radius.toFixed(1)}" fill="${fill}" stroke="var(--c-card)" stroke-width="2"/>`,
    `<text x="${cx.toFixed(1)}" y="${(cy + 3.8).toFixed(1)}" text-anchor="middle" fill="${ink}" font-family="${FONT_SANS}" font-size="${fontSize}" font-weight="700">${rank}</text>`,
  ].join("");
};

interface RankedKeyEntry {
  readonly rank: number;
  readonly provider: string;
  readonly label: string;
  readonly metric: string;
  readonly emphasized: boolean;
}

const rankedKeyHeight = (count: number): number => {
  const rows = Math.ceil(count / 2);

  return 26 + rows * 26 + 12;
};

const renderRankedKey = (
  entries: readonly RankedKeyEntry[],
  startX: number,
  startY: number,
  totalWidth: number
): string => {
  const parts: string[] = [
    `<line x1="${startX}" y1="${startY}" x2="${startX + totalWidth}" y2="${startY}" stroke="var(--c-border)" stroke-width="1"/>`,
  ];

  const colCount = 2;
  const rowsPerCol = Math.ceil(entries.length / colCount);
  const colGap = 24;
  const colW = (totalWidth - colGap) / colCount;

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];

    if (entry === undefined) {
      continue;
    }

    const col = Math.floor(i / rowsPerCol);
    const row = i % rowsPerCol;
    const x = startX + col * (colW + colGap);
    const y = startY + 24 + row * 26;
    const badgeR = 8.5;
    const badgeCx = x + badgeR + 2;
    const badgeCy = y - 4;
    const fill = providerVar(entry.provider);
    const ink = providerBadgeInk(entry.provider);
    const fontSize = entry.rank >= 10 ? "9.5" : "10.5";

    parts.push(
      `<circle cx="${badgeCx.toFixed(1)}" cy="${badgeCy.toFixed(1)}" r="${badgeR}" fill="${fill}"/>`,
      `<text x="${badgeCx.toFixed(1)}" y="${(badgeCy + 3.5).toFixed(1)}" text-anchor="middle" fill="${ink}" font-family="${FONT_SANS}" font-size="${fontSize}" font-weight="700">${entry.rank}</text>`,
      renderLabIcon(entry.provider, x + 25, y - 10.5, 13),
      `<text x="${(x + 44).toFixed(1)}" y="${y}" fill="${entry.emphasized ? "var(--c-text)" : "var(--c-muted)"}" font-family="${FONT_SANS}" font-size="12" font-weight="${entry.emphasized ? "600" : "500"}">${esc(entry.label)}</text>`,
      `<text x="${(x + colW - 2).toFixed(1)}" y="${y}" text-anchor="end" fill="var(--c-muted)" font-family="${FONT_MONO}" font-size="11">${esc(entry.metric)}</text>`
    );
  }

  return parts.join("\n");
};

const providerLegend = (
  providers: readonly string[],
  startX: number,
  y: number
): string => {
  const parts: string[] = [];
  let cursor = startX;

  for (const provider of providers) {
    parts.push(renderLabIcon(provider, cursor, y - 11.5, 14));
    const label = providerDisplay(provider);
    parts.push(
      `<text x="${(cursor + 19).toFixed(1)}" y="${y}" fill="var(--c-muted)" font-family="${FONT_SANS}" font-size="12">${esc(label)}</text>`
    );
    cursor += label.length * 7.2 + 38;
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
  const width = 760;
  const plotH = 290;
  const left = 68;
  const right = width - 28;
  const top = 114;
  const bottom = top + plotH;
  const keyTop = bottom + 56;
  const height = keyTop + rankedKeyHeight(options.items.length);
  const plotW = right - left;

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
  const maxY = 102.5;

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

  // Dedicated provider + frontier legend row above the plot area.
  const providers = [
    ...new Set(options.items.map((item) => item.provider)),
  ].toSorted();

  parts.push(
    providerLegend(providers, left + 4, 92),
    `<line x1="${(right - 120).toFixed(1)}" y1="88" x2="${(right - 94).toFixed(1)}" y2="88" stroke="var(--c-frontier)" stroke-width="1.6" stroke-dasharray="5 3" opacity="0.75"/>`,
    `<text x="${(right - 88).toFixed(1)}" y="92" fill="var(--c-muted)" font-family="${FONT_SANS}" font-size="12">Pareto frontier</text>`
  );

  // Horizontal gridlines and Y ticks.
  for (const yTick of linearTicks(minY, 100, 6)) {
    const py = scaleY(yTick);
    parts.push(
      `<line x1="${left}" y1="${py.toFixed(1)}" x2="${right}" y2="${py.toFixed(1)}" stroke="var(--c-grid)" stroke-width="1"/>`,
      `<text x="${left - 10}" y="${(py + 4).toFixed(1)}" text-anchor="end" fill="var(--c-muted)" font-family="${FONT_MONO}" font-size="12">${yTick.toFixed(0)}</text>`
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
      `<text x="${px.toFixed(1)}" y="${bottom + 21}" text-anchor="middle" fill="var(--c-muted)" font-family="${FONT_MONO}" font-size="12">${esc(options.formatX(xTick))}</text>`
    );
  }

  // Axes and directional hints.
  parts.push(
    `<line x1="${left}" y1="${top}" x2="${left}" y2="${bottom}" stroke="var(--c-axis)" stroke-width="1"/>`,
    `<line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="var(--c-axis)" stroke-width="1"/>`,
    `<text x="${(left + right) / 2}" y="${bottom + 42}" text-anchor="middle" fill="var(--c-muted)" font-family="${FONT_SANS}" font-size="12.5">${esc(options.xLabel)}</text>`,
    `<text x="20" y="${(top + bottom) / 2}" text-anchor="middle" fill="var(--c-muted)" font-family="${FONT_SANS}" font-size="12.5" transform="rotate(-90 20 ${(top + bottom) / 2})">${esc(options.yLabel)}</text>`
  );

  if (minY > 0) {
    parts.push(
      `<text x="${left + 10}" y="${bottom - 10}" fill="var(--c-subtle)" font-family="${FONT_SANS}" font-size="11">Y-axis starts at ${minY} (zoomed)</text>`
    );
  }

  parts.push(
    `<g stroke="var(--c-text)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"><line x1="${left + 19}" y1="${top + 17}" x2="${left + 11}" y2="${top + 9}"/><polyline points="${left + 11},${top + 15} ${left + 11},${top + 9} ${left + 17},${top + 9}"/></g>`,
    `<text x="${left + 25}" y="${top + 18}" fill="var(--c-text)" font-family="${FONT_SANS}" font-size="12" font-weight="600">Better (Higher autonomy, lower ${options.logX ? "cost" : "wall time"})</text>`
  );

  // Pareto frontier step-line.
  const frontier = computeParetoFrontier(options.items);
  const stepPath = renderParetoStepPath(frontier, scaleX, scaleY);

  if (stepPath !== null) {
    parts.push(stepPath);
  }

  const frontierIds = new Set(frontier.map((item) => item.id));
  const badgeR = 10.5;

  const rawPoints = options.items.map((item) => ({
    x: scaleX(Math.max(item.x, options.logX ? 0.05 : 0)),
    y: scaleY(item.y),
  }));

  const placed = separatePoints(
    rawPoints,
    {
      x1: left + badgeR + 4,
      y1: top + badgeR + 4,
      x2: right - badgeR - 4,
      y2: bottom - badgeR - 4,
    },
    badgeR * 2 + 3
  );

  // Subtle tick if a badge was nudged away from its exact coordinate.
  for (let i = 0; i < options.items.length; i += 1) {
    const item = options.items[i];
    const pt = placed[i];

    if (item === undefined || pt === undefined) {
      continue;
    }

    if (Math.hypot(pt.x - pt.origX, pt.y - pt.origY) > 6) {
      parts.push(
        `<line x1="${pt.origX.toFixed(1)}" y1="${pt.origY.toFixed(1)}" x2="${pt.x.toFixed(1)}" y2="${pt.y.toFixed(1)}" stroke="${providerVar(item.provider)}" stroke-width="1.2" stroke-opacity="0.65"/>`,
        `<circle cx="${pt.origX.toFixed(1)}" cy="${pt.origY.toFixed(1)}" r="2.2" fill="${providerVar(item.provider)}"/>`
      );
    }
  }

  // Numbered badges (drawn in reverse rank order so #1 always sits cleanly on top).
  for (let i = options.items.length - 1; i >= 0; i -= 1) {
    const item = options.items[i];
    const pt = placed[i];

    if (item === undefined || pt === undefined) {
      continue;
    }

    const isFrontier = frontierIds.has(item.id);
    parts.push(
      `<g class="chart-point" data-tip="${esc(item.tip)}">${renderNumberedBadge(pt.x, pt.y, i + 1, item.provider, badgeR, isFrontier)}</g>`
    );
  }

  // 2-column ranked key below the X-axis.
  const keyEntries: RankedKeyEntry[] = options.items.map((item, idx) => ({
    rank: idx + 1,
    provider: item.provider,
    label: item.label,
    metric: item.keyMetric,
    emphasized: frontierIds.has(item.id),
  }));

  parts.push(renderRankedKey(keyEntries, 32, keyTop, width - 64), "</svg>");

  return parts.join("\n");
};

const renderReviewerCalibration = (
  rows: readonly ModelRoleSummary[],
  excludedTasks: readonly string[]
): string => {
  const width = 760;
  const plotH = 290;
  const left = 68;
  const right = width - 28;
  const top = 114;
  const bottom = top + plotH;
  const keyTop = bottom + 56;
  const height = keyTop + rankedKeyHeight(rows.length);
  const plotW = right - left;

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

  // Right = 0 false alarms (higher restraint) with breathing room past 0; Left = more false alarms.
  const minAlarms = -0.45;
  const alarmSpan = maxAlarms - minAlarms;

  const scaleX = (alarms: number): number =>
    left + ((maxAlarms - alarms) / alarmSpan) * plotW;

  const scaleY = (recallPct: number): number =>
    bottom - ((recallPct - minRecall) / Math.max(10, 112 - minRecall)) * plotH;

  const scaleR = (wallS: number): number =>
    11 + Math.sqrt(wallS / maxWall) * 11;

  const subtitle =
    excludedTasks.length > 0
      ? `Seeded defect recall vs. false-alarm restraint (2× P0–P2 + 1× P3) · excludes ${excludedTasks.length} uncalibrated task · bubble = med wall`
      : "Seeded defect recall vs. false-alarm restraint (2× P0–P2 + 1× P3) · bubble size = median wall time";

  const parts: string[] = [
    svgHeader(width, height, "Code Reviewer Calibration Quadrant", subtitle),
  ];

  const providers = [...new Set(rows.map((row) => row.provider))].toSorted();
  parts.push(providerLegend(providers, left + 4, 92));

  // Top-right target quadrant highlight.
  const qx = scaleX(1.5);
  const qy = scaleY(95);
  parts.push(
    `<rect x="${qx.toFixed(1)}" y="${top}" width="${(right - qx).toFixed(1)}" height="${(qy - top).toFixed(1)}" fill="var(--c-quadrant)"/>`,
    `<line x1="${qx.toFixed(1)}" y1="${top}" x2="${qx.toFixed(1)}" y2="${bottom}" stroke="var(--c-axis)" stroke-width="1" stroke-dasharray="4 4"/>`,
    `<line x1="${left}" y1="${qy.toFixed(1)}" x2="${right}" y2="${qy.toFixed(1)}" stroke="var(--c-axis)" stroke-width="1" stroke-dasharray="4 4"/>`,
    `<text x="${(right - 22).toFixed(1)}" y="${(top + 18).toFixed(1)}" text-anchor="end" fill="var(--c-text)" font-family="${FONT_SANS}" font-size="11.5" font-weight="600">High Recall + High Restraint</text>`,
    `<g stroke="var(--c-text)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"><line x1="${(right - 17).toFixed(1)}" y1="${(top + 17).toFixed(1)}" x2="${(right - 10).toFixed(1)}" y2="${(top + 10).toFixed(1)}"/><polyline points="${(right - 15.5).toFixed(1)},${(top + 10).toFixed(1)} ${(right - 10).toFixed(1)},${(top + 10).toFixed(1)} ${(right - 10).toFixed(1)},${(top + 15.5).toFixed(1)}"/></g>`,
    `<text x="${(left + 10).toFixed(1)}" y="${(top + 18).toFixed(1)}" fill="var(--c-muted)" font-family="${FONT_SANS}" font-size="11.5">High Recall, Noisy</text>`,
    `<text x="${(right - 10).toFixed(1)}" y="${(bottom - 10).toFixed(1)}" text-anchor="end" fill="var(--c-subtle)" font-family="${FONT_SANS}" font-size="11.5">Clean, Under-Sensitive</text>`
  );

  for (const yTick of linearTicks(minRecall, 100, 5)) {
    const py = scaleY(yTick);
    parts.push(
      `<line x1="${left}" y1="${py.toFixed(1)}" x2="${right}" y2="${py.toFixed(1)}" stroke="var(--c-grid)" stroke-width="1"/>`,
      `<text x="${left - 10}" y="${(py + 4).toFixed(1)}" text-anchor="end" fill="var(--c-muted)" font-family="${FONT_MONO}" font-size="12">${yTick.toFixed(0)}%</text>`
    );
  }

  for (let alarms = 0; alarms <= maxAlarms; alarms += 1) {
    const px = scaleX(alarms);
    parts.push(
      `<line x1="${px.toFixed(1)}" y1="${top}" x2="${px.toFixed(1)}" y2="${bottom}" stroke="var(--c-grid)" stroke-width="1"/>`,
      `<text x="${px.toFixed(1)}" y="${bottom + 21}" text-anchor="middle" fill="var(--c-muted)" font-family="${FONT_MONO}" font-size="12">${alarms}</text>`
    );
  }

  parts.push(
    `<line x1="${left}" y1="${top}" x2="${left}" y2="${bottom}" stroke="var(--c-axis)" stroke-width="1"/>`,
    `<line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="var(--c-axis)" stroke-width="1"/>`,
    `<text x="${(left + right) / 2}" y="${bottom + 42}" text-anchor="middle" fill="var(--c-muted)" font-family="${FONT_SANS}" font-size="12.5">Weighted False Alarms (2× P0–P2 + 1× P3 — right is cleaner)</text>`,
    `<text x="20" y="${(top + bottom) / 2}" text-anchor="middle" fill="var(--c-muted)" font-family="${FONT_SANS}" font-size="12.5" transform="rotate(-90 20 ${(top + bottom) / 2})">Seeded Defect Recall (%)</text>`
  );

  const badgeR = 10;

  const rawPoints = rows.map((row) => ({
    x: scaleX(row.weightedFalseAlarms),
    y: scaleY((row.defectRecall ?? 1) * 100),
  }));

  const placed = separatePoints(
    rawPoints,
    {
      x1: left + 20,
      y1: top + 34,
      x2: right - 22,
      y2: bottom - 22,
    },
    26
  );

  // Layer 1: Translucent wall-time bubbles.
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    const pt = placed[i];

    if (row === undefined || pt === undefined) {
      continue;
    }

    const r = scaleR(row.medianWallS);
    const color = providerVar(row.provider);
    parts.push(
      `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${r.toFixed(1)}" fill="${color}" fill-opacity="0.16" stroke="${color}" stroke-width="1.5" stroke-opacity="0.55"/>`
    );
  }

  // Layer 2: Numbered badges centered in each bubble.
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    const pt = placed[i];

    if (row === undefined || pt === undefined) {
      continue;
    }

    const recallPct = (row.defectRecall ?? 1) * 100;
    const displayName = displayModelLabel(row.model);
    const tip = `${displayName} | LSAS ${row.lsas.toFixed(1)} | Recall ${recallPct.toFixed(1)}% | FP ${row.falsePositiveP0P2}, P3 ${row.nitpickP3} | Wall ${row.medianWallS.toFixed(1)}s | Cost $${row.totalCostUsd.toFixed(2)}`;

    parts.push(
      `<g class="chart-point" data-tip="${esc(tip)}">${renderNumberedBadge(pt.x, pt.y, i + 1, row.provider, badgeR, false)}</g>`
    );
  }

  // 2-column ranked key below the X-axis.
  const keyEntries: RankedKeyEntry[] = rows.map((row, idx) => {
    const recallPct = (row.defectRecall ?? 1) * 100;

    return {
      rank: idx + 1,
      provider: row.provider,
      label: displayModelLabel(row.model),
      metric: `${recallPct.toFixed(0)}% · ${row.medianWallS.toFixed(0)}s`,
      emphasized: row.weightedFalseAlarms <= 1.5 && recallPct >= 95,
    };
  });

  parts.push(renderRankedKey(keyEntries, 32, keyTop, width - 64), "</svg>");

  return parts.join("\n");
};

const renderFailureTaxonomy = (summary: BenchmarkSummary): string => {
  interface TaxonomyRow {
    readonly section: string;
    readonly provider: string;
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
        provider: row.provider,
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
        provider: row.provider,
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
      provider: row.provider,
      label: displayModelLabel(row.model),
      scoreLabel: `LSAS ${row.lsas.toFixed(1)}`,
      total: row.trials,
      counts: row.tierCounts,
    });
  }

  const width = 760;
  const rowH = 36;
  const sectionGap = 30;
  const sections = new Set(rows.map((row) => row.section)).size;
  const top = 114;
  const height = top + rows.length * rowH + sections * sectionGap + 34;
  const labelLeft = 52;
  const barLeft = 242;
  const barRight = width - 98;
  const barW = barRight - barLeft;

  const parts: string[] = [
    svgHeader(
      width,
      height,
      "Low-Steering Babysitting & Failure Taxonomy",
      "Share of trials by outcome tier — clean passes vs. friction, nudges, broken deliverables, and timeouts"
    ),
  ];

  // Single-row compact legend.
  let legendX = 32;

  for (const tier of TIER_META) {
    parts.push(
      `<rect x="${legendX}" y="79" width="12" height="12" rx="3" fill="${tier.fillVar}"/>`,
      `<text x="${legendX + 17}" y="89.5" fill="var(--c-muted)" font-family="${FONT_SANS}" font-size="12">${esc(tier.label)}</text>`
    );
    legendX += tier.label.length * 6.8 + 34;
  }

  let cursorY = top;
  let lastSection = "";

  for (const row of rows) {
    if (row.section !== lastSection) {
      if (lastSection !== "") {
        cursorY += 12;
      }

      parts.push(
        `<text x="32" y="${cursorY + 13}" fill="var(--c-muted)" font-family="${FONT_SANS}" font-size="11.5" font-weight="600" letter-spacing="0.06em">${esc(row.section.toUpperCase())}</text>`
      );
      cursorY += sectionGap;
      lastSection = row.section;
    }

    parts.push(
      renderLabIcon(row.provider, 32, cursorY + 7.5, 13),
      `<text x="${labelLeft}" y="${cursorY + 18}" fill="var(--c-text)" font-family="${FONT_SANS}" font-size="12.5">${esc(row.label)}</text>`
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
        `<rect class="chart-point" data-tip="${esc(tip)}" x="${segX.toFixed(1)}" y="${cursorY + 3}" width="${Math.max(1, segW - 1.5).toFixed(1)}" height="21" rx="3.5" fill="${tier.fillVar}"/>`
      );

      if (segW >= 24) {
        parts.push(
          `<text x="${(segX + segW / 2).toFixed(1)}" y="${cursorY + 17}" text-anchor="middle" fill="${tier.inkVar}" font-family="${FONT_MONO}" font-size="11.5" font-weight="600">${count}</text>`
        );
      }

      segX += segW;
    }

    parts.push(
      `<text x="${barRight + 10}" y="${cursorY + 18}" fill="var(--c-muted)" font-family="${FONT_MONO}" font-size="12">${esc(row.scoreLabel)}</text>`
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

  const labelRight = 216;
  const colStart = 230;
  const width = Math.max(760, colStart + 28 + reviewers.length * 250);
  const rowH = 64;

  const colW = Math.floor(
    (width - colStart - 28) / Math.max(1, reviewers.length)
  );

  const top = 116;
  const height = top + coders.length * rowH + 62;

  const parts: string[] = [
    svgHeader(
      width,
      height,
      "Phase 3 Coder × Reviewer Synergy Matrix",
      "Status dot = Pair LSAS tier · Pair LSAS, strict Pass@1, cost, and median wall time per pairing"
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
      `<text x="${x.toFixed(1)}" y="98" text-anchor="middle" fill="var(--c-text)" font-family="${FONT_SANS}" font-size="12.5" font-weight="600">Reviewer: ${esc(displayModelLabel(reviewer))}</text>`
    );
  }

  for (let row = 0; row < coders.length; row += 1) {
    const coder = coders[row];

    if (coder === undefined) {
      continue;
    }

    const y = top + row * rowH;
    const coderProvider = coder.split("/")[0] ?? "other";
    parts.push(
      renderLabIcon(coderProvider, 32, y + 25, 13),
      `<text x="52" y="${y + 36}" fill="var(--c-text)" font-family="${FONT_SANS}" font-size="12.5" font-weight="500">${esc(displayModelLabel(coder))}</text>`
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
          `<rect x="${x + 6}" y="${y + 6}" width="${colW - 12}" height="${rowH - 12}" rx="8" fill="var(--c-muted-bg)" stroke="var(--c-border)" stroke-width="1"/>`,
          `<text x="${(x + colW / 2).toFixed(1)}" y="${y + 36}" text-anchor="middle" fill="var(--c-subtle)" font-family="${FONT_MONO}" font-size="12">—</text>`
        );
        continue;
      }

      const accent = matrixAccentVar(cell.lsas);
      const tip = `${displayModelLabel(coder)} → ${displayModelLabel(reviewer)} | LSAS ${cell.lsas.toFixed(1)} | Pass ${cell.passedCount}/${cell.trials} | ZSDR ${(100 * cell.zsdrRate).toFixed(0)}% | Cost $${cell.totalCostUsd.toFixed(2)} | Med wall ${cell.medianWallS.toFixed(1)}s`;
      parts.push(
        `<g class="chart-point" data-tip="${esc(tip)}">`,
        `<rect x="${x + 6}" y="${y + 6}" width="${colW - 12}" height="${rowH - 12}" rx="8" fill="var(--c-muted-bg)" stroke="var(--c-border)" stroke-width="1"/>`,
        `<circle cx="${x + 20}" cy="${y + 24}" r="4" fill="${accent}"/>`,
        `<text x="${(x + colW / 2 + 6).toFixed(1)}" y="${y + 28}" text-anchor="middle" fill="var(--c-text)" font-family="${FONT_MONO}" font-size="13" font-weight="600">LSAS ${cell.lsas.toFixed(1)} · ${cell.passedCount}/${cell.trials}</text>`,
        `<text x="${(x + colW / 2 + 6).toFixed(1)}" y="${y + 46}" text-anchor="middle" fill="var(--c-muted)" font-family="${FONT_MONO}" font-size="11.5">$${cell.totalCostUsd.toFixed(2)} · med ${cell.medianWallS.toFixed(1)}s</text>`,
        "</g>"
      );
    }
  }

  // Footer totals per reviewer.
  const dividerY = top + coders.length * rowH + 10;
  const footerY = dividerY + 26;
  parts.push(
    `<line x1="${colStart + 6}" y1="${dividerY}" x2="${width - 34}" y2="${dividerY}" stroke="var(--c-border)" stroke-width="1"/>`,
    `<text x="${labelRight}" y="${footerY}" text-anchor="end" fill="var(--c-muted)" font-family="${FONT_SANS}" font-size="12" font-weight="600">Reviewer total</text>`
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
      `<text x="${x.toFixed(1)}" y="${footerY}" text-anchor="middle" fill="var(--c-text)" font-family="${FONT_MONO}" font-size="11.5" font-weight="600">${passed}/${total} pass · $${cost.toFixed(2)} · ${Math.round(wall)}s</text>`
    );
  }

  parts.push("</svg>");

  return parts.join("\n");
};

interface HeatmapPanel {
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

const buildHeatmapPanels = (
  summary: BenchmarkSummary
): readonly HeatmapPanel[] => {
  const panels: HeatmapPanel[] = [];

  for (const [role, title] of [
    ["coder", "Phase 1 — Standalone Coder"],
    ["code-reviewer", "Phase 2 — Code Reviewer"],
    ["pair", "Phase 3 — Pair Collaboration"],
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

    const heading =
      role === "pair"
        ? `${title} (${tasks.length} tasks × ${models.length} pairs)`
        : `${title} (${tasks.length} tasks)`;

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

  return panels;
};

const renderTaskHeatmap = (summary: BenchmarkSummary): string => {
  const panels = buildHeatmapPanels(summary);

  const width = 940;
  const labelW = 256;
  const rowH = 28;
  let totalH = 114;

  for (const panel of panels) {
    const headerH = panel.isPair ? 112 : 88;
    totalH += 36 + headerH + panel.tasks.length * rowH + 22;
  }

  const parts: string[] = [
    svgHeader(
      width,
      totalH,
      "Diagnostic Task × Model Outcome Heatmap",
      "Every trial colored by its 5-tier outcome taxonomy and annotated with wall time (seconds)"
    ),
  ];

  // Compact legend.
  let legendX = 32;

  for (const tier of TIER_META) {
    parts.push(
      `<rect x="${legendX}" y="79" width="11" height="11" rx="2.5" fill="${tier.fillVar}"/>`,
      `<text x="${legendX + 16}" y="89" fill="var(--c-muted)" font-family="${FONT_SANS}" font-size="11.5">${esc(tier.label)}</text>`
    );
    legendX += tier.label.length * 6.8 + 32;
  }

  let y = 116;

  for (const panel of panels) {
    const headerH = panel.isPair ? 112 : 88;
    parts.push(
      `<text x="32" y="${y + 15}" fill="var(--c-text)" font-family="${FONT_SANS}" font-size="13.5" font-weight="600">${esc(panel.heading)}</text>`
    );
    y += 30;

    const rightMargin = panel.isPair ? 132 : 96;

    const colW = Math.min(
      76,
      Math.floor(
        (width - labelW - rightMargin) / Math.max(1, panel.models.length)
      )
    );

    // Angled model column labels.
    for (let col = 0; col < panel.models.length; col += 1) {
      const model = panel.models[col];

      if (model === undefined) {
        continue;
      }

      const headerLabel = panel.isPair
        ? model
            .split(" -> ")
            .map((part) => scatterModelLabel(part.trim()))
            .join(" → ")
        : scatterModelLabel(model);

      const cx = labelW + col * colW + colW / 2;
      const labelY = y + headerH - 8;
      parts.push(
        `<text x="${cx.toFixed(1)}" y="${labelY}" text-anchor="start" fill="var(--c-muted)" font-family="${FONT_SANS}" font-size="10" transform="rotate(-40 ${cx.toFixed(1)} ${labelY})">${esc(headerLabel)}</text>`
      );
    }

    y += headerH;

    for (const taskId of panel.tasks) {
      parts.push(
        `<text x="${labelW - 10}" y="${y + 17}" text-anchor="end" fill="var(--c-text)" font-family="${FONT_MONO}" font-size="10.5">${esc(taskId)}</text>`
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
            `<rect x="${cx + 1.5}" y="${y + 1.5}" width="${colW - 3}" height="${rowH - 3}" rx="4" fill="var(--c-muted-bg)" stroke="var(--c-border)" stroke-width="0.75"/>`
          );
          continue;
        }

        const tierColors = TIER_BY_KEY[outcome.tier];
        const tip = `${taskId} | ${displayModelLabel(model)} | ${outcome.tier.replaceAll("_", " ")} | LSAS ${outcome.lsas.toFixed(1)} | ${outcome.wallS.toFixed(1)}s`;
        parts.push(
          `<g class="chart-point" data-tip="${esc(tip)}">`,
          `<rect x="${cx + 1.5}" y="${y + 1.5}" width="${colW - 3}" height="${rowH - 3}" rx="4" fill="${tierColors.fillVar}"/>`
        );

        if (colW >= 34) {
          parts.push(
            `<text x="${(cx + colW / 2).toFixed(1)}" y="${y + 16.5}" text-anchor="middle" fill="${tierColors.inkVar}" font-family="${FONT_MONO}" font-size="9.5" font-weight="600">${Math.round(outcome.wallS)}s</text>`
          );
        }

        parts.push("</g>");
      }

      y += rowH;
    }

    y += 22;
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

  const width = 840;
  const rowH = 38;
  const top = 114;
  const height = top + rows.length * rowH + 58;
  const leftBarStart = 238;
  const leftBarW = 194;
  const rightBarStart = 602;
  const rightBarW = 144;

  const maxTok = Math.max(50, ...rows.map((row) => row.tokPerS * 1.15));
  const maxDiff = Math.max(1.5, ...rows.map((row) => row.diffRatio * 1.15));

  const parts: string[] = [
    svgHeader(
      width,
      height,
      "Inference Overhead & Diff Discipline (Coders)",
      "Left: Active throughput (tok/s, shaded reasoning share, cold TTFT) · Right: Passing diff size vs. task median"
    ),
  ];

  parts.push(
    `<text x="${leftBarStart}" y="96" fill="var(--c-text)" font-family="${FONT_SANS}" font-size="12.5" font-weight="600">Throughput (tok/s) &amp; Reasoning Share</text>`,
    `<text x="${rightBarStart}" y="96" fill="var(--c-text)" font-family="${FONT_SANS}" font-size="12.5" font-weight="600">Diff Size vs. Median</text>`
  );

  // 1.0x reference line on right panel.
  const refX = rightBarStart + (1 / maxDiff) * rightBarW;
  parts.push(
    `<line x1="${refX.toFixed(1)}" y1="${top - 6}" x2="${refX.toFixed(1)}" y2="${top + rows.length * rowH}" stroke="var(--c-axis)" stroke-width="1.2" stroke-dasharray="4 3"/>`,
    `<text x="${refX.toFixed(1)}" y="${top + rows.length * rowH + 17}" text-anchor="middle" fill="var(--c-muted)" font-family="${FONT_MONO}" font-size="11">1.0× median</text>`
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
      renderLabIcon(row.provider, 32, y + 9, 13),
      `<text x="52" y="${y + 20}" fill="var(--c-text)" font-family="${FONT_SANS}" font-size="12">${esc(displayName)}</text>`,
      `<g class="chart-point" data-tip="${esc(leftTip)}">`,
      `<rect x="${leftBarStart}" y="${y + 5}" width="${Math.max(2, barW).toFixed(1)}" height="21" rx="4" fill="${color}" fill-opacity="0.86"/>`,
      `<rect x="${leftBarStart}" y="${y + 5}" width="${Math.max(0, reasonW).toFixed(1)}" height="21" rx="4" fill="var(--c-reason-overlay)"/>`,
      `</g>`,
      `<text x="${(leftBarStart + barW + 8).toFixed(1)}" y="${y + 20}" fill="var(--c-muted)" font-family="${FONT_MONO}" font-size="11">${Math.round(row.tokPerS)} t/s · ${Math.round(row.reasoningShare * 100)}% R · ${coldText}</text>`
    );

    const diffW = (row.diffRatio / maxDiff) * rightBarW;

    let diffColor = "var(--d-balanced)";
    let diffTag = "balanced";

    if (row.diffRatio < 0.8) {
      diffColor = "var(--d-compressed)";
      diffTag = "compact";
    } else if (row.diffRatio > 1.2) {
      diffColor = "var(--d-verbose)";
      diffTag = "verbose";
    }

    const rightTip = `${displayName} | Median diff ${row.diffRatio.toFixed(2)}× task median (${diffTag})`;

    parts.push(
      `<g class="chart-point" data-tip="${esc(rightTip)}">`,
      `<rect x="${rightBarStart}" y="${y + 5}" width="${Math.max(2, diffW).toFixed(1)}" height="21" rx="4" fill="${diffColor}"/>`,
      `</g>`,
      `<text x="${(rightBarStart + diffW + 8).toFixed(1)}" y="${y + 20}" fill="var(--c-muted)" font-family="${FONT_MONO}" font-size="11">${row.diffRatio.toFixed(2)}× (${diffTag})</text>`
    );
  }

  parts.push(
    `<text x="${leftBarStart}" y="${height - 16}" fill="var(--c-subtle)" font-family="${FONT_SANS}" font-size="11">Shaded left bar = reasoning share (R) · Right number = cold TTFT</text>`,
    "</svg>"
  );

  return parts.join("\n");
};

export const renderBenchmarkCharts = (
  summary: BenchmarkSummary
): readonly GeneratedChart[] => {
  const charts: GeneratedChart[] = [];

  if (summary.combinedCoderRows.length > 0) {
    const trialCount = summary.combinedCoderRows[0]?.totalTrials ?? 0;

    const costItems: ScatterItem[] = summary.combinedCoderRows.map((row) => ({
      id: row.model,
      label: displayModelLabel(row.model),
      keyMetric: `${row.aci.toFixed(1)} · $${row.totalCostUsd.toFixed(2)}`,
      provider: row.provider,
      x: row.totalCostUsd,
      y: row.aci,
      tip: `${displayModelLabel(row.model)} | ACI ${row.aci.toFixed(1)} (Solo ${row.solo.lsas.toFixed(1)}, Pair ${row.pair.lsas.toFixed(1)}) | Pass ${row.passedCount}/${row.totalTrials} | ZSDR ${(100 * row.zsdrRate).toFixed(1)}% | Cost $${row.totalCostUsd.toFixed(2)} | Wall ${Math.round(row.totalWallS)}s`,
    }));

    charts.push({
      id: "coder-cost-pareto",
      filename: "coder-cost-pareto.svg",
      title: "Coder Autonomy vs. Cost Pareto Frontier",
      subtitle: `ACI (0.6× Solo + 0.4× Pair LSAS, ${trialCount} trials) vs. total suite cost (USD, log scale)`,
      category: "coder",
      svg: renderParetoScatter({
        title: "Coder Autonomy vs. Cost Pareto Frontier",
        subtitle: `ACI (0.6× Solo + 0.4× Pair LSAS, ${trialCount} trials) vs. total suite cost (USD, log scale)`,
        xLabel: `Total ${trialCount}-Trial API Cost (USD, log scale)`,
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
      keyMetric: `${row.aci.toFixed(1)} · ${(row.totalWallS / 60).toFixed(1)}m`,
      provider: row.provider,
      x: row.totalWallS / 60,
      y: row.aci,
      tip: `${displayModelLabel(row.model)} | ACI ${row.aci.toFixed(1)} | Total wall ${(row.totalWallS / 60).toFixed(1)} min (${Math.round(row.totalWallS)}s) | Med wall ${row.medianWallS.toFixed(1)}s | Cost $${row.totalCostUsd.toFixed(2)}`,
    }));

    charts.push({
      id: "coder-speed-pareto",
      filename: "coder-speed-pareto.svg",
      title: "Coder Autonomy vs. Wall-Clock Time Pareto Frontier",
      subtitle: `ACI (${trialCount} trials) vs. total end-to-end wall-clock time (minutes)`,
      category: "coder",
      svg: renderParetoScatter({
        title: "Coder Autonomy vs. Wall-Clock Time Pareto Frontier",
        subtitle: `ACI (${trialCount} trials) vs. total end-to-end wall-clock time (minutes)`,
        xLabel: `Total ${trialCount}-Trial Wall-Clock Time (minutes)`,
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
      keyMetric: `${row.lsas.toFixed(1)} · $${row.totalCostUsd.toFixed(2)}`,
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
        ? `calibrated ${summary.reviewerCalibratedRows[0]?.trials ?? 0} tasks`
        : `${summary.reviewerCalibratedRows[0]?.trials ?? 0} tasks`;

    const reviewerCostItems: ScatterItem[] = summary.reviewerCalibratedRows.map(
      (row) => ({
        id: row.label,
        label: displayModelLabel(row.model),
        keyMetric: `${row.lsas.toFixed(1)} · $${row.totalCostUsd.toFixed(2)}`,
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
