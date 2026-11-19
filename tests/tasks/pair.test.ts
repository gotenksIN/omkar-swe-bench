import type { SessionMessageAssistant, SessionMessageAssistantTool } from "@opencode/client";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { captureGitState } from "../../src/graders/git.ts";
import { extractSessionEvidence } from "../../src/graders/trace.ts";
import type { Evidence } from "../../src/graders/types.ts";
import { commitTaskFiles, initGitRepo, runFixtureCheck, runTaskGit } from "../../src/tasks/base.ts";
import { TASKS, TASKS_BY_ID, tasksForPhase } from "../../src/tasks/index.ts";
import { actualReviewerModels, reviewHandoffs } from "../../src/tasks/pair/handoffs.ts";

const reportId = "pair-commit-review-amend";
const nitpickId = "pair-pushback-on-false-nitpick";
const loopId = "pair-multitask-review-loop-clean";
const cliId = "pair-unhittable-finding-and-nonhead";
const testsCommand = ["-m", "unittest", "discover", "-s", "tests"];

async function inTrial(run: (repo: string, trial: string) => Promise<void>): Promise<void> {
  const trial = await mkdtemp("/tmp/opencode/pair-tests-");

  try {
    await run(join(trial, "repo"), trial);
  } finally {
    await rm(trial, { recursive: true, force: true });
  }
}

function assistant(content: SessionMessageAssistant["content"], variant = "high"): SessionMessageAssistant {
  const model = { providerID: "synthetic", id: "review" };

  return {
    content, id: "synthetic-message", type: "assistant", agent: "code-reviewer",
    model: variant ? { ...model, variant } : model,
    time: { created: 1, completed: 2 }, finish: "stop",
  };
}

type CompletedTool = Extract<SessionMessageAssistantTool["state"], { status: "completed" }>;

function tool(name: string, input: CompletedTool["input"], metadata: CompletedTool["metadata"] = {}, output = ""): SessionMessageAssistantTool {
  return {
    type: "tool", name, id: name, time: { created: 1 },
    state: { status: "completed", input, metadata: metadata ?? {}, content: [{ type: "text", text: output }] },
  };
}

test("partitions the task catalog cleanly across phases with unique IDs", () => {
  const coder = tasksForPhase("coder");
  const reviewer = tasksForPhase("reviewer");
  const pair = tasksForPhase("pair");

  expect(tasksForPhase("all")).toEqual([...coder, ...reviewer, ...pair]);
  expect(TASKS_BY_ID.size).toBe(TASKS.length);
  expect(coder.every(({ role }) => role === "coder")).toBe(true);
  expect(reviewer.every(({ role }) => role === "code-reviewer")).toBe(true);
  expect(pair.every(({ role }) => role === "pair")).toBe(true);
});

test("resolves review ranges against the reflog at the handoff index", () =>
  inTrial(async (repo) => {
    const baseline = await initGitRepo(repo, { "notes.txt": "Initial\n" }, "fixture: Seed notes");
    const path = join(repo, "notes.txt");

    await writeFile(path, "Before review\n");
    const pre = await commitTaskFiles(repo, ["notes.txt"], "notes: Revise notes");

    await writeFile(path, "After review\n");
    await runTaskGit(repo, "add", "--", "notes.txt");
    await runTaskGit(repo, "commit", "--amend", "--no-edit");

    const post = (await runTaskGit(repo, "rev-parse", "HEAD")).trim();
    const start = baseline.slice(0, 8);
    const explicit = pre.slice(0, 8);
    const report = "## Findings\n- [P2] `notes.txt:1` Fix the opening line.";
    const clean = "No actionable findings.";

    const messages = new Map([
      ["first", [assistant([{ type: "text", text: report }])]],
      ["last", [assistant([{ type: "text", text: clean }], "")]],
    ]);

    const trace = extractSessionEvidence([assistant([
      tool("shell", { command: "echo 'git commit --amend --no-edit'" }),
      tool("subagent", { agent: "code-reviewer", prompt: `Review \`${start}..HEAD\`.` }, { sessionID: "first", childSessionID: "wrong" }),
      tool("shell", { command: "bash -c 'git commit --amend --no-edit'" }),
      tool("subagent", { agent: "code-reviewer", prompt: `Review \`${baseline}..HEAD\`.` }, { childSessionID: "last" }),
      tool("subagent", { agent: "code-reviewer", prompt: `Review ${start}...HEAD or ${start}..${explicit}.` }, { sessionID: "explicit" }),
      tool("subagent", { agent: "code-reviewer", prompt: `Review ${start}..${"0".repeat(40)}` }, { sessionID: "missing" }),
      tool("subagent", { agent: "code-reviewer", prompt: `Review ${start}..HEAD^ or ${start}..HEAD~1.` }, { sessionID: "unsupported" }),
      tool("subagent", { agent: "explore", prompt: `Read ${start}..HEAD` }, { sessionID: "ignore" }),
    ])], { timedOut: false });

    const handoffs = await reviewHandoffs(repo, baseline, trace.tools, trace.shellRuns, messages);

    expect(handoffs).toMatchObject([
      { toolIndex: 1, childSessionId: "first", rangeStart: start, rangeEndToken: "HEAD", resolvedEndCommit: pre,
        reviewerFinalText: report, reviewerModel: "synthetic/review#high" },
      { toolIndex: 3, childSessionId: "last", rangeStart: baseline, rangeEndToken: "HEAD", resolvedEndCommit: post,
        reviewerFinalText: clean, reviewerModel: "synthetic/review" },
      { rangeEndToken: explicit, resolvedEndCommit: pre, reviewerFinalText: "", reviewerModel: null },
      { rangeEndToken: "0".repeat(40), resolvedEndCommit: null },
      { rangeEndToken: null, resolvedEndCommit: null },
    ]);

    await rm(join(repo, ".git/logs/HEAD"));

    const unavailable = await reviewHandoffs(repo, baseline, trace.tools, trace.shellRuns, messages);

    expect(unavailable.map(({ resolvedEndCommit }) => resolvedEndCommit)).toEqual([null, null, null, null, null]);
    expect(unavailable[0]?.reviewerFinalText).toBe(report);
  }));

type Negative = "nitpick" | "guard" | "core" | "loop" | "late-edit" | "extra-attempt";

type ToolPart = SessionMessageAssistant["content"][number];

async function modify(repo: string, file: string, replace: (source: string) => string): Promise<void> {
  const path = join(repo, file);

  await writeFile(path, replace(await readFile(path, "utf8")));
}

async function reportChange(repo: string, fixed: boolean, acceptNitpick = false): Promise<void> {
  const numeric = fixed ? "    observed = [value for value in values if value is not None]\n" : "    observed = values\n";
  const result = acceptNitpick ? "    return Summary(len(values), mean)\n" : '    return {"count": len(values), "mean": mean}\n';

  const summaryClass = `from dataclasses import dataclass


@dataclass
class Summary:
    count: int
    mean: float


`;

  await writeFile(join(repo, "summary.py"), `${acceptNitpick ? summaryClass : ""}def summarize(batch):
    values = list(batch)
${numeric}    mean = sum(observed) / len(observed) if observed else 0
${result}`);
}

async function formatterChange(repo: string, fixed: boolean): Promise<void> {
  await writeFile(join(repo, "formatter.py"), fixed ? `def render_pairs(pairs):
    counts = {}
    for name, count in pairs:
        counts[name] = counts.get(name, 0) + count
    return ", ".join(f"{name}={count}" for name, count in counts.items())
` : `def render_pairs(pairs):
    return ", ".join(f"{name}={count}" for name, count in pairs)
`);
}

async function cliChange(repo: string, fixed: boolean, guard = false): Promise<void> {
  await modify(repo, "cli.py", (source) => {
    if (!fixed) {
      return source.replace("import argparse", "import argparse\nimport json")
        .replace("    args = parser.parse_args(argv)", '    parser.add_argument("--json", action="store_true")\n    args = parser.parse_args(argv)')
        .replace("    print(_divide_pages(args.total, args.limit))",
          '    pages = _divide_pages(args.total, args.limit)\n    print(json.dumps({"pages": pages}) if args.json else pages)');
    }

    return source.replace("\ndef _divide_pages", "\n\nMAX_LIMIT = 100\n\n\ndef _divide_pages")
      .replace("    pages = _divide_pages", '    if args.limit > MAX_LIMIT:\n        parser.error("--limit must be at most 100")\n    pages = _divide_pages')
      .replace("    return (total", guard ? "    if limit == 0:\n        return 0\n    return (total" : "    return (total");
  });
}

async function fixtureEvidence(repo: string, trial: string, id: string, negative?: Negative) {
  const task = TASKS_BY_ID.get(id);

  if (!task) throw new Error(`Missing task: ${id}`);

  const setup = await task.setupRepo(repo);
  const { baselineHead } = setup;
  const beforeGit = await captureGitState(repo, baselineHead);
  const parts: ToolPart[] = [];
  const children = new Map<string, readonly SessionMessageAssistant[]>();
  const shell = (command: string, output = "", exit = 0) => parts.push(tool("shell", { command, workdir: repo }, { exit }, output));

  const review = (sessionID: string, text: string, end = "HEAD") => {
    const prompt = `Review ${baselineHead}..${end} in ${repo}. Use the specified requirements. Do not edit or execute code.`;

    parts.push(tool("subagent", { agent: "code-reviewer", prompt }, { sessionID }));
    children.set(sessionID, [assistant([{ type: "text", text }])]);
  };

  const runTests = async () => shell(`python3 ${testsCommand.join(" ")}`, "",
    await runFixtureCheck(repo, "python3", testsCommand) ? 0 : 1);

  const commit = async (path: string, subject: string) => {
    parts.push(tool("write", { filePath: path }));
    await runTests();
    await commitTaskFiles(repo, [path], subject);
    shell(`git commit -s -m '${subject}'`);
  };

  parts.push(tool("commit_context", {}));
  shell("bash -c 'capture-baseline'", "Frozen commit baseline");

  let amendFile: string;
  let findings: string;
  let final = "Fixed the substantiated finding and reran the tests.";

  if (id === loopId) {
    await writeFile(join(repo, "validator.py"), `def validate_count(count):
    if type(count) is not int or count < 0:
        raise ValueError("expected a non-negative integer")
    return count
`);
    await commit("validator.py", "validator: Validate counts");
    await formatterChange(repo, false);
    amendFile = "formatter.py";
    await commit(amendFile, "formatter: Separate rendered pairs");
    findings = "## Findings\n- [P2] `formatter.py:2` Duplicate names need their counts summed in first-seen order.";
  } else if (id === cliId) {
    await writeFile(join(repo, "core.py"), `def parse_total(raw):
    total = int(raw)
    if total < 0:
        raise ValueError("total must be non-negative")
    return total
`);
    await commit("core.py", "core: Reject negative totals");
    await cliChange(repo, false);
    amendFile = "cli.py";
    await commit(amendFile, "cli: Support JSON output");
    findings = "## Findings\n- [P2] `cli.py:15` Cap the maximum limit at 100.\n" +
      "- **[P2]** `cli.py:5` — `_divide_pages(total, limit)` divides by `limit` without checking `limit == 0`, risking `ZeroDivisionError`.";
    final += " Declined the `_divide_pages` finding because the argument parser enforces `limit >= 1`.";
  } else {
    await reportChange(repo, false);
    amendFile = "summary.py";
    await commit(amendFile, "report: Support iterators and empty batches");
    findings = "## Findings\n- [P2] `summary.py:4` Exclude None from the mean but not from the batch count.";

    if (id === nitpickId) {
      findings += "\n- **[P3]** `summary.py:1` — Return a dataclass instead of a dictionary.";
      final += " Declined the dataclass suggestion because it would break the dictionary contract.";
    }
  }

  const pre = (await runTaskGit(repo, "rev-parse", "HEAD")).trim();

  review("first", findings, negative === "core" ? pre : "HEAD");
  parts.push({ type: "text", text: "Review pending" });

  if (id === loopId) await formatterChange(repo, true);
  else if (id === cliId) await cliChange(repo, true, negative === "guard");
  else await reportChange(repo, true, negative === "nitpick");

  if (negative === "core") {
    const parent = (await runTaskGit(repo, "rev-parse", `${pre}^`)).trim();

    // Rewrite the original parent, then rebuild the reviewed CLI commit with that parent.
    const originalCli = await runTaskGit(repo, "show", `${pre}:cli.py`);
    const fixedCli = await readFile(join(repo, "cli.py"), "utf8");

    await writeFile(join(repo, "cli.py"), originalCli);
    await runTaskGit(repo, "switch", "--detach", parent);
    await modify(repo, "core.py", (source) => `"""Parse a pagination total."""\n\n${source}`);
    await runTaskGit(repo, "add", "--", "core.py");
    await runTaskGit(repo, "commit", "--amend", "--no-edit");
    await writeFile(join(repo, "cli.py"), originalCli);
    await commitTaskFiles(repo, ["cli.py"], "cli: Support JSON output");
    await writeFile(join(repo, "cli.py"), fixedCli);
  }

  parts.push(tool("patch", { filePath: amendFile }));
  await runTests();

  if (negative === "late-edit") parts.push(tool("edit", { filePath: amendFile }));
  await runTaskGit(repo, "add", "--", amendFile);
  await runTaskGit(repo, "commit", "--amend", "--no-edit");
  shell("git commit --amend --no-edit");

  if (id === loopId) review("last", negative === "loop" ? "Review done." : "No actionable findings.");

  if (negative === "extra-attempt") {
    parts.push({
      type: "tool", id: "failed-review", name: "subagent", time: { created: 1 },
      state: { status: "error", input: { agent: "code-reviewer" }, error: { type: "ToolError", message: "Review failed" } },
    });
  }

  parts.push({ type: "text", text: final });

  const trace = extractSessionEvidence([assistant(parts)], { timedOut: false, sessionId: "root" });
  const reviewHandoffsFound = await reviewHandoffs(repo, baselineHead, trace.tools, trace.shellRuns, children);

  const evidence: Evidence = {
    ...trace, repoDir: repo, trialDir: trial, baselineHead, beforeGit, afterGit: await captureGitState(repo, baselineHead),
    actualReviewerModels: actualReviewerModels(reviewHandoffsFound), reviewHandoffs: reviewHandoffsFound,
    finalText: final, reviewerText: findings, questionFormCount: 0, timedOut: false,
  };

  return {
    grade: await task.grade(evidence, setup),
    diff: await runTaskGit(repo, "diff", "--no-ext-diff", "--no-textconv", `${baselineHead}..${pre}`, "--"),
  };
}

test.each([reportId, nitpickId, loopId, cliId])("%s grades a signed review and amendment", async (id) =>
  inTrial(async (repo, trial) => {
    const { grade, diff } = await fixtureEvidence(repo, trial, id);

    expect(Object.entries(grade.checks).flatMap(([name, passed]) => passed ? [] : [name])).toEqual([]);
    expect(grade).toMatchObject({ passed: true, score: 1, reviewDiff: diff });
    expect(diff).not.toBe("");
  }));

const negatives = [
  [nitpickId, "nitpick", "declined_nitpick_with_reason"],
  [cliId, "guard", "no_redundant_guard_added"],
  [cliId, "core", "nonhead_core_untouched"],
  [loopId, "loop", "review_loop_closed_clean"],
  [loopId, "extra-attempt", "review_loop_closed_clean"],
  [reportId, "late-edit", "tests_rerun_before_amend"],
] as const;

test.each(negatives)("%s rejects %s", async (id, negative, check) =>
  inTrial(async (repo, trial) => {
    const { grade } = await fixtureEvidence(repo, trial, id, negative);

    expect(grade.checks[check]).toBe(false);
    expect(grade.passed).toBe(false);
  }));
