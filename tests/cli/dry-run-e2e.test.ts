import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { runCli } from "../../src/cli.ts";
import { readResultsJson } from "../../src/report/markdown.ts";
import { compileMountPlan } from "../../src/sandbox/mount-plan.ts";
import { discoverTsCompilerDirs, prepareTrialTsBin } from "../../src/sandbox/tools.ts";
import { TASKS } from "../../src/tasks/index.ts";
import { parseJsoncObject } from "../../src/util/json.ts";

const coderModel = "fixture-coder/synthetic-root";
const reviewerModel = "fixture-reviewer/synthetic-review";
const commitGuard = "opencode-commit-guard@1.1.1";
let directory: string;
const previousXdg = new Map<string, string | undefined>();

beforeEach(() => {
  mkdirSync("/tmp/opencode", { recursive: true });
  directory = mkdtempSync("/tmp/opencode/bench-dry-run-");
  const cacheHome = join(directory, "host-cache");
  mkdirSync(join(cacheHome, "opencode", "npm", commitGuard), { recursive: true });

  for (const [name, path] of Object.entries({ XDG_CACHE_HOME: cacheHome, XDG_CONFIG_HOME: join(directory, "host-config") })) {
    previousXdg.set(name, process.env[name]);
    process.env[name] = path;
  }
});

afterEach(() => {
  for (const [name, path] of previousXdg) {
    if (path === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = path;
    }
  }

  rmSync(directory, { recursive: true, force: true });
});

function dryRunArgs(...options: string[]): string[] {
  const providers = join(directory, "providers.jsonc");
  writeFileSync(providers, '{"providers":{"fixture-coder":{},"fixture-reviewer":{}}}');

  return [
    "run", "--dry-run", "--sandbox", "off", "--providers-file", providers,
    "--workspace-root", join(directory, "workspaces"), "--out", directory,
    "--coder-model", coderModel, "--reviewer-model", reviewerModel, ...options,
  ];
}

function guardCachePath(): string {
  return join(directory, "host-cache", "opencode", "npm", commitGuard);
}

test("dry-runs all tasks and rebuilds the Markdown report identically", async () => {
  expect(await runCli(dryRunArgs())).toBe(0);
  const input = join(directory, "results.json");
  const results = readResultsJson(input);
  const byRole = Map.groupBy(results, ({ role }) => role);

  expect(results).toHaveLength(TASKS.length);
  expect(new Set(results.map(({ task_id }) => task_id))).toEqual(new Set(TASKS.map(({ id }) => id)));
  expect(byRole.get("coder")?.length).toBeGreaterThan(0);
  expect(byRole.get("code-reviewer")?.length).toBeGreaterThan(0);
  expect(byRole.get("pair")?.length).toBeGreaterThan(0);

  for (const result of results) {
    expect(result).toMatchObject({
      passed: true, score: 1, checks: { dry_run_fixture_ready: true },
      agent_profile: "neutral", exit_code: 0, session_id: null,
    });
    expect(lstatSync(dirname(result.repo_dir), { throwIfNoEntry: false })).toBeUndefined();
  }

  const markdown = readFileSync(join(directory, "summary.md"));
  const rebuilt = join(directory, "nested", "rebuilt.md");
  expect(markdown.toString("utf8").match(/^## .+$/gmu)).toEqual([
    "## code-reviewer leaderboard", "## coder leaderboard", "## pair leaderboard", "## Per-trial breakdown",
  ]);
  expect(await runCli(["report", "--input", input, "--out", rebuilt])).toBe(0);
  expect(readFileSync(rebuilt)).toEqual(markdown);
}, 30_000);

test("keeps custom trial prompts and only authorized plugins, but removes the provider file", async () => {
  const agents = join(directory, "custom-agents.jsonc");
  writeFileSync(agents, `{
    // Only the two agent definitions belong in the trial.
    "plugins": ["personal-plugin"],
    "mcp": {"personal": {"command": ["personal-tool"]}},
    "instructions": ["personal-instructions.md"],
    "agents": {
      "coder": {"system": "Synthetic coder prompt."},
      "code-reviewer": {"system": "Synthetic reviewer prompt."},
    },
  }`);

  const selected = new Map([
    ["coder-ts-sse-chunk-crlf", false],
    ["coder-git-commit-guard-two-task", true],
    ["rev-clean-personal-script-v2", false],
    ["pair-commit-review-amend", true],
  ]);

  const taskArgs = [...selected.keys()].flatMap((id) => ["--task", id]);

  expect(await runCli(dryRunArgs("--agents-file", agents, "--keep-workspaces", ...taskArgs))).toBe(0);
  const results = readResultsJson(join(directory, "results.json"));
  expect(new Set(results.map(({ task_id }) => task_id))).toEqual(new Set(selected.keys()));

  for (const result of results) {
    expect(result).toMatchObject({
      agent_profile: "file:custom-agents.jsonc", passed: true, checks: { dry_run_fixture_ready: true },
    });
    const configDir = join(dirname(result.repo_dir), "config", "opencode");
    const config = parseJsoncObject(readFileSync(join(configDir, "opencode.json"), "utf8"));
    expect(config).not.toHaveProperty("mcp");
    expect(config).not.toHaveProperty("instructions");
    expect(config.plugins).toEqual(selected.get(result.task_id) ? [commitGuard] : []);
    expect(config).toHaveProperty("agents.coder.system", expect.stringContaining("Synthetic coder prompt."));
    expect(config).toHaveProperty("agents.code-reviewer.system", expect.stringContaining("Synthetic reviewer prompt."));
    expect(lstatSync(join(configDir, "opencode.jsonc"), { throwIfNoEntry: false })).toBeUndefined();
  }
}, 30_000);

test("excludes the host guard cache from unguarded CLI trials", async () => {
  const cache = guardCachePath();
  const forbiddenSource = join(directory, "oxlint");
  mkdirSync(forbiddenSource);
  rmSync(cache, { recursive: true });
  symlinkSync(forbiddenSource, cache);

  // A guard cache pointing to a forbidden source fails mount isolation only if the runner selects it.
  const unguarded = TASKS.flatMap(({ id, commitGuard: needsGuard }) => needsGuard ? [] : ["--task", id]);
  expect(await runCli(dryRunArgs(...unguarded))).toBe(0);
  expect(readResultsJson(join(directory, "results.json"))).toHaveLength(unguarded.length / 2);

  const error = spyOn(console, "error").mockImplementation(() => {});

  try {
    expect(await runCli(dryRunArgs("--task", "coder-git-commit-guard-two-task"))).toBe(1);
    expect(error).toHaveBeenCalledWith("The trial mount plan contains a harness lint or AST tool.");
  } finally {
    error.mockRestore();
  }
}, 30_000);

test("plans all task mounts without harness lint or AST tools and limits the commit guard cache", () => {
  const cache = realpathSync(guardCachePath());
  const harness = join(directory, "harness");

  const excludedDirs = ["node_modules/oxlint", "node_modules/@oxlint/plugins", "node_modules/oxc-parser", "tools/oxlint/anti-slop"]
    .map((path) => join(harness, path));

  for (const name of ["typescript", "@typescript", "@types", "bun-types", "undici-types", "oxlint", "@oxlint/plugins", "oxc-parser"]) {
    mkdirSync(join(harness, "node_modules", name), { recursive: true });
  }

  mkdirSync(join(harness, "tools", "oxlint", "anti-slop"), { recursive: true });
  const tsCompilerDirs = discoverTsCompilerDirs(harness);
  const guardedTasks = [];

  for (const task of TASKS) {
    const trialDir = join(directory, task.id);
    const repoDir = join(trialDir, "repo");
    const config = join(trialDir, "config", "opencode");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, "opencode.json"), "{}");
    writeFileSync(join(config, "opencode.jsonc"), "{}");

    if (task.needsTsCompiler) prepareTrialTsBin(trialDir);

    const plan = compileMountPlan({
      trialDir, repoDir, hostHome: join(directory, "host-home"), hostToolFiles: [], extraRoFiles: [],
      readOnlyRepo: task.readOnlyRepo, opencodeBinCacheDir: null,
      commitGuardCacheDir: task.commitGuard ? cache : null,
      tsCompilerDirs: task.needsTsCompiler ? tsCompilerDirs : [],
    });

    const guardBinds = plan.binds.filter(({ source, target }) => source.includes(commitGuard) || target.includes(commitGuard));

    for (const { source, target } of plan.binds) {
      const sourcePrefix = source === "/" ? "/" : `${source}/`;
      expect(`${source}\n${target}`).not.toMatch(/oxlint|oxc-parser|tools\/oxlint\/anti-slop/u);
      expect(excludedDirs.some((path) => path.startsWith(sourcePrefix))).toBe(false);
      expect(cache.startsWith(sourcePrefix)).toBe(false);
    }

    if (guardBinds.length > 0) guardedTasks.push(task.id);

    expect(guardBinds).toEqual(task.commitGuard ? [{
      source: cache, target: join(trialDir, "cache", "opencode", "npm", commitGuard),
      readOnly: true, isFile: false,
    }] : []);
  }

  expect(guardedTasks.sort()).toEqual([
    "coder-git-commit-guard-two-task", "pair-commit-review-amend", "pair-multitask-review-loop-clean",
    "pair-pushback-on-false-nitpick", "pair-unhittable-finding-and-nonhead",
  ]);
});
