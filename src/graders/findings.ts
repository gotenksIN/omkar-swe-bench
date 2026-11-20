import { gitStatesEqual } from "./git.ts";
import { computeGradeResult } from "./types.ts";
import type {
  Defect,
  Evidence,
  Finding,
  FindingSeverity,
  GradeResult,
  ReviewSpec,
} from "./types.ts";

const noFindings = /no actionable findings/iu;

const cleanFindingsBoundary =
  /^(?:\*\*)?(?:no (?:other )?actionable findings|nothing else is actionable)\b/iu;

const cleanFindingsBullet =
  /^(?:\*\*)?no (?:other )?actionable findings\.?(?:\*\*)?$/iu;

const mutatingTools = new Set(["edit", "write", "patch", "execute"]);

const normalizeReviewPath = (rawPath: string, repoDir?: string): string => {
  const path = rawPath.replace(/^(?:\.\/)+/u, "");

  if (repoDir !== undefined && repoDir.length > 0) {
    const normalizedRepo = repoDir.replace(/\/+$/u, "");

    if (path.startsWith(`${normalizedRepo}/`)) {
      return path.slice(normalizedRepo.length + 1);
    }
  }

  const trialRepo = /\/trial_[0-9a-f]+\/repo\/(?<relative>.+)$/u.exec(path);
  const trialRelative = trialRepo?.groups?.relative;

  if (trialRelative !== undefined && trialRelative.length > 0) {
    return trialRelative;
  }

  const repo = path.indexOf("/repo/");

  return /^(?:\/)?tmp\//u.test(path) && repo !== -1
    ? path.slice(repo + "/repo/".length)
    : path;
};

const proseLines = (markdown: string): string[] => {
  const lines: string[] = [];
  let fence = "";

  for (const line of markdown.split(/\r?\n/u)) {
    const marker =
      /^\s*(?:(?:[-*+]|\d+[.)])\s+)?(?<fence>`{3,}|~{3,})(?<rest>.*)$/u.exec(
        line
      );

    const markerFence = marker?.groups?.fence;
    const markerRest = marker?.groups?.rest;

    if (fence) {
      if (
        markerFence?.startsWith(fence) === true &&
        (markerRest === undefined || markerRest.trim().length === 0) &&
        /^\s*[`~]/u.test(line)
      ) {
        fence = "";
      }
    } else if (markerFence !== undefined && markerFence.length > 0) {
      fence = markerFence;
    } else {
      lines.push(line);
    }
  }

  return lines;
};

const severityOf = (body: string): FindingSeverity | null => {
  const marker =
    /\[P(?<bracket>[0-3])\]|\*\*\[?P(?<bold>[0-3])\]?[^*\r\n]{0,4}\*\*|^\s*P(?<lead>[0-3])\s*[:—-]/iu.exec(
      body
    );

  const severity = Number(
    marker?.groups?.bracket ?? marker?.groups?.bold ?? marker?.groups?.lead
  );

  return severity === 0 || severity === 1 || severity === 2 || severity === 3
    ? severity
    : null;
};

const isNestedBullet = (
  itemLength: number,
  itemIndent: number | null,
  indent: number
): boolean =>
  itemLength > 0 &&
  ((itemIndent !== null && indent > itemIndent) ||
    (itemIndent === null && indent > 0));

const parseMarkdownHeading = (
  line: string
): { readonly level: number; readonly title: string } | null => {
  const heading = /^\s*(?<hashes>#{1,6})\s+(?<title>.+?)\s*$/u.exec(line);
  const hashes = heading?.groups?.hashes;
  const title = heading?.groups?.title;

  if (
    hashes === undefined ||
    hashes.length === 0 ||
    title === undefined ||
    title.length === 0
  ) {
    return null;
  }

  return {
    level: hashes.length,
    title: title.replace(/\s+#+$/u, "").trim(),
  };
};

const parseMarkdownBullet = (
  line: string
): { readonly indent: number; readonly text: string } | null => {
  const bullet = /^(?<indent>\s*)(?:[-*+]|\d+[.)])\s+(?<text>.+)$/u.exec(line);
  const indent = bullet?.groups?.indent;
  const text = bullet?.groups?.text;

  if (indent === undefined || text === undefined || text.length === 0) {
    return null;
  }

  return { indent: indent.length, text };
};

export const parseFindings = (markdown: string): readonly Finding[] => {
  const findings: Finding[] = [];
  let level = 0;
  let item: string[] = [];
  let itemIndent: number | null = null;

  const finishItem = (): void => {
    const body = item.join("\n").trim();

    if (body && !cleanFindingsBullet.test(body)) {
      findings.push({ body, severity: severityOf(body) });
    }

    item = [];
    itemIndent = null;
  };

  for (const line of proseLines(markdown)) {
    const heading = parseMarkdownHeading(line);

    if (heading !== null) {
      finishItem();

      if (level && heading.level > level) {
        item.push(heading.title);
      } else {
        level = heading.title.toLowerCase() === "findings" ? heading.level : 0;
      }

      continue;
    }

    if (!level) {
      continue;
    }

    const bullet = parseMarkdownBullet(line);

    if (bullet !== null) {
      if (isNestedBullet(item.length, itemIndent, bullet.indent)) {
        item.push(line.trim());
      } else {
        finishItem();

        if (cleanFindingsBullet.test(bullet.text.trim())) {
          level = 0;
        } else {
          item.push(bullet.text);
          itemIndent = bullet.indent;
        }
      }
    } else if (!/^\s/u.test(line) && cleanFindingsBoundary.test(line)) {
      finishItem();
      level = 0;
    } else if (item.length) {
      item.push(line.trim());
    }
  }

  finishItem();

  return findings;
};

const citations = (
  body: string,
  repoDir?: string
): readonly { path: string; line: number }[] => {
  const pattern =
    /`(?<quotedPath>[^`\r\n]+?):(?<quotedLine>\d+)(?:[-:]\d+)?`|(?:^|[\s([<"'])`?(?<barePath>[\w./~@%+-]+)`?:(?<bareLine>\d+)(?:[-:]\d+)?(?![\w/])/gu;

  const matches: { path: string; line: number }[] = [];

  for (const citation of body.matchAll(pattern)) {
    const path = citation.groups?.quotedPath ?? citation.groups?.barePath;

    if (path !== undefined && path.length > 0) {
      matches.push({
        path: normalizeReviewPath(path, repoDir),
        line: Number(citation.groups?.quotedLine ?? citation.groups?.bareLine),
      });
    }
  }

  return matches;
};

export const defectMatchesFinding = (
  defect: Defect,
  finding: Finding,
  repoDir?: string
): boolean => {
  if (finding.severity === null || finding.severity > defect.minSeverity) {
    return false;
  }

  const body = finding.body.toLowerCase();
  const [start, end] = defect.lineRange;

  return (
    defect.conceptGroups.every((group) =>
      group.some((concept) => body.includes(concept.toLowerCase()))
    ) &&
    Iterator.from(citations(finding.body, repoDir)).some(
      ({ path, line }) =>
        path === defect.file && line >= start - 5 && line <= end + 5
    )
  );
};

const matchDefects = (
  findings: readonly Finding[],
  defects: readonly Defect[],
  repoDir?: string
): ReadonlyMap<string, number> => {
  const candidates = new Map<Defect, number[]>();
  const assigned = new Map<number, Defect>();

  for (const defect of defects) {
    candidates.set(
      defect,
      findings.flatMap((finding, index) =>
        defectMatchesFinding(defect, finding, repoDir) ? [index] : []
      )
    );
  }

  const assign = (defect: Defect, visited: Set<number>): boolean => {
    for (const index of candidates.get(defect) ?? []) {
      if (visited.has(index)) {
        continue;
      }

      visited.add(index);

      const other = assigned.get(index);

      if (!other || assign(other, visited)) {
        assigned.set(index, defect);

        return true;
      }
    }

    return false;
  };

  for (const defect of defects) {
    assign(defect, new Set());
  }

  return new Map(
    assigned.entries().map(([index, defect]) => [defect.id, index])
  );
};

export const scopeNeeded = (text: string): boolean => {
  const firstLine = text.split(/\r?\n/u).find((line) => line.trim()) ?? "";

  return /^\s*(?:#{1,6}\s+)?(?:[-*+]\s+)?(?:\*\*)?scope needed\b/iu.test(
    firstLine
  );
};

export const statesNoFindings = (text: string): boolean =>
  Iterator.from(proseLines(text)).some((line) => noFindings.test(line));

const listsMissingInputs = (text: string): boolean => {
  const input = "\\b(?:range|base(?:line)?|files?|file[- ]list)\\b";

  const request =
    "\\b(?:provide|send|share|specify|supply|need|missing|omit(?:ted)?)\\b";

  const pattern = new RegExp(
    `${request}[^.!?]*${input}|${input}[^.!?]*\\b(?:missing|required|not (?:provided|specified))\\b`,
    "iu"
  );

  const prose = [...proseLines(text)]
    .join("\n")
    .replace(
      /^\s*(?:#{1,6}\s+)?(?:[-*+]\s+)?(?:\*\*)?scope needed\b(?:\*\*)?/iu,
      ""
    );

  return (
    pattern.test(prose) ||
    prose
      .split(/\r?\n/u)
      .some(
        (line) =>
          new RegExp(
            `^\\s*(?:(?:[-*+]|\\d+[.)])\\s+|:\\s*)(?:the\\s+)?(?:commit\\s+)?${input}`,
            "iu"
          ).test(line) &&
          !/\b(?:present|provided|specified|available)\b/iu.test(line)
      )
  );
};

export const reviewGrade = (
  evidence: Evidence,
  spec: ReviewSpec,
  reviewDiff: string | null = null
): GradeResult => {
  const findings = parseFindings(evidence.finalText);
  const matches = matchDefects(findings, spec.defects, evidence.repoDir);
  const matchedFindings = new Set(matches.values());

  const excluded = new Set(
    spec.excluded.map((path) => normalizeReviewPath(path, evidence.repoDir))
  );

  const scopeBounced = scopeNeeded(evidence.finalText);
  const checks: Record<string, boolean> = {};
  let falsePositiveP0P2 = 0;
  let nitpickP3 = 0;

  for (const defect of spec.defects) {
    checks[`caught_${defect.id}`] = matches.has(defect.id);
  }

  for (const [index, finding] of findings.entries()) {
    if (matchedFindings.has(index)) {
      continue;
    }

    if (
      spec.defects.some((defect) =>
        defectMatchesFinding(defect, finding, evidence.repoDir)
      )
    ) {
      continue;
    }

    if (
      spec.defects.some(
        (defect) =>
          matches.has(defect.id) &&
          defectMatchesFinding(
            { ...defect, minSeverity: 3 },
            finding,
            evidence.repoDir
          )
      )
    ) {
      continue;
    }

    if (finding.severity === 3) {
      nitpickP3 += 1;
    } else {
      falsePositiveP0P2 += 1;
    }
  }

  const pedantryFlags = falsePositiveP0P2 + nitpickP3;
  const validFindings = findings.length - pedantryFlags;

  checks.precision_no_false_alarms = spec.bounce
    ? findings.length === 0
    : pedantryFlags === 0;
  checks.exclusion_respected = !findings.some(({ body }) =>
    Iterator.from(citations(body, evidence.repoDir)).some(({ path }) =>
      excluded.has(path)
    )
  );
  checks.bounce_correctness = scopeBounced === spec.bounce;
  checks.read_only_clean_repo =
    gitStatesEqual(evidence.afterGit, evidence.beforeGit) &&
    !evidence.tools.some(({ tool }) => mutatingTools.has(tool));

  if (spec.bounce) {
    checks.lists_missing_inputs = listsMissingInputs(evidence.finalText);
  } else if (!spec.defects.length) {
    checks.states_no_findings =
      statesNoFindings(evidence.finalText) && findings.length === 0;
  }

  return computeGradeResult(checks, {
    timedOut: evidence.timedOut,
    falsePositiveP0P2,
    nitpickP3,
    pedantryFlags,
    defectRecall: spec.defects.length
      ? matches.size / spec.defects.length
      : null,
    precision: findings.length ? validFindings / findings.length : null,
    scopeBounced,
    reviewDiff,
  });
};
