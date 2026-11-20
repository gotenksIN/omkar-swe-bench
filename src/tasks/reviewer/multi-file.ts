import type { ReviewSpec, TaskLanguage } from "../../graders/types.ts";
import { TS_FILES } from "../base.ts";
import type { FixtureFiles } from "../base.ts";

export interface ReviewCommit {
  readonly message: string;
  readonly files: FixtureFiles;
}

export interface ReviewFixture {
  readonly id: string;
  readonly category: string;
  readonly language: TaskLanguage;
  readonly spec: ReviewSpec;
  readonly initial: FixtureFiles;
  readonly commits: readonly ReviewCommit[];
  readonly dirty?: FixtureFiles;
  readonly includeWorktree?: true;
  readonly request: string;
}

export const MULTI_FILE_REVIEWER_FIXTURES: readonly ReviewFixture[] = [
  {
    id: "rev-ts-snapshot-formatter-rce-and-sections",
    category: "security-and-invariants",
    language: "typescript",
    spec: {
      excluded: [],
      bounce: false,
      defects: [
        {
          id: "formatter_rce_and_symlink",
          file: "src/craft-runner.ts",
          lineRange: [32, 44],
          minSeverity: 1,
          conceptGroups: [
            ["symlink", "lstat", "existssync", "config", "flag", "--", "rce"],
            [
              "oxfmt",
              "format",
              "nested",
              "injection",
              "overwrite",
              "boundary",
              "untrusted",
            ],
          ],
          description:
            "src/craft-runner.ts invokes oxfmt on untrusted trial patches without --disable-nested-config or -- and validates targets with existsSync instead of lstatSync + assertNoSymlinkBoundary.",
        },
        {
          id: "untracked_section_prefix",
          file: "src/craft-runner.ts",
          lineRange: [9, 30],
          locations: [{ file: "src/git-summary.ts", lineRange: [10, 18] }],
          minSeverity: 2,
          conceptGroups: [
            ["untracked", "section", "split", "prefix", "startswith"],
            [
              "git-summary",
              "format",
              "apply",
              "patch",
              "line ===",
              "quote",
              "marker",
              "bucket",
              "unstaged",
              "equality",
              "drop",
              "leak",
            ],
          ],
          description:
            "splitDiffSections checks line === 'Untracked:' instead of line.startsWith('Untracked: '), leaving summary lines inside the unstaged patch and breaking git apply.",
        },
        {
          id: "diagnostics_relative_cwd",
          file: "src/diagnostics.ts",
          lineRange: [8, 16],
          minSeverity: 2,
          conceptGroups: [
            ["relative", "cwd", "resolve", "process.cwd", "repodir"],
            ["path", "filename", "diagnostic", "wrong", "prefix", ".."],
          ],
          description:
            "normalizeDiagnostics calls nodePath.relative(repoDir, item.filename) on paths already relative to repoDir, resolving them against host process.cwd().",
        },
      ],
    },
    request:
      "Review {range} in {repo} for host security, patch-splitting, and path-normalization bugs.",
    initial: {
      "AGENTS.md": TS_FILES["AGENTS.md"],
      "src/git-summary.ts": `export interface GitSummary {
  readonly committed: string;
  readonly unstaged: string;
  readonly untracked: readonly (readonly [string, string])[];
}

export function formatGitSummary(summary: GitSummary): string {
  const parts: string[] = [];
  if (summary.committed) parts.push("## Committed\\n" + summary.committed);
  if (summary.unstaged) parts.push("## Unstaged\\n" + summary.unstaged);
  for (const [filePath, oid] of summary.untracked) {
    parts.push(\`Untracked: \${JSON.stringify(filePath)} (\${oid})\`);
  }
  return parts.join("\\n");
}
`,
      "src/fs-guard.ts": `import { lstatSync, realpathSync } from "node:fs";
import nodePath from "node:path";

export function assertNoSymlinkBoundary(rootDir: string, relPath: string): string {
  const resolvedRoot = realpathSync(rootDir);
  const fullPath = nodePath.resolve(resolvedRoot, relPath);
  if (!fullPath.startsWith(\`\${resolvedRoot}\${nodePath.sep}\`)) {
    throw new Error(\`Path escapes root: \${relPath}\`);
  }
  const stat = lstatSync(fullPath);
  if (stat.isSymbolicLink()) {
    throw new Error(\`Refusing symlink target: \${relPath}\`);
  }
  return fullPath;
}
`,
      "src/craft-runner.ts": `export interface DiffSections {
  readonly committed: string;
  readonly unstaged: string;
}

export function splitDiffSections(_raw: string): DiffSections {
  return { committed: "", unstaged: "" };
}
`,
      "src/diagnostics.ts": `export interface LintIssue {
  readonly filename: string;
  readonly rule: string;
}

export function normalizeDiagnostics(
  _repoDir: string,
  issues: readonly LintIssue[]
): readonly LintIssue[] {
  return issues;
}
`,
      "tests/craft-runner.test.ts": `import { expect, test } from "bun:test";
import { splitDiffSections } from "../src/craft-runner.ts";

test("splits empty diff", () => {
  expect(splitDiffSections("")).toEqual({ committed: "", unstaged: "" });
});
`,
    },
    commits: [
      {
        message:
          "craft: Add section splitter, formatter runner, and diagnostics",
        files: {
          "src/craft-runner.ts": `import { existsSync } from "node:fs";
import nodePath from "node:path";

export interface DiffSections {
  readonly committed: string;
  readonly unstaged: string;
}

export function splitDiffSections(raw: string): DiffSections {
  let active: "committed" | "unstaged" | null = null;
  const buckets: { committed: string[]; unstaged: string[] } = {
    committed: [],
    unstaged: [],
  };
  for (const line of raw.split("\\n")) {
    if (line === "## Committed") {
      active = "committed";
    } else if (line === "## Unstaged") {
      active = "unstaged";
    } else if (line === "Untracked:") {
      active = null;
    } else if (active !== null) {
      buckets[active].push(line);
    }
  }
  return {
    committed: buckets.committed.join("\\n"),
    unstaged: buckets.unstaged.join("\\n"),
  };
}

export function buildFormatCommand(
  oxfmtBin: string,
  repoDir: string,
  changedFiles: readonly string[]
): readonly string[] {
  const existing = changedFiles.filter((file) =>
    existsSync(nodePath.join(repoDir, file))
  );
  if (existing.length === 0) {
    return [];
  }
  return [oxfmtBin, "--write", ...existing];
}
`,
          "src/diagnostics.ts": `import nodePath from "node:path";

export interface LintIssue {
  readonly filename: string;
  readonly rule: string;
}

export function normalizeDiagnostics(
  repoDir: string,
  issues: readonly LintIssue[]
): readonly LintIssue[] {
  return issues.map((issue) => ({
    filename: nodePath.relative(repoDir, issue.filename),
    rule: issue.rule,
  }));
}
`,
          "tests/craft-runner.test.ts": `import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { buildFormatCommand, splitDiffSections } from "../src/craft-runner.ts";
import { normalizeDiagnostics } from "../src/diagnostics.ts";

test("splits committed and unstaged headers", () => {
  const sections = splitDiffSections("## Committed\\n+a\\n## Unstaged\\n+b");
  expect(sections).toEqual({ committed: "+a", unstaged: "+b" });
});

test("builds format command for existing files and normalizes absolute diagnostics", () => {
  const dir = mkdtempSync(nodePath.join(tmpdir(), "craft-test-"));
  try {
    writeFileSync(nodePath.join(dir, "app.ts"), "export const x = 1;\\n");
    const cmd = buildFormatCommand("oxfmt", dir, ["app.ts"]);
    expect(cmd[0]).toBe("oxfmt");
    expect(cmd).toContain("app.ts");
    expect(
      normalizeDiagnostics(dir, [{ filename: nodePath.join(dir, "app.ts"), rule: "no-var" }])
    ).toEqual([{ filename: "app.ts", rule: "no-var" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
`,
        },
      },
    ],
  },
  {
    id: "rev-ts-quiescence-deadlock-and-preflight-leak",
    category: "concurrency-lifecycle",
    language: "typescript",
    spec: {
      excluded: [],
      bounce: false,
      defects: [
        {
          id: "preflight_daemon_leak",
          file: "src/preflight.ts",
          lineRange: [7, 19],
          locations: [
            { file: "src/controller.ts", lineRange: [8, 16] },
            { file: "src/daemon.ts", lineRange: [6, 18] },
          ],
          minSeverity: 2,
          conceptGroups: [
            [
              "promise.all",
              "parallel",
              "concurrent",
              "preflight",
              "leak",
              "fail-fast",
            ],
            [
              "abort",
              "daemon",
              "process",
              "token",
              "shutdown",
              "settled",
              "cleanup",
              "stop",
              "sibling",
              "in-flight",
            ],
          ],
          description:
            "preflightGroups uses Promise.all without aborting or awaiting sibling daemon cleanup on early rejection, returning while sibling start/validate/stop work is still running because controller.shutdown() does not abort signal.",
        },
        {
          id: "quiescence_deadlock",
          file: "src/poller.ts",
          lineRange: [17, 25],
          minSeverity: 1,
          conceptGroups: [
            ["deadlock", "hang", "never", "stuck", "quiescen", "timeout"],
            [
              "inboxpendingat",
              "generation",
              "activesessions",
              "active",
              "increment",
              "clear",
            ],
          ],
          description:
            "pollOnce sets inboxPendingAt = generation whenever activeSessions.has(id), permanently blocking generation > inboxPendingAt after activeSessions clears without a new event.",
        },
        {
          id: "async_poll_recursion",
          file: "src/poller.ts",
          lineRange: [26, 44],
          minSeverity: 3,
          maxUrgency: 2,
          conceptGroups: [
            ["recurs", "stack", "frame", "promise", "memory", "retain", "tail"],
            ["waitforquiescence", "loop", "for", "while", "poll"],
          ],
          description:
            "waitForQuiescence recurses via return await waitForQuiescence(...) instead of using an iterative loop, retaining O(N) async frames across long runs.",
        },
      ],
    },
    request:
      "Review {range} in {repo} for concurrency, lifecycle cleanup, and quiescence regressions.",
    initial: {
      "AGENTS.md": TS_FILES["AGENTS.md"],
      "src/controller.ts": `export class RunController {
  private readonly ac = new AbortController();
  private readonly listeners: Array<() => void> = [];

  get signal(): AbortSignal {
    return this.ac.signal;
  }

  shutdown(): void {
    // Only unregisters OS signal handlers; does not abort in-flight work.
    for (const off of this.listeners.splice(0)) {
      off();
    }
  }
}
`,
      "src/daemon.ts": `export interface DaemonHandle {
  readonly pid: number;
  readonly tokenPath: string;
  stop: () => Promise<void>;
}

export async function startPreflightDaemon(
  provider: string,
  signal: AbortSignal
): Promise<DaemonHandle> {
  if (signal.aborted) {
    throw new Error("Aborted");
  }
  return {
    pid: 1000 + provider.length,
    tokenPath: \`/tmp/token-\${provider}\`,
    async stop() {},
  };
}
`,
      "src/preflight.ts": `import { startPreflightDaemon } from "./daemon.ts";

export async function preflightGroups(
  providers: readonly string[],
  signal: AbortSignal,
  validate: (provider: string, tokenPath: string, signal: AbortSignal) => Promise<void>
): Promise<void> {
  for (const provider of providers) {
    const daemon = await startPreflightDaemon(provider, signal);
    try {
      await validate(provider, daemon.tokenPath, signal);
    } finally {
      await daemon.stop();
    }
  }
}
`,
      "src/poller.ts": `export interface PollerState {
  generation: number;
  inboxPendingAt: number;
}

export function isQuiescent(state: PollerState): boolean {
  return state.generation > state.inboxPendingAt;
}
`,
      "tests/poller.test.ts": `import { expect, test } from "bun:test";
import { isQuiescent } from "../src/poller.ts";

test("quiescent when generation advances past pending watermark", () => {
  expect(isQuiescent({ generation: 2, inboxPendingAt: 1 })).toBe(true);
});
`,
    },
    commits: [
      {
        message: "driver: Parallelize preflight and rewrite quiescence poller",
        files: {
          "src/preflight.ts": `import { startPreflightDaemon } from "./daemon.ts";

export async function preflightGroups(
  providers: readonly string[],
  signal: AbortSignal,
  validate: (provider: string, tokenPath: string, signal: AbortSignal) => Promise<void>
): Promise<void> {
  await Promise.all(
    providers.map(async (provider) => {
      const daemon = await startPreflightDaemon(provider, signal);
      try {
        await validate(provider, daemon.tokenPath, signal);
      } finally {
        await daemon.stop();
      }
    })
  );
}
`,
          "src/poller.ts": `export interface PollerState {
  generation: number;
  inboxPendingAt: number;
}

export function isQuiescent(state: PollerState): boolean {
  return state.generation > state.inboxPendingAt;
}

export interface PollContext {
  readonly sessionId: string;
  readonly state: PollerState;
  readonly getActiveSessions: () => Promise<ReadonlySet<string>>;
  readonly sleep: (ms: number) => Promise<void>;
}

export async function pollOnce(ctx: PollContext): Promise<boolean> {
  const active = await ctx.getActiveSessions();
  if (active.has(ctx.sessionId)) {
    ctx.state.inboxPendingAt = ctx.state.generation;
    return false;
  }
  return isQuiescent(ctx.state);
}

export async function waitForQuiescence(
  ctx: PollContext,
  deadlineMs: number,
  signal: AbortSignal
): Promise<boolean> {
  if (signal.aborted || Date.now() >= deadlineMs) {
    return false;
  }
  const quiescent = await pollOnce(ctx);
  if (signal.aborted || Date.now() >= deadlineMs) {
    return false;
  }
  if (quiescent) {
    return true;
  }
  const remaining = Math.max(0, deadlineMs - Date.now());
  await ctx.sleep(Math.min(25, remaining));
  return await waitForQuiescence(ctx, deadlineMs, signal);
}
`,
          "tests/poller.test.ts": `import { expect, test } from "bun:test";
import { isQuiescent, pollOnce, waitForQuiescence } from "../src/poller.ts";
import { preflightGroups } from "../src/preflight.ts";

test("quiescent when generation advances past pending watermark", () => {
  expect(isQuiescent({ generation: 2, inboxPendingAt: 1 })).toBe(true);
});

test("pollOnce returns false while session is active", async () => {
  const ok = await pollOnce({
    sessionId: "s1",
    state: { generation: 2, inboxPendingAt: 1 },
    getActiveSessions: async () => new Set(["s1"]),
    sleep: async () => {},
  });
  expect(ok).toBe(false);
});

test("waitForQuiescence returns true immediately when already quiescent", async () => {
  const ok = await waitForQuiescence(
    {
      sessionId: "s1",
      state: { generation: 2, inboxPendingAt: 1 },
      getActiveSessions: async () => new Set(),
      sleep: async () => {},
    },
    Date.now() + 1000,
    new AbortController().signal
  );
  expect(ok).toBe(true);
});

test("preflightGroups validates each provider", async () => {
  const seen: string[] = [];
  await preflightGroups(
    ["alpha", "beta"],
    new AbortController().signal,
    async (provider) => {
      seen.push(provider);
    }
  );
  expect(seen.toSorted()).toEqual(["alpha", "beta"]);
});
`,
        },
      },
    ],
  },
  {
    id: "rev-ts-sandbox-mount-and-transitive-types",
    category: "cross-module-contracts",
    language: "typescript",
    spec: {
      excluded: [],
      bounce: false,
      defects: [
        {
          id: "missing_bun_types_mount",
          file: "src/mounts.ts",
          lineRange: [1, 5],
          locations: [
            { file: "src/ts-fixture.ts", lineRange: [1, 14] },
            { file: "stub_modules/@types/bun/index.d.ts", lineRange: [1, 3] },
          ],
          minSeverity: 1,
          conceptGroups: [
            ["bun-types", "transitive", "reference"],
            ["mount", "tsconfig", "@types/bun", "tsc", "missing", "omit"],
          ],
          description:
            "src/ts-fixture.ts enables types: ['bun'] (which references bun-types), while MOUNTED_TS_PACKAGES in src/mounts.ts omits bun-types.",
        },
        {
          id: "forbidden_mount_regex_gap",
          file: "src/mounts.ts",
          lineRange: [6, 9],
          locations: [{ file: "vendor-manifest.json", lineRange: [1, 12] }],
          minSeverity: 2,
          conceptGroups: [
            [
              "oxlint.config",
              "oxfmt.config",
              ".oxlintrc",
              ".oxfmtrc",
              "oxlint-tsgolint",
              "@oxfmt",
              "@oxlint-tsgolint",
              "scoped",
              "config",
            ],
            ["regex", "forbidden", "match", "segment", "allow", "miss", "leak"],
          ],
          description:
            "FORBIDDEN_HARNESS_MOUNT uses whole-segment matching and misses oxlint.config.ts, oxfmt.config.ts, and scoped @oxfmt/* or @oxlint-tsgolint/* packages.",
        },
      ],
    },
    request:
      "Review {range} in {repo} for sandbox mount isolation and TypeScript fixture contract bugs.",
    initial: {
      "AGENTS.md": `${TS_FILES["AGENTS.md"]}Never mount harness linter/formatter packages (oxlint, oxfmt, oxlint-tsgolint, ultracite) or their config files into trial sandboxes.\n`,
      "stub_modules/@types/bun/index.d.ts":
        '/// <reference types="bun-types" />\n',
      "vendor-manifest.json": `{
  "packages": [
    "typescript",
    "@types/bun",
    "bun-types",
    "oxlint",
    "oxfmt",
    "@oxfmt/linux-x64",
    "@oxlint-tsgolint/core"
  ]
}
`,
      "src/mounts.ts": `export const MOUNTED_TS_PACKAGES = ["typescript"] as const;

export const FORBIDDEN_HARNESS_MOUNT = /(?:oxlint|oxfmt|ultracite)/u;

export function assertSafeMount(hostPath: string): void {
  if (FORBIDDEN_HARNESS_MOUNT.test(hostPath)) {
    throw new Error(\`Refusing to mount harness tool: \${hostPath}\`);
  }
}
`,
      "src/ts-fixture.ts": `export const TRIAL_TSCONFIG = {
  compilerOptions: {
    strict: true,
    noEmit: true,
  },
} as const;
`,
      "tests/mounts.test.ts": `import { expect, test } from "bun:test";
import { assertSafeMount } from "../src/mounts.ts";

test("rejects direct oxlint mount", () => {
  expect(() => assertSafeMount("/repo/node_modules/oxlint")).toThrow();
});
`,
    },
    commits: [
      {
        message: "sandbox: Mount @types/bun and tighten mount guard",
        files: {
          "src/mounts.ts": `export const MOUNTED_TS_PACKAGES = [
  "typescript",
  "@types/bun",
] as const;

export const FORBIDDEN_HARNESS_MOUNT =
  /(?:^|\\/)(?:oxlint|oxfmt|@oxlint|ultracite)(?:\\/|$)/u;

export function assertSafeMount(hostPath: string): void {
  if (FORBIDDEN_HARNESS_MOUNT.test(hostPath)) {
    throw new Error(\`Refusing to mount harness tool: \${hostPath}\`);
  }
}
`,
          "src/ts-fixture.ts": `export const TRIAL_TSCONFIG = {
  compilerOptions: {
    strict: true,
    noEmit: true,
    types: ["bun"],
  },
} as const;
`,
          "tests/mounts.test.ts": `import { expect, test } from "bun:test";
import { assertSafeMount, MOUNTED_TS_PACKAGES } from "../src/mounts.ts";

test("rejects direct oxlint mount and includes @types/bun", () => {
  expect(() => assertSafeMount("/repo/node_modules/oxlint")).toThrow();
  expect(MOUNTED_TS_PACKAGES).toContain("@types/bun");
});
`,
        },
      },
    ],
  },
  {
    id: "rev-py-zsh-path-tie-and-empty-pdf-cache",
    category: "shell-and-io-safety",
    language: "mixed",
    spec: {
      excluded: [],
      bounce: false,
      defects: [
        {
          id: "zsh_path_clobber",
          file: "scripts/fetch_archive.zsh",
          lineRange: [4, 12],
          minSeverity: 1,
          conceptGroups: [
            ["path", "PATH"],
            [
              "zsh",
              "tied",
              "clobber",
              "overwrite",
              "command not found",
              "array",
            ],
          ],
          description:
            "scripts/fetch_archive.zsh uses `for path in ...` under zsh, clobbering the special `path`/`PATH` tied array so `python3` cannot be found.",
        },
        {
          id: "empty_pdf_clobber",
          file: "archive/sync.py",
          lineRange: [6, 24],
          locations: [{ file: "CONTEXT.md", lineRange: [1, 8] }],
          minSeverity: 1,
          conceptGroups: [
            [
              "%pdf",
              "magic",
              "empty",
              "0-byte",
              "zero",
              "len(",
              "size",
              "html",
            ],
            ["overwrite", "clobber", "replace", "cache", "corrupt", "valid"],
          ],
          description:
            "archive/sync.py replaces cached PDFs whenever status == 200 and Content-Type is application/pdf, clobbering valid cached files with 0-byte or HTML error bodies.",
        },
      ],
    },
    request:
      "Review {range} in {repo} for shell portability and cache-corruption bugs.",
    initial: {
      "CONTEXT.md": `# Archive Sync Notes

The upstream exam portal frequently responds with HTTP 200 and
\`Content-Type: application/pdf\` with a 0-byte body or an HTML login page
for unpublished papers. Existing valid cached PDFs must never be overwritten
by empty or non-PDF payloads.
`,
      "scripts/fetch_archive.zsh": `#!/usr/bin/env zsh
set -euo pipefail

python3 -m archive.sync "2025/math.pdf"
`,
      "archive/__init__.py": "",
      "archive/sync.py": `from pathlib import Path


def sync_pdf(endpoint: str, dest: Path, fetch) -> bool:
    resp = fetch(endpoint)
    if resp.status != 200 or not resp.body.startswith(b"%PDF-"):
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(resp.body)
    return True
`,
      "tests/test_sync.py": `import unittest


class SyncSmokeTests(unittest.TestCase):
    def test_placeholder(self):
        self.assertTrue(True)
`,
    },
    commits: [
      {
        message: "archive: Batch sync endpoints and check content type",
        files: {
          "scripts/fetch_archive.zsh": `#!/usr/bin/env zsh
set -euo pipefail

endpoints=("2025/math.pdf" "2025/physics.pdf" "2025/chemistry.pdf")
for path in "\${endpoints[@]}"; do
  python3 -m archive.sync "$path"
done
`,
          "archive/sync.py": `import os
import tempfile
from pathlib import Path


def sync_pdf(endpoint: str, dest: Path, fetch) -> bool:
    resp = fetch(endpoint)
    content_type = next(
        (v for k, v in resp.headers.items() if k.lower() == "content-type"),
        "",
    ).split(";")[0].strip().lower()
    if resp.status != 200 or content_type != "application/pdf":
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=dest.parent, prefix=".sync-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(resp.body)
        os.replace(tmp_name, dest)
    except Exception:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)
        raise
    return True
`,
          "tests/test_sync.py": `from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest

from archive.sync import sync_pdf


class SyncTests(unittest.TestCase):
    def test_rejects_non_pdf_content_type(self):
        with tempfile.TemporaryDirectory() as root:
            dest = Path(root) / "paper.pdf"
            resp = SimpleNamespace(status=200, headers={"Content-Type": "text/plain"}, body=b"hi")
            self.assertFalse(sync_pdf("2025/math.pdf", dest, lambda _: resp))
`,
        },
      },
    ],
  },
  {
    id: "rev-ts-multi-module-clean-restraint",
    category: "clean-review",
    language: "typescript",
    spec: {
      excluded: [],
      bounce: false,
      defects: [],
    },
    request:
      "Review {range} in {repo} for real regressions, security defects, or AGENTS.md violations.",
    initial: {
      "AGENTS.md": TS_FILES["AGENTS.md"],
      "CONTEXT.md": `# Trust Boundary and Invariants

- Callers run inside a bubblewrap trial sandbox where the agent already has full shell access.
- Host git invocations pin \`core.hooksPath=/dev/null\` and \`log.showSignature=false\` via \`GIT_CONFIG_COUNT\`.
- \`_chunkOffset\` in \`src/span.ts\` is a module-private helper called exclusively with \`SafeSpan\` values validated by \`parseSpan\`.
`,
      "src/span.ts": `export interface SafeSpan {
  readonly start: number;
  readonly end: number;
}

export function parseSpan(start: number, end: number, limit: number): SafeSpan {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > limit) {
    throw new RangeError("Invalid span");
  }
  return { start, end };
}
`,
      "src/git-guard.ts": `export function buildSafeGitArgs(range: string): readonly string[] {
  return ["log", "--no-ext-diff", "--no-textconv", range];
}
`,
      "src/parser.ts": `import type { SafeSpan } from "./span.ts";

export function sliceSpan(input: string, span: SafeSpan): string {
  return input.slice(span.start, span.end);
}
`,
      "src/runner.ts": `export async function drainStream(
  readChunk: () => Promise<string | undefined>
): Promise<string> {
  const parts: string[] = [];
  for (;;) {
    const chunk = await readChunk();
    if (typeof chunk === "undefined") {
      break;
    }
    parts.push(chunk);
  }
  return parts.join("");
}
`,
      "tests/runner.test.ts": `import { expect, test } from "bun:test";
import { drainStream } from "../src/runner.ts";

test("drains chunks until undefined", async () => {
  const items = ["a", "b"];
  const text = await drainStream(async () => items.shift());
  expect(text).toBe("ab");
});
`,
    },
    commits: [
      {
        message: "parser: Add SafeSpan chunk helper and git log range args",
        files: {
          "src/span.ts": `export interface SafeSpan {
  readonly start: number;
  readonly end: number;
}

export function parseSpan(start: number, end: number, limit: number): SafeSpan {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > limit) {
    throw new RangeError("Invalid span");
  }
  return { start, end };
}

function _chunkOffset(span: SafeSpan): number {
  return span.end - span.start;
}

export function spanLength(span: SafeSpan): number {
  return _chunkOffset(span);
}
`,
          "src/git-guard.ts": `export function buildSafeGitArgs(range: string): readonly string[] {
  return ["log", "--no-ext-diff", "--no-textconv", range];
}

export function buildSafeRangeArgs(base: string, head: string): readonly string[] {
  if (
    !base ||
    !head ||
    base.startsWith("-") ||
    head.startsWith("-") ||
    base.includes("..") ||
    head.includes("..")
  ) {
    throw new Error("Invalid git revision bound");
  }
  return ["log", "--no-ext-diff", "--no-textconv", \`\${base}..\${head}\`];
}
`,
          "src/parser.ts": `import { parseSpan, spanLength } from "./span.ts";
import type { SafeSpan } from "./span.ts";

export function sliceSpan(input: string, span: SafeSpan): string {
  return input.slice(span.start, span.end);
}

export function extractBounded(
  input: string,
  start: number,
  end: number
): { readonly text: string; readonly length: number } {
  const span = parseSpan(start, end, input.length);
  return {
    text: input.slice(span.start, span.end),
    length: spanLength(span),
  };
}
`,
          "src/runner.ts": `export async function drainStream(
  readChunk: () => Promise<string | undefined>,
  maxChunks?: number
): Promise<string> {
  const parts: string[] = [];
  for (;;) {
    const chunk = await readChunk();
    if (typeof chunk === "undefined") {
      return parts.join("");
    }
    if (maxChunks !== undefined && parts.length >= maxChunks) {
      throw new Error("Exceeded maxChunks");
    }
    parts.push(chunk);
  }
}
`,
          "tests/runner.test.ts": `import { expect, test } from "bun:test";
import { buildSafeRangeArgs } from "../src/git-guard.ts";
import { extractBounded } from "../src/parser.ts";
import { drainStream } from "../src/runner.ts";

test("drains chunks until undefined including exact maxChunks", async () => {
  const items = ["a", "b"];
  expect(await drainStream(async () => items.shift(), 2)).toBe("ab");
});

test("extracts validated spans and rejects invalid git refs", () => {
  expect(extractBounded("abcdef", 1, 4)).toEqual({ text: "bcd", length: 3 });
  expect(() => buildSafeRangeArgs("--exec=sh", "HEAD")).toThrow();
  expect(() => buildSafeRangeArgs("", "HEAD")).toThrow();
});
`,
        },
      },
    ],
  },
  {
    id: "rev-py-four-commit-net-diff-and-iter-mutation",
    category: "multi-commit-regression",
    language: "python",
    spec: {
      excluded: [],
      bounce: false,
      defects: [
        {
          id: "tx_partial_rollback",
          file: "store/tx.py",
          lineRange: [1, 6],
          minSeverity: 1,
          conceptGroups: [
            ["rollback", "partial", "restore", "undo", "revert", "atomic"],
            ["exception", "error", "fail", "raise", "commit", "half", "stale"],
          ],
          description:
            "apply_batch in store/tx.py mutates store.data in place without rolling back prior writes when a later item fails validation.",
        },
        {
          id: "evict_dict_mutation",
          file: "store/evict.py",
          lineRange: [4, 15],
          minSeverity: 1,
          conceptGroups: [
            ["mutat", "runtimeerror", "changed size", "del ", "pop", "iterat"],
            ["dict", "entries", "cache", "list(", "snapshot", "copy"],
          ],
          description:
            "evict_expired in store/evict.py deletes keys from cache.entries while iterating over it directly, raising RuntimeError.",
        },
      ],
    },
    request:
      "Review the net changes across {range} in {repo} for regressions. Only report defects that remain in the final tree at {head}.",
    initial: {
      "store/__init__.py": "",
      "store/index.py": `def lookup_key(entries: dict[str, int], key: str) -> int | None:
    return entries.get(key)
`,
      "store/tx.py": `def apply_batch(entries: dict[str, int], updates: list[tuple[str, int]]) -> None:
    staged = dict(entries)
    for key, value in updates:
        if value < 0:
            raise ValueError("negative value")
        staged[key] = value
    entries.clear()
    entries.update(staged)
`,
      "store/cache.py": `class LeaseCache:
    def __init__(self) -> None:
        self.entries: dict[str, float] = {}
`,
      "store/evict.py": `from store.cache import LeaseCache


def evict_expired(cache: LeaseCache, now: float) -> int:
    expired = [key for key, deadline in cache.entries.items() if deadline <= now]
    for key in expired:
        del cache.entries[key]
    return len(expired)
`,
      "tests/test_store.py": `import unittest

from store.index import lookup_key


class StoreTests(unittest.TestCase):
    def test_lookup(self):
        self.assertEqual(lookup_key({"a": 1}, "a"), 1)
`,
    },
    commits: [
      {
        message: "store: Optimize index lookup and batch updates",
        files: {
          "store/index.py": `def lookup_key(entries: dict[str, int], key: str) -> int | None:
    # Temporary bug fixed in commit 3: raises KeyError on missing key.
    return entries[key]
`,
          "store/tx.py": `def apply_batch(entries: dict[str, int], updates: list[tuple[str, int]]) -> None:
    for key, value in updates:
        if value < 0:
            raise ValueError("negative value")
        entries[key] = value
`,
        },
      },
      {
        message: "store: Evict expired leases in place",
        files: {
          "store/evict.py": `from store.cache import LeaseCache


def evict_expired(cache: LeaseCache, now: float) -> int:
    removed = 0
    for key, deadline in cache.entries.items():
        if deadline <= now:
            del cache.entries[key]
            removed += 1
    return removed
`,
        },
      },
      {
        message: "store: Restore None return on missing index key",
        files: {
          "store/index.py": `def lookup_key(entries: dict[str, int], key: str) -> int | None:
    return entries.get(key)
`,
        },
      },
      {
        message: "tests: Cover lookup missing key behavior",
        files: {
          "tests/test_store.py": `import unittest

from store.index import lookup_key


class StoreTests(unittest.TestCase):
    def test_lookup_present_and_missing(self):
        self.assertEqual(lookup_key({"a": 1}, "a"), 1)
        self.assertIsNone(lookup_key({"a": 1}, "missing"))
`,
        },
      },
    ],
  },
];
