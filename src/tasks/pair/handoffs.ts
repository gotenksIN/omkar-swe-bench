import type { SessionMessageInfo } from "@opencode/client";

import { extractGitCommit, unwrapSimpleCommand } from "../../ast/bash.ts";
import { withIsolatedGitDir } from "../../graders/git.ts";
import { extractSessionEvidence } from "../../graders/trace.ts";
import { commandExitApplies, type ReviewHandoff, type ShellRunTrace, type ToolTraceEntry } from "../../graders/types.ts";
import { isString } from "../../util/json.ts";
import { runTaskGit } from "../base.ts";

export type ReadPairGit = (...args: string[]) => Promise<string>;

const fullSha = /^[a-f\d]{40}$/u;
const reviewRange = /(?<![\w.])([a-fA-F\d]{4,40})\.\.(HEAD|[a-fA-F\d]{4,40})(?![\w~^:@{/-]|\.[\w.])/gu;

export async function withPairHistory<T>(repoDir: string, head: string, inspect: (read: ReadPairGit) => Promise<T>): Promise<T> {
  if (!fullSha.test(head)) throw new Error("Expected a full Git commit hash.");

  return withIsolatedGitDir(
    repoDir,
    { head, copyReflog: true, neutralizeAttributes: true, prefix: ".pair-git-" },
    (dir) => inspect((...args) => runTaskGit(dir, "--git-dir=.", ...args)),
  );
}

export async function pairReflog(read: ReadPairGit, baselineHead: string) {
  const log = await read("reflog", "--format=%H%x09%gs");
  const created: string[] = [];
  const amended: string[] = [];
  let preAmendHead: string | null = null;

  for (const line of log.trimEnd().split("\n").reverse()) {
    const tab = line.indexOf("\t");
    const sha = line.slice(0, tab);
    const subject = line.slice(tab + 1);
    const isAmend = subject.startsWith("commit (amend): ");

    if (!fullSha.test(sha) || sha === baselineHead || (!isAmend && !subject.startsWith("commit: "))) continue;

    const descends = await read("merge-base", "--is-ancestor", baselineHead, sha).then(() => true, () => false);

    if (!descends) continue;

    if (isAmend) amended.push(sha);
    else {
      created.push(sha);

      if (amended.length === 0) preAmendHead = sha;
    }
  }

  return { created, amended, preAmendHead, postAmendHead: amended.at(-1) ?? null };
}

function reviewerModel(messages: readonly SessionMessageInfo[]): string | null {
  const model = messages.findLast((message) => message.type === "assistant")?.model;

  if (!model) return null;

  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`;
}

export async function reviewHandoffs(
  repoDir: string,
  baselineHead: string,
  tools: readonly ToolTraceEntry[],
  shellRuns: readonly ShellRunTrace[],
  childMessagesBySessionId: ReadonlyMap<string, readonly SessionMessageInfo[]>,
): Promise<readonly ReviewHandoff[]> {
  const provenAmendIndices: number[] = [];
  const ambiguousAmendIndices: number[] = [];
  const orderedAmendIndices: number[] = [];
  const reviews = [];

  for (const shellTrace of shellRuns) {
    for (const [cmdIndex, cmd] of shellTrace.parsed.commands.entries()) {
      const unwrapped = unwrapSimpleCommand(cmd);
      const commit = unwrapped ? extractGitCommit(unwrapped) : null;

      if (!commit?.amend) continue;

      if (shellTrace.exitCode === 0 && commandExitApplies(shellTrace, cmdIndex)) {
        provenAmendIndices.push(shellTrace.index);
        orderedAmendIndices.push(shellTrace.index);
      } else if (shellTrace.exitCode !== null && shellTrace.exitCode !== 0 && commandExitApplies(shellTrace, cmdIndex)) {
        // A definitively failed amend did not create a reflog entry.
        continue;
      } else {
        ambiguousAmendIndices.push(shellTrace.index);
        orderedAmendIndices.push(shellTrace.index);
      }
    }
  }

  for (const { index, tool, status, input, metadata } of tools) {
    if (tool !== "subagent" || status !== "completed" || input.agent !== "code-reviewer" || !isString(input.prompt)) continue;

    const childSessionId = isString(metadata?.sessionID) ? metadata.sessionID : metadata?.childSessionID;

    if (isString(childSessionId)) reviews.push({ toolIndex: index, childSessionId, prompt: input.prompt });
  }

  if (reviews.length === 0) return [];

  const history = await withPairHistory(repoDir, baselineHead, (read) => pairReflog(read, baselineHead));
  const commits = new Set([...history.created, ...history.amended]);
  const exactProven = provenAmendIndices.length === history.amended.length;
  const traceMatchesReflog = exactProven || (history.amended.length > 0 && orderedAmendIndices.length === history.amended.length);
  const resolvedAmendIndices = exactProven ? provenAmendIndices : orderedAmendIndices;

  return reviews.sort((left, right) => left.toolIndex - right.toolIndex).map((review) => {
    const { childSessionId, prompt, toolIndex } = review;
    const range = Iterator.from(prompt.matchAll(reviewRange)).find((match) => baselineHead.startsWith(match[1]?.toLowerCase() ?? ""));
    const rangeStart = range?.[1] ?? null;
    const rangeEndToken = range?.[2] ?? null;
    let resolvedEndCommit: string | null = null;

    if (rangeEndToken === "HEAD") {
      const amendsBefore = resolvedAmendIndices.filter((amendIndex) => amendIndex < toolIndex).length;
      const hadAmbiguousAmend = ambiguousAmendIndices.some((amendIndex) => amendIndex < toolIndex);

      if (amendsBefore === 0 && (!hadAmbiguousAmend || traceMatchesReflog)) {
        resolvedEndCommit = history.preAmendHead;
      } else if (amendsBefore > 0 && traceMatchesReflog) {
        resolvedEndCommit = history.amended[amendsBefore - 1] ?? null;
      }
    } else if (rangeEndToken !== null) {
      const matches = Array.from(commits.values().filter((sha) => sha.startsWith(rangeEndToken.toLowerCase())));

      if (matches.length === 1) resolvedEndCommit = matches[0] ?? null;
    }

    const messages = childMessagesBySessionId.get(childSessionId) ?? [];
    const { finalText } = extractSessionEvidence(messages, { timedOut: false, isSubagent: true, sessionId: childSessionId });

    return { ...review, rangeStart, rangeEndToken, resolvedEndCommit, reviewerFinalText: finalText, reviewerModel: reviewerModel(messages) };
  });
}

export function actualReviewerModels(handoffs: readonly ReviewHandoff[]): readonly string[] {
  return handoffs.flatMap(({ reviewerModel: model }) => model === null ? [] : [model]);
}
