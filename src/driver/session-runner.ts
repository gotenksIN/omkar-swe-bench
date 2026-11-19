import {
  ClientError,
  type MessageListInput,
  type OpenCodeClient,
  type OpenCodeEvent,
  type SessionMessageInfo,
  type SessionStructuredError,
} from "@opencode/client";
import { setTimeout as delay } from "node:timers/promises";

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
  readonly childMessagesBySessionId: ReadonlyMap<string, readonly SessionMessageInfo[]>;
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
  "ModelNotFoundError", "UnsupportedModelError", "AgentNotFoundError", "ConfigInvalidError",
  "SchemaError", "SchemaValidationError", "ValidationError", "ParseError", "MalformedResponse",
  "UnsupportedContentType", "SseEventTooLarge", "ExternalFormError", "WallClockTimeoutError", "AbortError",
  "InvalidRequestError", "UnauthorizedError", "ForbiddenError", "SandboxLaunchError",
]);

const transientErrors = new Set([
  "Transport", "PrematureSseDisconnectError", "UnexpectedServerExitError", "ReadinessTimeoutError",
  "ServerStartupError", "OverloadedError", "RateLimitError",
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET", "fetch failed",
]);

// The client preserves the declared error tag, but not its HTTP status.
const declaredStatuses = new Map([
  ["InvalidRequestError", 400], ["UnauthorizedError", 401], ["ForbiddenError", 403],
  ["InternalServerError", 500], ["ServiceUnavailableError", 503],
]);

export function isRetryableApiFailure({ status, errorType, message }: Omit<ErrorDiagnostic, "retryable" | "retryAfterMs">): boolean {
  if (terminalErrors.has(errorType) || (status !== null && [400, 401, 403, 404, 422].includes(status))) {
    return false;
  }

  return (status !== null && ([408, 429, 500, 502, 503, 504].includes(status) || (status >= 520 && status <= 529)))
    || transientErrors.has(errorType)
    || /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|UND_ERR_SOCKET|fetch failed)\b/u.test(message);
}

function diagnostic({ type: errorType, message, status, retryAfterMs }: SessionStructuredError): ErrorDiagnostic {
  const fields = { errorType, message, status: status ?? null };

  return { ...fields, retryAfterMs: retryAfterMs ?? null, retryable: isRetryableApiFailure(fields) };
}

function hasStatus(value: unknown): value is { status: number } {
  const boxed: object = Object(value);

  return value === boxed && "status" in boxed && Number.isFinite(boxed.status);
}

export function errorDiagnostic(cause: unknown): ErrorDiagnostic {
  if (!(cause instanceof Error)) {
    return diagnostic({ type: "Error", message: String(cause) });
  }

  const details: SessionStructuredError = {
    type: cause instanceof ClientError ? cause.reason : cause.name,
    message: cause.message,
  };

  if (hasStatus(cause)) {
    details.status = cause.status;
  } else if (cause instanceof ClientError && cause.reason === "UnexpectedStatus" && hasStatus(cause.cause)) {
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
}

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;

  return error;
}

// Rotate the signal on each event so a wakeup during an HTTP request is not lost.
function createWakeup() {
  let controller = new AbortController();

  return {
    current: () => controller.signal,
    notify: (): void => {
      controller.abort();
      controller = new AbortController();
    },
  };
}

async function waitForPoll(signal: AbortSignal, wakeup?: AbortSignal): Promise<void> {
  try {
    await delay(50, undefined, { signal: wakeup === undefined ? signal : AbortSignal.any([signal, wakeup]) });
  } catch (cause) {
    signal.throwIfAborted();

    if (!wakeup?.aborted) {
      throw cause;
    }
  }
}

async function readiness<T>(signal: AbortSignal, timeoutMs: number, work: (boundedSignal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const bounded = AbortSignal.any([signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await work(bounded);
  } catch (cause) {
    if (controller.signal.aborted && !signal.aborted) {
      throw namedError("ReadinessTimeoutError", "Timed out waiting for OpenCode readiness.");
    }

    throw cause;
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForLocationReady(
  client: OpenCodeClient,
  repoDir: string,
  activeProviderIds: Iterable<string>,
  signal: AbortSignal,
  timeoutMs = 10_000,
  wakeup?: () => AbortSignal,
): Promise<void> {
  const providers = new Set(activeProviderIds);
  const location = { directory: repoDir };

  await readiness(signal, timeoutMs, async (bounded) => {
    for (;;) {
      bounded.throwIfAborted();

      const nextUpdate = wakeup?.();

      const [agents, configuredProviders] = await Promise.all([
        client.agent.list({ location }, { signal: bounded }),
        client.provider.list({ location }, { signal: bounded }),
      ]);

      const agentIds = new Set(agents.data.map(({ id }) => id));
      const providerIds = new Set(configuredProviders.data.map(({ id }) => id));

      if (agentIds.has("coder") && agentIds.has("code-reviewer") && providers.values().every((id) => providerIds.has(id))) {
        return;
      }

      await waitForPoll(bounded, nextUpdate);
    }
  });
}

async function collectSessionMessages(
  client: OpenCodeClient, sessionID: string, signal: AbortSignal, messages: SessionMessageInfo[],
): Promise<void> {
  const request = { sessionID, limit: 200, order: "asc" } satisfies MessageListInput;
  const visited = new Set<string>();
  let cursor: string | undefined;

  do {
    const page = await client.message.list(cursor === undefined ? request : { ...request, cursor }, { signal });

    for (const message of page.data) {
      messages.push(message);
    }

    cursor = page.cursor.next ?? undefined;

    if (cursor !== undefined) {
      if (visited.has(cursor)) {
        return;
      }

      visited.add(cursor);
    }
  } while (cursor !== undefined);
}

const safeReviewerGitFlags = new Set([
  "--stat", "--numstat", "--shortstat", "--name-only", "--name-status", "--summary",
  "--patch", "-p", "-u", "--raw", "--oneline", "--graph", "--decorate", "--no-decorate",
  "--abbrev-commit", "--no-abbrev-commit", "--no-renames", "-M", "-C", "-B",
  "--find-renames", "--find-copies", "--full-index", "--color=never", "--no-color",
]);

const commitRangeArg = /^[0-9a-fA-F]{4,40}\.\.(?:HEAD|[0-9a-fA-F]{4,40})$/u;
const singleRevisionArg = /^(?:HEAD|[0-9a-fA-F]{4,40})$/u;
const safeFormatValue = /^[A-Za-z0-9%x\t _:-]+$/u;

export function isSafePairReviewerShellCommand(command: string): boolean {
  const parsed = parseShellScript(command);

  if (parsed.malformed || parsed.commands.length !== 1 || parsed.unwrapped.length !== 1) {
    return false;
  }

  const [cmd] = parsed.commands;

  if (!cmd || cmd.depth !== 0 || cmd.operatorAfter !== null || cmd.envAssignments.length > 0 || cmd.hasRedirection) {
    return false;
  }

  if (cmd.words[0]?.text !== "git") {
    return false;
  }

  const subcommand = cmd.words[1]?.text;

  if (subcommand !== "diff" && subcommand !== "log") {
    return false;
  }

  const rest = cmd.words.slice(2).map(({ text }) => text);
  let hasNoExtDiff = false;
  let hasNoTextconv = false;
  let afterDoubleDash = false;
  const revisions: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? "";

    if (afterDoubleDash) {
      if (!arg || arg.startsWith("/") || arg.startsWith(":(") || arg.split("/").includes("..")) {
        return false;
      }

      continue;
    }

    if (arg === "--") {
      afterDoubleDash = true;
      continue;
    }

    if (arg === "--no-ext-diff") {
      hasNoExtDiff = true;
      continue;
    }

    if (arg === "--no-textconv") {
      hasNoTextconv = true;
      continue;
    }

    if (safeReviewerGitFlags.has(arg) || /^(?:-U\d+|--unified=\d+)$/u.test(arg)) {
      continue;
    }

    if (arg === "-U") {
      const value = rest[index + 1];

      if (value === undefined || !/^\d+$/u.test(value)) return false;

      index += 1;
      continue;
    }

    if (subcommand === "log") {
      if (/^(?:-\d+|-n\d+|--max-count=\d+)$/u.test(arg)) {
        continue;
      }

      if (arg === "-n" || arg === "--max-count") {
        const value = rest[index + 1];

        if (value === undefined || !/^\d+$/u.test(value)) return false;

        index += 1;
        continue;
      }

      const inlineFormat = /^--(?:format|pretty)=(.*)$/u.exec(arg);

      if (inlineFormat?.[1] !== undefined) {
        if (!safeFormatValue.test(inlineFormat[1]) || /%[^A-Za-z]*G/u.test(inlineFormat[1])) return false;

        continue;
      }

      if (arg === "--format" || arg === "--pretty") {
        const value = rest[index + 1];

        if (value === undefined || !safeFormatValue.test(value) || /%[^A-Za-z]*G/u.test(value)) return false;

        index += 1;
        continue;
      }
    }

    if (arg.startsWith("-")) {
      return false;
    }

    revisions.push(arg);
  }

  if (!hasNoExtDiff || !hasNoTextconv) {
    return false;
  }

  if (subcommand === "diff") {
    return revisions.length === 1 && commitRangeArg.test(revisions[0] ?? "");
  }

  return revisions.length === 0
    || (revisions.length === 1 && (commitRangeArg.test(revisions[0] ?? "") || singleRevisionArg.test(revisions[0] ?? "")));
}

type OwnedEvent = Extract<OpenCodeEvent, {
  type: "session.text.started" | "session.retry.scheduled" | "permission.asked" | "form.created";
}>;

export async function runSession({
  client, exitPromise, repoDir, trialId, activeRole, modelSpec, activeProviderIds, prompt,
  wallTimeoutMs, readinessTimeoutMs = 10_000, signal,
}: RunSessionOptions): Promise<SessionRunResult> {
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
    wall.abort(namedError("WallClockTimeoutError", "The trial exceeded its wall-clock timeout."));
  }, wallTimeoutMs);

  function fail(error: ErrorDiagnostic): void {
    if (!runSignal.aborted) {
      failure = error;
      stop.abort();
    }
  }

  function reply(work: Promise<void>): void {
    pendingReplies += 1;
    void work.catch((cause) => fail(errorDiagnostic(cause))).finally(() => {
      pendingReplies -= 1;
      activity.notify();
    });
  }

  function handleOwned(event: OwnedEvent, sessionID: string): void {
    if (event.type === "session.text.started") {
      const id = event.data.assistantMessageID;

      if (!textStartedMsByMessageId.has(id)) {
        textStartedMsByMessageId.set(id, event.created);
      }
    } else if (event.type === "session.retry.scheduled") {
      scheduledRetries += 1;
    } else if (event.type === "permission.asked") {
      const rejectExternal = event.data.action === "external_directory";
      const isReviewerSession = activeRole === "code-reviewer" || (rootSessionId !== null && sessionID !== rootSessionId);
      const rejectReviewerMutation = isReviewerSession && ["edit", "write", "patch", "execute"].includes(event.data.action);

      const rejectReviewerShell = isReviewerSession && event.data.action === "shell"
        && (
          event.data.resources.length !== 1
          || event.data.metadata?.background === true
          || !isSafePairReviewerShellCommand(event.data.resources[0] ?? "")
        );

      if (rejectExternal || rejectReviewerMutation || rejectReviewerShell) {
        reply(client.permission.reply({
          sessionID,
          requestID: event.data.id,
          decision: "reject",
          message: rejectExternal
            ? "Access outside the trial repository is disabled in benchmark runs."
            : rejectReviewerShell
              ? "Run one foreground git diff --no-ext-diff --no-textconv <rev>..<rev> or git log --no-ext-diff --no-textconv command per shell call."
              : "Write and execution actions are disabled for read-only reviews.",
        }, request));
      } else {
        reply(client.permission.reply({ sessionID, requestID: event.data.id, decision: "once" }, request));
      }
    } else if (event.data.form.fields.some((field) => field.type === "external")) {
      fail(diagnostic({ type: "ExternalFormError", message: "External forms are disabled in benchmark runs." }));
    } else {
      questionFormCount += 1;
      reply(client.session.form.cancel({
        sessionID, formID: event.data.form.id,
        message: "Interactive questions are disabled in benchmark runs. Make a reasonable, reversible choice within task scope and continue.",
      }, request));
    }
  }

  function own(sessionID: string): void {
    if (!owned.has(sessionID)) {
      owned.add(sessionID);

      for (const event of unowned.get(sessionID) ?? []) {
        handleOwned(event, sessionID);
      }

      unowned.delete(sessionID);
    }
  }

  function onEvent(event: OpenCodeEvent): void {
    switch (event.type) {
      case "server.connected":
        connected = true;
        activity.notify();
        break;
      case "agent.updated":
      case "provider.updated":
        updates.notify();
        break;
      case "session.text.started":
      case "session.retry.scheduled":
      case "permission.asked":
      case "form.created": {
        const sessionID = event.type === "form.created" ? event.data.form.sessionID : event.data.sessionID;

        if (owned.has(sessionID)) {
          handleOwned(event, sessionID);
        } else if (rootSessionId !== null) {
          const pending = unowned.get(sessionID) ?? [];
          pending.push(event);
          unowned.set(sessionID, pending);
          activity.notify();
        }

        break;
      }

      case "session.inbox.enqueued":
      case "session.inbox.delivered":
      case "session.inbox.cancelled":
        if (event.data.sessionID === rootSessionId) {
          rootActivity += 1;
          activity.notify();
        }

        break;
      case "session.execution.started":
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.idle":
      case "session.status":
        if (event.data.sessionID === rootSessionId) {
          rootIdle = event.type === "session.idle" || event.type === "session.execution.succeeded"
            || event.type === "session.execution.failed" || (event.type === "session.status" && event.data.status.type === "idle");
          rootActivity += 1;

          if (event.type === "session.execution.failed") {
            executionFailure = diagnostic(event.data.error);
          } else if (event.type === "session.execution.succeeded" || event.type === "session.execution.started") {
            executionFailure = null;
          }

          activity.notify();
        } else if (event.type === "session.execution.failed") {
          childExecutionFailures.set(event.data.sessionID, diagnostic(event.data.error));
        } else if (event.type === "session.execution.succeeded" || event.type === "session.execution.started") {
          childExecutionFailures.delete(event.data.sessionID);
        }

        break;
    }
  }

  async function consumeEvents(): Promise<void> {
    const eventSignal = AbortSignal.any([runSignal, stream.signal]);
    let disconnected = diagnostic({ type: "PrematureSseDisconnectError", message: "The OpenCode event stream closed before quiescence." });

    try {
      for await (const event of client.event.subscribe({ signal: eventSignal })) {
        onEvent(event);
      }
    } catch (cause) {
      disconnected = errorDiagnostic(cause);
    }

    if (!eventSignal.aborted) {
      streamFailure = disconnected;

      if (!rootIdle) {
        fail(disconnected);
      }

      activity.notify();
    }
  }

  const events = consumeEvents();
  let quiescent = false;

  void exitPromise?.then((code) => {
    if (!quiescent && !stream.signal.aborted) {
      fail(diagnostic({
        type: code === 0 ? "PrematureSseDisconnectError" : "UnexpectedServerExitError",
        message: `OpenCode exited before quiescence (code ${code}).`,
      }));
    }
  }).catch((cause) => fail(errorDiagnostic(cause)));

  async function discoverChildren(sessionID: string, pollSignal: AbortSignal): Promise<boolean> {
    const jobs = await client.experimental.job.list({ sessionID, descendants: true }, { signal: pollSignal });
    let running = false;

    for (const job of jobs) {
      if (job.kind === "subagent") {
        own(job.childSessionID);
      }

      running ||= job.status === "running";
    }

    return running;
  }

  try {
    await readiness(runSignal, readinessTimeoutMs, async (bounded) => {
      while (!connected) {
        await waitForPoll(bounded, activity.current());
      }
    });

    const model = parseModelRef(modelSpec);
    await waitForLocationReady(
      client, repoDir, new Set([model.providerID, ...activeProviderIds]), runSignal, readinessTimeoutMs, updates.current,
    );

    const { id } = await client.session.create({
      agent: activeRole, model, location: { directory: repoDir }, title: `eval-${trialId}`,
    }, request);

    rootSessionId = id;
    own(id);
    await client.session.prompt({ sessionID: id, text: prompt }, request);

    for (;;) {
      runSignal.throwIfAborted();
      const wakeup = activity.current();
      const generation = rootActivity;

      if (rootIdle || unowned.size > 0) {
        const running = await discoverChildren(id, runSignal);

        if (rootIdle) {
          const [rootInbox, ...childInboxes] = await Promise.all([
            client.session.inbox.list({ sessionID: id }, request),
            ...owned.values().flatMap((sessionID) => sessionID === id ? [] : [client.session.inbox.list({ sessionID }, request)]),
          ]);

          runSignal.throwIfAborted();

          if (rootInbox.length > 0) {
            rootInboxPendingAt = generation;
          } else if (rootIdle && generation === rootActivity && rootActivity > rootInboxPendingAt
            && !running && pendingReplies === 0 && childInboxes.every((items) => items.length === 0)) {
            // An inbox item can be consumed before its SSE delivery or busy event reaches us.
            const active = await client.session.active(request);
            runSignal.throwIfAborted();

            if (!Object.hasOwn(active, id) && generation === rootActivity && pendingReplies === 0) {
              quiescent = true;
              failure = executionFailure;
              break;
            }
          }
        }
      }

      if (streamFailure !== null) {
        fail(streamFailure);
      }

      await waitForPoll(runSignal, wakeup);
    }
  } catch (cause) {
    failure ??= errorDiagnostic(runSignal.aborted ? runSignal.reason : cause);
  } finally {
    clearTimeout(timer);
    stream.abort();
    await events;
  }

  const timedOut = wall.signal.aborted;
  const abortedBeforeQuiescence = !quiescent && !timedOut && signal.aborted;
  let sentInterrupt = false;

  async function interrupt(sessionID: string, timeoutMs = 1_000): Promise<void> {
    sentInterrupt = true;
    await client.session.interrupt({ sessionID }, { signal: AbortSignal.timeout(timeoutMs) }).catch(() => {});
  }

  if (rootSessionId !== null) {
    const sessionID = rootSessionId;

    if (abortedBeforeQuiescence) {
      await interrupt(sessionID, 500);
    } else {
      const cleanupSignal = AbortSignal.timeout(3_000);

      if (!quiescent) {
        if (timedOut || signal.aborted || failure?.errorType === "ExternalFormError") {
          await interrupt(sessionID);
        }

        // The last job snapshot can contain children not seen before cancellation.
        await discoverChildren(sessionID, cleanupSignal).catch(() => {});
      }

      const collected = await Promise.allSettled(Array.from(owned, (id) => {
        const messages: SessionMessageInfo[] = id === sessionID ? rootMessages : [];

        if (id !== sessionID) {
          childMessagesBySessionId.set(id, messages);
        }

        return collectSessionMessages(client, id, cleanupSignal, messages);
      }));

      for (const result of collected) {
        if (result.status === "rejected") {
          failure ??= errorDiagnostic(result.reason);
        }
      }
    }
  }

  if (failure === null) {
    let fallbackChildFailure: ErrorDiagnostic | null = null;

    for (const id of owned) {
      if (id === rootSessionId) {
        continue;
      }

      const childError = childExecutionFailures.get(id);

      if (childError === undefined) {
        continue;
      }

      if (childError.retryable) {
        failure = childError;
        break;
      }

      fallbackChildFailure ??= childError;
    }

    failure ??= fallbackChildFailure;
  }

  if (failure === null) {
    for (const messages of [rootMessages, ...childMessagesBySessionId.values()]) {
      const lastAssistant = messages.findLast((message) => message.type === "assistant");

      if (lastAssistant?.type === "assistant" && lastAssistant.finish === "error" && lastAssistant.error !== undefined) {
        const candidate = diagnostic(lastAssistant.error);

        if (candidate.retryable || failure === null) {
          failure = candidate;

          if (candidate.retryable) {
            break;
          }
        }
      }
    }
  }

  const interrupted = !timedOut && signal.aborted;

  if (interrupted) {
    if (!sentInterrupt && rootSessionId !== null) {
      await interrupt(rootSessionId);
    }

    failure = diagnostic({ type: "AbortError", message: "The trial was interrupted." });
  }

  return {
    rootSessionId, rootMessages, childMessagesBySessionId, textStartedMsByMessageId, scheduledRetries, questionFormCount,
    timedOut, interrupted, exitCode: timedOut ? 124 : interrupted ? 130 : failure === null ? 0 : 1,
    errorDiagnostic: failure,
  };
}
