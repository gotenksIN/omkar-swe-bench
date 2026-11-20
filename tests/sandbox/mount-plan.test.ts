import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import nodePath from "node:path";

import { buildTrialEnv, toBwrapEnvArgs } from "../../src/sandbox/env.ts";
import { compileMountPlan } from "../../src/sandbox/mount-plan.ts";
import type { MountPlanInput } from "../../src/sandbox/mount-plan.ts";
import { probeSandbox } from "../../src/sandbox/process.ts";
import {
  COMMIT_GUARD_PACKAGE,
  discoverHostToolFiles,
  discoverTsCompilerDirs,
  linkHostTsNodeModules,
  prepareTrialTsBin,
} from "../../src/sandbox/tools.ts";

const sandboxTsConfig = `${JSON.stringify(
  {
    compilerOptions: {
      target: "ES2024",
      module: "Preserve",
      moduleResolution: "bundler",
      allowImportingTsExtensions: true,
      types: ["bun-types"],
      strict: true,
      noEmit: true,
    },
    include: ["src/**/*.ts", "tests/**/*.ts"],
  },
  null,
  2
)}\n`;

const sandbox = await probeSandbox();
let workspace: string;
let input: MountPlanInput;

beforeEach(() => {
  mkdirSync("/tmp/opencode", { recursive: true });
  workspace = mkdtempSync("/tmp/opencode/bench-mount-");
  const trialDir = nodePath.join(workspace, "trial");
  const repoDir = nodePath.join(trialDir, "repo");
  const hostHome = nodePath.join(workspace, "host-home");
  const config = nodePath.join(trialDir, "config", "opencode");

  mkdirSync(repoDir, { recursive: true });
  mkdirSync(hostHome);
  mkdirSync(config, { recursive: true });
  writeFileSync(nodePath.join(config, "opencode.json"), "{}");
  writeFileSync(nodePath.join(config, "opencode.jsonc"), "{}");
  input = {
    trialDir,
    repoDir,
    hostHome,
    readOnlyRepo: true,
    commitGuardCacheDir: null,
    opencodeBinCacheDir: null,
    tsCompilerDirs: [],
    hostToolFiles: [],
    extraRoFiles: [],
  };
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

test("orders system mounts, tmpfs masks, the workspace bind, and file-level config overlays", () => {
  const plan = compileMountPlan(input);

  expect(plan.unshareArgs).toEqual([
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--new-session",
    "--die-with-parent",
  ]);
  expect(plan.binds[0]).toEqual({
    source: "/usr",
    target: "/usr",
    readOnly: true,
    isFile: false,
  });

  const etcTargets = plan.binds.flatMap(({ target }) =>
    target.startsWith("/etc/") ? [target] : []
  );

  expect(etcTargets).not.toContain("/etc/opencode");

  for (const target of etcTargets) {
    expect(plan.binds.find((mount) => mount.target === target)).toMatchObject({
      source: realpathSync(target),
      readOnly: true,
    });
  }

  const config = nodePath.join(input.trialDir, "config", "opencode");
  const configJson = nodePath.join(config, "opencode.json");
  const configJsonc = nodePath.join(config, "opencode.jsonc");

  expect(plan.tmpfsPaths).toEqual(["/tmp", input.hostHome]);
  expect(plan.bwrapArgs.indexOf("--tmpfs")).toBeLessThan(
    plan.bwrapArgs.indexOf(input.trialDir)
  );
  expect(plan.binds).toContainEqual({
    source: input.repoDir,
    target: input.repoDir,
    readOnly: true,
    isFile: false,
  });
  expect(plan.binds).toContainEqual({
    source: configJson,
    target: configJson,
    readOnly: true,
    isFile: true,
  });
  expect(plan.binds).toContainEqual({
    source: configJsonc,
    target: configJsonc,
    readOnly: true,
    isFile: true,
  });
  expect(
    compileMountPlan({ ...input, readOnlyRepo: false }).binds.some(
      ({ target }) => target === input.repoDir
    )
  ).toBe(false);
});

test("rejects symlinks in trial and repository mount boundaries", () => {
  const alias = nodePath.join(workspace, "alias");
  const repoAlias = nodePath.join(input.trialDir, "repo-alias");

  symlinkSync(input.trialDir, alias);
  symlinkSync(input.repoDir, repoAlias);
  mkdirSync(nodePath.join(input.repoDir, "nested"));

  expect(() =>
    compileMountPlan({
      ...input,
      trialDir: alias,
      repoDir: nodePath.join(alias, "repo"),
    })
  ).toThrow("Unexpected symlink");
  expect(() =>
    compileMountPlan({ ...input, repoDir: nodePath.join(repoAlias, "nested") })
  ).toThrow("Unexpected symlink");
});

test("deduplicates resolved extraRoFiles and validates hostToolFiles executable names", () => {
  const credential = nodePath.join(
    input.hostHome,
    "credentials",
    "nested",
    "token"
  );

  const alias = nodePath.join(input.hostHome, "token-link");
  const tool = nodePath.join(input.hostHome, ".local", "bin", "bun");

  mkdirSync(nodePath.dirname(credential), { recursive: true });
  mkdirSync(nodePath.dirname(tool), { recursive: true });
  writeFileSync(credential, "token");
  symlinkSync(credential, alias);
  writeFileSync(tool, "", { mode: 0o755 });

  const plan = compileMountPlan({
    ...input,
    hostToolFiles: [
      { name: "bun", sourcePath: tool },
      { name: "bun", sourcePath: tool },
    ],
    extraRoFiles: [credential, alias],
  });

  const args = plan.bwrapArgs.slice(plan.bwrapArgs.indexOf("--dir"));

  expect(args).toEqual([
    "--dir",
    nodePath.dirname(credential),
    "--ro-bind",
    credential,
    credential,
    "--tmpfs",
    nodePath.join(input.trialDir, "host-bin"),
    "--ro-bind",
    tool,
    nodePath.join(input.trialDir, "host-bin", "bun"),
    "--remount-ro",
    nodePath.join(input.trialDir, "host-bin"),
  ]);

  const expectInvalidHostTool = (invalid: string): void => {
    expect(() =>
      compileMountPlan({
        ...input,
        hostToolFiles: [{ name: invalid, sourcePath: tool }],
      })
    ).toThrow("Invalid host tool executable name");
  };

  for (const invalid of ["../bun", "a/b", "..", "."]) {
    expectInvalidHostTool(invalid);
  }
});

test("binds optional caches before the minimal compiler packages and links them for host grading", () => {
  const harness = nodePath.join(workspace, "harness");
  const modules = nodePath.join(harness, "node_modules");
  const pnpmTypescript = nodePath.join(harness, "store", "typescript");
  const commitGuard = nodePath.join(workspace, COMMIT_GUARD_PACKAGE);
  const binCache = nodePath.join(workspace, "opencode-bin");

  for (const path of [
    "@typescript",
    "@types",
    "bun-types",
    "undici-types",
    "oxlint",
    "@oxlint/plugins",
    "oxc-parser",
  ]) {
    mkdirSync(nodePath.join(modules, path), { recursive: true });
  }

  mkdirSync(pnpmTypescript, { recursive: true });
  symlinkSync(pnpmTypescript, nodePath.join(modules, "typescript"));
  mkdirSync(commitGuard);
  mkdirSync(binCache);
  prepareTrialTsBin(input.trialDir);

  const tsCompilerDirs = discoverTsCompilerDirs(harness);

  const plan = compileMountPlan({
    ...input,
    tsCompilerDirs,
    commitGuardCacheDir: commitGuard,
    opencodeBinCacheDir: binCache,
  });

  expect(plan.binds.slice(-8).map(({ target }) => target)).toEqual([
    nodePath.join(
      input.trialDir,
      "cache",
      "opencode",
      "npm",
      COMMIT_GUARD_PACKAGE
    ),
    nodePath.join(input.trialDir, "cache", "opencode", "bin"),
    nodePath.join(input.trialDir, "node_modules", "typescript"),
    nodePath.join(input.trialDir, "node_modules", "@typescript"),
    nodePath.join(input.trialDir, "node_modules", "@types"),
    nodePath.join(input.trialDir, "node_modules", "bun-types"),
    nodePath.join(input.trialDir, "node_modules", "undici-types"),
    nodePath.join(input.trialDir, "ts-bin"),
  ]);
  expect(
    plan.binds.find(({ source }) => source === pnpmTypescript)?.target
  ).toBe(nodePath.join(input.trialDir, "node_modules", "typescript"));
  expect(readlinkSync(nodePath.join(input.trialDir, "ts-bin", "tsc"))).toBe(
    "../node_modules/typescript/bin/tsc"
  );

  const target = nodePath.join(input.trialDir, "node_modules", "typescript");

  mkdirSync(target, { recursive: true });
  linkHostTsNodeModules(input.trialDir, tsCompilerDirs);
  expect(realpathSync(target)).toBe(pnpmTypescript);
  expect(
    compileMountPlan({
      ...input,
      opencodeBinCacheDir: nodePath.join(workspace, "absent"),
    }).binds
  ).not.toContainEqual(
    expect.objectContaining({
      target: nodePath.join(input.trialDir, "cache", "opencode", "bin"),
    })
  );
  expect(() =>
    compileMountPlan({
      ...input,
      commitGuardCacheDir: nodePath.join(workspace, "absent"),
    })
  ).toThrow();
});

test("rejects forbidden TypeScript destinations and aliases to forbidden sources", () => {
  const antiSlopTypes = nodePath.join(
    workspace,
    "tools",
    "oxlint",
    "anti-slop",
    "@types"
  );

  const alias = nodePath.join(workspace, "alias");

  mkdirSync(antiSlopTypes, { recursive: true });
  symlinkSync(antiSlopTypes, alias);

  expect(() =>
    compileMountPlan({
      ...input,
      tsCompilerDirs: [{ sourceDir: workspace, packageSubpath: "oxlint" }],
    })
  ).toThrow("Invalid TypeScript compiler mount");
  expect(() =>
    compileMountPlan({
      ...input,
      tsCompilerDirs: [{ sourceDir: alias, packageSubpath: "@types" }],
    })
  ).toThrow("Invalid TypeScript compiler mount");
  expect(() =>
    compileMountPlan({
      ...input,
      tsCompilerDirs: [{ sourceDir: workspace, packageSubpath: "@types" }],
    })
  ).toThrow("Invalid TypeScript compiler mount");
});

test.skipIf(!sandbox.available)(
  "bwrap masks host files and enforces read-only repo and config mounts",
  async () => {
    const secret = nodePath.join(input.hostHome, "secret");
    const sibling = nodePath.join(workspace, "sibling");
    const config = nodePath.join(input.trialDir, "config", "opencode");

    writeFileSync(secret, "secret");
    writeFileSync(sibling, "sibling");
    writeFileSync(nodePath.join(input.repoDir, "existing"), "kept");

    const plan = compileMountPlan(input);

    const child = Bun.spawn(
      [
        "bwrap",
        ...plan.bwrapArgs,
        "--chdir",
        input.repoDir,
        "--",
        "/bin/sh",
        "-ec",
        `test ! -e "$1" && test ! -e "$2" &&
     test -f existing && ! touch added &&
     ! sh -c 'echo bad > "$1/opencode.json"' sh "$3" &&
     ! sh -c 'echo bad > "$1/opencode.jsonc"' sh "$3" &&
     ! mv "$3" "$3-renamed" && ! mv "\${3%/*}" "\${3%/*}-renamed" &&
     touch "$3/service.tmp"`,
        "sh",
        secret,
        sibling,
        config,
      ],
      { env: {}, stderr: "pipe", stdout: "ignore" }
    );

    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({
      code: 0,
      stderr: "",
    });
    expect(existsSync(nodePath.join(config, "service.tmp"))).toBe(true);
    expect(existsSync(nodePath.join(input.repoDir, "added"))).toBe(false);
  }
);

test.skipIf(!sandbox.available)(
  "bwrap runs tsc --noEmit on a Bun fixture with isolated read-only host-bin",
  async () => {
    const harnessRoot = nodePath.resolve(import.meta.dir, "../..");
    const tsCompilerDirs = discoverTsCompilerDirs(harnessRoot);
    const controlledBinDir = nodePath.join(input.hostHome, ".local", "bin");
    const controlledRuff = nodePath.join(controlledBinDir, "ruff");
    const siblingSecret = nodePath.join(controlledBinDir, "private-script");
    const previousPath = process.env.PATH;

    mkdirSync(controlledBinDir, { recursive: true });
    writeFileSync(controlledRuff, "#!/bin/sh\necho fake-ruff\n", {
      mode: 0o755,
    });
    writeFileSync(siblingSecret, "#!/bin/sh\necho secret\n", { mode: 0o755 });
    mkdirSync(nodePath.join(input.trialDir, "home"), { recursive: true });

    let hostToolFiles;

    try {
      process.env.PATH = `${controlledBinDir}:${previousPath ?? "/usr/bin:/bin"}`;
      hostToolFiles = discoverHostToolFiles();
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }

    writeFileSync(
      nodePath.join(input.repoDir, "tsconfig.json"),
      sandboxTsConfig
    );

    mkdirSync(nodePath.join(input.repoDir, "src"), { recursive: true });
    mkdirSync(nodePath.join(input.repoDir, "tests"), { recursive: true });
    writeFileSync(
      nodePath.join(input.repoDir, "src", "server.ts"),
      'export function portOf(): number {\n  return typeof Bun.version === "undefined" ? 0 : 8080;\n}\n'
    );
    writeFileSync(
      nodePath.join(input.repoDir, "tests", "server.test.ts"),
      'import { expect, test } from "bun:test";\nimport { portOf } from "../src/server.ts";\ntest("port", () => { expect(portOf()).toBe(8080); });\n'
    );
    prepareTrialTsBin(input.trialDir);

    const plan = compileMountPlan({
      ...input,
      hostHome: homedir(),
      readOnlyRepo: false,
      tsCompilerDirs,
      hostToolFiles,
    });

    const env = buildTrialEnv({
      trialDir: input.trialDir,
      tsCompilerDirs,
      resolvedHostToolDirs:
        hostToolFiles.length > 0
          ? [nodePath.join(input.trialDir, "host-bin")]
          : [],
      keepWorkspaces: false,
      extraEnvNames: [],
    });

    const child = Bun.spawn(
      [
        "bwrap",
        ...plan.bwrapArgs,
        ...toBwrapEnvArgs(env),
        "--chdir",
        input.repoDir,
        "--",
        "/bin/sh",
        "-ec",
        `tsc --noEmit -p tsconfig.json
     bun test
     test "$(ruff)" = "fake-ruff"
     test ! -e "$1"
     ! touch "$2/evil"`,
        "sh",
        siblingSecret,
        nodePath.join(input.trialDir, "host-bin"),
      ],
      { env: {}, stdout: "pipe", stderr: "pipe" }
    );

    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect({ code, output: code === 0 ? "" : stdout + stderr }).toEqual({
      code: 0,
      output: "",
    });
  }
);
