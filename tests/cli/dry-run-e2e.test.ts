import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import nodePath from "node:path";

import { runCli } from "../../src/cli.ts";
import { readResultsJson } from "../../src/report/markdown.ts";
import { tasksForPhase } from "../../src/tasks/index.ts";
import { parseJsoncObject } from "../../src/util/json.ts";

const coderModel = "fixture-coder/synthetic-root";
const reviewerModel = "fixture-reviewer/synthetic-review";
const commitGuard = "opencode-commit-guard@1.1.1";
let directory: string;
const previousXdg = new Map<string, string | undefined>();
let warnSpy: { mockRestore: () => void } | undefined;

beforeEach(() => {
  mkdirSync("/tmp/opencode", { recursive: true });
  directory = mkdtempSync("/tmp/opencode/bench-dry-run-");
  const cacheHome = nodePath.join(directory, "host-cache");
  mkdirSync(nodePath.join(cacheHome, "opencode", "npm", commitGuard), {
    recursive: true,
  });
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});

  for (const [name, path] of Object.entries({
    XDG_CACHE_HOME: cacheHome,
    XDG_CONFIG_HOME: nodePath.join(directory, "host-config"),
  })) {
    previousXdg.set(name, process.env[name]);
    process.env[name] = path;
  }
});

afterEach(() => {
  warnSpy?.mockRestore();
  warnSpy = undefined;

  for (const [name, path] of previousXdg) {
    if (path === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = path;
    }
  }

  rmSync(directory, { recursive: true, force: true });
});

const dryRunArgs = (...options: string[]): string[] => {
  const providers = nodePath.join(directory, "providers.jsonc");
  writeFileSync(
    providers,
    '{"providers":{"fixture-coder":{},"fixture-reviewer":{}}}'
  );

  return [
    "run",
    "--dry-run",
    "--sandbox",
    "off",
    "--providers-file",
    providers,
    "--workspace-root",
    nodePath.join(directory, "workspaces"),
    "--out",
    directory,
    "--coder-model",
    coderModel,
    "--reviewer-model",
    reviewerModel,
    ...options,
  ];
};

const guardCachePath = (): string =>
  nodePath.join(directory, "host-cache", "opencode", "npm", commitGuard);

test("dry-runs all tasks and rebuilds the Markdown report identically", async () => {
  expect(await runCli(dryRunArgs())).toBe(0);
  expect(warnSpy).toHaveBeenCalledWith(
    "No OpenCode catalog client supplied. Model and variant availability is unverified."
  );
  const input = nodePath.join(directory, "results.json");
  const results = readResultsJson(input);
  const byRole = Map.groupBy(results, ({ role }) => role);

  const allTasks = tasksForPhase("all");

  expect(results).toHaveLength(allTasks.length);
  expect(new Set(results.map(({ task_id }) => task_id))).toEqual(
    new Set(allTasks.map(({ id }) => id))
  );
  expect(byRole.get("coder")?.length).toBeGreaterThan(0);
  expect(byRole.get("code-reviewer")?.length).toBeGreaterThan(0);
  expect(byRole.get("pair")?.length).toBeGreaterThan(0);

  for (const result of results) {
    expect(result).toMatchObject({
      passed: true,
      score: 1,
      checks: { dry_run_fixture_ready: true },
      agent_profile: "neutral",
      exit_code: 0,
      session_id: null,
    });
    expect(
      lstatSync(nodePath.dirname(result.repo_dir), { throwIfNoEntry: false })
    ).toBeUndefined();
  }

  const markdown = readFileSync(nodePath.join(directory, "summary.md"));
  const rebuilt = nodePath.join(directory, "nested", "rebuilt.md");
  expect(markdown.toString("utf-8").match(/^## .+$/gmu)).toEqual([
    "## code-reviewer leaderboard",
    "## coder leaderboard",
    "## pair leaderboard",
    "## Per-trial breakdown",
  ]);
  expect(await runCli(["report", "--input", input, "--out", rebuilt])).toBe(0);
  expect(readFileSync(rebuilt)).toEqual(markdown);
}, 30_000);

test("keeps custom trial prompts and only authorized plugins, but removes the provider file", async () => {
  const agents = nodePath.join(directory, "custom-agents.jsonc");
  writeFileSync(
    agents,
    `{
    // Only the two agent definitions belong in the trial.
    "plugins": ["personal-plugin"],
    "mcp": {"personal": {"command": ["personal-tool"]}},
    "instructions": ["personal-instructions.md"],
    "agents": {
      "coder": {"system": "Synthetic coder prompt."},
      "code-reviewer": {"system": "Synthetic reviewer prompt."},
    },
  }`
  );

  const selected = new Map([
    ["coder-ts-sse-chunk-crlf", false],
    ["coder-git-commit-guard-two-task", true],
    ["rev-clean-personal-script", false],
    ["pair-commit-review-amend", true],
  ]);

  const taskArgs = [...selected.keys()].flatMap((id) => ["--task", id]);

  expect(
    await runCli(
      dryRunArgs("--agents-file", agents, "--keep-workspaces", ...taskArgs)
    )
  ).toBe(0);
  const results = readResultsJson(nodePath.join(directory, "results.json"));
  expect(new Set(results.map(({ task_id }) => task_id))).toEqual(
    new Set(selected.keys())
  );

  for (const result of results) {
    expect(result).toMatchObject({
      agent_profile: "file:custom-agents.jsonc",
      passed: true,
      checks: { dry_run_fixture_ready: true },
    });

    const configDir = nodePath.join(
      nodePath.dirname(result.repo_dir),
      "config",
      "opencode"
    );

    const config = parseJsoncObject(
      readFileSync(nodePath.join(configDir, "opencode.json"), "utf-8")
    );

    expect(config).not.toHaveProperty("mcp");
    expect(config).not.toHaveProperty("instructions");
    expect(config.plugins).toEqual(
      selected.get(result.task_id) === true ? [commitGuard] : []
    );
    expect(config).toHaveProperty(
      "agents.coder.system",
      expect.stringContaining("Synthetic coder prompt.")
    );
    expect(config).toHaveProperty(
      "agents.code-reviewer.system",
      expect.stringContaining("Synthetic reviewer prompt.")
    );
    expect(
      lstatSync(nodePath.join(configDir, "opencode.jsonc"), {
        throwIfNoEntry: false,
      })
    ).toBeUndefined();
  }
}, 30_000);

test("excludes the host guard cache from unguarded CLI trials", async () => {
  const cache = guardCachePath();
  const forbiddenSource = nodePath.join(directory, "oxlint");
  mkdirSync(forbiddenSource);
  rmSync(cache, { recursive: true });
  symlinkSync(forbiddenSource, cache);

  // A guard cache pointing to a forbidden source fails mount isolation only if the runner selects it.
  const unguarded = tasksForPhase("all").flatMap(
    ({ id, commitGuard: needsGuard }) => (needsGuard ? [] : ["--task", id])
  );

  expect(await runCli(dryRunArgs(...unguarded))).toBe(0);
  expect(
    readResultsJson(nodePath.join(directory, "results.json"))
  ).toHaveLength(unguarded.length / 2);

  const error = spyOn(console, "error").mockImplementation(() => {});

  try {
    expect(
      await runCli(dryRunArgs("--task", "coder-git-commit-guard-two-task"))
    ).toBe(1);
    expect(error).toHaveBeenCalledWith(
      "The trial mount plan contains a harness lint or AST tool."
    );
  } finally {
    error.mockRestore();
  }
}, 30_000);

test("validates phase/task mismatches, 32-bit timeout overflows, and --sandbox auto without bwrap", async () => {
  const err = spyOn(console, "error").mockImplementation(() => {});
  const previousPath = process.env.PATH;
  const emptyBinDir = nodePath.join(directory, "no-bwrap-bin");
  mkdirSync(emptyBinDir, { recursive: true });

  try {
    expect(
      await runCli(
        dryRunArgs("--phase", "reviewer", "--task", "coder-convention-autonomy")
      )
    ).toBe(1);
    expect(String(err.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "does not match --phase"
    );

    expect(
      await runCli(
        dryRunArgs(
          "--task",
          "coder-convention-autonomy",
          "--timeout-scale",
          "5000000"
        )
      )
    ).toBe(1);
    expect(String(err.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "Set --timeout-scale"
    );

    process.env.PATH = emptyBinDir;
    expect(
      await runCli([
        "run",
        "--sandbox",
        "auto",
        "--phase",
        "coder",
        "--task",
        "coder-convention-autonomy",
        "--coder-model",
        "synthetic/coder",
        "--out",
        nodePath.join(directory, "no-bwrap-coder"),
        "--workspace-root",
        nodePath.join(directory, "no-bwrap-ws"),
      ])
    ).toBe(1);
    expect(String(err.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "Cannot grade coder or pair trials without bubblewrap"
    );
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }

    err.mockRestore();
  }
});
