import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import nodePath from "node:path";

import { assertNoSymlinkBoundary } from "../util/fs.ts";
import { COMMIT_GUARD_PACKAGE, resolveTsCompilerDir } from "./tools.ts";
import type { HostToolFile, TsCompilerDir } from "./tools.ts";

export interface BindMount {
  readonly source: string;
  readonly target: string;
  readonly readOnly: boolean;
  readonly isFile: boolean;
}

export interface SymlinkMount {
  readonly linkTarget: string;
  readonly path: string;
}

export interface MountPlanInput {
  readonly trialDir: string;
  readonly repoDir: string;
  readonly hostHome: string;
  readonly readOnlyRepo: boolean;
  readonly commitGuardCacheDir: string | null;
  readonly opencodeBinCacheDir: string | null;
  readonly opencodeModelsCacheFile?: string | null;
  readonly tsCompilerDirs: readonly TsCompilerDir[];
  readonly hostToolFiles: readonly HostToolFile[];
  readonly extraRoFiles: readonly string[];
}

export interface MountPlan {
  readonly unshareArgs: readonly string[];
  readonly symlinks: readonly SymlinkMount[];
  readonly tmpfsPaths: readonly string[];
  readonly ensureDirs: readonly string[];
  readonly binds: readonly BindMount[];
  readonly bwrapArgs: readonly string[];
}

const etcEntries = [
  "/etc/resolv.conf",
  "/etc/hosts",
  "/etc/nsswitch.conf",
  "/etc/ssl",
  "/etc/ca-certificates",
  "/etc/localtime",
  "/etc/passwd",
  "/etc/group",
];

export const compileSystemMounts = (): Pick<
  MountPlan,
  "unshareArgs" | "symlinks" | "binds" | "bwrapArgs"
> => {
  const unshareArgs = [
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--new-session",
    "--die-with-parent",
  ];

  const symlinks: SymlinkMount[] = [];

  const binds: BindMount[] = [
    { source: "/usr", target: "/usr", readOnly: true, isFile: false },
  ];

  const bwrapArgs = [...unshareArgs, "--ro-bind", "/usr", "/usr"];

  for (const path of ["/bin", "/sbin", "/lib", "/lib64", "/lib32"]) {
    const entry = lstatSync(path, { throwIfNoEntry: false });

    if (entry?.isSymbolicLink() === true) {
      const linkTarget = readlinkSync(path);
      symlinks.push({ linkTarget, path });
      bwrapArgs.push("--symlink", linkTarget, path);
    } else if (entry?.isDirectory() === true) {
      binds.push({ source: path, target: path, readOnly: true, isFile: false });
      bwrapArgs.push("--ro-bind", path, path);
    }
  }

  return { unshareArgs, symlinks, binds, bwrapArgs };
};

export const containsPath = (directory: string, path: string): boolean =>
  directory === path ||
  path.startsWith(directory === "/" ? "/" : `${directory}/`);

const inside = (path: string, directory: string): boolean =>
  path !== directory && containsPath(directory, path);

const readOnlyMount = (
  sourcePath: string,
  target: string,
  isFile: boolean
): BindMount => {
  const source = realpathSync(sourcePath);
  const entry = statSync(source);

  if (isFile ? !entry.isFile() : !entry.isDirectory()) {
    throw new Error(
      `Expected a ${isFile ? "regular file" : "directory"}: ${sourcePath}`
    );
  }

  return { source, target, readOnly: true, isFile };
};

const depth = (path: string): number => path.split("/").length;

const addHostToolMounts = (
  input: MountPlanInput,
  trialDir: string,
  tmpfsPaths: string[],
  bwrapArgs: string[],
  bind: (mount: BindMount) => void
): void => {
  if (input.hostToolFiles.length === 0) {
    return;
  }

  const hostBin = nodePath.join(trialDir, "host-bin");
  const seenNames = new Set<string>();
  tmpfsPaths.push(hostBin);
  bwrapArgs.push("--tmpfs", hostBin);

  for (const { name, sourcePath } of input.hostToolFiles) {
    if (!/^[A-Za-z0-9._-]+$/u.test(name) || name === "." || name === "..") {
      throw new Error(`Invalid host tool executable name: ${name}`);
    }

    if (seenNames.has(name)) {
      continue;
    }

    seenNames.add(name);
    bind(readOnlyMount(sourcePath, nodePath.join(hostBin, name), true));
  }

  bwrapArgs.push("--remount-ro", hostBin);
};

const addCacheAndTsMounts = (
  input: MountPlanInput,
  trialDir: string,
  ensureParent: (target: string) => void,
  bind: (mount: BindMount) => void
): void => {
  if (input.commitGuardCacheDir !== null) {
    const target = nodePath.join(
      trialDir,
      "cache",
      "opencode",
      "npm",
      COMMIT_GUARD_PACKAGE
    );

    ensureParent(target);
    bind(readOnlyMount(input.commitGuardCacheDir, target, false));
  }

  if (
    input.opencodeBinCacheDir !== null &&
    statSync(input.opencodeBinCacheDir, { throwIfNoEntry: false }) !== undefined
  ) {
    const target = nodePath.join(trialDir, "cache", "opencode", "bin");
    ensureParent(target);
    bind(readOnlyMount(input.opencodeBinCacheDir, target, false));
  }

  if (
    input.opencodeModelsCacheFile !== undefined &&
    input.opencodeModelsCacheFile !== null
  ) {
    const target = nodePath.join(trialDir, "cache", "opencode", "models.json");
    ensureParent(target);
    bind(readOnlyMount(input.opencodeModelsCacheFile, target, true));
  }

  if (input.tsCompilerDirs.length > 0) {
    for (const entry of input.tsCompilerDirs) {
      const source = resolveTsCompilerDir(entry);

      const target = nodePath.join(
        trialDir,
        "node_modules",
        entry.packageSubpath
      );

      ensureParent(target);
      bind({ source, target, readOnly: true, isFile: false });
    }

    const tsBin = nodePath.join(trialDir, "ts-bin");
    assertNoSymlinkBoundary(tsBin, trialDir);
    bind(readOnlyMount(tsBin, tsBin, false));
  }
};

export const compileMountPlan = (input: MountPlanInput): MountPlan => {
  assertNoSymlinkBoundary(input.trialDir);
  assertNoSymlinkBoundary(input.repoDir);
  const trialDir = nodePath.resolve(input.trialDir);
  const repoDir = nodePath.resolve(input.repoDir);
  const hostHome = nodePath.resolve(input.hostHome);

  if (
    !inside(repoDir, trialDir) ||
    !statSync(trialDir).isDirectory() ||
    !statSync(repoDir).isDirectory()
  ) {
    throw new Error(
      `Expected a repository directory inside the trial directory: ${repoDir}`
    );
  }

  const system = compileSystemMounts();
  const binds = [...system.binds];
  const bwrapArgs = [...system.bwrapArgs];
  const ensureDirs = new Set<string>();
  const tmpfsPaths = ["/tmp", hostHome];

  const bind = (mount: BindMount): void => {
    binds.push(mount);
    bwrapArgs.push(
      mount.readOnly ? "--ro-bind" : "--bind",
      mount.source,
      mount.target
    );
  };

  const ensureParent = (target: string): void => {
    const parent = nodePath.dirname(target);

    if (!ensureDirs.has(parent)) {
      ensureDirs.add(parent);
      bwrapArgs.push("--dir", parent);
    }
  };

  for (const entry of etcEntries) {
    const info = statSync(entry, { throwIfNoEntry: false });

    if (info) {
      bind(readOnlyMount(entry, entry, info.isFile()));
    }
  }

  bwrapArgs.push("--proc", "/proc", "--dev", "/dev");

  for (const path of tmpfsPaths) {
    bwrapArgs.push("--tmpfs", path);
  }

  bind({ source: trialDir, target: trialDir, readOnly: false, isFile: false });

  if (input.readOnlyRepo) {
    bind({ source: repoDir, target: repoDir, readOnly: true, isFile: false });
  }

  const config = nodePath.join(trialDir, "config");
  const opencodeConfig = nodePath.join(config, "opencode");

  // Pin both directories in place without blocking writes to service and lock files.
  assertNoSymlinkBoundary(opencodeConfig, trialDir);

  for (const path of [config, opencodeConfig]) {
    bind({ source: path, target: path, readOnly: false, isFile: false });
  }

  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const path = nodePath.join(opencodeConfig, name);
    assertNoSymlinkBoundary(path, trialDir);
    bind(readOnlyMount(path, path, true));
  }

  const overlays = input.extraRoFiles.map((path) => {
    const source = realpathSync(path);

    return readOnlyMount(source, source, true);
  });

  overlays.sort((left, right) => depth(left.target) - depth(right.target));

  for (const mount of overlays) {
    const systemAlias = system.symlinks.some(
      ({ path }) => mount.target === path || inside(mount.target, path)
    );

    const covered = binds.some(
      ({ target, readOnly, isFile }) =>
        readOnly &&
        (mount.target === target || (!isFile && inside(mount.target, target)))
    );

    if (covered || systemAlias) {
      continue;
    }

    if (inside(mount.target, hostHome) || inside(mount.target, "/tmp")) {
      ensureParent(mount.target);
    }

    bind(mount);
  }

  addHostToolMounts(input, trialDir, tmpfsPaths, bwrapArgs, bind);
  addCacheAndTsMounts(input, trialDir, ensureParent, bind);

  return {
    unshareArgs: system.unshareArgs,
    symlinks: system.symlinks,
    tmpfsPaths,
    ensureDirs: [...ensureDirs],
    binds,
    bwrapArgs,
  };
};
