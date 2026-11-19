import { unwrapSimpleCommand, type ParsedShellScript } from "../ast/bash.ts";
import type { JsonObject } from "../util/json.ts";

export type TaskRole = "coder" | "code-reviewer" | "pair";

export type TaskLanguage = "python" | "typescript" | "git" | "mixed";

export type FindingSeverity = 0 | 1 | 2 | 3;

export interface Defect {
  readonly id: string;
  readonly file: string;
  readonly lineRange: readonly [number, number];
  readonly minSeverity: FindingSeverity;
  readonly conceptGroups: readonly (readonly string[])[];
  readonly description: string;
}

export interface Finding {
  readonly severity: FindingSeverity | null;
  readonly body: string;
}

export interface ReviewSpec {
  readonly defects: readonly Defect[];
  readonly excluded: readonly string[];
  readonly bounce: boolean;
}

export interface GitState {
  readonly head: string;
  readonly committed: string;
  readonly staged: string;
  readonly unstaged: string;
  readonly untracked: readonly (readonly [path: string, digest: string])[];
  readonly changedFiles: ReadonlySet<string>;
}

export interface ToolTraceEntry {
  readonly index: number;
  readonly sessionId: string;
  readonly isSubagent: boolean;
  readonly tool: string;
  readonly status: "pending" | "running" | "completed" | "error";
  readonly input: JsonObject;
  readonly textOutput: string;
  readonly errorText: string | null;
  readonly metadata: JsonObject | null;
}

export interface ShellRunTrace {
  readonly index: number;
  readonly command: string;
  readonly workdir: string | null;
  readonly exitCode: number | null;
  readonly status: "completed" | "error";
  readonly output: string;
  readonly parsed: ParsedShellScript;
}

export interface ReviewHandoff {
  readonly toolIndex: number;
  readonly childSessionId: string;
  readonly prompt: string;
  readonly rangeStart: string | null;
  readonly rangeEndToken: string | null;
  readonly resolvedEndCommit: string | null;
  readonly reviewerFinalText: string;
  readonly reviewerModel: string | null;
}

export interface Evidence {
  readonly repoDir: string;
  readonly trialDir: string;
  readonly baselineHead: string;
  readonly beforeGit: GitState;
  readonly afterGit: GitState;
  readonly tools: readonly ToolTraceEntry[];
  readonly shellRuns: readonly ShellRunTrace[];
  readonly questionFormCount: number;
  readonly finalText: string;
  readonly transcriptText: string;
  readonly reviewerText: string;
  readonly reviewHandoffs: readonly ReviewHandoff[];
  readonly actualReviewerModels: readonly string[];
  readonly timedOut: boolean;
}

export interface CheckOutcomes {
  readonly [checkName: string]: boolean;
}

export interface GradeResult {
  readonly passed: boolean;
  readonly score: number;
  readonly checks: CheckOutcomes;
  readonly notes: readonly string[];
  readonly pedantryFlags: number;
  readonly falsePositiveP0P2: number;
  readonly nitpickP3: number;
  readonly defectRecall: number | null;
  readonly precision: number | null;
  readonly scopeBounced: boolean;
  readonly blockerDisclosed: boolean | null;
  readonly reviewDiff: string | null;
}

interface GradeOptions extends Partial<Omit<GradeResult, "passed" | "score" | "checks">> {
  readonly timedOut: boolean;
  readonly exitCode?: number | null;
  readonly partial?: boolean;
}

export function computeGradeResult(checks: CheckOutcomes, options: GradeOptions): GradeResult {
  const checkNames = Object.keys(checks);
  const passedCount = checkNames.filter((name) => checks[name]).length;
  const { timedOut, exitCode = 0, partial = false } = options;

  return {
    checks,
    score: checkNames.length === 0 ? 0 : passedCount / checkNames.length,
    passed: checkNames.length > 0 && passedCount === checkNames.length && !timedOut && exitCode === 0 && !partial,
    notes: options.notes ?? [],
    pedantryFlags: options.pedantryFlags ?? 0,
    falsePositiveP0P2: options.falsePositiveP0P2 ?? 0,
    nitpickP3: options.nitpickP3 ?? 0,
    defectRecall: options.defectRecall ?? null,
    precision: options.precision ?? null,
    scopeBounced: options.scopeBounced ?? false,
    blockerDisclosed: options.blockerDisclosed ?? null,
    reviewDiff: options.reviewDiff ?? null,
  };
}

function enablesErrexit(words: readonly { readonly text: string }[]): boolean {
  if (words[0]?.text !== "set") return false;

  for (let i = 1; i < words.length; i += 1) {
    const text = words[i]?.text ?? "";

    if (/^-[A-Za-z]*e[A-Za-z]*$/u.test(text) || (text === "-o" && words[i + 1]?.text === "errexit")) return true;
  }

  return false;
}

function disablesErrexit(words: readonly { readonly text: string }[]): boolean {
  if (words[0]?.text !== "set") return false;

  for (let i = 1; i < words.length; i += 1) {
    const text = words[i]?.text ?? "";

    if (/^\+[A-Za-z]*e[A-Za-z]*$/u.test(text) || (text === "+o" && words[i + 1]?.text === "errexit")) return true;
  }

  return false;
}

const FLOW_TERMINATORS = new Set(["exit", "return", "exec"]);

function execHasOperand(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";

    if (arg === "--") return index + 1 < args.length;

    if (arg === "-c" || arg === "-l") continue;

    if (arg === "-a") {
      index += 1;
      continue;
    }

    return true;
  }

  return false;
}

function terminatesShell(cmd: ShellRunTrace["parsed"]["commands"][number], exitCode: number): boolean {
  const unwrapped = unwrapSimpleCommand(cmd);
  const name = unwrapped?.executable ?? cmd.words[0]?.text;

  if (name === undefined || !FLOW_TERMINATORS.has(name)) return false;

  const args = unwrapped?.args ?? cmd.words.slice(1).map(({ text }) => text);

  if (name === "exec") return execHasOperand(args);

  const literal = args[0];

  if (literal !== undefined && /^\d+$/u.test(literal) && (Number(literal) & 255) !== exitCode) {
    return false;
  }

  return true;
}

function siblingExitApplies(
  commands: ShellRunTrace["parsed"]["commands"],
  siblingIndices: readonly number[],
  position: number,
  exitCode: number,
): boolean {
  for (let idx = 0; idx < position; idx += 1) {
    const cmd = commands[siblingIndices[idx] ?? -1];

    if (!cmd || terminatesShell(cmd, exitCode)) return false;
  }

  // Partition sibling commands into `;`/`\n`-separated statements (lists).
  const statements: number[][] = [];
  let current: number[] = [];

  for (const idx of siblingIndices) {
    const cmd = commands[idx];

    if (!cmd) return false;

    current.push(idx);

    if (cmd.operatorAfter === ";" || cmd.operatorAfter === "\n" || cmd.operatorAfter === null) {
      statements.push(current);
      current = [];
    }
  }

  if (current.length > 0) statements.push(current);

  const targetIndex = siblingIndices[position];
  const statementIndex = statements.findIndex((stmt) => stmt.includes(targetIndex ?? -1));
  const statement = statements[statementIndex];

  if (statementIndex < 0 || !statement) return false;

  // Track `set -e` across statements preceding the target statement.
  let errexit = false;

  for (let s = 0; s < statementIndex; s += 1) {
    const stmt = statements[s];

    if (!stmt) return false;

    if (stmt.length === 1) {
      const only = commands[stmt[0] ?? -1];

      if (only) {
        if (enablesErrexit(only.words)) errexit = true;
        else if (disablesErrexit(only.words)) errexit = false;
      }
    }
  }

  // Last statement in the sequence.
  if (statementIndex === statements.length - 1) {
    if (errexit && statementIndex > 0 && exitCode !== 0) return false;

    if (statement.length === 1) return true;

    // A pure `&&` chain exiting 0 proves every command in the chain ran and succeeded.
    const pureAnd = statement.slice(0, -1).every((idx) => commands[idx]?.operatorAfter === "&&");

    return pureAnd && exitCode === 0;
  }

  // Earlier statement: exitCode === 0 proves execution only when errexit is active on a single simple command.
  if (exitCode !== 0 || !errexit || statement.length !== 1) return false;

  // Ensure no command in the remaining statements is backgrounded.
  for (let s = statementIndex + 1; s < statements.length; s += 1) {
    const stmt = statements[s];

    if (!stmt || stmt.some((idx) => commands[idx]?.operatorAfter === "&")) return false;
  }

  return true;
}

export function commandExitApplies(run: ShellRunTrace, commandIndex: number): boolean {
  const { commands, malformed } = run.parsed;

  if (malformed || run.exitCode === null || commands.length === 0) return false;

  const target = commands[commandIndex];

  if (target === undefined || target.operatorAfter === "&" || target.words[0]?.text === "!") return false;

  if (target.depth === 0) {
    const topLevel: number[] = [];

    for (let index = 0; index < commands.length; index += 1) {
      if (commands[index]?.depth === 0) topLevel.push(index);
    }

    const position = topLevel.indexOf(commandIndex);

    return position >= 0 && siblingExitApplies(commands, topLevel, position, run.exitCode);
  }

  // Nested commands inherit exit status only when parsed directly from an enclosing `sh|bash|zsh -c`.
  const origin = target.shellCOrigin;

  if (origin === undefined || !commandExitApplies(run, origin)) return false;

  const siblings: number[] = [];

  for (let index = origin + 1; index < commands.length; index += 1) {
    if (commands[index]?.shellCOrigin === origin) siblings.push(index);
  }

  const position = siblings.indexOf(commandIndex);

  return position >= 0 && siblingExitApplies(commands, siblings, position, run.exitCode);
}

function isShortCircuitedByPrevious(
  commands: ShellRunTrace["parsed"]["commands"],
  siblings: readonly number[],
  position: number,
): boolean {
  if (position <= 0) return false;

  const previous = commands[siblings[position - 1] ?? -1];

  if (!previous) return false;

  const name = unwrapSimpleCommand(previous)?.executable ?? previous.words[0]?.text;

  return (previous.operatorAfter === "&&" && name === "false")
    || (previous.operatorAfter === "||" && (name === "true" || name === ":"));
}

export function commandCanProduceOutput(run: ShellRunTrace, commandIndex: number): boolean {
  const { commands, malformed } = run.parsed;

  if (malformed || run.exitCode === null || commands.length === 0) return false;

  const target = commands[commandIndex];

  if (target === undefined || target.operatorAfter === "&" || target.words[0]?.text === "!") return false;

  let siblings: number[];

  if (target.depth === 0) {
    siblings = [];

    for (let index = 0; index < commands.length; index += 1) {
      if (commands[index]?.depth === 0) siblings.push(index);
    }
  } else {
    const origin = target.shellCOrigin;

    if (origin === undefined || !commandCanProduceOutput(run, origin)) return false;

    siblings = [];

    for (let index = origin + 1; index < commands.length; index += 1) {
      if (commands[index]?.shellCOrigin === origin) siblings.push(index);
    }
  }

  const position = siblings.indexOf(commandIndex);

  if (position < 0) return false;

  for (let idx = 0; idx < position; idx += 1) {
    const cmd = commands[siblings[idx] ?? -1];

    if (!cmd || terminatesShell(cmd, run.exitCode)) return false;
  }

  return !isShortCircuitedByPrevious(commands, siblings, position);
}
