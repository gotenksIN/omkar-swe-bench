import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  buildTrialConfig,
  writeTrialConfig,
} from "../../src/config/prompts.ts";
import { writeProviderConfig } from "../../src/config/providers.ts";
import { startOpenCodeServer } from "../../src/driver/server.ts";
import { buildTrialEnv } from "../../src/sandbox/env.ts";
import { compileMountPlan } from "../../src/sandbox/mount-plan.ts";
import { probeSandbox } from "../../src/sandbox/process.ts";
import { discoverHostToolFiles } from "../../src/sandbox/tools.ts";

mkdirSync("/tmp/opencode", { recursive: true });

const sandbox = await probeSandbox();
const executable = Bun.which("opencode");

test.skipIf(!sandbox.available || executable === null)(
  "starts and closes real sandboxed OpenCode with Basic auth",
  async () => {
    const trialDir = mkdtempSync("/tmp/opencode/driver-server-");
    const repoDir = path.join(trialDir, "repo");
    const hostToolFiles = discoverHostToolFiles();

    const resolvedHostToolDirs =
      hostToolFiles.length > 0 ? [path.join(trialDir, "host-bin")] : [];

    try {
      mkdirSync(repoDir);
      mkdirSync(path.join(trialDir, "home"));
      writeTrialConfig(trialDir, buildTrialConfig({ role: "coder" }).config);
      writeProviderConfig(trialDir, {
        filteredProviders: {},
        extraRoFiles: [],
        extraEnvNames: [],
      });

      const mountPlan = compileMountPlan({
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

      const envVars = buildTrialEnv({
        trialDir,
        tsCompilerDirs: [],
        resolvedHostToolDirs,
        keepWorkspaces: false,
        extraEnvNames: [],
      });

      const server = await startOpenCodeServer({
        trialDir,
        repoDir,
        mountPlan,
        envVars,
        sandboxed: true,
        startupTimeoutMs: 5000,
        signal: new AbortController().signal,
      });

      try {
        const info = await server.client.server.info();
        expect(info.version).toMatch(/^\d+\.\d+\.\d+/u);
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
  },
  10_000
);

const expectServerRejects = async (
  work: Promise<Awaited<ReturnType<typeof startOpenCodeServer>>>,
  expectedMessage: string
): Promise<void> => {
  let caught: Error | null = null;

  try {
    await work;
  } catch (error) {
    caught = error instanceof Error ? error : new Error(String(error));
  }

  expect(caught?.message ?? "").toContain(expectedMessage);
};

const waitForChildExit = async (
  stat: ReturnType<typeof Bun.file>,
  attemptsRemaining: number
): Promise<void> => {
  if (attemptsRemaining <= 0 || !(await stat.exists())) {
    return;
  }

  const text = await stat.text().catch(() => "");

  if (/\) Z /u.test(text)) {
    return;
  }

  await Bun.sleep(5);
  await waitForChildExit(stat, attemptsRemaining - 1);
};

test.each([
  [
    "malformed first line",
    "printf 'not-json\\n'; read -r line",
    "Invalid OpenCode startup URL",
  ],
  [
    "no startup line",
    "read -r line",
    "Timed out waiting for OpenCode server startup",
  ],
])("rejects %s and closes the child", async (_label, script, message) => {
  const trialDir = mkdtempSync("/tmp/opencode/driver-startup-");

  try {
    const pidFile = path.join(trialDir, "pid");
    writeFileSync(
      path.join(trialDir, "opencode"),
      `#!/bin/sh\nprintf '%s' "$$" > "$PID_FILE"\n${script}\n`,
      { mode: 0o700 }
    );

    const envVars = new Map([
      ["PATH", trialDir],
      ["OPENCODE_PASSWORD", "test-password"],
      ["PID_FILE", pidFile],
      ["HOME", trialDir],
    ]);

    await expectServerRejects(
      startOpenCodeServer({
        trialDir,
        repoDir: trialDir,
        sandboxed: false,
        mountPlan: null,
        envVars,
        startupTimeoutMs: 150,
        signal: new AbortController().signal,
      }),
      message
    );
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
    const marker = path.join(trialDir, "child-finished");
    const childFile = path.join(trialDir, "child");
    writeFileSync(
      path.join(trialDir, "opencode"),
      `#!/bin/sh
(/bin/sleep 5; : > "$MARKER") &
printf '%s' "$!" > "$CHILD_FILE"
read -r line
wait
`,
      { mode: 0o700 }
    );

    await expectServerRejects(
      startOpenCodeServer({
        trialDir,
        repoDir: trialDir,
        sandboxed: false,
        mountPlan: null,
        envVars: new Map([
          ["PATH", trialDir],
          ["OPENCODE_PASSWORD", "test-password"],
          ["HOME", trialDir],
          ["MARKER", marker],
          ["CHILD_FILE", childFile],
        ]),
        startupTimeoutMs: 150,
        shutdownGraceMs: 100,
        signal: new AbortController().signal,
      }),
      "Timed out waiting for OpenCode server startup"
    );
    const childPid = Number(await Bun.file(childFile).text());
    expect(childPid).toBeGreaterThan(1);

    const stat = Bun.file(`/proc/${childPid}/stat`);
    await waitForChildExit(stat, 20);

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
    writeFileSync(
      path.join(trialDir, "opencode"),
      '#!/bin/sh\nprintf "%s\\n" "bwrap: Can\'t bind mount /missing" >&2\nexit 1\n',
      { mode: 0o700 }
    );

    const envVars = new Map([
      ["PATH", trialDir],
      ["OPENCODE_PASSWORD", "test-password"],
      ["HOME", trialDir],
    ]);

    try {
      await startOpenCodeServer({
        trialDir,
        repoDir: trialDir,
        sandboxed: false,
        mountPlan: null,
        envVars,
        startupTimeoutMs: 1000,
        signal: new AbortController().signal,
      });
      throw new Error("Expected startOpenCodeServer to reject.");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error instanceof Error ? error.name : "").toBe(
        "SandboxLaunchError"
      );
      expect(error instanceof Error ? error.message : "").toContain("bwrap:");
    }
  } finally {
    rmSync(trialDir, { recursive: true, force: true });
  }
});

test("preserves SandboxLaunchError when server exits right after printing a startup URL", async () => {
  const trialDir = mkdtempSync("/tmp/opencode/driver-url-crash-");

  try {
    writeFileSync(
      path.join(trialDir, "opencode"),
      "#!/bin/sh\nprintf '{\"url\":\"http://127.0.0.1:1\"}\\n'\nprintf 'ConfigInvalid: broken config\\n' >&2\nexit 1\n",
      { mode: 0o700 }
    );

    const envVars = new Map([
      ["PATH", trialDir],
      ["OPENCODE_PASSWORD", "test-password"],
      ["HOME", trialDir],
    ]);

    try {
      await startOpenCodeServer({
        trialDir,
        repoDir: trialDir,
        sandboxed: false,
        mountPlan: null,
        envVars,
        startupTimeoutMs: 1000,
        signal: new AbortController().signal,
      });
      throw new Error("Expected startOpenCodeServer to reject.");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error instanceof Error ? error.name : "").toBe(
        "SandboxLaunchError"
      );
      expect(error instanceof Error ? error.message : "").toContain(
        "ConfigInvalid"
      );
    }
  } finally {
    rmSync(trialDir, { recursive: true, force: true });
  }
});
