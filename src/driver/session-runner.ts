import { setTimeout as delay } from "node:timers/promises";

import { ClientError } from "@opencode/client";
import type {
  MessageListInput,
  OpenCodeClient,
  OpenCodeEvent,
  SessionMessageInfo,
  SessionStructuredError,
} from "@opencode/client";

import { parseShellScript } from "../ast/bash.ts";
import { parseModelRef } from "../config/models.ts";
import { isFiniteNumber } from "../util/json.ts";

export interface ErrorDiagnostic {
  readonly retryable: boolean;
  readonly status: number | null;
  readonly errorType: string;
  readonly message: string;
  readonly retryAfterMs: number | null;
}

export interface SessionRunResult {
  readonly rootSessionId: string | null;
  readonly rootMessages: readonly SessionMessageInfo[];
  readonly childMessagesBySessionId: ReadonlyMap<
    string,
    readonly SessionMessageInfo[]
  >;
  readonly textStartedMsByMessageId: ReadonlyMap<string, number>;
  readonly scheduledRetries: number;
  readonly questionFormCount: number;
  readonly timedOut: boolean;
  readonly interrupted: boolean;
  readonly exitCode: number;
  readonly errorDiagnostic: ErrorDiagnostic | null;
}

export interface RunSessionOptions {
  readonly client: OpenCodeClient;
  readonly exitPromise?: Promise<number | null>;
  readonly repoDir: string;
  readonly trialId: string;
  readonly activeRole: "coder" | "code-reviewer";
  readonly modelSpec: string;
  readonly activeProviderIds: Iterable<string>;
  readonly prompt: string;
  readonly wallTimeoutMs: number;
  readonly readinessTimeoutMs?: number;
  readonly signal: AbortSignal;
}

const terminalErrors = new Set([
  "ModelNotFoundError",
  "UnsupportedModelError",
  "AgentNotFoundError",
  "ConfigInvalidError",
  "SchemaError",
  "SchemaValidationError",
  "ValidationError",
  "ParseError",
  "MalformedResponse",
  "UnsupportedContentType",
  "SseEventTooLarge",
  "ExternalFormError",
  "WallClockTimeoutError",
  "AbortError",
  "InvalidCursorError",
  "InvalidRequestError",
  "UnauthorizedError",
  "ForbiddenError",
  "SandboxLaunchError",
]);

const transientErrors = new Set([
  "Transport",
  "PrematureSseDisconnectError",
  "UnexpectedServerExitError",
  "ReadinessTimeoutError",
  "ServerStartupError",
  "OverloadedError",
  "RateLimitError",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_SOCKET",
  "fetch failed",
]);

// The client preserves the declared error tag, but not its HTTP status.
const declaredStatuses = new Map([
  ["InvalidCursorError", 400],
  ["InvalidRequestError", 400],
  ["UnauthorizedError", 401],
  ["ForbiddenError", 403],
  ["InternalServerError", 500],
  ["UnknownError", 500],
  ["ServiceUnavailableError", 503],
]);

const transientReadinessErrors = new Set([
  "LocationNotFoundError",
  "ServiceUnavailableError",
]);

const settledReplyErrors = new Set([
  "PermissionNotFoundError",
  "FormNotFoundError",
  "FormAlreadySettledError",
]);

export const isRetryableApiFailure = ({
  status,
  errorType,
  message,
}: Omit<ErrorDiagnostic, "retryable" | "retryAfterMs">): boolean => {
  if (
    terminalErrors.has(errorType) ||
    (status !== null && [400, 401, 403, 404, 422].includes(status))
  ) {
    return false;
  }

  return (
    (status !== null &&
      ([408, 429, 500, 502, 503, 504].includes(status) ||
        (status >= 520 && status <= 529))) ||
    transientErrors.has(errorType) ||
    /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|UND_ERR_SOCKET|fetch failed)\b/u.test(
      message
    )
  );
};

const diagnostic = ({
  type: errorType,
  message,
  status,
  retryAfterMs,
}: SessionStructuredError): ErrorDiagnostic => {
  const fields = { errorType, message, status: status ?? null };

  return {
    ...fields,
    retryAfterMs: retryAfterMs ?? null,
    retryable: isRetryableApiFailure(fields),
  };
};

const hasStatus = (value: unknown): value is { status: number } => {
  const boxed = new Object(value);

  return value === boxed && "status" in boxed && Number.isFinite(boxed.status);
};

export const errorDiagnostic = (cause: unknown): ErrorDiagnostic => {
  if (!(cause instanceof Error)) {
    return diagnostic({ type: "Error", message: String(cause) });
  }

  const details: SessionStructuredError = {
    type: cause instanceof ClientError ? cause.reason : cause.name,
    message: cause.message,
  };

  if (hasStatus(cause)) {
    details.status = cause.status;
  } else if (
    cause instanceof ClientError &&
    cause.reason === "UnexpectedStatus" &&
    hasStatus(cause.cause)
  ) {
    details.status = cause.cause.status;
  } else {
    const status = declaredStatuses.get(cause.name);

    if (status !== undefined) {
      details.status = status;
    }
  }

  if ("retryAfterMs" in cause && isFiniteNumber(cause.retryAfterMs)) {
    details.retryAfterMs = cause.retryAfterMs;
  }

  if ("code" in cause && transientErrors.has(String(cause.code))) {
    details.type = String(cause.code);
  }

  return diagnostic(details);
};

const namedError = (name: string, message: string): Error => {
  const error = new Error(message);
  error.name = name;

  return error;
};

// Rotate the signal on each event so a wakeup during an HTTP request is not lost.
const createWakeup = () => {
  let controller = new AbortController();

  return {
    current: () => controller.signal,
    notify: (): void => {
      controller.abort();
      controller = new AbortController();
    },
  };
};

const waitForPoll = async (
  signal: AbortSignal,
  wakeup?: AbortSignal
): Promise<void> => {
  try {
    await delay(50, undefined, {
      signal: wakeup === undefined ? signal : AbortSignal.any([signal, wakeup]),
    });
  } catch (error) {
    signal.throwIfAborted();

    if (wakeup?.aborted !== true) {
      throw error;
    }
  }
};

const readiness = async <T>(
  signal: AbortSignal,
  timeoutMs: number,
  work: (boundedSignal: AbortSignal) => Promise<T>
): Promise<T> => {
  const controller = new AbortController();
  const bounded = AbortSignal.any([signal, controller.signal]);

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await work(bounded);
  } catch (error) {
    if (controller.signal.aborted && !signal.aborted) {
      throw namedError(
        "ReadinessTimeoutError",
        "Timed out waiting for OpenCode readiness."
      );
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
};

export const waitForLocationReady = async (
  client: OpenCodeClient,
  repoDir: string,
  activeProviderIds: Iterable<string>,
  signal: AbortSignal,
  timeoutMs = 10_000,
  wakeup?: () => AbortSignal
): Promise<void> => {
  const providers = new Set(activeProviderIds);
  const location = { directory: repoDir };

  await readiness(signal, timeoutMs, async (bounded) => {
    const poll = async (): Promise<void> => {
      bounded.throwIfAborted();

      const nextUpdate = wakeup?.();

      try {
        const [agents, configuredProviders] = await Promise.all([
          client.agent.list({ location }, { signal: bounded }),
          client.provider.list({ location }, { signal: bounded }),
        ]);

        const agentIds = new Set(agents.data.map(({ id }) => id));

        const providerIds = new Set(
          configuredProviders.data.map(({ id }) => id)
        );

        if (
          agentIds.has("coder") &&
          agentIds.has("code-reviewer") &&
          providers.values().every((id) => providerIds.has(id))
        ) {
          return;
        }
      } catch (error) {
        if (
          bounded.aborted ||
          !(error instanceof Error) ||
          !transientReadinessErrors.has(error.name)
        ) {
          throw error;
        }
      }

      await waitForPoll(bounded, nextUpdate);
      await poll();
    };

    await poll();
  });
};

const collectSessionMessages = async (
  client: OpenCodeClient,
  sessionID: string,
  signal: AbortSignal,
  messages: SessionMessageInfo[]
): Promise<void> => {
  const visited = new Set<string>();

  const fetchPage = async (cursor?: string): Promise<void> => {
    const input: MessageListInput =
      cursor === undefined
        ? { sessionID, limit: 200, order: "asc" }
        : { sessionID, limit: 200, cursor };

    const page = await client.message.list(input, { signal });

    if (page.data.length === 0) {
      return;
    }

    for (const message of page.data) {
      messages.push(message);
    }

    const nextCursor = page.cursor.next ?? undefined;

    if (nextCursor === undefined || visited.has(nextCursor)) {
      return;
    }

    visited.add(nextCursor);
    await fetchPage(nextCursor);
  };

  await fetchPage();
};

const safeReviewerGitFlags = new Set([
  "--stat",
  "--numstat",
  "--shortstat",
  "--name-only",
  "--name-status",
  "--summary",
  "--patch",
  "-p",
  "-u",
  "--raw",
  "--oneline",
  "--graph",
  "--decorate",
  "--no-decorate",
  "--abbrev-commit",
  "--no-abbrev-commit",
  "--no-renames",
  "-M",
  "-C",
  "-B",
  "--find-renames",
  "--find-copies",
  "--full-index",
  "--color=never",
  "--no-color",
]);

const commitRangeArg = /^[0-9a-fA-F]{4,40}\.\.(?:HEAD|[0-9a-fA-F]{4,40})$/u;
const singleRevisionArg = /^(?:HEAD|[0-9a-fA-F]{4,40})$/u;
const safeFormatValue = /^[A-Za-z0-9%x\t _:-]+$/u;

const isSafeReviewerPathspec = (arg: string): boolean =>
  arg.length > 0 &&
  !arg.startsWith("/") &&
  !arg.startsWith(":(") &&
  !arg.split("/").includes("..");

const isSafeFormatString = (value: string): boolean =>
  safeFormatValue.test(value) && !/%[^A-Za-z]*G/u.test(value);

const consumeReviewerLogFlag = (
  arg: string,
  nextValue: string | undefined
): "invalid" | "skip1" | "skip2" | "unhandled" => {
  if (/^(?:-\d+|-n\d+|--max-count=\d+)$/u.test(arg)) {
    return "skip1";
  }

  if (arg === "-n" || arg === "--max-count") {
    return nextValue !== undefined && /^\d+$/u.test(nextValue)
      ? "skip2"
      : "invalid";
  }

  const inlineFormat = /^--(?:format|pretty)=(?<format>.*)$/u.exec(arg);
  const inlineValue = inlineFormat?.groups?.format;

  if (inlineValue !== undefined) {
    return isSafeFormatString(inlineValue) ? "skip1" : "invalid";
  }

  if (arg === "--format" || arg === "--pretty") {
    return nextValue !== undefined && isSafeFormatString(nextValue)
      ? "skip2"
      : "invalid";
  }

  return "unhandled";
};

const isValidReviewerRevisions = (
  subcommand: "diff" | "log",
  revisions: readonly string[],
  allowWorktreeDiff: boolean
): boolean => {
  const [first, second] = revisions;

  if (subcommand === "diff") {
    if (!allowWorktreeDiff) {
      return revisions.length === 1 && commitRangeArg.test(first ?? "");
    }

    return (
      revisions.length === 0 ||
      (revisions.length === 1 &&
        (commitRangeArg.test(first ?? "") ||
          singleRevisionArg.test(first ?? ""))) ||
      (revisions.length === 2 &&
        singleRevisionArg.test(first ?? "") &&
        singleRevisionArg.test(second ?? ""))
    );
  }

  return (
    revisions.length === 0 ||
    (revisions.length === 1 &&
      (commitRangeArg.test(first ?? "") || singleRevisionArg.test(first ?? "")))
  );
};

const consumeSafeReviewerArg = (
  subcommand: "diff" | "log",
  arg: string,
  nextValue: string | undefined,
  revisions: string[],
  allowWorktreeDiff: boolean
): "invalid" | "skip1" | "skip2" => {
  if (
    safeReviewerGitFlags.has(arg) ||
    /^(?:-U\d+|--unified=\d+)$/u.test(arg) ||
    (allowWorktreeDiff &&
      subcommand === "diff" &&
      (arg === "--cached" || arg === "--staged"))
  ) {
    return "skip1";
  }

  if (arg === "-U") {
    return nextValue !== undefined && /^\d+$/u.test(nextValue)
      ? "skip2"
      : "invalid";
  }

  if (subcommand === "log") {
    const logResult = consumeReviewerLogFlag(arg, nextValue);

    if (logResult !== "unhandled") {
      return logResult;
    }
  }

  if (arg.startsWith("-")) {
    return "invalid";
  }

  revisions.push(arg);

  return "skip1";
};

const extractSafeReviewerGitCommand = (
  command: string
): { readonly subcommand: "diff" | "log"; readonly rest: string[] } | null => {
  const parsed = parseShellScript(command);

  if (
    parsed.malformed ||
    parsed.commands.length !== 1 ||
    parsed.unwrapped.length !== 1
  ) {
    return null;
  }

  const [cmd] = parsed.commands;

  if (
    !cmd ||
    cmd.depth !== 0 ||
    cmd.operatorAfter !== null ||
    cmd.envAssignments.length > 0 ||
    cmd.hasRedirection === true ||
    cmd.words[0]?.text !== "git"
  ) {
    return null;
  }

  const subcommand = cmd.words[1]?.text;

  if (subcommand !== "diff" && subcommand !== "log") {
    return null;
  }

  return { subcommand, rest: cmd.words.slice(2).map(({ text }) => text) };
};

export const isSafeReviewerShellCommand = (
  command: string,
  options?: { readonly allowWorktreeDiff?: boolean }
): boolean => {
  const allowWorktreeDiff = options?.allowWorktreeDiff === true;
  const extracted = extractSafeReviewerGitCommand(command);

  if (extracted === null) {
    return false;
  }

  const { subcommand, rest } = extracted;
  let hasNoExtDiff = false;
  let hasNoTextconv = false;
  let afterDoubleDash = false;
  const revisions: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? "";

    if (afterDoubleDash) {
      if (!isSafeReviewerPathspec(arg)) {
        return false;
      }

      continue;
    }

    if (arg === "--") {
      afterDoubleDash = true;
    } else if (arg === "--no-ext-diff") {
      hasNoExtDiff = true;
    } else if (arg === "--no-textconv") {
      hasNoTextconv = true;
    } else {
      const outcome = consumeSafeReviewerArg(
        subcommand,
        arg,
        rest[index + 1],
        revisions,
        allowWorktreeDiff
      );

      if (outcome === "invalid") {
        return false;
      }

      if (outcome === "skip2") {
        index += 1;
      }
    }
  }

  return (
    hasNoExtDiff &&
    hasNoTextconv &&
    isValidReviewerRevisions(subcommand, revisions, allowWorktreeDiff)
  );
};

export const isSafePairReviewerShellCommand = (command: string): boolean =>
  isSafeReviewerShellCommand(command, { allowWorktreeDiff: false });

type OwnedEvent = Extract<
  OpenCodeEvent,
  {
    type:
      | "session.text.started"
      | "session.retry.scheduled"
      | "permission.asked"
      | "form.created";
  }
>;

const permissionRejectReason = (
  rejectExternal: boolean,
  rejectReviewerShell: boolean,
  allowWorktreeDiff: boolean
): string => {
  if (rejectExternal) {
    return "Access outside the trial repository is disabled in benchmark runs.";
  }

  if (rejectReviewerShell) {
    return allowWorktreeDiff
      ? "Run one foreground git diff --no-ext-diff --no-textconv [<rev>..<rev> | <rev>] or git log --no-ext-diff --no-textconv command per shell call."
      : "Run one foreground git diff --no-ext-diff --no-textconv <rev>..<rev> or git log --no-ext-diff --no-textconv command per shell call.";
  }

  return "Write and execution actions are disabled for read-only reviews.";
};

const pickChildFailure = (
  owned: ReadonlySet<string>,
  rootSessionId: string | null,
  childExecutionFailures: ReadonlyMap<string, ErrorDiagnostic>
): ErrorDiagnostic | null => {
  let fallback: ErrorDiagnostic | null = null;

  for (const id of owned) {
    if (id === rootSessionId) {
      continue;
    }

    const childError = childExecutionFailures.get(id);

    if (childError === undefined) {
      continue;
    }

    if (childError.retryable) {
      return childError;
    }

    fallback ??= childError;
  }

  return fallback;
};

const pickAssistantFailure = (
  rootMessages: readonly SessionMessageInfo[],
  childMessagesBySessionId: ReadonlyMap<string, SessionMessageInfo[]>
): ErrorDiagnostic | null => {
  let fallback: ErrorDiagnostic | null = null;

  for (const messages of [rootMessages, ...childMessagesBySessionId.values()]) {
    const lastAssistant = messages.findLast(
      (message) => message.type === "assistant"
    );

    if (
      lastAssistant?.type === "assistant" &&
      lastAssistant.finish === "error" &&
      lastAssistant.error !== undefined
    ) {
      const candidate = diagnostic(lastAssistant.error);

      if (candidate.retryable) {
        return candidate;
      }

      fallback ??= candidate;
    }
  }

  return fallback;
};

const resolveSessionExitCode = (
  timedOut: boolean,
  interrupted: boolean,
  failure: ErrorDiagnostic | null
): number => {
  if (timedOut) {
    return 124;
  }

  if (interrupted) {
    return 130;
  }

  return failure === null ? 0 : 1;
};

const isOwnedEvent = (event: OpenCodeEvent): event is OwnedEvent =>
  event.type === "session.text.started" ||
  event.type === "session.retry.scheduled" ||
  event.type === "permission.asked" ||
  event.type === "form.created";

const isLifecycleEvent = (
  event: OpenCodeEvent
): event is Extract<
  OpenCodeEvent,
  {
    type:
      | "session.execution.started"
      | "session.execution.succeeded"
      | "session.execution.failed"
      | "session.idle"
      | "session.status";
  }
> =>
  event.type === "session.execution.started" ||
  event.type === "session.execution.succeeded" ||
  event.type === "session.execution.failed" ||
  event.type === "session.idle" ||
  event.type === "session.status";

export const runSession = async ({
  client,
  exitPromise,
  repoDir,
  trialId,
  activeRole,
  modelSpec,
  activeProviderIds,
  prompt,
  wallTimeoutMs,
  readinessTimeoutMs = 10_000,
  signal,
}: RunSessionOptions): Promise<SessionRunResult> => {
  const stop = new AbortController();
  const wall = new AbortController();
  const stream = new AbortController();
  const runSignal = AbortSignal.any([signal, stop.signal, wall.signal]);
  const request = { signal: runSignal };
  const updates = createWakeup();
  const activity = createWakeup();
  const owned = new Set<string>();
  const unowned = new Map<string, OwnedEvent[]>();
  const textStartedMsByMessageId = new Map<string, number>();
  const rootMessages: SessionMessageInfo[] = [];
  const childMessagesBySessionId = new Map<string, SessionMessageInfo[]>();
  let rootSessionId: string | null = null;
  let scheduledRetries = 0;
  let questionFormCount = 0;
  let pendingReplies = 0;
  let connected = false;
  let rootIdle = false;
  let rootActivity = 0;
  let rootInboxPendingAt = -1;
  let streamFailure: ErrorDiagnostic | null = null;
  let executionFailure: ErrorDiagnostic | null = null;
  const childExecutionFailures = new Map<string, ErrorDiagnostic>();
  let failure: ErrorDiagnostic | null = null;

  const timer = setTimeout(() => {
    wall.abort(
      namedError(
        "WallClockTimeoutError",
        "The trial exceeded its wall-clock timeout."
      )
    );
  }, wallTimeoutMs);

  const fail = (error: ErrorDiagnostic): void => {
    if (!runSignal.aborted) {
      failure = error;
      stop.abort();
    }
  };

  const reply = (work: Promise<void>): void => {
    pendingReplies += 1;

    const runReply = async (): Promise<void> => {
      try {
        await work;
      } catch (error) {
        if (error instanceof Error && settledReplyErrors.has(error.name)) {
          return;
        }

        fail(errorDiagnostic(error));
      } finally {
        pendingReplies -= 1;
        activity.notify();
      }
    };

    void runReply();
  };

  const handleOwned = (event: OwnedEvent, sessionID: string): void => {
    if (event.type === "session.text.started") {
      const id = event.data.assistantMessageID;

      if (!textStartedMsByMessageId.has(id)) {
        textStartedMsByMessageId.set(id, event.created);
      }
    } else if (event.type === "session.retry.scheduled") {
      scheduledRetries += 1;
    } else if (event.type === "permission.asked") {
      const rejectExternal = event.data.action === "external_directory";

      const isReviewerSession =
        activeRole === "code-reviewer" ||
        (rootSessionId !== null && sessionID !== rootSessionId);

      const rejectReviewerMutation =
        isReviewerSession &&
        ["edit", "write", "patch", "execute"].includes(event.data.action);

      const allowWorktreeDiff =
        activeRole === "code-reviewer" && sessionID === rootSessionId;

      const rejectReviewerShell =
        isReviewerSession &&
        event.data.action === "shell" &&
        (event.data.resources.length !== 1 ||
          event.data.metadata?.background === true ||
          !isSafeReviewerShellCommand(event.data.resources[0] ?? "", {
            allowWorktreeDiff,
          }));

      if (rejectExternal || rejectReviewerMutation || rejectReviewerShell) {
        reply(
          client.permission.reply(
            {
              sessionID,
              requestID: event.data.id,
              decision: "reject",
              message: permissionRejectReason(
                rejectExternal,
                rejectReviewerShell,
                allowWorktreeDiff
              ),
            },
            request
          )
        );
      } else {
        reply(
          client.permission.reply(
            { sessionID, requestID: event.data.id, decision: "once" },
            request
          )
        );
      }
    } else if (
      event.data.form.fields.some((field) => field.type === "external")
    ) {
      fail(
        diagnostic({
          type: "ExternalFormError",
          message: "External forms are disabled in benchmark runs.",
        })
      );
    } else {
      questionFormCount += 1;
      reply(
        client.session.form.cancel(
          {
            sessionID,
            formID: event.data.form.id,
            message:
              "Interactive questions are disabled in benchmark runs. Make a reasonable, reversible choice within task scope and continue.",
          },
          request
        )
      );
    }
  };

  const own = (sessionID: string): void => {
    if (!owned.has(sessionID)) {
      owned.add(sessionID);

      for (const event of unowned.get(sessionID) ?? []) {
        handleOwned(event, sessionID);
      }

      unowned.delete(sessionID);
    }
  };

  const handleExecutionOrStatusEvent = (
    event: Extract<
      OpenCodeEvent,
      {
        type:
          | "session.execution.started"
          | "session.execution.succeeded"
          | "session.execution.failed"
          | "session.idle"
          | "session.status";
      }
    >
  ): void => {
    if (event.data.sessionID === rootSessionId) {
      rootIdle =
        event.type === "session.idle" ||
        event.type === "session.execution.succeeded" ||
        event.type === "session.execution.failed" ||
        (event.type === "session.status" && event.data.status.type === "idle");
      rootActivity += 1;

      if (event.type === "session.execution.failed") {
        executionFailure = diagnostic(event.data.error);
      } else if (
        event.type === "session.execution.succeeded" ||
        event.type === "session.execution.started"
      ) {
        executionFailure = null;
      }

      activity.notify();

      return;
    }

    if (event.type === "session.execution.failed") {
      childExecutionFailures.set(
        event.data.sessionID,
        diagnostic(event.data.error)
      );
    } else if (
      event.type === "session.execution.succeeded" ||
      event.type === "session.execution.started"
    ) {
      childExecutionFailures.delete(event.data.sessionID);
    }
  };

  const onEvent = (event: OpenCodeEvent): void => {
    if (event.type === "server.connected") {
      connected = true;
      activity.notify();
    } else if (
      event.type === "agent.updated" ||
      event.type === "provider.updated"
    ) {
      updates.notify();
    } else if (isOwnedEvent(event)) {
      const sessionID =
        event.type === "form.created"
          ? event.data.form.sessionID
          : event.data.sessionID;

      if (owned.has(sessionID)) {
        handleOwned(event, sessionID);
      } else if (rootSessionId !== null) {
        const pending = unowned.get(sessionID) ?? [];
        pending.push(event);
        unowned.set(sessionID, pending);
        activity.notify();
      }
    } else if (
      event.type === "session.inbox.enqueued" ||
      event.type === "session.inbox.delivered" ||
      event.type === "session.inbox.cancelled"
    ) {
      if (event.data.sessionID === rootSessionId) {
        rootActivity += 1;
        activity.notify();
      }
    } else if (isLifecycleEvent(event)) {
      handleExecutionOrStatusEvent(event);
    }
  };

  const consumeEvents = async (): Promise<void> => {
    const eventSignal = AbortSignal.any([runSignal, stream.signal]);

    let disconnected = diagnostic({
      type: "PrematureSseDisconnectError",
      message: "The OpenCode event stream closed before quiescence.",
    });

    try {
      for await (const event of client.event.subscribe({
        signal: eventSignal,
      })) {
        onEvent(event);
      }
    } catch (error) {
      disconnected = errorDiagnostic(error);
    }

    if (!eventSignal.aborted) {
      streamFailure = disconnected;

      if (!rootIdle) {
        fail(disconnected);
      }

      activity.notify();
    }
  };

  const events = consumeEvents();
  let quiescent = false;

  const watchServerExit = async (): Promise<void> => {
    if (exitPromise === undefined) {
      return;
    }

    try {
      const code = await exitPromise;

      if (!quiescent && !stream.signal.aborted) {
        fail(
          diagnostic({
            type:
              code === 0
                ? "PrematureSseDisconnectError"
                : "UnexpectedServerExitError",
            message: `OpenCode exited before quiescence (code ${code}).`,
          })
        );
      }
    } catch (error) {
      fail(errorDiagnostic(error));
    }
  };

  void watchServerExit();

  const discoverChildren = async (
    sessionID: string,
    pollSignal: AbortSignal
  ): Promise<boolean> => {
    const jobs = await client.experimental.job.list(
      { sessionID, descendants: true },
      { signal: pollSignal }
    );

    let running = false;

    for (const job of jobs) {
      if (job.kind === "subagent") {
        own(job.childSessionID);
      }

      running ||= job.status === "running";
    }

    return running;
  };

  const waitUntilConnected = async (bounded: AbortSignal): Promise<void> => {
    if (connected) {
      return;
    }

    await waitForPoll(bounded, activity.current());
    await waitUntilConnected(bounded);
  };

  const checkQuiescent = async (
    id: string,
    generation: number
  ): Promise<boolean> => {
    const running = await discoverChildren(id, runSignal);

    if (!rootIdle) {
      return false;
    }

    const [rootInbox, ...childInboxes] = await Promise.all([
      client.session.inbox.list({ sessionID: id }, request),
      ...owned
        .values()
        .flatMap((sessionID) =>
          sessionID === id
            ? []
            : [client.session.inbox.list({ sessionID }, request)]
        ),
    ]);

    runSignal.throwIfAborted();

    if (rootInbox.length > 0) {
      rootInboxPendingAt = generation;

      return false;
    }

    if (
      !(
        rootIdle &&
        generation === rootActivity &&
        rootActivity > rootInboxPendingAt &&
        !running &&
        pendingReplies === 0 &&
        childInboxes.every((items) => items.length === 0)
      )
    ) {
      return false;
    }

    // An inbox item can be consumed before its SSE delivery or busy event reaches us.
    const active = await client.session.active(request);
    runSignal.throwIfAborted();

    return (
      !Object.hasOwn(active, id) &&
      generation === rootActivity &&
      pendingReplies === 0
    );
  };

  const waitForQuiescence = async (id: string): Promise<void> => {
    for (;;) {
      runSignal.throwIfAborted();
      const wakeup = activity.current();
      const generation = rootActivity;

      if (
        (rootIdle || unowned.size > 0) &&
        // oxlint-disable-next-line no-await-in-loop -- Long-lived session polling must be iterative to keep memory O(1) across multi-minute trials.
        (await checkQuiescent(id, generation))
      ) {
        quiescent = true;
        failure = executionFailure;

        return;
      }

      if (streamFailure !== null) {
        fail(streamFailure);
      }

      // oxlint-disable-next-line no-await-in-loop -- Long-lived session polling must be iterative to keep memory O(1) across multi-minute trials.
      await waitForPoll(runSignal, wakeup);
    }
  };

  try {
    await readiness(runSignal, readinessTimeoutMs, waitUntilConnected);

    const model = parseModelRef(modelSpec);
    await waitForLocationReady(
      client,
      repoDir,
      new Set([model.providerID, ...activeProviderIds]),
      runSignal,
      readinessTimeoutMs,
      updates.current
    );

    const { id } = await client.session.create(
      {
        agent: activeRole,
        model,
        location: { directory: repoDir },
        title: `eval-${trialId}`,
      },
      request
    );

    rootSessionId = id;
    own(id);
    await client.session.prompt({ sessionID: id, text: prompt }, request);
    await waitForQuiescence(id);
  } catch (error) {
    failure ??= errorDiagnostic(runSignal.aborted ? runSignal.reason : error);
  } finally {
    clearTimeout(timer);
    stream.abort();
    await events;
  }

  const timedOut = wall.signal.aborted;
  const abortedBeforeQuiescence = !quiescent && !timedOut && signal.aborted;
  let sentInterrupt = false;

  const interrupt = async (
    sessionID: string,
    timeoutMs = 1000
  ): Promise<void> => {
    sentInterrupt = true;

    try {
      await client.session.interrupt(
        { sessionID },
        { signal: AbortSignal.timeout(timeoutMs) }
      );
    } catch {
      // Ignore interrupt errors during teardown.
    }
  };

  const collectAfterRun = async (sessionID: string): Promise<void> => {
    if (abortedBeforeQuiescence) {
      await interrupt(sessionID, 500);

      return;
    }

    const cleanupSignal = AbortSignal.timeout(3000);

    if (!quiescent) {
      if (
        timedOut ||
        signal.aborted ||
        failure?.errorType === "ExternalFormError"
      ) {
        await interrupt(sessionID);
      }

      // The last job snapshot can contain children not seen before cancellation.
      try {
        await discoverChildren(sessionID, cleanupSignal);
      } catch {
        // Ignore child discovery errors during teardown.
      }
    }

    const collected = await Promise.allSettled(
      Array.from(owned, async (id) => {
        const messages: SessionMessageInfo[] =
          id === sessionID ? rootMessages : [];

        if (id !== sessionID) {
          childMessagesBySessionId.set(id, messages);
        }

        await collectSessionMessages(client, id, cleanupSignal, messages);
      })
    );

    for (const result of collected) {
      if (result.status === "rejected") {
        failure ??= errorDiagnostic(result.reason);
      }
    }
  };

  if (rootSessionId !== null) {
    await collectAfterRun(rootSessionId);
  }

  failure ??= pickChildFailure(owned, rootSessionId, childExecutionFailures);
  failure ??= pickAssistantFailure(rootMessages, childMessagesBySessionId);

  const interrupted = !timedOut && signal.aborted;

  if (interrupted) {
    if (!sentInterrupt && rootSessionId !== null) {
      await interrupt(rootSessionId);
    }

    failure = diagnostic({
      type: "AbortError",
      message: "The trial was interrupted.",
    });
  }

  return {
    rootSessionId,
    rootMessages,
    childMessagesBySessionId,
    textStartedMsByMessageId,
    scheduledRetries,
    questionFormCount,
    timedOut,
    interrupted,
    exitCode: resolveSessionExitCode(timedOut, interrupted, failure),
    errorDiagnostic: failure,
  };
};
