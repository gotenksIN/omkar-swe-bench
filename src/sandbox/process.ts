import { compileSystemMounts } from "./mount-plan.ts";

export type SandboxMode = "require" | "auto" | "off";

export async function probeSandbox(): Promise<{ available: boolean; reason: string | null }> {
  const bwrap = Bun.which("bwrap");

  if (bwrap === null) {
    return { available: false, reason: "bwrap is not on PATH." };
  }

  try {
    const { bwrapArgs } = compileSystemMounts();

    const child = Bun.spawn([bwrap, ...bwrapArgs, "--proc", "/proc", "--dev", "/dev", "--", "/bin/true"], {
      env: {},
      stderr: "pipe",
      stdout: "ignore",
    });

    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

    return code === 0
      ? { available: true, reason: null }
      : { available: false, reason: stderr.trim() || `bwrap exited with code ${code}.` };
  } catch (cause) {
    return { available: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

function assertProcessGroup(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new RangeError(`Invalid detached process group ID: ${pid}`);
  }
}

export function killProcessGroup(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  assertProcessGroup(pid);

  try {
    process.kill(-pid, signal);
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) {
      throw cause;
    }
  }
}

export class RunController {
  readonly #controller = new AbortController();
  readonly #interrupt = (): void => {
    this.abort();
  };

  constructor() {
    process.on("SIGINT", this.#interrupt);
    process.on("SIGTERM", this.#interrupt);
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  abort(): void {
    if (this.signal.aborted) {
      return;
    }

    process.off("SIGINT", this.#interrupt);
    process.off("SIGTERM", this.#interrupt);
    this.#controller.abort();
  }

  shutdown(): void {
    process.off("SIGINT", this.#interrupt);
    process.off("SIGTERM", this.#interrupt);
  }
}
