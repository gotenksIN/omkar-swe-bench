import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { toBwrapEnvArgs } from "../sandbox/env.ts";
import type { MountPlan } from "../sandbox/mount-plan.ts";
import { killProcessGroup } from "../sandbox/process.ts";
import { isJsonObject, isString, parseJsonText } from "../util/json.ts";

export interface StartServerOptions {
  readonly trialDir: string;
  readonly repoDir: string;
  readonly sandboxed: boolean;
  readonly mountPlan: MountPlan | null;
  readonly envVars: ReadonlyMap<string, string>;
  readonly startupTimeoutMs: number;
  readonly signal: AbortSignal;
}

export interface ServerHandle {
  readonly baseUrl: string;
  readonly pid: number;
  readonly client: OpenCodeClient;
  readonly stderrTail: () => string;
  readonly exitPromise: Promise<number | null>;
  readonly close: () => Promise<void>;
}

export function generateServerPassword(): string {
  return randomBytes(32).toString("base64url");
}

function startupUrl(line: string): string {
  try {
    const value = parseJsonText(line);

    if (isJsonObject(value) && isString(value.url) && /^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(value.url)) {
      new URL(value.url);

      return value.url;
    }
  } catch (cause) {
    throw new Error("Invalid OpenCode startup URL on stdout.", { cause });
  }

  throw new Error("Invalid OpenCode startup URL on stdout.");
}

export async function startOpenCodeServer(options: StartServerOptions): Promise<ServerHandle> {
  const { envVars, mountPlan, repoDir, sandboxed, startupTimeoutMs, signal } = options;
  signal.throwIfAborted();
  const password = envVars.get("OPENCODE_PASSWORD");

  if (!password) {
    throw new Error("Set OPENCODE_PASSWORD before starting OpenCode.");
  }

  if (sandboxed && mountPlan === null) {
    throw new Error("A mount plan is required for sandboxed OpenCode.");
  }

  const command = ["opencode", "serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"];

  const args = sandboxed && mountPlan !== null
    ? ["bwrap", ...mountPlan.bwrapArgs, ...toBwrapEnvArgs(envVars), "--", ...command]
    : command;

  const proc = Bun.spawn(args, {
    cwd: repoDir, env: sandboxed ? {} : Object.fromEntries(envVars), detached: true,
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });

  const exitPromise = proc.exited;
  const stdout = proc.stdout.getReader();
  const stderr = proc.stderr.getReader();
  const tailLimit = 16_384;
  let tail = "";
  let closing: Promise<void> | undefined;

  const stderrDrained = (async () => {
    const decoder = new TextDecoder();

    try {
      for (;;) {
        const chunk = await stderr.read();
        tail = (tail + decoder.decode(chunk.value, { stream: !chunk.done })).slice(-tailLimit);

        if (chunk.done) {
          return;
        }
      }
    } catch {
      // Retain the tail if the pipe breaks.
    }
  })();

  async function closeProcess(): Promise<void> {
    if (signal.aborted && proc.exitCode === null && proc.signalCode === null) {
      killProcessGroup(proc.pid);
      await exitPromise;
      await Promise.allSettled([stdout.cancel(), stderr.cancel()]);

      return;
    }

    try {
      await proc.stdin.end();
    } catch {
      // The server can close its pipe before it exits.
    }

    const deadline = new AbortController();

    try {
      const exited = await Promise.race([
        exitPromise.then(() => true),
        delay(3_000, false, { signal: deadline.signal }),
      ]);

      if (!exited && proc.exitCode === null && proc.signalCode === null) {
        killProcessGroup(proc.pid);
        await exitPromise;
      }
    } finally {
      deadline.abort();
      await Promise.allSettled([stdout.cancel(), stderr.cancel()]);
    }
  }

  function close(): Promise<void> {
    closing ??= closeProcess();

    return closing;
  }

  const startup = new AbortController();
  const startupSignal = AbortSignal.any([signal, startup.signal]);

  const deadline = setTimeout(() => {
    const failure = new Error("Timed out waiting for OpenCode server startup.");
    failure.name = "ReadinessTimeoutError";
    startup.abort(failure);
  }, startupTimeoutMs);

  const aborted = Promise.withResolvers<never>();
  const onAbort = (): void => aborted.reject(startupSignal.reason);
  startupSignal.addEventListener("abort", onAbort, { once: true });

  const exited = exitPromise.then(async (code) => {
    await Promise.race([stderrDrained, delay(200)]);
    const detail = tail.trim();
    const suffix = detail ? `: ${detail}` : "";
    const failure = new Error(`OpenCode exited during startup (code ${code})${suffix}`);

    const deterministicLaunch = proc.signalCode === null
      && /bwrap:|execvp|ConfigInvalid|Invalid config|ENOENT|Permission denied/iu.test(detail);

    failure.name = deterministicLaunch
      ? "SandboxLaunchError"
      : code === 0 ? "ServerStartupError" : "UnexpectedServerExitError";

    throw failure;
  });

  async function connect(): Promise<{ baseUrl: string; client: OpenCodeClient }> {
    const decoder = new TextDecoder();
    let line = "";

    for (;;) {
      const chunk = await stdout.read();

      if (chunk.done) {
        return exited;
      }

      line += decoder.decode(chunk.value, { stream: true });
      const newline = line.indexOf("\n");

      if (newline !== -1) {
        const baseUrl = startupUrl(line.slice(0, newline).trimEnd());
        const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
        const client = OpenCode.make({ baseUrl, headers: { authorization } });

        void (async () => {
          try {
            while (!(await stdout.read()).done) {
              // Drain output to keep the server from blocking on a full pipe.
            }
          } catch {
            // The pipe can close during teardown.
          }
        })();

        await client.server.info({ signal: startupSignal });

        return { baseUrl, client };
      }

      if (line.length > tailLimit) {
        throw new Error("Invalid OpenCode startup URL on stdout: line too long.");
      }
    }
  }

  try {
    const { baseUrl, client } = await Promise.race([connect(), aborted.promise, exited]);

    return { baseUrl, pid: proc.pid, client, stderrTail: () => tail, exitPromise, close };
  } catch (cause) {
    const crashed = !startupSignal.aborted
      && await Promise.race([exitPromise.then(() => true), delay(50, false)]);

    startup.abort();

    try {
      if (crashed) {
        await exited;
      }
    } finally {
      await close();
    }

    throw cause;
  } finally {
    clearTimeout(deadline);
    startupSignal.removeEventListener("abort", onAbort);
  }
}
