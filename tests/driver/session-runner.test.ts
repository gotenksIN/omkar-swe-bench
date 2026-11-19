import { OpenCode } from "@opencode/client";
import { expect, test } from "bun:test";

import { isRetryableApiFailure, isSafePairReviewerShellCommand, runSession } from "../../src/driver/session-runner.ts";
import { parseJsonText, type JsonObject } from "../../src/util/json.ts";

const repoDir = "/tmp/opencode/session-fixture";
const idle = (id: string): JsonObject => ({ id, type: "idle", time: { created: 1_000 } });

function fakeOpenCode(
  scenario:
    | "complete"
    | "report-race"
    | "active-overlap-no-sse"
    | "child-failure"
    | "external"
    | "timeout"
    | "disconnected"
    | "not-connected",
) {
  const calls: string[] = [];
  const actions: JsonObject[] = [];
  let events: ReadableStreamDefaultController<string> | undefined;
  let sequence = 0;
  let initialized = false;
  let polls = 0;
  let providersReady = false;
  let agentsReady = false;
  let interrupts = 0;
  let processingReport = scenario === "report-race" || scenario === "active-overlap-no-sse";
  let messagesGate: Promise<void> | undefined;

  function emit(type: string, data: JsonObject = {}, created = 1_500): void {
    sequence += 1;
    events?.enqueue(`data: ${JSON.stringify({
      id: `event-${sequence}`, type, created, data, durable: { aggregateID: "root", seq: sequence, version: 1 },
    })}\n\n`);
  }

  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const { pathname, searchParams } = new URL(request.url);
      calls.push(`${request.method} ${pathname}`);

      switch (pathname) {
        case "/api/event":
          return new Response(new ReadableStream({
            start(controller) {
              events = controller;

              if (scenario !== "not-connected") {
                setTimeout(() => {
                  initialized = true;
                  emit("server.connected");
                }, 20);
              }
            },
            cancel() {
              events = undefined;
            },
          }), { headers: { "content-type": "text/event-stream" } });
        case "/api/agent": {
          expect(initialized).toBe(true);
          expect(searchParams.get("location[directory]")).toBe(repoDir);
          const data = agentsReady ? [{ id: "coder" }, { id: "code-reviewer" }] : [{ id: "coder" }];

          if (!agentsReady) {
            agentsReady = true;
            emit("agent.updated");
          }

          return Response.json({ data });
        }

        case "/api/provider": {
          expect(initialized).toBe(true);
          expect(searchParams.get("location[directory]")).toBe(repoDir);
          const data = providersReady ? [{ id: "synthetic" }, { id: "review" }] : [{ id: "synthetic" }];

          if (!providersReady) {
            providersReady = true;
            emit("provider.updated");
          }

          return Response.json({ data });
        }

        case "/api/session":
          expect(calls.filter((call) => call === "GET /api/agent").length).toBeGreaterThanOrEqual(2);
          expect(calls.filter((call) => call === "GET /api/provider").length).toBeGreaterThanOrEqual(2);
          expect(parseJsonText(await request.text())).toEqual({
            agent: "coder", model: { id: "test-model", providerID: "synthetic", variant: "fast" },
            location: { directory: repoDir }, title: "eval-fixture",
          });

          return Response.json({ data: { id: "root" } });
        case "/api/session/root/prompt":
          expect(parseJsonText(await request.text())).toEqual({ text: "Synthetic task" });

          if (scenario === "disconnected") {
            events?.close();
            events = undefined;
          } else if (scenario === "external") {
            emit("form.created", { form: {
              id: "oauth", sessionID: "root", title: "Login",
              fields: [{ type: "external", key: "login", url: "http://127.0.0.1/oauth" }],
            } });
          } else if (scenario === "complete") {
            emit("permission.asked", { id: "ask", sessionID: "child", action: "edit", resources: ["fixture"] });
            emit("permission.asked", { id: "ask-ext", sessionID: "root", action: "external_directory", resources: ["/etc/passwd"] });
            emit("session.text.started", { sessionID: "root", assistantMessageID: "answer", ordinal: 0 }, 1_520);
            emit("session.text.started", { sessionID: "root", assistantMessageID: "answer", ordinal: 1 }, 1_620);
            emit("session.retry.scheduled", { sessionID: "child", assistantMessageID: "child-answer", attempt: 1 });
            emit("form.created", { form: {
              id: "question", sessionID: "root", title: "Continue?", fields: [{ type: "boolean", key: "continue" }],
            } });
            emit("session.idle", { sessionID: "root" });
          } else if (scenario === "report-race" || scenario === "active-overlap-no-sse") {
            emit("session.idle", { sessionID: "root" });
          } else if (scenario === "child-failure") {
            emit("session.execution.failed", {
              sessionID: "child",
              error: { type: "ServiceUnavailableError", status: 503, message: "Upstream busy" },
            });
            emit("session.idle", { sessionID: "root" });
          }

          return Response.json({ data: {} });
        case "/api/session/child/permission/ask/reply":
          expect(parseJsonText(await request.text())).toMatchObject({ decision: "reject" });
          actions.push({ type: "permission" });

          return new Response(null, { status: 204 });
        case "/api/session/root/permission/ask-ext/reply":
          expect(parseJsonText(await request.text())).toMatchObject({ decision: "reject" });
          actions.push({ type: "permission-reject" });

          return new Response(null, { status: 204 });
        case "/api/session/root/form/question":
          expect(request.method).toBe("DELETE");
          expect(searchParams.get("message")).toContain("Make a reasonable, reversible choice");
          actions.push({ type: "form" });

          return new Response(null, { status: 204 });
        case "/api/experimental/job":
          expect(searchParams.get("sessionID")).toBe("root");
          expect(searchParams.get("descendants")).toBe("true");
          polls += 1;

          return Response.json({ data: scenario === "complete" || scenario === "report-race" || scenario === "child-failure" ? [
            { id: "job", kind: "subagent", sessionID: "root", childSessionID: "child", status: scenario === "complete" && polls === 1 ? "running" : "completed" },
            ...(polls >= 2 ? [{ id: "nested", kind: "subagent", sessionID: "child", childSessionID: "grandchild", status: "completed" }] : []),
          ] : [] });
        case "/api/session/active":
          if (processingReport) {
            processingReport = false;

            if (scenario === "report-race") {
              setTimeout(() => {
                emit("session.inbox.delivered", { sessionID: "root", inboxID: "child-report" });
                emit("session.execution.succeeded", { sessionID: "root" });
              }, 20);
            }

            return Response.json({ data: { root: { type: "running" } } });
          }

          return Response.json({ data: {} });
        case "/api/session/root/inbox":
          if (scenario === "report-race" || scenario === "active-overlap-no-sse" || scenario === "child-failure") {
            return Response.json({ data: [] });
          }

          if (polls <= 2) {
            return Response.json({ data: [{ id: "child-report" }] });
          }

          if (polls === 3) {
            emit("session.inbox.delivered", { sessionID: "root", inboxID: "child-report" });
            emit("session.status", { sessionID: "root", status: { type: "busy" } });
            setTimeout(() => emit("session.execution.succeeded", { sessionID: "root" }), 20);
          }

          return Response.json({ data: [] });
        case "/api/session/child/inbox":
        case "/api/session/grandchild/inbox":
          return Response.json({ data: [] });
        case "/api/session/root/message":
        case "/api/session/child/message":
        case "/api/session/grandchild/message": {
          expect(searchParams.get("limit")).toBe("200");
          expect(searchParams.get("order")).toBe("asc");

          if (pathname === "/api/session/root/message") {
            const cursor = searchParams.get("cursor");
            expect([null, "page-2"]).toContain(cursor);

            if (scenario === "report-race" && cursor !== null) {
              await messagesGate;
            }

            return Response.json({
              data: [idle(cursor === null ? "first" : "second")],
              cursor: { next: "page-2" },
            });
          }

          return Response.json({ data: [idle(pathname.includes("grandchild") ? "nested" : "review")], cursor: { next: null } });
        }

        case "/api/session/root/interrupt":
          interrupts += 1;

          return Response.json({ interrupted: true });
        default:
          return new Response(null, { status: 404 });
      }
    },
  });

  return {
    server, calls, actions, polls: () => polls, interrupts: () => interrupts,
    holdSecondPage: (gate: Promise<void>): void => {
      messagesGate = gate;
    },
    run: (wallTimeoutMs = 2_000, readinessTimeoutMs = 1_000, signal = new AbortController().signal) => runSession({
      client: OpenCode.make({ baseUrl: server.url.origin }),
      repoDir, trialId: "fixture", activeRole: "coder", modelSpec: "synthetic/test-model#fast",
      activeProviderIds: ["synthetic", "review"], prompt: "Synthetic task", wallTimeoutMs, readinessTimeoutMs, signal,
    }),
  };
}

test("waits for both readiness barriers and collects quiescent root and descendant messages", async () => {
  const fixture = fakeOpenCode("complete");

  try {
    const result = await fixture.run();
    expect(result.exitCode).toBe(0);
    expect(result.errorDiagnostic).toBeNull();
    expect(result.rootSessionId).toBe("root");
    expect(fixture.calls[0]).toBe("GET /api/event");
    expect(fixture.polls()).toBeGreaterThanOrEqual(4);
    expect(fixture.calls).toContain("GET /api/session/grandchild/inbox");
    expect(fixture.actions).toContainEqual({ type: "permission" });
    expect(fixture.actions).toContainEqual({ type: "permission-reject" });
    expect(fixture.actions).toContainEqual({ type: "form" });
    expect(result.questionFormCount).toBe(1);
    expect(result.scheduledRetries).toBe(1);
    expect(result.textStartedMsByMessageId).toEqual(new Map([["answer", 1_520]]));
    expect(result.rootMessages.map(({ id }) => id)).toEqual(["first", "second"]);
    expect(result.childMessagesBySessionId.get("child")?.map(({ id }) => id)).toEqual(["review"]);
    expect(result.childMessagesBySessionId.get("grandchild")?.map(({ id }) => id)).toEqual(["nested"]);
  } finally {
    await fixture.server.stop(true);
  }
});

test("completes quiescence when session.active clears without a follow-up SSE event", async () => {
  const fixture = fakeOpenCode("active-overlap-no-sse");

  try {
    const result = await fixture.run(1_000);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(fixture.calls.filter((call) => call === "GET /api/session/active")).toHaveLength(2);
  } finally {
    await fixture.server.stop(true);
  }
});

test("propagates child subagent execution failures as retryable diagnostics", async () => {
  const fixture = fakeOpenCode("child-failure");

  try {
    const result = await fixture.run(1_000);
    expect(result.exitCode).toBe(1);
    expect(result.errorDiagnostic).toMatchObject({
      errorType: "ServiceUnavailableError",
      status: 503,
      retryable: true,
    });
  } finally {
    await fixture.server.stop(true);
  }
});

test("does not treat an empty inbox as idle while the root processes a report", async () => {
  const fixture = fakeOpenCode("report-race");

  try {
    const result = await fixture.run();
    expect(result.exitCode).toBe(0);
    expect(fixture.calls.filter((call) => call === "GET /api/session/active")).toHaveLength(2);
    expect(fixture.calls.indexOf("GET /api/session/root/message"))
      .toBeGreaterThan(fixture.calls.lastIndexOf("GET /api/session/active"));
  } finally {
    await fixture.server.stop(true);
  }
});

test("reports an interrupt when abort arrives during message pagination", async () => {
  const fixture = fakeOpenCode("report-race");
  const abort = new AbortController();
  const page = Promise.withResolvers<void>();
  fixture.holdSecondPage(page.promise);

  try {
    const resultPromise = fixture.run(2_000, 1_000, abort.signal);
    const deadline = Date.now() + 1_000;

    while (fixture.calls.filter((call) => call === "GET /api/session/root/message").length < 2 && Date.now() < deadline) {
      await Bun.sleep(5);
    }

    expect(fixture.calls.filter((call) => call === "GET /api/session/root/message")).toHaveLength(2);
    abort.abort();
    page.resolve();
    const result = await resultPromise;
    expect(result).toMatchObject({ exitCode: 130, timedOut: false, interrupted: true });
    expect(result.rootMessages.map(({ id }) => id)).toEqual(["first", "second"]);
    expect(fixture.interrupts()).toBe(1);
  } finally {
    page.resolve();
    await fixture.server.stop(true);
  }
});

test.each([
  ["external", "ExternalFormError", false],
  ["disconnected", "PrematureSseDisconnectError", true],
  ["not-connected", "ReadinessTimeoutError", true],
] as const)("classifies %s sessions", async (scenario, errorType, retryable) => {
  const fixture = fakeOpenCode(scenario);

  try {
    const result = await fixture.run(2_000, 75);
    expect(result.errorDiagnostic).toMatchObject({ errorType, retryable });
    expect(result.exitCode).toBe(1);
    expect(result.questionFormCount).toBe(0);
    expect(fixture.actions).toEqual([]);

    if (scenario === "not-connected") {
      expect(fixture.calls).toEqual(["GET /api/event"]);
    }
  } finally {
    await fixture.server.stop(true);
  }
});

test("interrupts on wall timeout and collects partial messages", async () => {
  const fixture = fakeOpenCode("timeout");

  try {
    const result = await fixture.run(250);
    expect(result).toMatchObject({ exitCode: 124, timedOut: true, interrupted: false, errorDiagnostic: { retryable: false } });
    expect(fixture.interrupts()).toBe(1);
    expect(result.rootMessages.map(({ id }) => id)).toEqual(["first", "second"]);
  } finally {
    await fixture.server.stop(true);
  }
});

test("distinguishes external abort from wall timeout", async () => {
  const fixture = fakeOpenCode("timeout");
  const abort = new AbortController();

  try {
    const resultPromise = fixture.run(2_000, 1_000, abort.signal);
    const deadline = Date.now() + 1_000;

    while (!fixture.calls.includes("POST /api/session/root/prompt") && Date.now() < deadline) {
      await Bun.sleep(5);
    }

    abort.abort();
    const result = await resultPromise;
    expect(result).toMatchObject({ exitCode: 130, timedOut: false, interrupted: true });
    expect(fixture.interrupts()).toBe(1);
  } finally {
    await fixture.server.stop(true);
  }
});

test("classifies HTTP and provider errors", () => {
  for (const status of [408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 528, 529]) {
    expect(isRetryableApiFailure({ errorType: "UnexpectedStatus", status, message: "" })).toBe(true);
  }

  for (const status of [400, 401, 403, 404, 422, 501, 519, 530]) {
    expect(isRetryableApiFailure({ errorType: "UnexpectedStatus", status, message: "" })).toBe(false);
  }

  for (const errorType of ["ProviderRequestError", "APICallError"]) {
    expect(isRetryableApiFailure({ errorType, status: 429, message: "" })).toBe(true);
    expect(isRetryableApiFailure({ errorType, status: null, message: "" })).toBe(false);
  }

  for (const errorType of ["OverloadedError", "RateLimitError", "ServerStartupError"]) {
    expect(isRetryableApiFailure({ errorType, status: null, message: "" })).toBe(true);
  }

  for (const errorType of ["Transport", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET", "fetch failed",
    "PrematureSseDisconnectError", "UnexpectedServerExitError", "ReadinessTimeoutError"]) {
    expect(isRetryableApiFailure({ errorType, status: null, message: "" })).toBe(true);
  }

  for (const errorType of ["ModelNotFoundError", "UnsupportedModelError", "AgentNotFoundError", "ConfigInvalidError",
    "SchemaValidationError", "ExternalFormError", "WallClockTimeoutError", "SandboxLaunchError"]) {
    expect(isRetryableApiFailure({ errorType, status: 500, message: "fetch failed" })).toBe(false);
  }
});

test("validates pair reviewer git shell commands strictly against commit ranges and safe flags", () => {
  expect(isSafePairReviewerShellCommand("git diff --no-ext-diff --no-textconv a1b2c3d4..HEAD")).toBe(true);
  expect(isSafePairReviewerShellCommand("git diff --no-ext-diff --no-textconv -U 3 --stat a1b2c3d4..e5f6a7b8 -- summary.py")).toBe(true);
  expect(isSafePairReviewerShellCommand("git log -n 5 --no-ext-diff --no-textconv --format='%h %s' a1b2c3d4..HEAD")).toBe(true);
  expect(isSafePairReviewerShellCommand("git log --no-ext-diff --no-textconv --oneline HEAD")).toBe(true);

  expect(isSafePairReviewerShellCommand("git diff --no-ext-diff --no-textconv -S a1b2c3d4..HEAD HEAD")).toBe(false);
  expect(isSafePairReviewerShellCommand("git diff --no-ext-diff --no-textconv a1b2c3d4..HEAD > pwned.txt")).toBe(false);
  expect(isSafePairReviewerShellCommand("git diff --no-ext-diff --no-textconv a1b2c3d4..HEAD 2>&1")).toBe(false);
  expect(isSafePairReviewerShellCommand("git diff --no-ext-diff --no-textconv a1b2c3d4..HEAD &")).toBe(false);
  expect(isSafePairReviewerShellCommand("git diff --no-ext-diff --no-textconv HEAD file..txt")).toBe(false);
  expect(isSafePairReviewerShellCommand("git diff --no-ext-diff --no-textconv -- a1b2c3d4..HEAD")).toBe(false);
  expect(isSafePairReviewerShellCommand("git diff --no-ext-diff --no-textconv a1b2c3d4..HEAD -- ../outside.py")).toBe(false);
  expect(isSafePairReviewerShellCommand("git diff a1b2c3d4..HEAD")).toBe(false);
  expect(isSafePairReviewerShellCommand("git diff --no-ext-diff --no-textconv --output=pwn a1b2c3d4..HEAD")).toBe(false);
  expect(isSafePairReviewerShellCommand("git log --no-ext-diff --no-textconv --show-signature HEAD")).toBe(false);
  expect(isSafePairReviewerShellCommand("git log --no-ext-diff --no-textconv --format=%GG HEAD")).toBe(false);
  expect(isSafePairReviewerShellCommand("git diff --no-ext-diff --no-textconv a1b2c3d4..HEAD && rm -rf .")).toBe(false);
});
