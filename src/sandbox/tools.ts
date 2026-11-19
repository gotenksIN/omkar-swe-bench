import { lstatSync, mkdirSync, readlinkSync, realpathSync, rmdirSync, statSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { assertNoSymlinkBoundary } from "../util/fs.ts";

export interface TsCompilerDir {
  readonly sourceDir: string;
  readonly packageSubpath: string;
}

export interface HostToolFile {
  readonly name: string;
  readonly sourcePath: string;
}

const tsPackages = ["typescript", "@typescript", "@types", "bun-types", "undici-types"];
const toolNames = ["opencode", "bun", "node", "ruff", "git", "python3", "ssh-keygen"];
export const COMMIT_GUARD_PACKAGE = "opencode-commit-guard@1.1.1";
export const FORBIDDEN_HARNESS_MOUNT = /(?:^|\/)(?:oxlint|oxc-parser|@oxlint|anti-slop)(?:\/|$)/u;

function whichOnPath(name: string): string | null {
  const pathEnv = process.env.PATH;

  return pathEnv === undefined ? Bun.which(name) : Bun.which(name, { PATH: pathEnv });
}

export function requireGlobalRuff(): string {
  const executable = whichOnPath("ruff");

  if (executable === null) {
    throw new Error("Install ruff globally on PATH (for example: uv tool install ruff==0.17.5).");
  }

  return realpathSync(executable);
}

export async function runHostRuffCheck(repoDir: string): Promise<{ exitCode: number; output: string }> {
  const ruff = requireGlobalRuff();

  const child = Bun.spawn([ruff, "check", "--no-cache", "."], {
    cwd: repoDir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);

  return { exitCode, output: stdout + stderr };
}

export function discoverHostToolFiles(): HostToolFile[] {
  const files: HostToolFile[] = [];

  for (const name of toolNames) {
    const executable = whichOnPath(name);

    if (executable === null) {
      continue;
    }

    const sourcePath = realpathSync(executable);

    if (name !== "ruff" && (sourcePath.startsWith("/usr/") || sourcePath.startsWith("/bin/"))) {
      continue;
    }

    files.push({ name, sourcePath });
  }

  return files;
}

export function discoverHostToolDirs(): string[] {
  const dirs = new Set<string>();

  for (const tool of toolNames) {
    const executable = whichOnPath(tool);

    if (executable !== null) {
      dirs.add(dirname(executable));
    }
  }

  return [...dirs];
}

export function discoverOpenCodeCaches() {
  const cacheHome = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  const commitGuard = join(cacheHome, "opencode", "npm", COMMIT_GUARD_PACKAGE);
  const bin = join(cacheHome, "opencode", "bin");

  return {
    commitGuardCacheDir: statSync(commitGuard, { throwIfNoEntry: false })?.isDirectory() ? commitGuard : null,
    opencodeBinCacheDir: statSync(bin, { throwIfNoEntry: false })?.isDirectory() ? bin : null,
  };
}

export function discoverTsCompilerDirs(harnessRoot: string): TsCompilerDir[] {
  return tsPackages.flatMap((packageSubpath) => {
    const path = join(harnessRoot, "node_modules", packageSubpath);

    return statSync(path, { throwIfNoEntry: false })?.isDirectory()
      ? [{ sourceDir: resolveTsCompilerDir({ sourceDir: path, packageSubpath }), packageSubpath }]
      : [];
  });
}

export function resolveTsCompilerDir({ sourceDir, packageSubpath }: TsCompilerDir): string {
  const source = realpathSync(sourceDir);

  if (
    !tsPackages.includes(packageSubpath) || basename(source) !== packageSubpath
    || FORBIDDEN_HARNESS_MOUNT.test(sourceDir) || FORBIDDEN_HARNESS_MOUNT.test(source)
  ) {
    throw new Error(`Invalid TypeScript compiler mount: ${sourceDir} → ${packageSubpath}`);
  }

  if (!statSync(source).isDirectory()) {
    throw new Error(`Expected a TypeScript compiler directory: ${source}`);
  }

  return source;
}

export function prepareTrialTsBin(trialDir: string): void {
  const bin = join(trialDir, "ts-bin");
  mkdirSync(bin);
  symlinkSync("../node_modules/typescript/bin/tsc", join(bin, "tsc"));
}

export function linkHostTsNodeModules(trialDir: string, tsCompilerDirs: readonly TsCompilerDir[]): void {
  if (tsCompilerDirs.length === 0) {
    return;
  }

  assertNoSymlinkBoundary(trialDir);

  const nodeModules = join(trialDir, "node_modules");
  mkdirSync(nodeModules, { recursive: true });
  assertNoSymlinkBoundary(nodeModules);

  for (const compilerDir of tsCompilerDirs) {
    const source = resolveTsCompilerDir(compilerDir);
    const target = join(nodeModules, compilerDir.packageSubpath);
    const entry = lstatSync(target, { throwIfNoEntry: false });

    if (entry?.isSymbolicLink() && readlinkSync(target) === source) {
      continue;
    }

    if (entry?.isDirectory()) {
      // A bind at a missing target leaves an empty placeholder after bwrap exits.
      rmdirSync(target);
    }

    symlinkSync(source, target);
  }
}
