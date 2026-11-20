import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { buildTrialEnv, toBwrapEnvArgs } from "../../src/sandbox/env.ts";
import { compileMountPlan } from "../../src/sandbox/mount-plan.ts";
import { probeSandbox } from "../../src/sandbox/process.ts";
import {
  discoverHostToolFiles,
  requireGlobalRuff,
  runHostRuffCheck,
} from "../../src/sandbox/tools.ts";

const sandbox = await probeSandbox();
const hasRuff = Bun.which("ruff") !== null;
let workspace = "";

beforeAll(() => {
  mkdirSync("/tmp/opencode", { recursive: true });
  workspace = mkdtempSync("/tmp/opencode/bench-ruff-");
});

afterAll(() => {
  if (workspace) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test.skipIf(!hasRuff)(
  "grades Python files on the host with the global ruff binary without writing a cache",
  async () => {
    const repoDir = path.join(workspace, "host-check");

    mkdirSync(repoDir, { recursive: true });
    writeFileSync(path.join(repoDir, "example.py"), "import os\n");

    const dirty = await runHostRuffCheck(repoDir);

    expect(dirty.exitCode).toBe(1);
    expect(dirty.output).toContain("F401");
    expect(existsSync(path.join(repoDir, ".ruff_cache"))).toBe(false);

    writeFileSync(path.join(repoDir, "example.py"), "print(1)\n");
    const clean = await runHostRuffCheck(repoDir);
    expect(clean.exitCode).toBe(0);
  }
);

test("fails fast with install instructions when ruff is absent from PATH", () => {
  const previousPath = process.env.PATH;

  try {
    process.env.PATH = workspace;
    expect(() => requireGlobalRuff()).toThrow(/Install ruff globally/u);
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
  }
});

test.skipIf(!sandbox.available || !hasRuff)(
  "runs global ruff read-only across four concurrent sandboxes",
  async () => {
    const hostToolFiles = discoverHostToolFiles();

    const trials = Array.from({ length: 4 }, (_, index) => {
      const trialDir = path.join(workspace, `worker-${index}`);
      const repoDir = path.join(trialDir, "repo");
      const config = path.join(trialDir, "config", "opencode");

      mkdirSync(repoDir, { recursive: true });
      mkdirSync(config, { recursive: true });
      mkdirSync(path.join(trialDir, "home"));
      writeFileSync(path.join(config, "opencode.json"), "{}");
      writeFileSync(path.join(config, "opencode.jsonc"), "{}");
      writeFileSync(path.join(repoDir, "example.py"), "print(1)\n");

      const plan = compileMountPlan({
        trialDir,
        repoDir,
        hostHome: homedir(),
        readOnlyRepo: false,
        commitGuardCacheDir: null,
        opencodeBinCacheDir: null,
        tsCompilerDirs: [],
        hostToolFiles,
        extraRoFiles: [],
      });

      const env = buildTrialEnv({
        trialDir,
        tsCompilerDirs: [],
        resolvedHostToolDirs:
          hostToolFiles.length > 0 ? [path.join(trialDir, "host-bin")] : [],
        keepWorkspaces: false,
        extraEnvNames: [],
      });

      return {
        trialDir,
        repoDir,
        args: [...plan.bwrapArgs, ...toBwrapEnvArgs(env)],
      };
    });

    const results = await Promise.all(
      trials.map(async ({ repoDir, args }) => {
        const child = Bun.spawn(
          [
            "bwrap",
            ...args,
            "--chdir",
            repoDir,
            "--",
            "ruff",
            "check",
            "--no-cache",
            ".",
          ],
          { env: {}, stdout: "pipe", stderr: "pipe" }
        );

        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);

        return { code, diagnostics: code === 0 ? "" : stdout + stderr };
      })
    );

    expect(results).toEqual(
      Array.from({ length: 4 }, () => ({ code: 0, diagnostics: "" }))
    );
  },
  30_000
);
