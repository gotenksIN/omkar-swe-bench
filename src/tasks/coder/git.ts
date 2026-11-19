import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import { setupSshSigning, signedCommitChecks, withIsolatedGitDir } from "../../graders/git.ts";
import type { Evidence } from "../../graders/types.ts";
import {
  buildCoderGradeResult, checksPython, PY_FILES, runFixtureCheck, runTaskGit, setupCoderFixture, type EvalTask,
} from "../base.ts";

const configSubject = "config: Reject invalid scope patterns";
const cliSubject = "cli: Add --json output to version";
const scope = new Set(["config.py", "cli.py"]);

const files = {
  ...PY_FILES,
  "NOTES.md": "# Release notes\n\nRecord release changes here.\n",
  "config.py": `def parse_scope(pattern):
    return pattern.strip()
`,
  "cli.py": `import argparse

VERSION = "1.4.0"


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("version",))
    parser.parse_args(argv)
    print(VERSION)


if __name__ == "__main__":
    main()
`,
  "tests/test_cli.py": `import json
import subprocess
import sys
import unittest

from config import parse_scope


class ReleaseTests(unittest.TestCase):
    def test_scope(self):
        self.assertEqual(parse_scope("graders"), "graders")
        with self.assertRaises(ValueError):
            parse_scope("../graders")

    def test_version_json(self):
        output = subprocess.check_output([sys.executable, "cli.py", "version", "--json"], text=True)
        self.assertEqual(json.loads(output), {"version": "1.4.0"})
`,
};

async function inspectTaskHistory(ev: Evidence): Promise<{ separate: boolean; committedNotes: boolean }> {
  const { repoDir, baselineHead, afterGit } = ev;

  async function inspect(dir: string): Promise<{ separate: boolean; committedNotes: boolean }> {
    const read = (...args: string[]) => runTaskGit(dir, "--git-dir=.", ...args);

    const committedNotes = (await read("diff-tree", "--no-commit-id", "--name-only", "-r",
      baselineHead, afterGit.head, "--", "NOTES.md")) !== "";

    const commits = (await read("rev-list", "--reverse", `${baselineHead}..${afterGit.head}`)).trim().split("\n");

    if (commits.length !== 2) return { committedNotes, separate: false };

    const expected = [[configSubject, "config.py"], [cliSubject, "cli.py"]];
    let parent = baselineHead;

    for (const [index, commit] of commits.entries()) {
      const header = await read("show", "-s", "--format=%P%n%s", commit, "--");
      const paths = await read("diff-tree", "--no-renames", "--name-only", "-z", "-r", parent, commit, "--");
      const [subject, path] = expected[index] ?? [];

      if (header !== `${parent}\n${subject}\n` || paths !== `${path}\0`) return { committedNotes, separate: false };

      parent = commit;
    }

    return { committedNotes, separate: true };
  }

  try {
    return await withIsolatedGitDir(repoDir, { prefix: ".task-history-" }, inspect);
  } catch {
    return { separate: false, committedNotes: true };
  }
}

function scopedEvidence(ev: Evidence, preservesWork: boolean, committedNotes: boolean): Evidence {
  const { beforeGit, afterGit } = ev;

  if (!preservesWork || committedNotes || !beforeGit.changedFiles.has("NOTES.md")) return ev;

  const changedFiles = new Set(afterGit.changedFiles);
  changedFiles.delete("NOTES.md");

  return { ...ev, afterGit: { ...afterGit, changedFiles } };
}

export const commitGuardTwoTask: EvalTask = {
  id: "coder-git-commit-guard-two-task",
  category: "git-workflow",
  language: "git",
  role: "coder",
  timeoutSeconds: 240,
  commitGuard: true,
  readOnlyRepo: false,
  needsRuff: true,
  needsTsCompiler: false,
  async setupRepo(repoDir) {
    const setup = await setupCoderFixture(repoDir, files, `Complete these two tasks in order.
Capture the commit context before committing. Use the configured SSH signing key and sign off.
Leave the pre-existing unstaged change in NOTES.md untouched. Do not edit the tests.

1. In config.py, accept scope names starting with a lowercase ASCII letter and followed only by lowercase ASCII letters, digits, underscores, or hyphens. Raise ValueError for invalid input. Commit only config.py with subject "${configSubject}".
2. In cli.py, support \`version --json\` with a JSON object containing the version. Preserve the plain version output. Commit only cli.py with subject "${cliSubject}".

Run \`python3 -m unittest discover -s tests\` and \`ruff check .\` after the edits.
`);

    const allowedSigners = await setupSshSigning(repoDir);
    await appendFile(join(repoDir, "NOTES.md"), "\nUnpublished notes: review the next release before tagging.\n");

    return { ...setup, allowedSigners };
  },
  async grade(ev, setup) {
    const { beforeGit, afterGit, repoDir } = ev;
    const preservesWork = afterGit.unstaged === beforeGit.unstaged && afterGit.staged === "" && afterGit.untracked.length === 0;
    const { separate, committedNotes } = await inspectTaskHistory(ev);
    const scoped = scopedEvidence(ev, preservesWork, committedNotes);

    const signOptions = setup.allowedSigners === undefined
      ? { amended: false }
      : { amended: false, allowedSigners: setup.allowedSigners };

    const [common, signed, patterns, version] = await Promise.all([
      checksPython(scoped, scope, { expectNoCommits: false }),
      signedCommitChecks(ev, ["config", "cli"], signOptions),
      runFixtureCheck(repoDir, "python3", ["-"], `
from config import parse_scope

for pattern in ("config", "a", "io_2", "build-core"):
    assert parse_scope(pattern) == pattern
for pattern in ("", "../config", "core/cli", "core*", "é", "UPPER", "a.b", "9core", " config", "ok\\n"):
    try:
        parse_scope(pattern)
    except ValueError:
        pass
    else:
        raise AssertionError(f"accepted invalid scope: {pattern!r}")
`),
      runFixtureCheck(repoDir, "python3", ["-"], `
import json
import subprocess
import sys

def cli(*args):
    return subprocess.check_output([sys.executable, "cli.py", "version", *args], text=True)

assert cli() == "1.4.0\\n"
assert json.loads(cli("--json")) == {"version": "1.4.0"}
`),
    ]);

    return buildCoderGradeResult({
      ...common, ...signed, separate_scoped_changes: separate, preserves_unstaged_work: preservesWork,
      scope_patterns: patterns, version_json: version,
    }, [], { timedOut: ev.timedOut });
  },
};
