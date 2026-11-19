import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { buildTrialEnv, toBwrapEnvArgs } from "../../src/sandbox/env.ts";
import { compileMountPlan } from "../../src/sandbox/mount-plan.ts";
import { probeSandbox } from "../../src/sandbox/process.ts";
import { discoverHostToolFiles, requireGlobalRuff, runHostRuffCheck } from "../../src/sandbox/tools.ts";

const sandbox = await probeSandbox();
const hasRuff = Bun.which("ruff") !== null;
let workspace = "";

beforeAll(() => {
  mkdirSync("/tmp/opencode", { recursive: true });
  workspace = mkdtempSync("/tmp/opencode/bench-ruff-");
});

afterAll(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

test.skipIf(!hasRuff)("grades Python files on the host with the global ruff binary without writing a cache", async () => {
  const repoDir = join(workspace, "host-check");

  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, "example.py"), "import os\n");

  const dirty = await runHostRuffCheck(repoDir);

  expect(dirty.exitCode).toBe(1);
  expect(dirty.output).toContain("F401");
  expect(existsSync(join(repoDir, ".ruff_cache"))).toBe(false);

  writeFileSync(join(repoDir, "example.py"), "print(1)\n");
  expect((await runHostRuffCheck(repoDir)).exitCode).toBe(0);
});

test("fails fast with install instructions when ruff is absent from PATH", () => {
  const previousPath = process.env.PATH;

  try {
    process.env.PATH = workspace;
    expect(() => requireGlobalRuff()).toThrow(/Install ruff globally/u);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test.skipIf(!sandbox.available || !hasRuff)("runs global ruff read-only across four concurrent sandboxes", async () => {
  const hostToolFiles = discoverHostToolFiles();

  const trials = Array.from({ length: 4 }, (_, index) => {
    const trialDir = join(workspace, `worker-${index}`);
    const repoDir = join(trialDir, "repo");
    const config = join(trialDir, "config", "opencode");

    mkdirSync(repoDir, { recursive: true });
    mkdirSync(config, { recursive: true });
    mkdirSync(join(trialDir, "home"));
    writeFileSync(join(config, "opencode.json"), "{}");
    writeFileSync(join(config, "opencode.jsonc"), "{}");
    writeFileSync(join(repoDir, "example.py"), "print(1)\n");

    const plan = compileMountPlan({
      trialDir, repoDir, hostHome: homedir(), readOnlyRepo: false,
      commitGuardCacheDir: null, opencodeBinCacheDir: null, tsCompilerDirs: [],
      hostToolFiles, extraRoFiles: [],
    });

    const env = buildTrialEnv({
      trialDir, tsCompilerDirs: [], resolvedHostToolDirs: hostToolFiles.length > 0 ? [join(trialDir, "host-bin")] : [],
      keepWorkspaces: false, extraEnvNames: [],
    });

    return { trialDir, repoDir, args: [...plan.bwrapArgs, ...toBwrapEnvArgs(env)] };
  });

  const results = await Promise.all(trials.map(async ({ trialDir, repoDir, args }) => {
    const child = Bun.spawn([
      "bwrap", ...args, "--chdir", repoDir, "--", "/bin/sh", "-ec",
      `ruff check --no-cache .
       ! touch "$1/ruff-tamper"`,
      "sh", join(trialDir, "host-bin"),
    ], { env: {}, stdout: "pipe", stderr: "pipe" });

    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);

    return { code, diagnostics: code === 0 ? "" : stdout + stderr };
  }));

  expect(results).toEqual(Array.from({ length: 4 }, () => ({ code: 0, diagnostics: "" })));
}, 30_000);
