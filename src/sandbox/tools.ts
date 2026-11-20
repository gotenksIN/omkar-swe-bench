import {
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import nodePath from "node:path";

import { assertNoSymlinkBoundary, atomicWriteFile } from "../util/fs.ts";
import { isJsonObject, parseJsonText } from "../util/json.ts";

export interface TsCompilerDir {
  readonly sourceDir: string;
  readonly packageSubpath: string;
}

export interface HostToolFile {
  readonly name: string;
  readonly sourcePath: string;
}

const tsPackages = [
  "typescript",
  "@typescript",
  "@types",
  "bun-types",
  "undici-types",
];

const toolNames = [
  "opencode",
  "bun",
  "node",
  "ruff",
  "git",
  "python3",
  "ssh-keygen",
];

export const COMMIT_GUARD_PACKAGE = "opencode-commit-guard@1.1.1";

export const FORBIDDEN_HARNESS_MOUNT =
  /(?:^|\/)(?:oxlint|oxlint-tsgolint|oxfmt|ultracite|oxc-parser|@oxlint|@oxlint-tsgolint|@oxfmt|@oxc-parser|@oxc-project|anti-slop|oxlint\.config\.[cm]?[jt]s|oxfmt\.config\.[cm]?[jt]s|\.oxlintrc\.jsonc?|\.oxfmtrc\.jsonc?)(?:\/|$)/u;

const DEFAULT_MODELS_URL = "https://models.opencode.ai";

const MODELS_CATALOG_PATH =
  "/experimental/v2.0/api.json?type=chat,decision,image,video";

const whichOnPath = (name: string): string | null => {
  const pathEnv = process.env.PATH;

  return pathEnv === undefined
    ? Bun.which(name)
    : Bun.which(name, { PATH: pathEnv });
};

export const resolveSandboxTool = (name: string): string | null =>
  name === "python3"
    ? (Bun.which("python3", { PATH: "/usr/bin:/bin" }) ??
      whichOnPath("python3"))
    : whichOnPath(name);

export const requireGlobalRuff = (): string => {
  const executable = whichOnPath("ruff");

  if (executable === null) {
    throw new Error(
      "Install ruff globally on PATH (for example: uv tool install ruff==0.17.5)."
    );
  }

  return realpathSync(executable);
};

export const runHostRuffCheck = async (
  repoDir: string
): Promise<{ exitCode: number; output: string }> => {
  const ruff = requireGlobalRuff();

  const child = Bun.spawn([ruff, "check", "--no-cache", "."], {
    cwd: repoDir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { exitCode, output: stdout + stderr };
};

export const discoverHostToolFiles = (): HostToolFile[] => {
  const files: HostToolFile[] = [];

  for (const name of toolNames) {
    const executable = resolveSandboxTool(name);

    if (executable === null) {
      continue;
    }

    const sourcePath = realpathSync(executable);

    if (
      name !== "ruff" &&
      (sourcePath.startsWith("/usr/") || sourcePath.startsWith("/bin/"))
    ) {
      continue;
    }

    files.push({ name, sourcePath });
  }

  return files;
};

export const discoverHostToolDirs = (): string[] => {
  const dirs = new Set<string>();

  for (const tool of toolNames) {
    const executable = resolveSandboxTool(tool);

    if (executable !== null) {
      dirs.add(nodePath.dirname(executable));
    }
  }

  return [...dirs];
};

export const discoverOpenCodeCaches = () => {
  const cacheHome =
    process.env.XDG_CACHE_HOME ?? nodePath.join(homedir(), ".cache");

  const commitGuard = nodePath.join(
    cacheHome,
    "opencode",
    "npm",
    COMMIT_GUARD_PACKAGE
  );

  const bin = nodePath.join(cacheHome, "opencode", "bin");

  const models =
    process.env.OPENCODE_MODELS_PATH ??
    nodePath.join(cacheHome, "opencode", "models.json");

  return {
    commitGuardCacheDir:
      statSync(commitGuard, {
        throwIfNoEntry: false,
      })?.isDirectory() === true
        ? commitGuard
        : null,
    opencodeBinCacheDir:
      statSync(bin, { throwIfNoEntry: false })?.isDirectory() === true
        ? bin
        : null,
    opencodeModelsCacheFile:
      statSync(models, {
        throwIfNoEntry: false,
      })?.isFile() === true
        ? realpathSync(models)
        : null,
  };
};

export const refreshOpenCodeModelsCache = async (
  signal: AbortSignal
): Promise<string | null> => {
  const override = process.env.OPENCODE_MODELS_PATH;

  if (override !== undefined) {
    if (statSync(override, { throwIfNoEntry: false })?.isFile() !== true) {
      throw new Error(
        `OPENCODE_MODELS_PATH is not a readable file: ${override}`
      );
    }

    return realpathSync(override);
  }

  const cacheHome =
    process.env.XDG_CACHE_HOME ?? nodePath.join(homedir(), ".cache");

  const opencodeCacheDir = nodePath.resolve(cacheHome, "opencode");
  const target = nodePath.join(opencodeCacheDir, "models.json");

  const existing =
    statSync(target, { throwIfNoEntry: false })?.isFile() === true
      ? realpathSync(target)
      : null;

  const envModelsUrl = process.env.OPENCODE_MODELS_URL;

  const baseUrl = (
    envModelsUrl !== undefined && envModelsUrl.length > 0
      ? envModelsUrl
      : DEFAULT_MODELS_URL
  ).replace(/\/+$/u, "");

  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);

  try {
    let response = await fetch(`${baseUrl}${MODELS_CATALOG_PATH}`, {
      signal: requestSignal,
    });

    if (response.status === 404 && baseUrl !== DEFAULT_MODELS_URL) {
      response = await fetch(`${baseUrl}/api.json`, { signal: requestSignal });
    }

    if (!response.ok) {
      return existing;
    }

    const text = await response.text();

    if (!isJsonObject(parseJsonText(text))) {
      return existing;
    }

    mkdirSync(opencodeCacheDir, { recursive: true });
    atomicWriteFile(target, text, 0o644);

    return realpathSync(target);
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }

    return existing;
  }
};

export const discoverTsCompilerDirs = (harnessRoot: string): TsCompilerDir[] =>
  tsPackages.flatMap((packageSubpath) => {
    const path = nodePath.join(harnessRoot, "node_modules", packageSubpath);

    return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true
      ? [
          {
            sourceDir: resolveTsCompilerDir({
              sourceDir: path,
              packageSubpath,
            }),
            packageSubpath,
          },
        ]
      : [];
  });

export const resolveTsCompilerDir = ({
  sourceDir,
  packageSubpath,
}: TsCompilerDir): string => {
  const source = realpathSync(sourceDir);

  if (
    !tsPackages.includes(packageSubpath) ||
    nodePath.basename(source) !== packageSubpath ||
    FORBIDDEN_HARNESS_MOUNT.test(sourceDir) ||
    FORBIDDEN_HARNESS_MOUNT.test(source)
  ) {
    throw new Error(
      `Invalid TypeScript compiler mount: ${sourceDir} → ${packageSubpath}`
    );
  }

  if (!statSync(source).isDirectory()) {
    throw new Error(`Expected a TypeScript compiler directory: ${source}`);
  }

  return source;
};

export const prepareTrialTsBin = (trialDir: string): void => {
  const bin = nodePath.join(trialDir, "ts-bin");
  mkdirSync(bin);
  symlinkSync("../node_modules/typescript/bin/tsc", nodePath.join(bin, "tsc"));
};

export const linkHostTsNodeModules = (
  trialDir: string,
  tsCompilerDirs: readonly TsCompilerDir[]
): void => {
  if (tsCompilerDirs.length === 0) {
    return;
  }

  assertNoSymlinkBoundary(trialDir);

  const nodeModules = nodePath.join(trialDir, "node_modules");
  mkdirSync(nodeModules, { recursive: true });
  assertNoSymlinkBoundary(nodeModules);

  for (const compilerDir of tsCompilerDirs) {
    const source = resolveTsCompilerDir(compilerDir);
    const target = nodePath.join(nodeModules, compilerDir.packageSubpath);
    const entry = lstatSync(target, { throwIfNoEntry: false });

    if (entry?.isSymbolicLink() === true && readlinkSync(target) === source) {
      continue;
    }

    if (entry?.isDirectory() === true) {
      // A bind at a missing target leaves an empty placeholder after bwrap exits.
      rmdirSync(target);
    }

    symlinkSync(source, target);
  }
};
