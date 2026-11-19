import { realpathSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { checkPythonHasTestMethods } from "../ast/python.ts";
import { analyzeTypeScriptRepo } from "../ast/typescript.ts";
import { ranCommand } from "../graders/trace.ts";
import {
  computeGradeResult, type CheckOutcomes, type Defect, type Evidence, type GradeResult, type TaskLanguage, type TaskRole,
} from "../graders/types.ts";
import { compileSystemMounts } from "../sandbox/mount-plan.ts";
import { discoverTsCompilerDirs, linkHostTsNodeModules, runHostRuffCheck } from "../sandbox/tools.ts";
import { assertNoSymlinkBoundary } from "../util/fs.ts";

export interface TaskSetupResult {
  readonly baselineHead: string;
  readonly prompt: string;
  readonly reviewSpecText: string;
  readonly reviewDiff: string | null;
  readonly seededDefects: readonly Defect[];
  readonly reviewRequirements: string;
  readonly reviewerBrief: string;
  readonly allowedSigners?: string;
}

export interface EvalTask {
  readonly id: string;
  readonly role: TaskRole;
  readonly category: string;
  readonly language: TaskLanguage;
  readonly timeoutSeconds: number;
  readonly commitGuard: boolean;
  readonly readOnlyRepo: boolean;
  readonly needsRuff: boolean;
  readonly needsTsCompiler: boolean;
  readonly setupRepo: (repoDir: string) => Promise<TaskSetupResult>;
  readonly grade: (evidence: Evidence, setup: TaskSetupResult) => Promise<GradeResult>;
}

export type FixtureFiles = Readonly<Record<string, string>>;

export const PY_FILES = {
  ".gitignore": "__pycache__/\n.ruff_cache/\n.pytest_cache/\n",
  "ruff.toml": `target-version = "py312"
line-length = 100
lint.select = ["E4", "E7", "E9", "F", "I", "B", "BLE", "SIM", "UP", "ASYNC", "RUF"]
`,
} satisfies FixtureFiles;

export const TS_FILES = {
  "package.json": JSON.stringify({ type: "module", scripts: { typecheck: "tsc --noEmit", test: "bun test" } }, null, 2) + "\n",
  "tsconfig.json": JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: "ESNext",
      types: ["bun"],
      module: "Preserve",
      moduleResolution: "bundler",
      moduleDetection: "force",
      allowImportingTsExtensions: true,
      verbatimModuleSyntax: true,
      erasableSyntaxOnly: true,
      exactOptionalPropertyTypes: true,
      noImplicitOverride: true,
      noFallthroughCasesInSwitch: true,
      noUncheckedIndexedAccess: true,
    },
    include: ["src/**/*.ts", "tests/**/*.ts"],
  }, null, 2) + "\n",
  ".gitignore": "node_modules/\ncoverage/\n",
  "AGENTS.md": `# TypeScript standards

Use concrete types instead of \`any\`, \`: object\` parameters, or dictionaries with \`unknown\`, \`any\`, \`object\`, or \`{}\` values.
Use \`unknown\` only for type predicate subjects and \`cause: unknown\`.
Use runtime predicates to narrow inputs instead of runtime \`typeof\`, except to compare with \`"undefined"\`.
Never chain type assertions.
For each unavoidable non-const assertion, place a \`// SAFETY: ...\` comment on the preceding line and explain the invariant.
Test public interfaces without mocking modules.
`,
} satisfies FixtureFiles;

const gitEnv = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_NO_LAZY_FETCH: "1",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};

export async function runTaskGit(repoDir: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "--no-replace-objects", ...args], {
    cwd: repoDir, env: gitEnv, stdout: "pipe", stderr: "pipe",
  });

  const [exit, output, error] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);

  if (exit !== 0) throw new Error(`git ${args[0]} failed (${exit}): ${error.trim()}`);

  return output;
}

export async function commitTaskFiles(repoDir: string, paths: readonly string[], message: string): Promise<string> {
  await runTaskGit(repoDir, "add", "--", ...paths);
  await runTaskGit(repoDir, "commit", "-s", "-m", message, "--only", "--", ...paths);

  return (await runTaskGit(repoDir, "rev-parse", "HEAD")).trim();
}

export async function initGitRepo(
  repoDir: string, files: FixtureFiles, commitMessage: string,
): Promise<string> {
  await mkdir(repoDir, { recursive: true });
  await runTaskGit(repoDir, "init", "--initial-branch=main", "--template=", "--object-format=sha1");
  await runTaskGit(repoDir, "config", "--local", "user.name", "Eval Runner");
  await runTaskGit(repoDir, "config", "--local", "user.email", "eval@example.invalid");
  await runTaskGit(repoDir, "config", "--local", "commit.gpgsign", "false");

  for (const [path, content] of Object.entries(files)) {
    const target = join(repoDir, path);

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { mode: path.endsWith(".sh") ? 0o755 : 0o644, flag: "wx" });
  }

  return commitTaskFiles(repoDir, Object.keys(files), commitMessage);
}

export async function setupCoderFixture(repoDir: string, files: FixtureFiles, prompt: string): Promise<TaskSetupResult> {
  return {
    baselineHead: await initGitRepo(repoDir, files, "fixture: Seed trial repository"),
    prompt,
    reviewSpecText: "",
    reviewDiff: null,
    seededDefects: [],
    reviewRequirements: "",
    reviewerBrief: "",
  };
}

async function* testFiles(repoDir: string, dir: string, pattern: RegExp): AsyncIterable<string> {
  try {
    for (const entry of await readdir(join(repoDir, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;

      if (entry.isDirectory()) yield* testFiles(repoDir, path, pattern);

      if (entry.isFile() && pattern.test(entry.name)) yield path;
    }
  } catch (cause) {
    if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") throw cause;
  }
}

export function pythonTestFiles(repoDir: string): Promise<string[]> {
  return Array.fromAsync(testFiles(repoDir, "tests", /^test.*\.py$/u));
}

async function runFixture(
  repoDir: string, tool: "bun" | "python3", args: readonly string[], input?: string,
): Promise<{ exit: number; stderr: string } | null> {
  try {
    assertNoSymlinkBoundary(repoDir);

    const executable = Bun.which(tool);

    if (executable === null) return null;

    const target = `/tools/${tool}`;
    const { bwrapArgs } = compileSystemMounts();

    // Mount only trial files and the selected tool. The PID namespace contains descendants on timeout.
    const child = Bun.spawn([
      "bwrap", ...bwrapArgs, "--unshare-net", "--proc", "/proc", "--dev", "/dev",
      "--tmpfs", "/tmp", "--dir", "/home", "--ro-bind", resolve(repoDir), "/repo",
      "--ro-bind", realpathSync(executable), target, "--chdir", "/repo", "--", target, ...args,
    ], {
      env: { PATH: "/tools:/usr/bin:/bin", HOME: "/home", TMPDIR: "/tmp", PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" },
      stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
      stdout: "ignore",
      stderr: "pipe",
      timeout: 15_000,
      killSignal: "SIGKILL",
    });

    const decoder = new TextDecoder();
    let stderr = "";

    for await (const chunk of child.stderr) stderr = (stderr + decoder.decode(chunk, { stream: true })).slice(-4096);

    return { exit: await child.exited, stderr: stderr + decoder.decode() };
  } catch {
    return null;
  }
}

export async function runFixtureCheck(
  repoDir: string, tool: "bun" | "python3", args: readonly string[], input?: string,
): Promise<boolean> {
  return (await runFixture(repoDir, tool, args, input))?.exit === 0;
}

function noCommits(ev: Evidence): boolean {
  return ev.afterGit.head === ev.baselineHead && ev.afterGit.staged === "";
}

const successfulRun = { afterLastEdit: true, success: true };

const bunTestRun = {
  ...successfulRun,
  verifiedPassOutput: (output: string): boolean =>
    /\b[1-9]\d*\s+pass\b/u.test(output) && !/\b[1-9]\d*\s+(?:fail|error)s?\b/iu.test(output),
};

const unittestRun = {
  ...successfulRun,
  verifiedPassOutput: (output: string): boolean => /\bRan [1-9]\d* tests?\b[\s\S]*?\nOK\b/u.test(output),
};

const pytestRun = {
  ...successfulRun,
  verifiedPassOutput: (output: string): boolean =>
    /\b[1-9]\d*\s+passed\b/u.test(output) && !/\b[1-9]\d*\s+(?:failed|errors?)\b/iu.test(output),
};

const ruffCheckRun = {
  ...successfulRun,
  verifiedPassOutput: (output: string): boolean => /\bAll checks passed!/u.test(output),
};

export async function checksPython(
  ev: Evidence, allowedFiles: ReadonlySet<string>, options?: { readonly expectNoCommits?: boolean },
): Promise<CheckOutcomes> {
  const files = await pythonTestFiles(ev.repoDir);

  const [testsPass, methodsPresent, ruffPass] = await Promise.all([
    runFixture(ev.repoDir, "python3", ["-m", "unittest", "discover", "-s", "tests"]),
    files.length > 0 && checkPythonHasTestMethods(ev.repoDir, files),
    runHostRuffCheck(ev.repoDir).then(({ exitCode }) => exitCode === 0, () => false),
  ]);

  const paths = ev.afterGit.changedFiles;

  return {
    unit_tests_pass: testsPass?.exit === 0 && /\bRan [1-9]\d* tests?\b/u.test(testsPass.stderr) && methodsPresent,
    unit_tests_executed: ranCommand(ev, ["unittest"], unittestRun) || ranCommand(ev, ["pytest"], pytestRun),
    changed_only_scoped_files: paths.size > 0 && [...paths].every((file) => allowedFiles.has(file)),
    ruff_check_passes: ruffPass,
    ruff_check_executed: ranCommand(ev, ["ruff", "check"], ruffCheckRun),
    ...(options?.expectNoCommits === false ? null : { no_commits_created: noCommits(ev) }),
  };
}

const harnessRoot = resolve(import.meta.dir, "../..");
const scopedTsTest = /^tests\/(?:.+\/)?[^/]+\.test\.ts$/u;

async function tscPasses(repoDir: string): Promise<boolean> {
  try {
    linkHostTsNodeModules(dirname(resolve(repoDir)), discoverTsCompilerDirs(harnessRoot));

    const compiler = Bun.spawn([join(harnessRoot, "node_modules/.bin/tsc"), "--noEmit", "-p", "tsconfig.json"], {
      cwd: repoDir, env: { PATH: process.env.PATH }, stdout: "ignore", stderr: "ignore", timeout: 15_000, killSignal: "SIGKILL",
    });

    return await compiler.exited === 0;
  } catch {
    return false;
  }
}

export async function checksTypeScript(ev: Evidence, allowedSrcFiles: ReadonlySet<string>): Promise<CheckOutcomes> {
  const paths = ev.afterGit.changedFiles;
  const tests = await Array.fromAsync(testFiles(ev.repoDir, "tests", /^[^/]+\.test\.ts$/u));
  const tsc = await tscPasses(ev.repoDir);

  return {
    bun_tests_pass: tests.length > 0 && await runFixtureCheck(ev.repoDir, "bun", ["--no-env-file", "test"]),
    bun_tests_executed: ranCommand(ev, ["bun", "test"], bunTestRun),
    changed_only_scoped_files: paths.size > 0 && [...paths].every((file) => allowedSrcFiles.has(file) || scopedTsTest.test(file)),
    no_commits_created: noCommits(ev),
    tsc_passes: tsc,
    ts_ast_hygiene: analyzeTypeScriptRepo(ev.repoDir).passed,
  };
}

export function buildCoderGradeResult(
  checks: CheckOutcomes, notes: readonly string[], options?: Partial<Parameters<typeof computeGradeResult>[1]>,
): GradeResult {
  return computeGradeResult(checks, { timedOut: false, ...options, notes });
}
