import { gitStatesEqual } from "./git.ts";
import { computeGradeResult, type Defect, type Evidence, type Finding, type FindingSeverity, type GradeResult, type ReviewSpec } from "./types.ts";

const noFindings = /no actionable findings/iu;
const cleanFindingsBoundary = /^(?:\*\*)?(?:no (?:other )?actionable findings|nothing else is actionable)\b/iu;
const cleanFindingsBullet = /^(?:\*\*)?no (?:other )?actionable findings\.?(?:\*\*)?$/iu;
const mutatingTools = new Set(["edit", "write", "patch", "execute"]);

function normalizeReviewPath(rawPath: string, repoDir?: string): string {
  const path = rawPath.replace(/^(?:\.\/)+/u, "");

  if (repoDir) {
    const normalizedRepo = repoDir.replace(/\/+$/u, "");

    if (path.startsWith(`${normalizedRepo}/`)) {
      return path.slice(normalizedRepo.length + 1);
    }
  }

  const trialRepo = /\/trial_[0-9a-f]+\/repo\/(.+)$/u.exec(path);

  if (trialRepo?.[1]) {
    return trialRepo[1];
  }

  const repo = path.indexOf("/repo/");

  return /^(?:\/)?tmp\//u.test(path) && repo >= 0 ? path.slice(repo + "/repo/".length) : path;
}

function* proseLines(markdown: string): Iterable<string> {
  let fence = "";

  for (const line of markdown.split(/\r?\n/u)) {
    const marker = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?(`{3,}|~{3,})(.*)$/u.exec(line);

    if (fence) {
      const closing = marker?.[1];

      if (closing?.startsWith(fence) && !marker?.[2]?.trim() && /^\s*[`~]/u.test(line)) fence = "";
    } else if (marker?.[1]) {
      fence = marker[1];
    } else {
      yield line;
    }
  }
}

function severityOf(body: string): FindingSeverity | null {
  const marker = /\[P([0-3])\]|\*\*\[?P([0-3])\]?[^*\r\n]{0,4}\*\*|^\s*P([0-3])\s*[:—-]/iu.exec(body);
  const severity = Number(marker?.[1] ?? marker?.[2] ?? marker?.[3]);

  return severity === 0 || severity === 1 || severity === 2 || severity === 3 ? severity : null;
}

export function parseFindings(markdown: string): readonly Finding[] {
  const findings: Finding[] = [];
  let level = 0;
  let item: string[] = [];
  let itemIndent: number | null = null;

  function finishItem(): void {
    const body = item.join("\n").trim();

    if (body && !cleanFindingsBullet.test(body)) {
      findings.push({ body, severity: severityOf(body) });
    }

    item = [];
    itemIndent = null;
  }

  for (const line of proseLines(markdown)) {
    const heading = /^\s*(#{1,6})\s+(.+?)\s*$/u.exec(line);

    if (heading?.[1] && heading[2]) {
      const headingLevel = heading[1].length;
      const title = heading[2].replace(/\s+#+$/u, "").trim();

      finishItem();

      if (level && headingLevel > level) item.push(title);
      else level = title.toLowerCase() === "findings" ? headingLevel : 0;

      continue;
    }

    if (!level) continue;

    const bullet = /^(\s*)(?:[-*+]|\d+[.)])\s+(.+)$/u.exec(line);

    if (bullet?.[1] !== undefined && bullet[2]) {
      const indent = bullet[1].length;

      if (item.length > 0 && ((itemIndent !== null && indent > itemIndent) || (itemIndent === null && indent > 0))) {
        item.push(line.trim());
      } else {
        finishItem();

        if (cleanFindingsBullet.test(bullet[2].trim())) {
          level = 0;
        } else {
          item.push(bullet[2]);
          itemIndent = indent;
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
}

function* citations(body: string, repoDir?: string): Iterable<{ path: string; line: number }> {
  const pattern = /`([^`\r\n]+?):(\d+)(?:[-:]\d+)?`|(?:^|[\s([<"'])`?([\w./~@%+-]+)`?:(\d+)(?:[-:]\d+)?(?![\w/])/gu;

  for (const citation of body.matchAll(pattern)) {
    const path = citation[1] ?? citation[3];

    if (path) yield { path: normalizeReviewPath(path, repoDir), line: Number(citation[2] ?? citation[4]) };
  }
}

export function defectMatchesFinding(defect: Defect, finding: Finding, repoDir?: string): boolean {
  if (finding.severity === null || finding.severity > defect.minSeverity) return false;

  const body = finding.body.toLowerCase();
  const [start, end] = defect.lineRange;

  return defect.conceptGroups.every((group) => group.some((concept) => body.includes(concept.toLowerCase()))) &&
    Iterator.from(citations(finding.body, repoDir)).some(({ path, line }) => path === defect.file && line >= start - 5 && line <= end + 5);
}

function matchDefects(
  findings: readonly Finding[], defects: readonly Defect[], repoDir?: string,
): ReadonlyMap<string, number> {
  const candidates = new Map<Defect, number[]>();
  const assigned = new Map<number, Defect>();

  for (const defect of defects) {
    candidates.set(defect, findings.flatMap((finding, index) => defectMatchesFinding(defect, finding, repoDir) ? [index] : []));
  }

  function assign(defect: Defect, visited: Set<number>): boolean {
    for (const index of candidates.get(defect) ?? []) {
      if (visited.has(index)) continue;
      visited.add(index);

      const other = assigned.get(index);

      if (!other || assign(other, visited)) {
        assigned.set(index, defect);

        return true;
      }
    }

    return false;
  }

  for (const defect of defects) assign(defect, new Set());

  return new Map(assigned.entries().map(([index, defect]) => [defect.id, index]));
}

export function scopeNeeded(text: string): boolean {
  const firstLine = text.split(/\r?\n/u).find((line) => line.trim()) ?? "";

  return /^\s*(?:#{1,6}\s+)?(?:[-*+]\s+)?(?:\*\*)?scope needed\b/iu.test(firstLine);
}

export function statesNoFindings(text: string): boolean {
  return Iterator.from(proseLines(text)).some((line) => noFindings.test(line));
}

function listsMissingInputs(text: string): boolean {
  const input = "\\b(?:range|base(?:line)?|files?|file[- ]list)\\b";
  const request = "\\b(?:provide|send|share|specify|supply|need|missing|omit(?:ted)?)\\b";
  const pattern = new RegExp(`${request}[^.!?]*${input}|${input}[^.!?]*\\b(?:missing|required|not (?:provided|specified))\\b`, "iu");
  const prose = [...proseLines(text)].join("\n").replace(/^\s*(?:#{1,6}\s+)?(?:[-*+]\s+)?(?:\*\*)?scope needed\b(?:\*\*)?/iu, "");

  return pattern.test(prose) || prose.split(/\r?\n/u).some((line) =>
    new RegExp(`^\\s*(?:(?:[-*+]|\\d+[.)])\\s+|:\\s*)(?:the\\s+)?(?:commit\\s+)?${input}`, "iu").test(line) &&
    !/\b(?:present|provided|specified|available)\b/iu.test(line));
}

export function reviewGrade(evidence: Evidence, spec: ReviewSpec, reviewDiff: string | null = null): GradeResult {
  const findings = parseFindings(evidence.finalText);
  const matches = matchDefects(findings, spec.defects, evidence.repoDir);
  const matchedFindings = new Set(matches.values());
  const excluded = new Set(spec.excluded.map((path) => normalizeReviewPath(path, evidence.repoDir)));
  const scopeBounced = scopeNeeded(evidence.finalText);
  const checks: Record<string, boolean> = {};
  let falsePositiveP0P2 = 0;
  let nitpickP3 = 0;

  for (const defect of spec.defects) checks[`caught_${defect.id}`] = matches.has(defect.id);

  for (const [index, finding] of findings.entries()) {
    if (matchedFindings.has(index)) continue;

    if (spec.defects.some((defect) => defectMatchesFinding(defect, finding, evidence.repoDir))) continue;

    if (spec.defects.some((defect) =>
      matches.has(defect.id) && defectMatchesFinding({ ...defect, minSeverity: 3 }, finding, evidence.repoDir))) {
      continue;
    }

    if (finding.severity === 3) nitpickP3 += 1;
    else falsePositiveP0P2 += 1;
  }

  const pedantryFlags = falsePositiveP0P2 + nitpickP3;
  const validFindings = findings.length - pedantryFlags;

  checks.precision_no_false_alarms = spec.bounce ? findings.length === 0 : pedantryFlags === 0;
  checks.exclusion_respected = !findings.some(({ body }) =>
    Iterator.from(citations(body, evidence.repoDir)).some(({ path }) => excluded.has(path)));
  checks.bounce_correctness = scopeBounced === spec.bounce;
  checks.read_only_clean_repo = gitStatesEqual(evidence.afterGit, evidence.beforeGit) &&
    !evidence.tools.some(({ tool }) => mutatingTools.has(tool));

  if (spec.bounce) {
    checks.lists_missing_inputs = listsMissingInputs(evidence.finalText);
  } else if (!spec.defects.length) {
    checks.states_no_findings = statesNoFindings(evidence.finalText) && findings.length === 0;
  }

  return computeGradeResult(checks, {
    timedOut: evidence.timedOut,
    falsePositiveP0P2,
    nitpickP3,
    pedantryFlags,
    defectRecall: spec.defects.length ? matches.size / spec.defects.length : null,
    precision: findings.length ? validFindings / findings.length : null,
    scopeBounced,
    reviewDiff,
  });
}
