import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { buildTrialConfig, writeTrialConfig } from "../../src/config/prompts.ts";
import { writeProviderConfig } from "../../src/config/providers.ts";
import { generateServerPassword, startOpenCodeServer } from "../../src/driver/server.ts";
import { buildTrialEnv } from "../../src/sandbox/env.ts";
import { compileMountPlan } from "../../src/sandbox/mount-plan.ts";
import { probeSandbox } from "../../src/sandbox/process.ts";
import { discoverHostToolFiles } from "../../src/sandbox/tools.ts";

mkdirSync("/tmp/opencode", { recursive: true });

const sandbox = await probeSandbox();
const executable = Bun.which("opencode");

test.skipIf(!sandbox.available || executable === null)("starts and closes real sandboxed OpenCode with Basic auth", async () => {
  if (executable === null) {
    throw new Error("OpenCode is not installed.");
  }

  const trialDir = mkdtempSync("/tmp/opencode/driver-server-");
  const repoDir = join(trialDir, "repo");
  const hostToolFiles = discoverHostToolFiles();
  const resolvedHostToolDirs = hostToolFiles.length > 0 ? [join(trialDir, "host-bin")] : [];

  try {
    mkdirSync(repoDir);
    mkdirSync(join(trialDir, "home"));
    writeTrialConfig(trialDir, buildTrialConfig({ role: "coder" }).config);
    writeProviderConfig(trialDir, { filteredProviders: {}, extraRoFiles: [], extraEnvNames: [] });

    const mountPlan = compileMountPlan({
      trialDir, repoDir, hostHome: homedir(), readOnlyRepo: false,
      commitGuardCacheDir: null, opencodeBinCacheDir: null, tsCompilerDirs: [], hostToolFiles, extraRoFiles: [],
    });

    const envVars = new Map(buildTrialEnv({
      trialDir, tsCompilerDirs: [], resolvedHostToolDirs,
      keepWorkspaces: false, extraEnvNames: [],
    }));

    envVars.set("OPENCODE_PASSWORD", generateServerPassword());

    const server = await startOpenCodeServer({
      trialDir, repoDir, mountPlan, envVars, sandboxed: true, startupTimeoutMs: 5_000, signal: new AbortController().signal,
    });

    try {
      expect(Buffer.from(envVars.get("OPENCODE_PASSWORD") ?? "", "base64url")).toHaveLength(32);
      expect((await server.client.server.info()).version).toMatch(/^\d+\.\d+\.\d+/u);
      const unauthorized = await fetch(`${server.baseUrl}/api/info`);
      expect(unauthorized.status).toBe(401);
      await unauthorized.body?.cancel();
      const firstClose = server.close();
      expect(server.close()).toBe(firstClose);
      await firstClose;
      expect(await server.exitPromise).toBe(0);
      expect(() => process.kill(server.pid, 0)).toThrow();
    } finally {
      await server.close();
    }
  } finally {
    rmSync(trialDir, { recursive: true, force: true });
  }
}, 10_000);

test.each([
  ["malformed first line", "printf 'not-json\\n'; read -r line", "Invalid OpenCode startup URL"],
  ["no startup line", "read -r line", "Timed out waiting for OpenCode server startup"],
])("rejects %s and closes the child", async (_label, script, message) => {
  const trialDir = mkdtempSync("/tmp/opencode/driver-startup-");

  try {
    const pidFile = join(trialDir, "pid");
    writeFileSync(join(trialDir, "opencode"), `#!/bin/sh\nprintf '%s' "$$" > "$PID_FILE"\n${script}\n`, { mode: 0o700 });

    const envVars = new Map([
      ["PATH", trialDir], ["OPENCODE_PASSWORD", generateServerPassword()], ["PID_FILE", pidFile], ["HOME", trialDir],
    ]);

    await expect(startOpenCodeServer({
      trialDir, repoDir: trialDir, sandboxed: false, mountPlan: null, envVars,
      startupTimeoutMs: 150, signal: new AbortController().signal,
    })).rejects.toThrow(message);
    const pid = Number(await Bun.file(pidFile).text());
    expect(pid).toBeGreaterThan(1);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    rmSync(trialDir, { recursive: true, force: true });
  }
});

test("kills the detached process group when stdin closes but the server does not exit", async () => {
  const trialDir = mkdtempSync("/tmp/opencode/driver-group-");

  try {
    const marker = join(trialDir, "child-finished");
    const childFile = join(trialDir, "child");
    writeFileSync(join(trialDir, "opencode"), `#!/bin/sh
(/bin/sleep 5; : > "$MARKER") &
printf '%s' "$!" > "$CHILD_FILE"
read -r line
wait
`, { mode: 0o700 });

    await expect(startOpenCodeServer({
      trialDir, repoDir: trialDir, sandboxed: false, mountPlan: null,
      envVars: new Map([
        ["PATH", trialDir], ["OPENCODE_PASSWORD", generateServerPassword()], ["HOME", trialDir],
        ["MARKER", marker], ["CHILD_FILE", childFile],
      ]),
      startupTimeoutMs: 150, signal: new AbortController().signal,
    })).rejects.toThrow("Timed out waiting for OpenCode server startup");
    const childPid = Number(await Bun.file(childFile).text());
    expect(childPid).toBeGreaterThan(1);

    const stat = Bun.file(`/proc/${childPid}/stat`);

    for (let attempt = 0; attempt < 20 && await stat.exists(); attempt += 1) {
      if (/\) Z /u.test(await stat.text().catch(() => ""))) {
        break;
      }

      await Bun.sleep(5);
    }

    const childState = await stat.text().catch(() => "");
    expect(childState === "" || /\) Z /u.test(childState)).toBe(true);
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(trialDir, { recursive: true, force: true });
  }
}, 10_000);

test("drains stderr before classifying deterministic launch failures as SandboxLaunchError", async () => {
  const trialDir = mkdtempSync("/tmp/opencode/driver-launch-");

  try {
    writeFileSync(join(trialDir, "opencode"), "#!/bin/sh\nprintf \"%s\\n\" \"bwrap: Can't bind mount /missing\" >&2\nexit 1\n", { mode: 0o700 });

    const envVars = new Map([["PATH", trialDir], ["OPENCODE_PASSWORD", generateServerPassword()], ["HOME", trialDir]]);

    try {
      await startOpenCodeServer({
        trialDir, repoDir: trialDir, sandboxed: false, mountPlan: null, envVars,
        startupTimeoutMs: 1_000, signal: new AbortController().signal,
      });
      throw new Error("Expected startOpenCodeServer to reject.");
    } catch (cause) {
      expect(cause).toBeInstanceOf(Error);
      expect(cause instanceof Error ? cause.name : "").toBe("SandboxLaunchError");
      expect(cause instanceof Error ? cause.message : "").toContain("bwrap:");
    }
  } finally {
    rmSync(trialDir, { recursive: true, force: true });
  }
});

test("preserves SandboxLaunchError when server exits right after printing a startup URL", async () => {
  const trialDir = mkdtempSync("/tmp/opencode/driver-url-crash-");

  try {
    writeFileSync(
      join(trialDir, "opencode"),
      "#!/bin/sh\nprintf '{\"url\":\"http://127.0.0.1:1\"}\\n'\nprintf 'ConfigInvalid: broken config\\n' >&2\nexit 1\n",
      { mode: 0o700 },
    );

    const envVars = new Map([["PATH", trialDir], ["OPENCODE_PASSWORD", generateServerPassword()], ["HOME", trialDir]]);

    try {
      await startOpenCodeServer({
        trialDir, repoDir: trialDir, sandboxed: false, mountPlan: null, envVars,
        startupTimeoutMs: 1_000, signal: new AbortController().signal,
      });
      throw new Error("Expected startOpenCodeServer to reject.");
    } catch (cause) {
      expect(cause).toBeInstanceOf(Error);
      expect(cause instanceof Error ? cause.name : "").toBe("SandboxLaunchError");
      expect(cause instanceof Error ? cause.message : "").toContain("ConfigInvalid");
    }
  } finally {
    rmSync(trialDir, { recursive: true, force: true });
  }
});
