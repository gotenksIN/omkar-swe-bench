import { expect, test } from "bun:test";

import { parseShellScript, unwrapSimpleCommand } from "../../src/ast/bash.ts";

test("preserves shell words, quoting, assignments and separators", () => {
  const parsed = parseShellScript("FLAG='a b' printf \"%s\" 'a # b' word#hash x\\ y \\\n" +
    "  \"\\\"\\\\\\$\\`\\q\\\nend\" $'\\t\\x41\\101' | cat && true || false; echo ok &\n# ignored\npwd");

  expect(parsed.malformed).toBe(false);
  expect(parsed.commands[0]).toEqual({
    envAssignments: ["FLAG=a b"],
    words: [
      { text: "printf", quoted: false },
      { text: "%s", quoted: true },
      { text: "a # b", quoted: true },
      { text: "word#hash", quoted: false },
      { text: "x y", quoted: true },
      { text: '"\\$`\\qend', quoted: true },
      { text: "\tAA", quoted: true },
    ],
    operatorAfter: "|",
    depth: 0,
  });
  expect(parsed.commands.map(({ operatorAfter }) => operatorAfter)).toEqual(["|", "&&", "||", ";", "&", null]);
  expect(parseShellScript('"X=1"; ru\\\nff check # comment').unwrapped.map(({ executable }) => executable))
    .toEqual(["X=1", "ruff"]);
});

test("consumes queued heredocs but not here-strings or arithmetic shifts", () => {
  const parsed = parseShellScript(
    "cat 3<<'ONE' <<-T\\WO \\\n <<< 'git commit' && echo ready\n" +
    "git commit --amend\nONE\n\tgit commit --no-edit\n\tTWO\n" +
    "(( 1 << (2 + 3) )); echo $(( 1 << (2 + 3) )); (git commit -F - <<END\nfake\nEND\n)",
  );

  expect(parsed.malformed).toBe(false);
  expect(parsed.unwrapped.map(({ executable }) => executable)).toEqual(["cat", "echo", "echo", "git"]);
  expect(parsed.gitCommits).toEqual([{ amend: false, noEdit: false, args: ["-F", "-"] }]);
});

test("reads unquoted heredoc continuations without parsing their content", () => {
  const parsed = parseShellScript("cat <<EOF\nx\\\nEOF\ngit commit --amend\nE\\\nOF\ngit commit --no-edit");

  expect(parsed.malformed).toBe(false);
  expect(parsed.gitCommits).toEqual([{ amend: false, noEdit: true, args: ["--no-edit"] }]);
});

test("finds commands in nested substitutions, subshells, and shell payloads", () => {
  const parsed = parseShellScript(
    "echo \"$(echo $(printf x); (git -c user.name=test commit --amend))\" " +
    "`echo \\`git commit --no-edit\\``; " +
    "bash -c 'sh -c \"zsh -c \\\"git commit --amend --no-edit\\\"\"'; " +
    "echo '$(git commit)' \"\\$(git commit)\"",
  );

  expect(parsed.malformed).toBe(false);
  expect(parsed.gitCommits).toEqual([
    { amend: true, noEdit: false, args: ["--amend"] },
    { amend: false, noEdit: true, args: ["--no-edit"] },
    { amend: true, noEdit: true, args: ["--amend", "--no-edit"] },
  ]);
  expect(parsed.commands.values().filter(({ words }) => words[0]?.text === "git").map(({ depth }) => depth).toArray())
    .toEqual([2, 2, 3]);
});

test("skips Git global options and ignores positional and option values", () => {
  const parsed = parseShellScript(
    "git --no-pager -C /repo --git-dir /git --work-tree=/tree commit --amend --no-edit; " +
    "git --git-dir=/git --work-tree /tree commit -m --amend -- --no-edit; " +
    "git show commit; git commit --help",
  );

  expect(parsed.gitCommits).toEqual([
    { amend: true, noEdit: true, args: ["--amend", "--no-edit"] },
    { amend: false, noEdit: false, args: ["-m", "--amend", "--", "--no-edit"] },
  ]);
});

test("unwraps env, control, uv and Python module wrappers", () => {
  const parsed = parseShellScript(
    "if env -i -u HOME DEBUG=1 time command nohup /bin/uvx --offline --from tools --with dep ruff check; " +
    "then /bin/uv tool run --isolated -w plugin -c constraints ruff==0.17.5 check; " +
    "else uv run --no-sync --package=tools /bin/python3.13 -BEsS -uO -m pytest -q; fi",
  );

  expect(parsed.unwrapped.map(({ executable, args }) => [executable, args])).toEqual([
    ["ruff", ["check"]], ["ruff", ["check"]], ["pytest", ["-q"]],
  ]);
  expect(unwrapSimpleCommand({
    envAssignments: ["HOME=tmp"],
    words: [{ text: "builtin", quoted: false }, { text: "echo", quoted: false }],
    depth: 0,
    operatorAfter: null,
  })).toEqual({ executable: "echo", args: [], rawWords: ["builtin", "echo"], rejectedFlag: null });
  expect(unwrapSimpleCommand({ envAssignments: ["A=b"], words: [], depth: 0, operatorAfter: null })).toBeNull();
});

test("exposes shell and script targets, with the same basename as direct invocation", () => {
  const parsed = parseShellScript("bash scripts/verify_deploy.sh --dry-run; ./scripts/verify_deploy.sh arg");

  expect(parsed.unwrapped).toEqual([
    { executable: "bash", args: ["scripts/verify_deploy.sh", "--dry-run"], rejectedFlag: "--dry-run",
      rawWords: ["bash", "scripts/verify_deploy.sh", "--dry-run"] },
    { executable: "verify_deploy.sh", args: ["--dry-run"], rejectedFlag: "--dry-run",
      rawWords: ["bash", "scripts/verify_deploy.sh", "--dry-run"] },
    { executable: "verify_deploy.sh", args: ["arg"], rejectedFlag: null, rawWords: ["./scripts/verify_deploy.sh", "arg"] },
  ]);
});

test.each(["ruff>=0.17", "ruff~=0.17", "ruff@0.17.5"])("normalizes a versioned executable: %s", (tool) => {
  expect(parseShellScript(`uvx '${tool}' check`).unwrapped[0]?.executable).toBe("ruff");
});

test.each(["-h", "--help", "-V", "--version", "--dry-run", "--collect-only"])("marks non-execution: %s", (flag) => {
  expect(parseShellScript(`ruff check ${flag}`).unwrapped[0]?.rejectedFlag).toBe(flag);
});

test.each(["echo 'hi", 'echo "hi', "echo $'hi", "echo \\", "echo $(pwd", "echo `pwd", "(echo hi",
  "(( 1 << 3 )", "echo $((1 << 3)", "cat <<", "cat <<END", "cat <<END\nmissing\n"])("marks malformed input: %j", (source) => {
  expect(parseShellScript(source).malformed).toBe(true);
});

test("bounds input by UTF-8 bytes and bounds substitution depth", () => {
  expect(parseShellScript("é".repeat(131_072)).malformed).toBe(false);
  expect(parseShellScript("é".repeat(131_073)).malformed).toBe(true);
  expect(parseShellScript("echo $(".repeat(12) + "pwd" + ")".repeat(12)).malformed).toBe(false);
  expect(parseShellScript("echo $(".repeat(13) + "pwd" + ")".repeat(13)).malformed).toBe(true);
  expect(parseShellScript('echo ' + '$(("'.repeat(100) + '1' + '"))'.repeat(100)).malformed).toBe(true);
});

test("does not interpret Git option values as commit flags", () => {
  const parsed = parseShellScript("git -C --version commit -m '--dry-run'; git commit -qm '--amend'; git commit -- --help");

  expect(parsed.gitCommits).toEqual([
    { amend: false, noEdit: false, args: ["-m", "--dry-run"] },
    { amend: false, noEdit: false, args: ["-qm", "--amend"] },
    { amend: false, noEdit: false, args: ["--", "--help"] },
  ]);
});

test("reads static shell payloads around arithmetic and marks unknown payloads incomplete", () => {
  const parsed = parseShellScript('sh -c "echo $((1+1)); git commit --amend"');

  expect(parsed.malformed).toBe(false);
  expect(parsed.gitCommits).toEqual([{ amend: true, noEdit: false, args: ["--amend"] }]);
  expect(parseShellScript('sh -c "echo $(generate); git commit"').malformed).toBe(true);
});
