import type { SessionMessageInfo } from "@opencode/client";

import { extractGitCommit, unwrapSimpleCommand } from "../../ast/bash.ts";
import { withIsolatedGitDir } from "../../graders/git.ts";
import { extractSessionEvidence } from "../../graders/trace.ts";
import { commandExitApplies } from "../../graders/types.ts";
import type {
  ReviewHandoff,
  ShellRunTrace,
  ToolTraceEntry,
} from "../../graders/types.ts";
import { isString } from "../../util/json.ts";
import { runTaskGit } from "../base.ts";

export type ReadPairGit = (...args: string[]) => Promise<string>;

const fullSha = /^[a-f\d]{40}$/u;

const reviewRange =
  /(?<![\w.])(?<start>[a-fA-F\d]{4,40})\.\.(?<end>HEAD|[a-fA-F\d]{4,40})(?![\w~^:@{/-]|\.[\w.])/gu;

export const withPairHistory = async <T>(
  repoDir: string,
  head: string,
  inspect: (read: ReadPairGit) => Promise<T>
): Promise<T> => {
  if (!fullSha.test(head)) {
    throw new Error("Expected a full Git commit hash.");
  }

  return await withIsolatedGitDir(
    repoDir,
    {
      head,
      copyReflog: true,
      neutralizeAttributes: true,
      prefix: ".pair-git-",
    },
    async (dir) =>
      await inspect(
        async (...args) => await runTaskGit(dir, "--git-dir=.", ...args)
      )
  );
};

const isAncestorCommit = async (
  read: ReadPairGit,
  baselineHead: string,
  sha: string
): Promise<boolean> => {
  try {
    await read("merge-base", "--is-ancestor", baselineHead, sha);

    return true;
  } catch {
    return false;
  }
};

export const pairReflog = async (read: ReadPairGit, baselineHead: string) => {
  const log = await read("reflog", "--format=%H%x09%gs");
  const candidates: { readonly sha: string; readonly isAmend: boolean }[] = [];

  for (const line of log.trimEnd().split("\n").toReversed()) {
    const tab = line.indexOf("\t");
    const sha = line.slice(0, tab);
    const subject = line.slice(tab + 1);
    const isAmend = subject.startsWith("commit (amend): ");

    if (
      !fullSha.test(sha) ||
      sha === baselineHead ||
      (!isAmend && !subject.startsWith("commit: "))
    ) {
      continue;
    }

    candidates.push({ sha, isAmend });
  }

  const ancestry = await Promise.all(
    candidates.map(
      async ({ sha }) => await isAncestorCommit(read, baselineHead, sha)
    )
  );

  const created: string[] = [];
  const amended: string[] = [];
  let preAmendHead: string | null = null;

  for (const [index, candidate] of candidates.entries()) {
    if (ancestry[index] !== true) {
      continue;
    }

    if (candidate.isAmend) {
      amended.push(candidate.sha);
    } else {
      created.push(candidate.sha);

      if (amended.length === 0) {
        preAmendHead = candidate.sha;
      }
    }
  }

  return {
    created,
    amended,
    preAmendHead,
    postAmendHead: amended.at(-1) ?? null,
  };
};

const reviewerModel = (
  messages: readonly SessionMessageInfo[]
): string | null => {
  const model = messages.findLast(
    (message) => message.type === "assistant"
  )?.model;

  if (!model) {
    return null;
  }

  const suffix =
    model.variant !== undefined && model.variant.length > 0
      ? `#${model.variant}`
      : "";

  return `${model.providerID}/${model.id}${suffix}`;
};

const splitSessionTurns = (
  messages: readonly SessionMessageInfo[]
): readonly (readonly SessionMessageInfo[])[] => {
  const turns: SessionMessageInfo[][] = [];
  let current: SessionMessageInfo[] = [];
  let hasTurnMessage = false;

  for (const message of messages) {
    if (message.type === "user" && hasTurnMessage) {
      turns.push(current);
      current = [];
      hasTurnMessage = false;
    }

    current.push(message);

    if (message.type === "user" || message.type === "assistant") {
      hasTurnMessage = true;
    }

    if (message.type === "idle" && hasTurnMessage) {
      turns.push(current);
      current = [];
      hasTurnMessage = false;
    }
  }

  if (hasTurnMessage) {
    turns.push(current);
  }

  return turns;
};

export interface ReviewHandoffsOptions {
  readonly timedOut?: boolean;
}

const collectAmendIndices = (shellRuns: readonly ShellRunTrace[]) => {
  const provenAmendIndices: number[] = [];
  const ambiguousAmendIndices: number[] = [];
  const orderedAmendIndices: number[] = [];

  for (const shellTrace of shellRuns) {
    for (const [cmdIndex, cmd] of shellTrace.parsed.commands.entries()) {
      const unwrapped = unwrapSimpleCommand(cmd);
      const commit = unwrapped ? extractGitCommit(unwrapped) : null;

      if (commit?.amend !== true) {
        continue;
      }

      if (
        shellTrace.exitCode === 0 &&
        commandExitApplies(shellTrace, cmdIndex)
      ) {
        provenAmendIndices.push(shellTrace.index);
        orderedAmendIndices.push(shellTrace.index);
      } else if (
        shellTrace.exitCode !== null &&
        shellTrace.exitCode !== 0 &&
        commandExitApplies(shellTrace, cmdIndex)
      ) {
        // A definitively failed amend did not create a reflog entry.
        continue;
      } else {
        ambiguousAmendIndices.push(shellTrace.index);
        orderedAmendIndices.push(shellTrace.index);
      }
    }
  }

  return { provenAmendIndices, ambiguousAmendIndices, orderedAmendIndices };
};

const resolveReviewEndCommit = (
  rangeEndToken: string | null,
  toolIndex: number,
  history: Awaited<ReturnType<typeof pairReflog>>,
  commits: ReadonlySet<string>,
  resolvedAmendIndices: readonly number[],
  ambiguousAmendIndices: readonly number[],
  traceMatchesReflog: boolean
): string | null => {
  if (rangeEndToken === "HEAD") {
    const amendsBefore = resolvedAmendIndices.filter(
      (amendIndex) => amendIndex < toolIndex
    ).length;

    const hadAmbiguousAmend = ambiguousAmendIndices.some(
      (amendIndex) => amendIndex < toolIndex
    );

    if (amendsBefore === 0 && (!hadAmbiguousAmend || traceMatchesReflog)) {
      return history.preAmendHead;
    }

    if (amendsBefore > 0 && traceMatchesReflog) {
      return history.amended[amendsBefore - 1] ?? null;
    }

    return null;
  }

  if (rangeEndToken === null) {
    return null;
  }

  const prefix = rangeEndToken.toLowerCase();
  let match: string | null = null;

  for (const sha of commits) {
    if (!sha.startsWith(prefix)) {
      continue;
    }

    if (match !== null) {
      return null;
    }

    match = sha;
  }

  return match;
};

export const reviewHandoffs = async (
  repoDir: string,
  baselineHead: string,
  tools: readonly ToolTraceEntry[],
  shellRuns: readonly ShellRunTrace[],
  childMessagesBySessionId: ReadonlyMap<string, readonly SessionMessageInfo[]>,
  options?: ReviewHandoffsOptions
): Promise<readonly ReviewHandoff[]> => {
  const { provenAmendIndices, ambiguousAmendIndices, orderedAmendIndices } =
    collectAmendIndices(shellRuns);

  const reviews = [];

  for (const { index, tool, status, input, metadata } of tools) {
    if (
      tool !== "subagent" ||
      status !== "completed" ||
      input.agent !== "code-reviewer" ||
      !isString(input.prompt)
    ) {
      continue;
    }

    const childSessionId = isString(metadata?.sessionID)
      ? metadata.sessionID
      : metadata?.childSessionID;

    if (isString(childSessionId)) {
      reviews.push({ toolIndex: index, childSessionId, prompt: input.prompt });
    }
  }

  if (reviews.length === 0) {
    return [];
  }

  const history = await withPairHistory(
    repoDir,
    baselineHead,
    async (read) => await pairReflog(read, baselineHead)
  );

  const commits = new Set([...history.created, ...history.amended]);
  const exactProven = provenAmendIndices.length === history.amended.length;

  const traceMatchesReflog =
    exactProven ||
    (history.amended.length > 0 &&
      orderedAmendIndices.length === history.amended.length);

  const resolvedAmendIndices = exactProven
    ? provenAmendIndices
    : orderedAmendIndices;

  const turnsBySessionId = new Map<
    string,
    readonly (readonly SessionMessageInfo[])[]
  >();

  const nextTurnBySessionId = new Map<string, number>();

  return reviews
    .toSorted((left, right) => left.toolIndex - right.toolIndex)
    .map((review) => {
      const { childSessionId, prompt, toolIndex } = review;

      const range = Iterator.from(prompt.matchAll(reviewRange)).find((match) =>
        baselineHead.startsWith(match.groups?.start?.toLowerCase() ?? "")
      );

      const rangeStart = range?.groups?.start ?? null;
      const rangeEndToken = range?.groups?.end ?? null;

      const resolvedEndCommit = resolveReviewEndCommit(
        rangeEndToken,
        toolIndex,
        history,
        commits,
        resolvedAmendIndices,
        ambiguousAmendIndices,
        traceMatchesReflog
      );

      let turns = turnsBySessionId.get(childSessionId);

      if (turns === undefined) {
        turns = splitSessionTurns(
          childMessagesBySessionId.get(childSessionId) ?? []
        );
        turnsBySessionId.set(childSessionId, turns);
      }

      const turnIndex = nextTurnBySessionId.get(childSessionId) ?? 0;
      nextTurnBySessionId.set(childSessionId, turnIndex + 1);

      const turnMessages = turns[turnIndex] ?? [];

      const { finalText } = extractSessionEvidence(turnMessages, {
        timedOut: options?.timedOut ?? false,
        isSubagent: true,
        sessionId: childSessionId,
      });

      return {
        ...review,
        rangeStart,
        rangeEndToken,
        resolvedEndCommit,
        reviewerFinalText: finalText,
        reviewerModel: reviewerModel(turnMessages),
      };
    });
};

export const actualReviewerModels = (
  handoffs: readonly ReviewHandoff[]
): readonly string[] =>
  handoffs.flatMap(({ reviewerModel: model }) =>
    model === null ? [] : [model]
  );
