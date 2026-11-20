import { isSafeReviewerShellCommand } from "../driver/session-runner.ts";
import { isString } from "../util/json.ts";
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

const metadataBullet =
  /^(?:\*\*)?(?:location|file|line|lines|path|scenario|impact|cause|root cause|evidence|fix|correction|recommendation|remediation|details?|why|risk|context|scope|note)s?(?:\*\*)?\s*:/iu;

const locationMetadataLine =
  /^\s*(?:[-*+]\s+)?(?:\*\*)?(?:location|file|path)s?(?:\*\*)?\s*:/iu;

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
  let inSeverityHeading = false;

  const finishItem = (): void => {
    const body = item.join("\n").trim();

    if (body && !cleanFindingsBullet.test(body)) {
      findings.push({ body, severity: severityOf(body) });
    }

    item = [];
    itemIndent = null;
    inSeverityHeading = false;
  };

  for (const line of proseLines(markdown)) {
    const heading = parseMarkdownHeading(line);

    if (heading !== null) {
      finishItem();

      if (level && heading.level > level) {
        if (severityOf(heading.title) !== null) {
          item.push(heading.title);
          inSeverityHeading = true;
        }
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
      const headingDetail =
        inSeverityHeading &&
        severityOf(bullet.text) === null &&
        metadataBullet.test(bullet.text);

      if (
        isNestedBullet(item.length, itemIndent, bullet.indent) ||
        headingDetail
      ) {
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

interface Citation {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

const citations = (body: string, repoDir?: string): readonly Citation[] => {
  const pattern =
    /`(?<quotedPath>[^`\r\n]+?):(?<quotedStart>\d+)(?:[-–](?<quotedEnd>\d+)|:\d+)?`|(?:^|[\s([<"'])`?(?<barePath>[\w./~@%+-]+)`?:(?<bareStart>\d+)(?:[-–](?<bareEnd>\d+)|:\d+)?(?![\w/])/gu;

  const matches: Citation[] = [];

  for (const citation of body.matchAll(pattern)) {
    const path = citation.groups?.quotedPath ?? citation.groups?.barePath;

    if (path !== undefined && path.length > 0) {
      const startLine = Number(
        citation.groups?.quotedStart ?? citation.groups?.bareStart
      );

      const rawEnd = citation.groups?.quotedEnd ?? citation.groups?.bareEnd;
      const endLine = rawEnd === undefined ? startLine : Number(rawEnd);

      matches.push({
        path: normalizeReviewPath(path, repoDir),
        startLine: Math.min(startLine, endLine),
        endLine: Math.max(startLine, endLine),
      });
    }
  }

  return matches;
};

const primaryCitations = (
  body: string,
  repoDir?: string
): readonly Citation[] => {
  const lines = body.split(/\r?\n/u);
  const explicit: Citation[] = [];

  for (const line of lines) {
    if (locationMetadataLine.test(line)) {
      explicit.push(...citations(line, repoDir));
    }
  }

  if (explicit.length > 0) {
    return explicit;
  }

  const firstLine = lines[0] ?? "";
  const separator = /\s+(?:—|–|--)\s+|(?<![\w./~@%+-]):\s+/u.exec(firstLine);

  if (separator !== null) {
    const leadCitations = citations(
      firstLine.slice(0, separator.index),
      repoDir
    );

    if (leadCitations.length > 0) {
      return leadCitations;
    }
  }

  return citations(body, repoDir);
};

const matchesLocation = (
  cited: readonly Citation[],
  file: string,
  lineRange: readonly [number, number]
): boolean => {
  const [start, end] = lineRange;

  return cited.some(
    ({ path, startLine, endLine }) =>
      path === file && endLine >= start - 5 && startLine <= end + 5
  );
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

  const conceptsMatched = defect.conceptGroups.every((group) =>
    group.some((concept) => body.includes(concept.toLowerCase()))
  );

  if (!conceptsMatched) {
    return false;
  }

  const cited = primaryCitations(finding.body, repoDir);

  const locations = [
    { file: defect.file, lineRange: defect.lineRange },
    ...(defect.locations ?? []),
  ];

  if (defect.requireMultiFileCitation === true) {
    const allCited = citations(finding.body, repoDir);

    return (
      locations.some(({ file, lineRange }) =>
        matchesLocation(cited, file, lineRange)
      ) &&
      locations.every(({ file, lineRange }) =>
        matchesLocation(allCited, file, lineRange)
      )
    );
  }

  return locations.some(({ file, lineRange }) =>
    matchesLocation(cited, file, lineRange)
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

  const result = new Map<string, number>();

  for (const [index, defect] of assigned.entries()) {
    result.set(defect.id, index);
  }

  for (const defect of defects) {
    if (result.has(defect.id) || defect.allowBundledMatch !== true) {
      continue;
    }

    const shared = (candidates.get(defect) ?? []).find((index) => {
      const owner = assigned.get(index);

      return (
        owner !== undefined &&
        owner.allowBundledMatch === true &&
        owner.file === defect.file
      );
    });

    if (shared !== undefined) {
      result.set(defect.id, shared);
    }
  }

  return result;
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
  const input =
    "\\b(?:range|base(?:line)?|files?|file[- ]list|commits?|revisions?|refs?|shas?|diffs?|branch(?:es)?|worktree|working[- ]tree|scope)\\b";

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
  let severityOverstated = 0;

  for (const defect of spec.defects) {
    const matchedIndex = matches.get(defect.id);
    checks[`caught_${defect.id}`] = matchedIndex !== undefined;

    if (matchedIndex !== undefined && defect.maxUrgency !== undefined) {
      const matchedFinding = findings[matchedIndex];

      if (
        matchedFinding !== undefined &&
        matchedFinding.severity !== null &&
        matchedFinding.severity < defect.maxUrgency
      ) {
        severityOverstated += 1;
      }
    }
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
    !evidence.tools.some(
      ({ tool, status, input }) =>
        mutatingTools.has(tool) ||
        (tool === "shell" &&
          status === "completed" &&
          (input.background === true ||
            !isString(input.command) ||
            !isSafeReviewerShellCommand(input.command, {
              allowWorktreeDiff: true,
            })))
    );

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
    severityOverstated,
    pedantryFlags,
    defectRecall: spec.defects.length
      ? matches.size / spec.defects.length
      : null,
    precision: findings.length ? validFindings / findings.length : null,
    scopeBounced,
    reviewDiff,
  });
};
