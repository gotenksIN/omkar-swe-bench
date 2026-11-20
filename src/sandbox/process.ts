import { compileSystemMounts } from "./mount-plan.ts";

export type SandboxMode = "require" | "auto" | "off";

export const probeSandbox = async (): Promise<{
  available: boolean;
  reason: string | null;
}> => {
  const bwrap =
    process.env.PATH === undefined
      ? Bun.which("bwrap")
      : Bun.which("bwrap", { PATH: process.env.PATH });

  if (bwrap === null) {
    return { available: false, reason: "bwrap is not on PATH." };
  }

  try {
    const { bwrapArgs } = compileSystemMounts();

    const child = Bun.spawn(
      [
        bwrap,
        ...bwrapArgs,
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--",
        "/bin/true",
      ],
      {
        env: {},
        stderr: "pipe",
        stdout: "ignore",
      }
    );

    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    return code === 0
      ? { available: true, reason: null }
      : {
          available: false,
          reason: stderr.trim() || `bwrap exited with code ${code}.`,
        };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};

const assertProcessGroup = (pid: number): void => {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new RangeError(`Invalid detached process group ID: ${pid}`);
  }
};

export const killProcessGroup = (
  pid: number,
  signal: NodeJS.Signals = "SIGKILL"
): void => {
  assertProcessGroup(pid);

  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ESRCH")
    ) {
      throw error;
    }
  }
};

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
