import type { SessionMessageAssistantTool, SessionMessageInfo } from "@opencode/client";
import { realpathSync } from "node:fs";
import { posix, resolve } from "node:path";

import { parseShellScript, skipShellFlags, unwrapSimpleCommand, type SimpleCommand, type UnwrappedCommand } from "../ast/bash.ts";
import { isInteger, isJsonArray, isJsonObject, isString, type JsonObject, type JsonValue } from "../util/json.ts";
import { scopeNeeded, statesNoFindings } from "./findings.ts";
import { commandCanProduceOutput, commandExitApplies, type Evidence, type ShellRunTrace, type ToolTraceEntry } from "./types.ts";

export interface ExtractedSessionTrace {
  readonly tools: readonly ToolTraceEntry[];
  readonly shellRuns: readonly ShellRunTrace[];
  readonly transcriptText: string;
  readonly finalText: string;
}

interface TraceOptions {
  readonly timedOut: boolean;
  readonly isSubagent?: boolean;
  readonly sessionId?: string;
}

type ToolDetails = Omit<ToolTraceEntry, "index" | "sessionId" | "isSubagent">;

function stringValue(value: JsonValue | undefined): string | null {
  return isString(value) ? value : null;
}

function toolDetails(part: SessionMessageAssistantTool): ToolDetails {
  const { state } = part;

  if (state.status === "streaming") {
    return { tool: part.name, status: "pending", input: {}, textOutput: "", errorText: null, metadata: null };
  }

  return {
    tool: part.name,
    status: state.status,
    input: state.input,
    textOutput: ("content" in state ? state.content : undefined)
      ?.flatMap((item) => item.type === "text" ? [item.text] : []).join("") ?? "",
    errorText: state.status === "error" ? state.error.message : null,
    metadata: state.metadata ?? null,
  };
}

function nestedTool(call: JsonObject): ToolDetails | null {
  const tool = stringValue(call.tool);
  const { status } = call;
  const metadata = isJsonObject(call.metadata) ? call.metadata : null;

  if (!tool || (status !== "pending" && status !== "running" && status !== "completed" && status !== "error")) return null;

  return {
    tool,
    status,
    input: isJsonObject(call.input) ? call.input : {},
    textOutput: stringValue(call.textOutput) ?? stringValue(call.output) ?? "",
    errorText: stringValue(call.errorText) ?? stringValue(call.error),
    metadata,
  };
}

function shellRun(entry: ToolTraceEntry, nested: boolean): ShellRunTrace | null {
  const { index, tool, status, input, metadata } = entry;
  const command = stringValue(input.command);

  if (tool !== "shell" || (status !== "completed" && status !== "error") || command === null) return null;

  const exit = metadata?.exit;

  const exitCode = isInteger(exit) ? exit
    : nested || input.background === true ? null : status === "completed" ? 0 : 1;

  return {
    index,
    command,
    workdir: stringValue(input.workdir),
    exitCode,
    status,
    output: entry.textOutput || entry.errorText || "",
    parsed: parseShellScript(command),
  };
}

function isReviewText(text: string): boolean {
  return /^\s*##\s+findings\s*$/imu.test(text) || scopeNeeded(text);
}

export function extractSessionEvidence(
  messages: readonly SessionMessageInfo[], options: TraceOptions,
): ExtractedSessionTrace {
  const tools: ToolTraceEntry[] = [];
  const shellRuns: ShellRunTrace[] = [];
  const transcript: string[] = [];
  let finalText = "";
  let precedingReview = "";

  function record(details: ToolDetails, nestedCall = false): void {
    const entry = {
      ...details, index: tools.length, sessionId: options.sessionId ?? "", isSubagent: options.isSubagent ?? false,
    };

    tools.push(entry);

    const shell = shellRun(entry, nestedCall);

    if (shell) shellRuns.push(shell);

    const nested = entry.metadata?.toolCalls;

    if (entry.tool !== "execute" || !isJsonArray(nested)) return;

    for (const call of nested) {
      const tool = isJsonObject(call) ? nestedTool(call) : null;

      if (tool) record(tool, true);
    }
  }

  for (const message of messages) {
    if (message.type !== "assistant") continue;

    const parts: string[] = [];

    for (const part of message.content) {
      if (part.type === "text") parts.push(part.text);
      else if (part.type === "tool") record(toolDetails(part));
    }

    const text = parts.join("\n").trim();

    if (text) transcript.push(text);

    if (!text || (options.timedOut && message.time.completed === undefined)) continue;

    if (isReviewText(text) || statesNoFindings(text)) precedingReview = text;

    if (message.finish === "stop") {
      finalText = text.length < 40 && precedingReview ? precedingReview : text;
    }
  }

  return { tools, shellRuns, transcriptText: transcript.join("\n"), finalText };
}

export interface RanCommandOptions {
  readonly afterLastEdit?: boolean;
  readonly beforeCommandIndex?: number;
  readonly outputPattern?: RegExp;
  readonly success?: boolean | null;
  readonly verifiedOutput?: (output: string) => boolean;
}

const ruffValueFlags = new Set(["--config", "--cache-dir", "--output-format"]);

const bunValueFlags = new Set([
  "-c", "--config", "--cwd", "--env-file", "--preload", "-r", "--conditions", "--main-fields", "--define", "-d", "--loader",
]);

function stripLeadingFlags(args: readonly string[], valueFlags: ReadonlySet<string>): readonly string[] {
  let idx = 0;

  while (idx < args.length) {
    const arg = args[idx] ?? "";

    if (!arg.startsWith("-") || arg === "-") break;

    idx += 1;

    if (valueFlags.has(arg)) idx += 1;
  }

  return args.slice(idx);
}

function normalizeCommandArgs(command: UnwrappedCommand): readonly string[] {
  if (command.executable === "ruff") return stripLeadingFlags(command.args, ruffValueFlags);

  if (command.executable === "bun") return stripLeadingFlags(command.args, bunValueFlags);

  return command.args;
}

function matchesPrefix(command: UnwrappedCommand, prefix: readonly string[]): boolean {
  if (command.rejectedFlag !== null) return false;

  const [wanted, ...args] = prefix;

  if (wanted === undefined) return false;

  const executableMatches = command.executable === wanted || command.executable === posix.basename(wanted);

  if (!executableMatches) return false;

  const normalizedArgs = normalizeCommandArgs(command);

  if (args.every((arg, index) => normalizedArgs[index] === arg)) return true;

  // Treat `bun run [--bun] test` as executing `bun test`.
  if (wanted === "bun" && args.length === 1 && args[0] === "test" && normalizedArgs[0] === "run") {
    let idx = 1;

    while (idx < normalizedArgs.length && normalizedArgs[idx]?.startsWith("-")) idx += 1;

    return normalizedArgs[idx] === "test";
  }

  return false;
}

function sameDirectory(workdir: string | null, repoDir: string): boolean {
  if (workdir === null) return true;

  try {
    return realpathSync(resolve(repoDir, workdir)) === realpathSync(repoDir);
  } catch {
    return false;
  }
}

function matchesStage(stage: SimpleCommand, prefix: readonly string[]): boolean {
  const command = unwrapSimpleCommand(stage);

  if (!command) return false;

  if (matchesPrefix(command, prefix)) return true;

  if (!/^(?:sh|bash|zsh)$/u.test(command.executable)) return false;

  const idx = skipShellFlags(command.args);
  const script = command.args[idx];

  return script !== undefined && script.endsWith(".sh") && !script.startsWith("-") &&
    matchesPrefix({ ...command, executable: posix.basename(script), args: command.args.slice(idx + 1) }, prefix);
}

function matchesPipeline(
  run: ShellRunTrace, prefix: readonly string[], commandLimit = run.parsed.commands.length,
): boolean {
  const preceding = new Map<number, SimpleCommand>();

  for (let cmdIndex = 0; cmdIndex < commandLimit; cmdIndex += 1) {
    const stage = run.parsed.commands[cmdIndex];

    if (!stage) continue;

    const left = preceding.get(stage.depth);

    if (left?.operatorAfter === "|" && (matchesStage(left, prefix) || matchesStage(stage, prefix))) return true;

    preceding.set(stage.depth, stage);
  }

  return false;
}

export function ranCommand(
  evidence: Pick<Evidence, "tools" | "shellRuns" | "repoDir">,
  wantedPrefix: readonly string[],
  options: RanCommandOptions = {},
): boolean {
  let lastEdit = -Infinity;

  if (options.afterLastEdit) {
    for (const { index, tool, status } of evidence.tools) {
      if (status === "completed" && (tool === "edit" || tool === "write" || tool === "patch")) {
        lastEdit = Math.max(lastEdit, index);
      }
    }
  }

  return evidence.shellRuns.some((run) => {
    if (run.index <= lastEdit || run.parsed.malformed || !sameDirectory(run.workdir, evidence.repoDir)) return false;

    const bounded = options.beforeCommandIndex !== undefined;
    const commandLimit = bounded ? Math.min(options.beforeCommandIndex, run.parsed.commands.length) : run.parsed.commands.length;
    const candidateCommands = bounded ? run.parsed.commands.slice(0, commandLimit) : run.parsed.commands;

    const matched = bounded
      ? candidateCommands.some((stage) => matchesStage(stage, wantedPrefix))
      : run.parsed.unwrapped.some((command) => matchesPrefix(command, wantedPrefix));

    if (!matched) return false;

    if (options.outputPattern && !new RegExp(options.outputPattern).test(run.output)) return false;

    if (options.success == null) return true;

    const directStatus = candidateCommands.some((stage, cmdIndex) =>
      matchesStage(stage, wantedPrefix) && commandExitApplies(run, cmdIndex) && (run.exitCode === 0) === options.success);

    const hasLaterMatch = bounded
      && run.parsed.commands.slice(commandLimit).some((stage) => matchesStage(stage, wantedPrefix));

    const verifiedOutput = options.verifiedOutput !== undefined
      && !hasLaterMatch
      && options.verifiedOutput(run.output)
      && candidateCommands.some((stage, cmdIndex) =>
        matchesStage(stage, wantedPrefix) && commandCanProduceOutput(run, cmdIndex));

    return directStatus || verifiedOutput || (options.outputPattern !== undefined && matchesPipeline(run, wantedPrefix, commandLimit));
  });
}
