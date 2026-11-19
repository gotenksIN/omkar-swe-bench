import type { SessionMessageAssistant, SessionMessageAssistantTool } from "@opencode/client";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { extractSessionEvidence, ranCommand } from "../../src/graders/trace.ts";

function assistant(
  content: SessionMessageAssistant["content"], finish: NonNullable<SessionMessageAssistant["finish"]> = "stop",
  completed = true,
): SessionMessageAssistant {
  return {
    content, finish, id: "message", type: "assistant", agent: "coder",
    model: { id: "test-model", providerID: "synthetic" }, time: completed ? { created: 1, completed: 2 } : { created: 1 },
  };
}

function tool(name: string, state: SessionMessageAssistantTool["state"]): SessionMessageAssistantTool {
  return { type: "tool", id: name, name, state, time: { created: 1 } };
}

function completedShell(command: string, workdir?: string, exit = 0, output = ""): SessionMessageAssistantTool {
  const input = workdir === undefined ? { command } : { command, workdir };

  return tool("shell", { status: "completed", input, metadata: { exit }, content: [{ type: "text", text: output }] });
}

test("joins REST text content, records shell errors, and places nested calls in sequence", () => {
  const legacyOutput = {
    status: "completed",
    input: { command: "uvx ruff check ." },
    content: [
      { type: "text", text: "All " }, { type: "file", uri: "file:///tmp/opencode/report.txt", mime: "text/plain" },
      { type: "text", text: "checks passed." },
    ],
    output: "Do not use legacy output.",
  } satisfies SessionMessageAssistantTool["state"] & { output: string };

  const trace = extractSessionEvidence([
    assistant([
      { type: "reasoning", text: "Not shown" },
      { type: "text", text: "First message" },
      tool("execute", {
        status: "completed", input: {}, content: [{ type: "text", text: "Code Mode output" }],
        metadata: {
          toolCalls: [
            { tool: "commit_context", status: "completed", input: { refresh: true } },
            { tool: "shell", status: "completed", input: { command: "capture-baseline" } },
            { tool: "execute", status: "completed", metadata: { toolCalls: [{ tool: "read", status: "completed" }] } },
            null,
            { tool: "invalid", status: "invalid" },
          ],
        },
      }),
      tool("shell", legacyOutput),
      tool("shell", {
        status: "error", input: { command: "./scripts/verify_deploy.sh", workdir: "/tmp/opencode/repo" },
        metadata: { exit: 8 }, error: { type: "ToolError", message: "Missing fixtures/prod.json" },
      }),
      tool("shell", {
        status: "error", input: { command: "bun test" }, error: { type: "ToolError", message: "Test failed" },
        content: [{ type: "text", text: "Test output" }],
      }),
      tool("shell", { status: "running", input: { command: "bun test" }, metadata: {} }),
      tool("read", { status: "streaming", input: "{" }),
    ], "tool-calls"),
    assistant([{ type: "text", text: "Final" }, { type: "text", text: "answer" }]),
  ], { timedOut: false, sessionId: "child", isSubagent: true });

  expect(trace.tools.map(({ index, tool, status }) => [index, tool, status])).toEqual([
    [0, "execute", "completed"], [1, "commit_context", "completed"], [2, "shell", "completed"], [3, "execute", "completed"],
    [4, "read", "completed"], [5, "shell", "completed"], [6, "shell", "error"], [7, "shell", "error"],
    [8, "shell", "running"], [9, "read", "pending"],
  ]);
  expect(trace.tools.every(({ sessionId, isSubagent }) => sessionId === "child" && isSubagent)).toBe(true);
  expect(trace.tools[6]).toMatchObject({ errorText: "Missing fixtures/prod.json", textOutput: "" });
  expect(trace.shellRuns).toMatchObject([
    { index: 2, exitCode: null, output: "" },
    { index: 5, exitCode: 0, output: "All checks passed.", parsed: { unwrapped: [{ executable: "ruff", args: ["check", "."] }] } },
    { index: 6, exitCode: 8, status: "error", output: "Missing fixtures/prod.json", workdir: "/tmp/opencode/repo" },
    { index: 7, exitCode: 1, status: "error", output: "Test output" },
  ]);
  expect(trace.finalText).toBe("Final\nanswer");
  expect(trace.transcriptText).toBe("First message\nFinal\nanswer");
  expect(ranCommand({ ...trace, repoDir: "/tmp/opencode/repo" }, ["capture-baseline"], { success: true })).toBe(false);
  expect(ranCommand({ ...trace, repoDir: "/tmp/opencode/repo" }, ["capture-baseline"], { success: false })).toBe(false);
});

test("preserves a findings or scope report before a short stop and ignores unfinished answers on timeout", () => {
  const findings = "## Findings\n- [P1] `file.ts:12` The job can run twice.";
  const scope = "Scope needed\nSend the commit range or the list of files.";
  const stub = assistant([{ type: "text", text: "Review finished." }]);
  const unfinished = assistant([{ type: "text", text: "This answer has not completed and must not replace the report." }], "stop", false);

  for (const report of [findings, scope]) {
    const earlier = assistant([{ type: "text", text: report }], "tool-calls");

    expect(extractSessionEvidence([earlier, stub, unfinished], { timedOut: true }).finalText).toBe(report);
    expect(extractSessionEvidence([earlier], { timedOut: false }).finalText).toBe("");
  }

  expect(extractSessionEvidence([unfinished], { timedOut: true }).finalText).toBe("");
  expect(extractSessionEvidence([stub], { timedOut: false }).finalText).toBe("Review finished.");
  expect(extractSessionEvidence([
    assistant([{ type: "text", text: findings }], "tool-calls"), assistant([{ type: "text", text: "No actionable findings." }]),
  ], { timedOut: false }).finalText).toBe("No actionable findings.");
});

test("recognizes real commands after edits in the trial repository, not help modes or other directories", () => {
  const workspace = mkdtempSync("/tmp/opencode/graders-trace-");

  try {
    const repoDir = join(workspace, "repo");
    const alias = join(workspace, "alias");

    mkdirSync(repoDir);
    symlinkSync(repoDir, alias);

    const trace = extractSessionEvidence([assistant([
      completedShell("bun test", repoDir),
      tool("patch", { status: "completed", input: {}, content: [{ type: "text", text: "Changed file" }] }),
      completedShell("bun test", workspace),
      completedShell("bun test", join(workspace, "missing")),
      completedShell("bun test --help", repoDir),
      completedShell("uvx ruff check .", alias, 0, "All checks passed."),
      completedShell("bash ./scripts/verify_deploy.sh", repoDir, 1, "Missing fixtures/prod.json"),
      completedShell("bun run typecheck"),
      completedShell("bun run lint --help", repoDir),
      completedShell("bun run lint", "."),
    ])], { timedOut: false });

    const evidence = { ...trace, repoDir };

    expect(ranCommand(evidence, ["bun", "test"], { success: true })).toBe(true);
    expect(ranCommand(evidence, ["bun", "test"], { afterLastEdit: true })).toBe(false);
    expect(ranCommand(evidence, ["ruff", "check"], { afterLastEdit: true, success: true, outputPattern: /checks passed/ })).toBe(true);
    expect(ranCommand(evidence, ["ruff", "check"], { success: false })).toBe(false);
    expect(ranCommand(evidence, ["ruff", "format"])).toBe(false);
    expect(ranCommand(evidence, ["scripts/verify_deploy.sh"], { success: false, outputPattern: /Missing fixtures\/prod\.json/ })).toBe(true);
    expect(ranCommand(evidence, ["verify_deploy.sh"], { success: true })).toBe(false);
    expect(ranCommand(evidence, ["verify_deploy.sh"], { success: null })).toBe(true);
    expect(ranCommand(evidence, ["bun", "run", "typecheck"], { afterLastEdit: true, success: true })).toBe(true);
    expect(ranCommand(evidence, ["bun", "run", "lint"], { afterLastEdit: true, success: true })).toBe(true);
    expect(ranCommand(evidence, [])).toBe(false);

    const relaxed = extractSessionEvidence([assistant([
      completedShell("bun run test", repoDir),
      completedShell("ruff --no-cache check .", repoDir),
      completedShell("set -e\npython3 -m unittest discover -s tests\nuvx ruff check .", repoDir),
      completedShell("bash -e scripts/verify_deploy.sh", repoDir, 1, "Missing fixtures/prod.json"),
      tool("edit", { status: "error", input: {}, error: { type: "ToolError", message: "No match" } }),
    ])], { timedOut: false });

    const relaxedEvidence = { ...relaxed, repoDir };
    expect(ranCommand(relaxedEvidence, ["bun", "test"], { afterLastEdit: true, success: true })).toBe(true);
    expect(ranCommand(relaxedEvidence, ["ruff", "check"], { afterLastEdit: true, success: true })).toBe(true);
    expect(ranCommand(relaxedEvidence, ["unittest"], { afterLastEdit: true, success: true })).toBe(true);
    expect(ranCommand(relaxedEvidence, ["verify_deploy.sh"], { success: false, outputPattern: /Missing fixtures\/prod\.json/ })).toBe(true);

    const shortCircuited = extractSessionEvidence([assistant([
      completedShell("true || bun test", repoDir, 0),
      completedShell("false && scripts/verify_deploy.sh", repoDir, 1, "Missing fixtures/prod.json"),
      completedShell("set -e; false && bun test; true", repoDir, 0),
      completedShell("set -e; bash -c 'true'; (false && bun test) || true", repoDir, 0),
      completedShell("bash -n -c 'bun test'", repoDir, 0),
      completedShell("! bash -c 'bun test'", repoDir, 0),
      completedShell("! bun test", repoDir, 0),
      completedShell("bash -c 'exit 0; bun test'", repoDir, 0),
      completedShell("bash -c 'exec true; bun test'", repoDir, 0),
      completedShell("bash -c 'return 0; bun test'", repoDir, 0),
    ])], { timedOut: false });

    expect(ranCommand({ ...shortCircuited, repoDir }, ["bun", "test"], { success: true })).toBe(false);
    expect(ranCommand({ ...shortCircuited, repoDir }, ["verify_deploy.sh"], { success: false })).toBe(false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("uses matching output to disambiguate pipeline status only for a command in the pipeline", () => {
  const trace = extractSessionEvidence([assistant([
    completedShell("bash scripts/verify_deploy.sh | tee /tmp/opencode/report", undefined, 0, "Missing fixtures/prod.json"),
    completedShell("bun test | tee /tmp/opencode/report", undefined, 1, "4 pass"),
    completedShell("bun run lint; echo done | cat", undefined, 1, "done"),
    completedShell("uvx ruff check .; echo '", undefined, 0, "All checks passed"),
    completedShell("bun run typecheck; echo done", undefined, 0, "done"),
    completedShell("uvx ruff check . && echo done", undefined, 0, "done"),
    tool("shell", {
      status: "completed", input: { command: "background-task", background: true }, content: [{ type: "text", text: "Started" }],
    }),
  ])], { timedOut: false });

  const evidence = { ...trace, repoDir: "/tmp/opencode/repo" };

  expect(ranCommand(evidence, ["verify_deploy.sh"], { success: false, outputPattern: /Missing fixtures/ })).toBe(true);
  expect(ranCommand(evidence, ["verify_deploy.sh"], { success: false })).toBe(false);
  expect(ranCommand(evidence, ["verify_deploy.sh"], { success: false, outputPattern: /Deployed/ })).toBe(false);
  expect(ranCommand(evidence, ["bun", "test"], { success: true, outputPattern: /4 pass/ })).toBe(true);
  expect(ranCommand(evidence, ["bun", "run", "lint"], { success: true, outputPattern: /done/ })).toBe(false);
  expect(ranCommand(evidence, ["ruff", "check"], { success: true })).toBe(true);
  expect(ranCommand(evidence, ["bun", "run", "typecheck"], { success: true })).toBe(false);
  expect(ranCommand(evidence, ["background-task"], { success: true })).toBe(false);
});
