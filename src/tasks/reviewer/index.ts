import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { reviewGrade } from "../../graders/findings.ts";
import type { ReviewSpec, TaskLanguage } from "../../graders/types.ts";
import { commitTaskFiles, initGitRepo, PY_FILES, runTaskGit, TS_FILES, type EvalTask, type FixtureFiles } from "../base.ts";

interface ReviewCommit {
  readonly message: string;
  readonly files: FixtureFiles;
}

interface ReviewFixture {
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

async function writeFiles(repoDir: string, files: FixtureFiles): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(repoDir, path);

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

function reviewerTask(fixture: ReviewFixture): EvalTask {
  const { id, category, language, spec } = fixture;

  return {
    id, category, language, role: "code-reviewer", timeoutSeconds: 480, commitGuard: false, readOnlyRepo: true,
    needsRuff: false, needsTsCompiler: false,
    async setupRepo(repoDir) {
      const initial = language === "typescript" ? fixture.initial : { ...PY_FILES, ...fixture.initial };
      const base = await initGitRepo(repoDir, initial, "fixture: Seed trial repository");
      let head = base;

      for (const { files, message } of fixture.commits) {
        await writeFiles(repoDir, files);
        head = await commitTaskFiles(repoDir, Object.keys(files), message);
      }

      if (fixture.dirty) await writeFiles(repoDir, fixture.dirty);

      const range = `${base}..${head}`;
      const diff = ["diff", "--no-ext-diff", "--no-textconv"];
      let reviewDiff = spec.bounce ? "" : await runTaskGit(repoDir, ...diff, range);

      if (fixture.includeWorktree) reviewDiff += await runTaskGit(repoDir, ...diff, head);

      const reviewSpecText = fixture.request.replaceAll("{range}", range).replaceAll("{head}", head)
        .replaceAll("{repo}", () => repoDir);

      const prompt = spec.bounce ? reviewSpecText : [
        reviewSpecText,
        "Do not modify the repository or run its code. Report actionable findings under `## Findings` with [P0]–[P3] priorities and file:line citations.",
        "If there are none, say “No actionable findings.”",
      ].join("\n");

      return {
        baselineHead: head, prompt, reviewSpecText, reviewDiff, seededDefects: spec.defects,
        reviewRequirements: "", reviewerBrief: "",
      };
    },
    async grade(evidence, setup) {
      return reviewGrade(evidence, spec, setup.reviewDiff);
    },
  };
}

const mediaOrder = `from operator import itemgetter


def ordered_titles(rows):
    """Return the titles in ascending playback order.

    Each row contains a title, a playback index, and a duration in seconds.
    """
    title_index = 0
    playback_index = 1
    duration_index = 2

    for row in rows:
        if row[duration_index] < 0:
            raise ValueError("duration must not be negative")

    return [row[title_index] for row in sorted(rows, key=itemgetter(playback_index))]
`;

const googleClient = `import { decodeSearchResponse } from "./types.ts";

const searchEndpoint = "https://search.example.invalid/v1/search";

export async function search(query: string, apiKey: string) {
  const url = new URL(searchEndpoint);
  url.searchParams.set("q", query);

  // The provider authenticates requests with its API key header.
  const headers = { "X-API-Key": apiKey };
  const response = await fetch(url, {
    headers,
    redirect: "error",
  });

  if (!response.ok) throw new Error(\`Search failed: \${response.status}\`);
  return decodeSearchResponse(await response.text());
}
`;

const cacheClient = `import json


def _call_model(prompt, transport):
    return transport.generate(prompt)


def _read_cache(path):
    return json.loads(path.read_text(encoding="utf-8"))


def _write_cache(path, result):
    path.write_text(json.dumps(result), encoding="utf-8")


def summarize(prompt, cache, transport):
    """Return the cached summary or generate it on a cache miss.

    The caller gives each prompt its own cache path.
    """
    try:
        return _read_cache(cache)
    except FileNotFoundError:
        pass
    except json.JSONDecodeError:
        cache.unlink(missing_ok=True)

    result = _call_model(prompt, transport)
    _write_cache(cache, result)
    return result
`;

const previewWorker = `import asyncio

from yt_dlp import YoutubeDL


async def preview(video_id):
    """Read metadata for a previously validated YouTube video ID."""
    return await asyncio.to_thread(_extract_title, video_id)


def _extract_title(video_id):
    url = f"https://www.youtube.com/watch?v={video_id}"
    with YoutubeDL({"quiet": True, "skip_download": True}) as downloader:
        return downloader.extract_info(url, download=False)["title"]
`;

const quotaApp = `from collections import deque

MAX_INPUT = 4096


class RateLimit:
    """Track up to five accepted requests per minute for one caller."""

    def __init__(self):
        self.accepted = deque()

    def take_slot(self, now):
        while self.accepted and now - self.accepted[0] >= 60:
            self.accepted.popleft()
        if len(self.accepted) >= 5:
            return False
        self.accepted.append(now)
        return True


def submit(text, quota, now, queue):
    """Enqueue plain text or return an HTTP error code."""
    if len(text) > MAX_INPUT:
        return 413
    if not quota.take_slot(now):
        return 429
    queue.append(text)
    return 202
`;

const buildScript = String.raw`import json
from pathlib import Path


def main():
    # Keep output.json byte-identical to the compact manifest from this build.
    # The deploy job checks the file against the generated bytes.
    manifest = {"assets": ["styles.css"]}
    output = json.dumps(manifest, separators=(",", ":")) + "\n"
    Path(__file__).with_name("output.json").write_text(output, encoding="utf-8")


if __name__ == "__main__":
    main()
`;

const csvReader = `import csv


def read_titles(path):
    """Read titles from a UTF-8 CSV with a title column."""
    with path.open(encoding="utf-8") as stream:
        return [row["title"] for row in csv.DictReader(stream)]
`;

const catalogModelModule = `export interface CatalogModel {
  /** Session model identifier passed to toSessionModel. */
  readonly id: string;
  /** Upstream provider wire name used internally by the transport layer. */
  readonly wireModel: string;
  readonly variants: readonly string[];
}

export interface CatalogProvider {
  readonly id: string;
  readonly models: readonly CatalogModel[];
}

export interface ModelSpec {
  readonly providerID: string;
  readonly modelID: string;
  readonly variant?: string;
}

export const DEFAULT_MODELS = [
  "openai/gpt-fast#medium",
  "anthropic/claude-core#high",
  "google/gemini-pro#medium",
] as const;

export function parseModelSpec(spec: string): ModelSpec {
  const trimmed = spec.trim();
  const hash = trimmed.indexOf("#");
  const base = hash >= 0 ? trimmed.slice(0, hash) : trimmed;
  const variant = hash >= 0 ? trimmed.slice(hash + 1) : undefined;
  const slash = base.indexOf("/");
  if (slash <= 0 || slash === base.length - 1) throw new Error(\`Invalid model spec: \${spec}\`);
  if (variant !== undefined && (!variant || variant.includes("#"))) throw new Error(\`Invalid variant: \${spec}\`);
  return variant === undefined
    ? { providerID: base.slice(0, slash), modelID: base.slice(slash + 1) }
    : { providerID: base.slice(0, slash), modelID: base.slice(slash + 1), variant };
}

export function toSessionModel(spec: string): { readonly providerID: string; readonly modelID: string } {
  const { providerID, modelID } = parseModelSpec(spec);
  return { providerID, modelID };
}
`;

export const REVIEWER_TASKS: readonly EvalTask[] = [
  reviewerTask({
    id: "rev-clean-personal-script-v2", category: "clean-review", language: "python",
    spec: { defects: [], excluded: [], bounce: false },
    request: "Please do a static review of {range} in {repo}. This is my personal script for listing journal entries. Look for regressions in how it selects and prints entries.",
    initial: {
      "journal.py": `from pathlib import Path


def entry_names(directory):
    return sorted(path.stem for path in directory.glob("*.txt") if path.is_file())


if __name__ == "__main__":
    for name in entry_names(Path.home() / "journal"):
        print(name)
`,
    },
    commits: [{
      message: "journal: Accept an optional entry directory",
      files: {
        "journal.py": `import argparse
from pathlib import Path


def entry_names(directory):
    return sorted(path.stem for path in directory.glob("*.txt") if path.is_file())


def main():
    parser = argparse.ArgumentParser(description="List journal entries by name.")
    parser.add_argument("directory", nargs="?", type=Path, default=Path.home() / "journal")
    args = parser.parse_args()
    for name in entry_names(args.directory):
        print(name)


if __name__ == "__main__":
    main()
`,
      },
    }],
  }),
  reviewerTask({
    id: "rev-soft-commit-range-no-filelist", category: "scope-calibration", language: "python",
    spec: {
      excluded: ["AGENTS.md"], bounce: false,
      defects: [{
        id: "swapped_indices", file: "modules/media.py", lineRange: [9, 25], minSeverity: 1,
        conceptGroups: [["index", "indices"], ["sort", "swap", "order", "revers", "flip", "duration"]],
        description: "Swapping the playback and duration indices sorts titles by duration instead of playback order.",
      }],
    },
    request: "Review {range} in {repo} for playlist regressions. Use the commit range to find the changed files. Exclude AGENTS.md and ignore all worktree changes.",
    initial: {
      "AGENTS.md": "# Playlist project\n\nPreserve playback order in playlist exports.\n",
      "modules/media.py": mediaOrder,
      "README.md": "# Playlist export\n",
    },
    commits: [
      {
        message: "docs: Describe playlist row fields",
        files: { "README.md": "# Playlist export\n\nEach row contains a title, playback index, and duration in seconds.\n" },
      },
      {
        message: "media: Reorder playlist field lookups",
        files: { "modules/media.py": mediaOrder.replace("playback_index = 1\n    duration_index = 2", "playback_index = 2\n    duration_index = 1") },
      },
      {
        message: "media: Export titles as plain text",
        files: { "modules/export.py": `from .media import ordered_titles


def render_playlist(rows):
    return "\\n".join(ordered_titles(rows))
` },
      },
    ],
    dirty: { "AGENTS.md": "# Playlist project\n\nUse playback order in playlist exports.\n\nKeep exported titles as plain text.\n" },
  }),
  reviewerTask({
    id: "rev-missing-scope-true-bounce", category: "scope-calibration", language: "python",
    spec: { defects: [], excluded: [], bounce: true },
    request: "Review my recent refactor in {repo} for regressions.",
    initial: { "inventory.py": "def count_items(items):\n    return sum(len(batch) for batch in items)\n" },
    commits: [{
      message: "inventory: Clarify the batch parameter",
      files: { "inventory.py": "def count_items(batches):\n    return sum(len(batch) for batch in batches)\n" },
    }],
  }),
  reviewerTask({
    id: "rev-ts-redirect-leak-and-antislop", category: "standards-review", language: "typescript",
    spec: {
      excluded: ["src/legacy_openai.ts"], bounce: false,
      defects: [
        {
          id: "redirect_policy", file: "src/google.ts", lineRange: [11, 14], minSeverity: 1,
          conceptGroups: [
            ["redirect"],
            ["key", "credential", "header", "auth"],
            ["origin", "host", "domain", "third-party", "external", "server", "target"],
          ],
          description: "Following redirects can forward the custom API key header to another origin.",
        },
        {
          id: "decoder_standards", file: "src/types.ts", lineRange: [3, 10], minSeverity: 3,
          conceptGroups: [
            ["typeof", "assert", "assertion", "cast", "as SearchResponse"],
            ["safety", "anti-slop", "project", "AGENTS", "forbid", "prohibit", "avoid", "disallow", "violat", "standard", "rule"],
          ],
          description: "The decoder uses runtime typeof and an unannotated type assertion against the project standards.",
        },
      ],
    },
    request: "Review {range} in {repo} for search client regressions and violations of AGENTS.md. Exclude src/legacy_openai.ts from the review.",
    initial: {
      "AGENTS.md": TS_FILES["AGENTS.md"],
      "src/google.ts": googleClient,
      "src/types.ts": `export interface SearchResponse { readonly title: string }

export function decodeSearchResponse(text: string): SearchResponse {
  const payload = JSON.parse(text);
  const title = payload?.title;
  if (String(title) !== title) throw new TypeError("Expected a title");
  return { title };
}
`,
      "src/legacy_openai.ts": "export const legacyModel = \"archive-v1\";\n",
    },
    commits: [{
      message: "search: Follow redirects and update response decoding",
      files: {
        "src/google.ts": googleClient.replace('redirect: "error"', 'redirect: "follow"'),
        "src/types.ts": `export interface SearchResponse { readonly title: string }

export function decodeSearchResponse(text: string): SearchResponse {
  const payload = JSON.parse(text) as SearchResponse | null;
  const title = payload?.title;
  if (typeof title !== "string") throw new TypeError("Expected a title");
  return { title };
}
`,
        "src/legacy_openai.ts": `export const legacyModel = "archive-v2";
export const maxPromptLength = "4096" as string;
`,
      },
    }],
  }),
  reviewerTask({
    id: "rev-py-cache-discard-and-monkeypatch", category: "standards-review", language: "python",
    spec: {
      excluded: [], bounce: false,
      defects: [
        {
          id: "cache_discard", file: "modules/gemini.py", lineRange: [23, 28], minSeverity: 2,
          conceptGroups: [
            ["cache"],
            ["discard", "delete", "unlink", "destroy", "remove"],
            ["oserror", "permission", "filesystem", "read error", "unreadable", "i/o"],
          ],
          description: "The cache recovery path deletes the original file after filesystem errors that do not imply corruption.",
        },
        {
          id: "internal_monkeypatch", file: "tests/test_e2e_pipeline.py", lineRange: [22, 23], minSeverity: 2,
          conceptGroups: [["patch"], ["_call_model", "internal"], ["transport", "AGENTS", "public", "boundary", "interface", "summarize"]],
          description: "The end-to-end test patches the internal model helper instead of supplying a fake transport.",
        },
      ],
    },
    request: "Review {range} in {repo} for cache regressions and conformance to the project's test rules in AGENTS.md.",
    initial: {
      "AGENTS.md": "# Test boundaries\n\nTest through the public interface. Do not patch internal functions such as `_call_model`. Fake the transport boundary instead.\n",
      "modules/gemini.py": cacheClient,
      "tests/test_e2e_pipeline.py": `from modules.gemini import summarize


class FakeTransport:
    def generate(self, prompt):
        return "short summary"


def test_summarizes_on_cache_miss(tmp_path):
    cache = tmp_path / "summary.json"
    assert summarize("notes", cache, FakeTransport()) == "short summary"
`,
    },
    commits: [{
      message: "cache: Rebuild unreadable summaries and exercise recovery",
      files: {
        "modules/gemini.py": cacheClient.replace("except json.JSONDecodeError:", "except (OSError, json.JSONDecodeError):"),
        "tests/test_e2e_pipeline.py": `from unittest.mock import patch

from modules.gemini import summarize


class FakeTransport:
    def generate(self, prompt):
        return "short summary"


def test_summarizes_on_cache_miss(tmp_path):
    cache = tmp_path / "summary.json"
    assert summarize("notes", cache, FakeTransport()) == "short summary"


def test_rebuilds_corrupt_cache(tmp_path):
    cache = tmp_path / "summary.json"
    cache.write_text("{", encoding="utf-8")
    prompt = "meeting notes"
    expected = "short summary"

    with patch("modules.gemini._call_model", return_value=expected):
        assert summarize(prompt, cache, None) == expected

    assert summarize(prompt, cache, None) == expected
`,
      },
    }],
  }),
  reviewerTask({
    id: "rev-py-ytdlp-thread-leak-and-ratelimit", category: "regression-review", language: "python",
    spec: {
      excluded: [], bounce: false,
      defects: [
        {
          id: "thread_timeout", file: "app/preview.py", lineRange: [5, 10], minSeverity: 2,
          conceptGroups: [
            ["thread"], ["timeout", "cancel"],
            ["continue", "running", "run", "hang", "stop", "leak", "release", "block", "alive", "background", "terminat", "exit"],
          ],
          description: "The coroutine times out without stopping yt-dlp in the background worker thread.",
        },
        {
          id: "quota_before_validation", file: "app/main.py", lineRange: [22, 27], minSeverity: 2,
          conceptGroups: [
            ["quota", "slot", "rate limit", "rate-limit", "budget"], ["oversized", "length", "4096", "too long", "max_input"],
          ],
          description: "Oversized input uses a quota slot even though submission is rejected.",
        },
      ],
    },
    request: "Review {range} in {repo} for regressions in video previews and text submission.",
    initial: { "app/preview.py": previewWorker, "app/main.py": quotaApp },
    commits: [{
      message: "app: Time out previews and reorder submission checks",
      files: {
        "app/preview.py": previewWorker.replace(
          "return await asyncio.to_thread(_extract_title, video_id)",
          "return await asyncio.wait_for(asyncio.to_thread(_extract_title, video_id), timeout=3)",
        ),
        "app/main.py": quotaApp.replace(
          "    if len(text) > MAX_INPUT:\n        return 413\n    if not quota.take_slot(now):\n        return 429",
          "    if not quota.take_slot(now):\n        return 429\n    if len(text) > MAX_INPUT:\n        return 413",
        ),
      },
    }],
  }),
  reviewerTask({
    id: "rev-mixed-committed-plus-worktree", category: "scope-calibration", language: "mixed",
    spec: {
      excluded: [], bounce: false,
      defects: [{
        id: "manifest_bytes", file: "output.json", lineRange: [1, 4], minSeverity: 1,
        conceptGroups: [
          ["byte", "whitespace", "format", "indent", "pretty"],
          ["head", "commit", "worktree", "working tree", "working-tree", "uncommitted", "unstaged", "dirty", "modified"],
        ],
        description: "The working-tree manifest has the same data as HEAD but its pretty formatting breaks byte equality.",
      }],
    },
    request: "Review both the committed changes ({range}) and the tracked working-tree changes against {head} in {repo}. Check the release diff against the rules in AGENTS.md.",
    initial: {
      "AGENTS.md": "# Release manifest\n\nCommit the compact output from build.py. Keep output.json byte-identical to that generated manifest in the release worktree.\n",
      "build.py": buildScript,
      "output.json": '{"assets":["styles.css"]}\n',
      "index.html": "<!doctype html>\n<html lang=\"en\">\n<title>Asset catalog</title>\n<p>Asset catalog</p>\n",
    },
    commits: [{
      message: "build: Include the entry page in the manifest",
      files: {
        "build.py": buildScript.replace('["styles.css"]', '["styles.css", "index.html"]'),
        "output.json": '{"assets":["styles.css","index.html"]}\n',
      },
    }],
    dirty: {
      "index.html": "<!doctype html>\n<html lang=\"en\">\n<title>Asset catalog</title>\n<h1>Asset catalog</h1>\n",
      "output.json": '{\n  "assets": [\n    "styles.css",\n    "index.html"\n  ]\n}\n',
    },
    includeWorktree: true,
  }),
  reviewerTask({
    id: "rev-calibration-trap-clean-idiomatic", category: "clean-review", language: "python",
    spec: { defects: [], excluded: [], bounce: false },
    request: "Review {range} in {repo} for regressions. This Linux-only CLI reads trusted local CSV exports. Use CONTEXT.md for its input and path contract.",
    initial: {
      "modules/media.py": csvReader,
      "modules/cli.py": `import argparse
from pathlib import Path

from .media import read_titles


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("csv", type=Path)
    args = parser.parse_args(argv)
    for title in read_titles(args.csv):
        print(title)


if __name__ == "__main__":
    main()
`,
      "CONTEXT.md": "# Media export\n\nRun on Linux. Pass the path to a trusted UTF-8 CSV with a title column.\n",
      "tests/test_media.py": `from modules.media import read_titles


def test_quoted_title(tmp_path):
    path = tmp_path / "media.csv"
    path.write_text('title\\n"Blue, green"\\n', encoding="utf-8")
    assert read_titles(path) == ["Blue, green"]
`,
    },
    commits: [{
      message: "media: Read local exports with native paths and CSV newlines",
      files: {
        "modules/media.py": csvReader.replace('encoding="utf-8"', 'encoding="utf-8", newline=""'),
        "modules/cli.py": `import argparse
from pathlib import Path

from .media import read_titles


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("csv", type=Path, nargs="?", default=Path("media.csv"))
    args = parser.parse_args(argv)
    for title in read_titles(args.csv):
        print(title)


if __name__ == "__main__":
    main()
`,
        "CONTEXT.md": `# Media export

Run on Linux. Pass the path to a trusted UTF-8 CSV with a title column.
If you omit the path, read media.csv from the current directory.
Relative paths stay relative to the current directory.
Quoted titles can contain commas and embedded newlines.
`,
        "tests/test_media.py": `from modules.media import read_titles


def test_quoted_title(tmp_path):
    path = tmp_path / "media.csv"
    path.write_bytes(b'title\\r\\n"Blue, green\\r\\nred"\\r\\n')
    assert read_titles(path) == ["Blue, green\\r\\nred"]
`,
      },
    }],
  }),
  reviewerTask({
    id: "rev-py-denylist-bandaid-rewrite", category: "architecture-review", language: "python",
    spec: {
      excluded: [], bounce: false,
      defects: [{
        id: "denylist_shell_rewrite", file: "app/git_preview.py", lineRange: [3, 18], minSeverity: 1,
        conceptGroups: [
          ["denylist", "deny-list", "blocklist", "block-list", "blacklist", "blocked", "shell=true", "shell injection", "command injection"],
          [
            "bypass", "newline", "\\n", "flag", "--no-index", "quote", "interpolat", "concatenat",
            "fundamental", "symptom", "band-aid", "whack-a-mole", "fragile", "brittle", "insufficient",
            "command separator", "does not block", "option parsing disabled",
          ],
          ["allowlist", "allow-list", "whitelist", "shell=false", "argument list", "argument vector", "argv", "list of arguments", "sequence of arguments", "without a shell", "without shell"],
        ],
        description: "Extending a substring denylist on a shell=True git command remains trivially bypassable; replace it with strict revision allowlisting and direct argument-list execution without a shell.",
      }],
    },
    request: "Review {range} in {repo} for security and design flaws. preview_diff runs on an HTTP preview service where repo is a trusted local Path and revision_spec is an untrusted query parameter.",
    initial: {
      "app/git_preview.py": `import subprocess

BLOCKED = (";", "&&", "||", "|", "\`", "$(")


def preview_diff(repo, revision_spec):
    """Return a read-only git diff for an untrusted revision_spec query string."""
    raw = revision_spec.strip()
    if not raw or any(token in raw for token in BLOCKED):
        raise ValueError("unsafe revision spec")
    completed = subprocess.run(
        f'git -C "{repo}" diff --no-ext-diff --no-textconv {raw}',
        shell=True,
        check=True,
        capture_output=True,
        text=True,
    )
    return completed.stdout
`,
    },
    commits: [{
      message: "security: Block redirections and output flags in preview_diff",
      files: {
        "app/git_preview.py": `import subprocess

BLOCKED = (";", "&&", "||", "|", "\`", "$(", ">", "<", "--output", "--ext-diff")


def preview_diff(repo, revision_spec):
    """Return a read-only git diff for an untrusted revision_spec query string."""
    raw = revision_spec.strip()
    if not raw or any(token in raw for token in BLOCKED):
        raise ValueError("unsafe revision spec")
    completed = subprocess.run(
        f'git -C "{repo}" diff --no-ext-diff --no-textconv {raw}',
        shell=True,
        check=True,
        capture_output=True,
        text=True,
    )
    return completed.stdout
`,
      },
    }],
  }),
  reviewerTask({
    id: "rev-ts-tautological-and-inverted-test", category: "standards-review", language: "typescript",
    spec: {
      excluded: [], bounce: false,
      defects: [
        {
          id: "catalog_id_mismatch", file: "src/models.ts", lineRange: [44, 54], minSeverity: 1,
          conceptGroups: [
            ["wiremodel", "wire model", "wire name"],
            ["entry.id", ".id", "`id`", " id", "identifier", "tosessionmodel", "session model", "alias"],
          ],
          description: "validateCatalogSpecs matches entry.wireModel instead of entry.id, diverging from the modelID passed by toSessionModel.",
        },
        {
          id: "tautological_and_inverted_tests", file: "tests/models.test.ts", lineRange: [17, 36], minSeverity: 3,
          conceptGroups: [
            ["tautolog", "copy", "duplicat", "change-detector", "literal", "verbatim", "hardcod", "default_models", "invert", "mirror", "enshrin", "circular", "wiremodel"],
            ["test", "agents", "contract", "behavior", "public", "interface", "tosessionmodel", "assert", "bug", "wrong", "spec"],
          ],
          description: "tests/models.test.ts duplicates DEFAULT_MODELS verbatim as a tautological assertion and enshrines the inverted wireModel lookup bug.",
        },
      ],
    },
    request: "Review {range} in {repo} for catalog validation regressions and conformance to the testing rules in AGENTS.md.",
    initial: {
      "AGENTS.md": `${TS_FILES["AGENTS.md"]}Do not write tautological or change-detector tests that duplicate exported constants or mirror implementation bugs.\n`,
      "src/models.ts": catalogModelModule,
      "tests/models.test.ts": `import { expect, test } from "bun:test";

import { parseModelSpec, toSessionModel } from "../src/models.ts";

test("extracts provider, model ID, and optional variant", () => {
  expect(parseModelSpec("openai/gpt-fast#medium")).toEqual({
    providerID: "openai",
    modelID: "gpt-fast",
    variant: "medium",
  });
  expect(toSessionModel("openai/gpt-fast#medium")).toEqual({
    providerID: "openai",
    modelID: "gpt-fast",
  });
});
`,
    },
    commits: [{
      message: "models: Add catalog validation and model list tests",
      files: {
        "src/models.ts": `${catalogModelModule}
export function validateCatalogSpecs(specs: readonly string[], providers: readonly CatalogProvider[]): void {
  for (const spec of specs) {
    const parsed = parseModelSpec(spec);
    const provider = providers.find((entry) => entry.id === parsed.providerID);
    if (!provider) throw new Error(\`Unknown provider: \${parsed.providerID}\`);
    const model = provider.models.find((entry) => entry.wireModel === parsed.modelID);
    if (!model) throw new Error(\`Unknown model: \${parsed.providerID}/\${parsed.modelID}\`);
    if (parsed.variant !== undefined && !model.variants.includes(parsed.variant)) {
      throw new Error(\`Unknown variant: \${parsed.variant}\`);
    }
  }
}
`,
        "tests/models.test.ts": `import { expect, test } from "bun:test";

import { DEFAULT_MODELS, parseModelSpec, toSessionModel, validateCatalogSpecs } from "../src/models.ts";

test("extracts provider, model ID, and optional variant", () => {
  expect(parseModelSpec("openai/gpt-fast#medium")).toEqual({
    providerID: "openai",
    modelID: "gpt-fast",
    variant: "medium",
  });
  expect(toSessionModel("openai/gpt-fast#medium")).toEqual({
    providerID: "openai",
    modelID: "gpt-fast",
  });
});

test("keeps default model specs", () => {
  expect(DEFAULT_MODELS).toEqual([
    "openai/gpt-fast#medium",
    "anthropic/claude-core#high",
    "google/gemini-pro#medium",
  ]);
});

test("validates model specs against catalog entries", () => {
  const providers = [
    {
      id: "openai",
      models: [
        { id: "gpt-fast", wireModel: "gpt-wire-v1", variants: ["medium"] },
      ],
    },
  ];
  expect(() => validateCatalogSpecs(["openai/gpt-wire-v1#medium"], providers)).not.toThrow();
  expect(() => validateCatalogSpecs(["openai/gpt-fast#medium"], providers)).toThrow(/Unknown model/u);
});
`,
      },
    }],
  }),
  reviewerTask({
    id: "rev-py-clean-security-rewrite-restraint", category: "clean-review", language: "python",
    spec: { defects: [], excluded: [], bounce: false },
    request: "Review {range} in {repo} for security flaws and regressions. Use CONTEXT.md for the service trust boundary and contract.",
    initial: {
      "CONTEXT.md": `# Git preview service

\`preview_diff(repo, base, head)\` renders a read-only unified diff for an internal HTTP preview service running on Linux.

## Trust boundary

- \`repo\` is a trusted, service-owned absolute \`Path\` to a mirror maintained by the service.
- Service mirrors disable Git hooks, fsmonitor, external diff drivers, textconv filters, and replace objects in host configuration.
- \`base\` and \`head\` are untrusted HTTP query strings and must be full 40-character lowercase hexadecimal commit SHAs.
- Empty strings, branch names, refspecs, flags, and uppercase or short SHAs are rejected with \`ValueError\`.
- Callers translate \`subprocess.CalledProcessError\` and \`subprocess.TimeoutExpired\` into HTTP 404/504 responses.
`,
      "app/git_preview.py": `import subprocess

BLOCKED = (";", "&&", "||", "|", "\`", "$(")


def preview_diff(repo, base, head):
    """Return a read-only git diff between two commit SHAs."""
    for value in (base, head):
        if not value or any(token in value for token in BLOCKED):
            raise ValueError("unsafe revision")
    completed = subprocess.run(
        f'git -C "{repo}" diff --no-ext-diff --no-textconv {base}..{head}',
        shell=True,
        check=True,
        capture_output=True,
        text=True,
    )
    return completed.stdout
`,
      "tests/test_git_preview.py": `import pytest

from app.git_preview import preview_diff


def test_preview_diff_rejects_shell_metacharacters(tmp_path):
    with pytest.raises(ValueError):
        preview_diff(tmp_path, "a" * 40, f"{'b' * 40};id")
`,
    },
    commits: [{
      message: "security: Replace shell denylist with SHA allowlist and argv subprocess",
      files: {
        "app/git_preview.py": `import os
import re
import subprocess
from pathlib import Path

_SHA_RE = re.compile(r"[0-9a-f]{40}")


def _validate_sha(value: str, label: str) -> str:
    if not isinstance(value, str) or not _SHA_RE.fullmatch(value):
        raise ValueError(f"invalid {label} commit SHA")
    return value


def preview_diff(repo: Path | str, base: str, head: str) -> str:
    """Return a read-only git diff between two validated commit SHAs."""
    base_sha = _validate_sha(base, "base")
    head_sha = _validate_sha(head, "head")
    completed = subprocess.run(
        [
            "git",
            "-C",
            os.fspath(repo),
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            f"{base_sha}..{head_sha}",
            "--",
        ],
        shell=False,
        stdin=subprocess.DEVNULL,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=10,
    )
    return completed.stdout
`,
        "tests/test_git_preview.py": `import subprocess

import pytest

from app.git_preview import preview_diff


def _git(repo, *args):
    completed = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return completed.stdout.strip()


def test_preview_diff_returns_diff_for_valid_shas(tmp_path):
    _git(tmp_path, "init", "--initial-branch=main")
    _git(tmp_path, "config", "user.name", "Test")
    _git(tmp_path, "config", "user.email", "test@example.invalid")
    target = tmp_path / "notes.txt"
    target.write_text("before\\n", encoding="utf-8")
    _git(tmp_path, "add", "notes.txt")
    _git(tmp_path, "-c", "commit.gpgsign=false", "commit", "-m", "initial")
    base = _git(tmp_path, "rev-parse", "HEAD")

    target.write_text("after\\n", encoding="utf-8")
    _git(tmp_path, "add", "notes.txt")
    _git(tmp_path, "-c", "commit.gpgsign=false", "commit", "-m", "update")
    head = _git(tmp_path, "rev-parse", "HEAD")

    diff = preview_diff(tmp_path, base, head)
    assert "-before" in diff
    assert "+after" in diff


@pytest.mark.parametrize(
    "bad_sha",
    [
        "",
        "abc123",
        "A" * 40,
        f"{'a' * 40}\\n",
        "--output=leak.txt",
        f"{'a' * 40};id",
    ],
)
def test_preview_diff_rejects_invalid_shas(tmp_path, bad_sha):
    valid = "a" * 40
    with pytest.raises(ValueError):
        preview_diff(tmp_path, bad_sha, valid)
    with pytest.raises(ValueError):
        preview_diff(tmp_path, valid, bad_sha)
`,
      },
    }],
  }),
];
