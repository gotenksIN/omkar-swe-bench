import { lstatSync, readlinkSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import nodePath from "node:path";

import { extractGitCommit, unwrapSimpleCommand } from "../ast/bash.ts";
import { assertNoSymlinkBoundary } from "../util/fs.ts";
import { commandExitApplies } from "./types.ts";
import type { CheckOutcomes, Evidence, GitState } from "./types.ts";

const diff = [
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--ignore-submodules=dirty",
];

export interface IsolatedGitOptions {
  readonly head?: string;
  readonly copyMetadata?: boolean;
  readonly copyReflog?: boolean;
  readonly neutralizeAttributes?: boolean;
  readonly prefix?: string;
}

const gitEnv = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

const run = async (repoDir: string, args: string[], allowFailure = false) => {
  const child = Bun.spawn(args, {
    cwd: repoDir,
    env: gitEnv,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [output, error, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (!allowFailure && exitCode !== 0) {
    throw new Error(
      `${args[0]} ${args[1]} failed (${exitCode}): ${error.trim()}`
    );
  }

  return { output, exitCode };
};

const git = async (repoDir: string, ...args: string[]): Promise<string> => {
  const result = await run(repoDir, ["git", ...args]);

  return result.output;
};

const copyGitFile = async (
  gitDir: string,
  inspectionDir: string,
  path: string
): Promise<void> => {
  const source = nodePath.join(gitDir, path);
  const entry = lstatSync(source, { throwIfNoEntry: false });

  if (!entry) {
    return;
  }

  if (!entry.isFile()) {
    throw new Error(`Expected a regular Git metadata file: ${path}`);
  }

  await copyFile(source, nodePath.join(inspectionDir, path));
};

export const withIsolatedGitDir = async <T>(
  repoDir: string,
  options: IsolatedGitOptions,
  inspect: (dir: string) => Promise<T>
): Promise<T> => {
  const gitDir = nodePath.resolve(repoDir, ".git");
  const objects = nodePath.join(gitDir, "objects");

  assertNoSymlinkBoundary(gitDir);
  assertNoSymlinkBoundary(objects, gitDir);

  if (!lstatSync(objects).isDirectory()) {
    throw new Error("Expected a Git metadata directory: objects");
  }

  const dir = await mkdtemp(
    nodePath.join(
      nodePath.dirname(nodePath.resolve(repoDir)),
      options.prefix ?? ".grader-git-"
    )
  );

  try {
    // Isolate Git metadata so host inspections never load trial configuration or hooks.
    await mkdir(nodePath.join(dir, "info"));
    await symlink(objects, nodePath.join(dir, "objects"), "dir");

    if (options.copyMetadata === true) {
      const refs = nodePath.join(gitDir, "refs");
      assertNoSymlinkBoundary(refs, gitDir);

      if (!lstatSync(refs).isDirectory()) {
        throw new Error("Expected a Git metadata directory: refs");
      }

      await symlink(refs, nodePath.join(dir, "refs"), "dir");

      await Promise.all(
        ["HEAD", "index", "packed-refs"].map(async (path) => {
          await copyGitFile(gitDir, dir, path);
        })
      );

      const info = lstatSync(nodePath.join(gitDir, "info"), {
        throwIfNoEntry: false,
      });

      if (info?.isDirectory() === true) {
        await copyGitFile(gitDir, dir, "info/exclude");
      }
    } else {
      await mkdir(nodePath.join(dir, "refs"));
      await writeFile(
        nodePath.join(dir, "HEAD"),
        `${options.head ?? "ref: refs/heads/main"}\n`
      );
    }

    if (options.copyReflog === true) {
      await mkdir(nodePath.join(dir, "logs"));
      const logDir = nodePath.join(gitDir, "logs");

      if (
        lstatSync(logDir, { throwIfNoEntry: false })?.isDirectory() === true
      ) {
        assertNoSymlinkBoundary(logDir, gitDir);
        await copyGitFile(gitDir, dir, "logs/HEAD");
      }
    }

    if (options.neutralizeAttributes === true) {
      await writeFile(
        nodePath.join(dir, "info/attributes"),
        "* -export-ignore -export-subst\n"
      );
    }

    return await inspect(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const withInspectionDir = async <T>(
  repoDir: string,
  inspect: (dir: string) => Promise<T>
): Promise<T> =>
  await withIsolatedGitDir(repoDir, { copyMetadata: true }, inspect);

const inspectArgs = (repoDir: string, inspectionDir: string): string[] => [
  "git",
  "--git-dir",
  inspectionDir,
  "--work-tree",
  nodePath.resolve(repoDir),
  "--no-replace-objects",
];

const nulPaths = (output: string): string[] =>
  output ? output.slice(0, -1).split("\0") : [];

export const captureGitState = async (
  repoDir: string,
  baselineHead: string
): Promise<GitState> =>
  await withInspectionDir(
    repoDir,
    async (dir) => await inspectGitState(repoDir, dir, baselineHead)
  );

const inspectGitState = async (
  repoDir: string,
  inspectionDir: string,
  baselineHead: string
): Promise<GitState> => {
  const range = `${baselineHead}..HEAD`;
  const prefix = inspectArgs(repoDir, inspectionDir);

  const read = async (...args: string[]): Promise<string> => {
    const result = await run(repoDir, [...prefix, ...args]);

    return result.output;
  };

  const [
    head,
    committed,
    staged,
    unstaged,
    committedPaths,
    stagedPaths,
    unstagedPaths,
    newPaths,
  ] = await Promise.all([
    read("rev-parse", "HEAD"),
    read(...diff, "--binary", range, "--"),
    read(...diff, "--binary", "--cached", "--"),
    read(...diff, "--binary", "--"),
    read(...diff, "--no-renames", "--name-only", "-z", range, "--"),
    read(...diff, "--no-renames", "--name-only", "-z", "--cached", "--"),
    read(...diff, "--no-renames", "--name-only", "-z", "--"),
    read("ls-files", "--others", "--exclude-standard", "-z"),
  ]);

  const paths = nulPaths(newPaths).toSorted();
  const untracked: [string, string][] = [];

  const regularFiles: {
    readonly index: number;
    readonly path: string;
    readonly mode: string;
  }[] = [];

  for (const path of paths) {
    const fullPath = nodePath.join(repoDir, path.replace(/\/$/u, ""));
    const stats = lstatSync(fullPath);
    const mode = stats.mode.toString(8);

    if (stats.isSymbolicLink()) {
      untracked.push([path, `${mode}:${readlinkSync(fullPath)}`]);
    } else if (stats.isFile()) {
      regularFiles.push({ index: untracked.length, path, mode });
      untracked.push([path, `${mode}:pending`]);
    } else if (stats.isDirectory()) {
      untracked.push([path, `${mode}:directory`]);
    } else {
      untracked.push([path, `${mode}:special`]);
    }
  }

  const hashChunkSize = 100;

  for (let start = 0; start < regularFiles.length; start += hashChunkSize) {
    const chunk = regularFiles.slice(start, start + hashChunkSize);

    // oxlint-disable-next-line no-await-in-loop -- Hash untracked files in bounded sequential chunks to avoid FD exhaustion on large untracked trees.
    const output = await read(
      "hash-object",
      "--no-filters",
      "--",
      ...chunk.map(({ path }) => path)
    );

    const hashes = output.trimEnd().split("\n");

    for (const [offset, entry] of chunk.entries()) {
      const hash = hashes[offset] ?? "";
      untracked[entry.index] = [entry.path, `${entry.mode}:${hash.trim()}`];
    }
  }

  return {
    head: head.trim(),
    committed,
    staged,
    unstaged,
    untracked,
    changedFiles: new Set([
      ...nulPaths(committedPaths),
      ...nulPaths(stagedPaths),
      ...nulPaths(unstagedPaths),
      ...paths,
    ]),
  };
};

export const gitStatesEqual = (a: GitState, b: GitState): boolean =>
  a.head === b.head &&
  a.committed === b.committed &&
  a.staged === b.staged &&
  a.unstaged === b.unstaged &&
  a.untracked.length === b.untracked.length &&
  a.untracked.every(
    ([path, digest], index) =>
      path === b.untracked[index]?.[0] && digest === b.untracked[index]?.[1]
  );

export const setupSshSigning = async (repoDir: string): Promise<string> => {
  const key = nodePath.resolve(repoDir, ".git/eval-signing-key");
  const signers = nodePath.resolve(repoDir, ".git/eval-allowed-signers");

  await run(repoDir, [
    "ssh-keygen",
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-f",
    key,
  ]);

  const rawPublicKey = await readFile(`${key}.pub`, "utf-8");
  const allowedSigners = `eval@example.invalid ${rawPublicKey.trim()}\n`;

  await writeFile(signers, allowedSigners);
  await git(repoDir, "config", "--local", "gpg.format", "ssh");
  await git(
    repoDir,
    "config",
    "--local",
    "gpg.ssh.allowedSignersFile",
    signers
  );
  await git(repoDir, "config", "--local", "user.signingkey", key);
  await git(repoDir, "config", "--local", "commit.gpgsign", "true");

  return allowedSigners;
};

const signedHistory = async (
  evidence: Evidence,
  expectedScopes: readonly string[],
  inspectionDir: string,
  allowedSigners: string | undefined
): Promise<boolean> => {
  const { repoDir, baselineHead } = evidence;
  const prefix = inspectArgs(repoDir, inspectionDir);

  const read = async (...args: string[]): Promise<string> => {
    const result = await run(repoDir, [...prefix, ...args]);

    return result.output;
  };

  const history = await read("rev-list", "--reverse", `${baselineHead}..HEAD`);
  const commits = history.trim() ? history.trim().split("\n") : [];

  if (commits.length !== expectedScopes.length) {
    return false;
  }

  const signers = nodePath.join(inspectionDir, "allowed-signers");
  const hasSigners = allowedSigners !== undefined && allowedSigners.length > 0;

  if (commits.length > 0 && !hasSigners) {
    return false;
  }

  if (hasSigners) {
    await writeFile(signers, allowedSigners);
  }

  const checks = await Promise.all(
    commits.map(async (sha, index): Promise<boolean> => {
      const scope = expectedScopes[index];

      if (scope === undefined) {
        return false;
      }

      const [rawSubject, raw] = await Promise.all([
        read("show", "-s", "--format=%s", sha),
        read("cat-file", "commit", sha),
      ]);

      const subject = rawSubject.trimEnd();
      const separator = raw.indexOf("\n\n");
      const header = raw.slice(0, separator);
      const body = raw.slice(separator + 2);
      const title = new RegExp(`^${RegExp.escape(scope)}: [A-Z].*`, "u");

      if (
        !title.test(subject) ||
        subject.length > 72 ||
        subject.endsWith(".") ||
        separator === -1 ||
        !header.includes("\ngpgsig ") ||
        !/^Signed-off-by:/mu.test(body)
      ) {
        return false;
      }

      const verification = await run(
        repoDir,
        [
          ...prefix,
          "-c",
          "gpg.format=ssh",
          "-c",
          `gpg.ssh.allowedSignersFile=${signers}`,
          "verify-commit",
          sha,
        ],
        true
      );

      return verification.exitCode === 0;
    })
  );

  return checks.every(Boolean);
};

export interface SignedCommitOptions {
  readonly amended: boolean;
  readonly maxAmendments?: number;
  readonly allowedSigners?: string;
}

export const signedCommitChecks = async (
  evidence: Evidence,
  expectedScopes: readonly string[],
  options: SignedCommitOptions
): Promise<CheckOutcomes> => {
  let firstCommit = Infinity;
  let rejected = false;
  let commits = 0;
  let amendments = 0;

  for (const shell of evidence.shellRuns) {
    for (const [cmdIndex, cmd] of shell.parsed.commands.entries()) {
      const unwrapped = unwrapSimpleCommand(cmd);
      const invocation = unwrapped ? extractGitCommit(unwrapped) : null;

      if (!invocation) {
        continue;
      }

      firstCommit = Math.min(firstCommit, shell.index);

      if (invocation.amend) {
        amendments += 1;
      } else {
        commits += 1;
      }

      if (
        shell.exitCode !== 0 ||
        !commandExitApplies(shell, cmdIndex) ||
        (invocation.amend && !invocation.noEdit)
      ) {
        rejected = true;
      }
    }
  }

  const context = evidence.tools.some(
    (tool) =>
      tool.index < firstCommit &&
      tool.tool === "commit_context" &&
      tool.status === "completed"
  );

  const frozenText = "Frozen commit baseline";

  const frozenTools = new Set(
    evidence.tools.flatMap((tool) =>
      tool.tool === "shell" && tool.textOutput.includes(frozenText)
        ? [tool.index]
        : []
    )
  );

  const frozen = evidence.shellRuns.some(
    (shell) =>
      shell.index < firstCommit &&
      shell.exitCode === 0 &&
      (shell.output.includes(frozenText) || frozenTools.has(shell.index))
  );

  const minAmendments = options.amended ? 1 : 0;
  const maxAmendments = options.maxAmendments ?? minAmendments;

  return {
    signed_scoped_history: await withInspectionDir(
      evidence.repoDir,
      async (dir) =>
        await signedHistory(
          evidence,
          expectedScopes,
          dir,
          options.allowedSigners
        )
    ),
    commit_context_before_commit:
      Number.isFinite(firstCommit) && context && frozen,
    no_rejected_commits: !rejected && commits === expectedScopes.length,
    amendment_count: amendments >= minAmendments && amendments <= maxAmendments,
  };
};
