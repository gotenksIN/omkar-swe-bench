import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { parseShellScript } from "../../src/ast/bash.ts";
import { captureGitState, gitStatesEqual, setupSshSigning, signedCommitChecks } from "../../src/graders/git.ts";
import type { Evidence, GitState, ShellRunTrace, ToolTraceEntry } from "../../src/graders/types.ts";

function git(repoDir: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: repoDir,
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });

  if (!result.success) throw new Error(result.stderr.toString());

  return result.stdout.toString();
}

function seedRepo(repoDir: string): string {
  git(repoDir, "init", "-b", "main");
  git(repoDir, "config", "user.name", "Eval Runner");
  git(repoDir, "config", "user.email", "eval@example.invalid");
  git(repoDir, "config", "commit.gpgsign", "false");

  for (const path of ["committed.txt", "staged.txt", "unstaged.txt"]) writeFileSync(join(repoDir, path), "initial\n");

  writeFileSync(join(repoDir, ".gitignore"), "ignored.txt\n");
  git(repoDir, "add", ".");
  git(repoDir, "commit", "-m", "Seed fixture");

  return git(repoDir, "rev-parse", "HEAD").trim();
}

test("captures committed, staged, unstaged, and sorted untracked changes including link targets and mode", async () => {
  const repoDir = mkdtempSync("/tmp/opencode/graders-git-");

  try {
    const baseline = seedRepo(repoDir);
    const before = await captureGitState(repoDir, baseline);

    expect(before).toEqual({ head: baseline, committed: "", staged: "", unstaged: "", untracked: [], changedFiles: new Set() });

    writeFileSync(join(repoDir, "committed.txt"), "committed\n");
    git(repoDir, "add", "committed.txt");
    git(repoDir, "commit", "-m", "Add committed change");
    writeFileSync(join(repoDir, "staged.txt"), "staged\n");
    writeFileSync(join(repoDir, "binary.dat"), new Uint8Array([0, 1, 2]));
    git(repoDir, "add", "staged.txt", "binary.dat");
    git(repoDir, "mv", "committed.txt", "renamed.txt");
    writeFileSync(join(repoDir, "unstaged.txt"), "unstaged\n");
    writeFileSync(join(repoDir, "z\nnew.txt"), "untracked\n", { mode: 0o644 });
    chmodSync(join(repoDir, "z\nnew.txt"), 0o644);
    symlinkSync("missing.txt", join(repoDir, "a-link"));
    writeFileSync(join(repoDir, "ignored.txt"), "ignored\n");
    const nestedRepo = join(repoDir, "subrepo");
    mkdirSync(nestedRepo);
    seedRepo(nestedRepo);

    const state = await captureGitState(repoDir, baseline);
    const digest = git(repoDir, "hash-object", "--", "z\nnew.txt").trim();

    expect(state.head).not.toBe(baseline);
    expect(state.committed).toContain("+committed\n");
    expect(state.staged).toContain("+staged\n");
    expect(state.staged).toContain("GIT binary patch");
    expect(state.unstaged).toContain("+unstaged\n");
    expect(state.untracked).toEqual([
      ["a-link", "120777:missing.txt"],
      ["subrepo/", expect.stringMatching(/:directory$/u)],
      ["z\nnew.txt", `100644:${digest}`],
    ]);
    expect(state.changedFiles).toEqual(new Set([
      "committed.txt", "renamed.txt", "staged.txt", "unstaged.txt", "binary.dat", "z\nnew.txt", "a-link", "subrepo/",
    ]));
    expect((await captureGitState(repoDir, state.head)).changedFiles.has("committed.txt")).toBe(true);
    expect(gitStatesEqual(state, await captureGitState(repoDir, baseline))).toBe(true);

    for (const field of ["head", "committed", "staged", "unstaged"]) {
      expect(gitStatesEqual(state, { ...state, [field]: "different" })).toBe(false);
    }

    expect(gitStatesEqual(state, { ...state, changedFiles: new Set() })).toBe(true);
    expect(gitStatesEqual(state, { ...state, untracked: [] })).toBe(false);
    chmodSync(join(repoDir, "z\nnew.txt"), 0o755);
    expect(gitStatesEqual(state, await captureGitState(repoDir, baseline))).toBe(false);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

function shell(index: number, command: string, output = "", exitCode = 0): ShellRunTrace {
  return { index, command, output, exitCode, status: "completed", parsed: parseShellScript(command), workdir: null };
}

function historyEvidence(repoDir: string, beforeGit: GitState, afterGit: GitState): Evidence {
  const context: ToolTraceEntry = {
    tool: "commit_context", index: 1, status: "completed", textOutput: "", errorText: null, metadata: null,
    input: {}, sessionId: "synthetic", isSubagent: false,
  };

  return {
    repoDir, trialDir: dirname(repoDir), baselineHead: beforeGit.head, beforeGit, afterGit, tools: [context],
    shellRuns: [shell(2, "capture-baseline", "Frozen commit baseline"), shell(3, "git commit -s -m 'app.ts: Reject input'")],
    questionFormCount: 0, finalText: "", transcriptText: "", reviewerText: "", reviewHandoffs: [],
    actualReviewerModels: [], timedOut: false,
  };
}

test("verifies SSH signatures, literal scopes, signoffs, commit ordering, and amend rules", async () => {
  const repoDir = mkdtempSync("/tmp/opencode/graders-sign-");

  try {
    const baseline = seedRepo(repoDir);
    const before = await captureGitState(repoDir, baseline);

    const allowedSigners = await setupSshSigning(repoDir);
    git(repoDir, "commit", "--allow-empty", "-s", "-m", "app.ts: Reject input");

    const evidence = historyEvidence(repoDir, before, await captureGitState(repoDir, baseline));
    const normal = { amended: false, allowedSigners };
    const amendOpts = { amended: true, allowedSigners };
    const scopes = ["app.ts"];

    const success = {
      signed_scoped_history: true, commit_context_before_commit: true, no_rejected_commits: true, amendment_count: true,
    };

    expect(await signedCommitChecks(evidence, scopes, normal)).toEqual(success);
    expect((await signedCommitChecks({
      ...evidence,
      shellRuns: [
        shell(2, "capture-baseline", "Frozen commit baseline"),
        shell(3, "git add .\ngit commit -s -m 'app.ts: Reject input'"),
      ],
    }, scopes, normal)).no_rejected_commits).toBe(true);
    expect((await signedCommitChecks(evidence, ["appXts"], normal)).signed_scoped_history).toBe(false);
    expect((await signedCommitChecks(evidence, [...scopes, "extra"], normal)).signed_scoped_history).toBe(false);
    expect((await signedCommitChecks({ ...evidence, tools: [] }, scopes, normal)).commit_context_before_commit).toBe(false);
    expect((await signedCommitChecks({
      ...evidence, tools: evidence.tools.map((entry) => ({ ...entry, index: 3 })),
    }, scopes, normal)).commit_context_before_commit).toBe(false);
    expect((await signedCommitChecks({
      ...evidence, tools: evidence.tools.map((entry) => ({ ...entry, status: "error" })),
    }, scopes, normal)).commit_context_before_commit).toBe(false);
    expect((await signedCommitChecks({
      ...evidence, shellRuns: [shell(4, "capture-baseline", "Frozen commit baseline"), shell(3, "git commit")],
    }, scopes, normal)).commit_context_before_commit).toBe(false);
    expect((await signedCommitChecks({
      ...evidence, shellRuns: [shell(2, "capture-baseline", "Frozen commit baseline", 1), shell(3, "git commit", "", 1)],
    }, scopes, normal))).toMatchObject({ commit_context_before_commit: false, no_rejected_commits: false });

    const context = evidence.tools[0];

    if (!context) throw new Error("Missing synthetic context invocation.");

    expect((await signedCommitChecks({
      ...evidence,
      tools: [context, { ...context, tool: "shell", index: 2, textOutput: "Frozen commit baseline" }],
      shellRuns: [shell(2, "capture-baseline"), shell(3, "git commit")],
    }, scopes, normal)).commit_context_before_commit).toBe(true);

    git(repoDir, "commit", "--amend", "--no-edit", "--allow-empty", "-s");

    const amended = { ...evidence, shellRuns: [...evidence.shellRuns, shell(4, "git commit --amend --no-edit")] };

    expect(await signedCommitChecks(amended, scopes, amendOpts)).toEqual(success);
    expect((await signedCommitChecks(amended, scopes, normal)).amendment_count).toBe(false);
    expect((await signedCommitChecks({
      ...evidence, shellRuns: [...evidence.shellRuns, shell(4, "git commit --amend -m changed")],
    }, scopes, amendOpts)).no_rejected_commits).toBe(false);
    expect((await signedCommitChecks({
      ...evidence, shellRuns: [...evidence.shellRuns, shell(4, "git commit --amend --no-edit; echo done")],
    }, scopes, amendOpts)).no_rejected_commits).toBe(false);

    git(repoDir, "commit", "--amend", "--allow-empty", "-m", "appXts: Reject input");
    expect((await signedCommitChecks(amended, scopes, amendOpts)).signed_scoped_history).toBe(false);
    git(repoDir, "commit", "--amend", "--allow-empty", "-m", "app.ts: Reject input");
    expect((await signedCommitChecks(amended, scopes, amendOpts)).signed_scoped_history).toBe(false);
    git(repoDir, "commit", "--amend", "--allow-empty", "-s", "-m", "app.ts: Reject input");
    git(repoDir, "config", "gpg.ssh.program", "/no-such-trial-verifier");
    writeFileSync(join(repoDir, ".git", "eval-allowed-signers"), "");
    expect((await signedCommitChecks(amended, scopes, amendOpts)).signed_scoped_history).toBe(true);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
