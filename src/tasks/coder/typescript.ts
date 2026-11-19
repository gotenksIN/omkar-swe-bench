import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSync, Visitor } from "oxc-parser";

import type { Evidence } from "../../graders/types.ts";
import { assertNoSymlinkBoundary } from "../../util/fs.ts";
import {
  buildCoderGradeResult, checksTypeScript, runFixtureCheck, setupCoderFixture, TS_FILES,
  type EvalTask, type FixtureFiles,
} from "../base.ts";

interface TypeScriptTask {
  readonly id: string;
  readonly category: string;
  readonly timeoutSeconds?: number;
  readonly files: FixtureFiles;
  readonly scope: readonly string[];
  readonly prompt: string;
  readonly check: string;
  readonly probe: string;
  readonly checkSource?: (repoDir: string) => Promise<boolean>;
}

function typeScriptTask({
  id, category, timeoutSeconds = 240, files, scope, prompt, check, probe, checkSource,
}: TypeScriptTask): EvalTask {
  return {
    id, category, role: "coder", language: "typescript", timeoutSeconds,
    commitGuard: false, readOnlyRepo: false, needsTsCompiler: true, needsRuff: false,
    setupRepo: (repoDir) => setupCoderFixture(repoDir, { ...TS_FILES, ...files },
      `${prompt.trim()}\n\nEdit only ${scope.join(", ")} and tests/**/*.test.ts. Do not stage or commit.\n` +
      "Run `bun test` and `tsc --noEmit` after your edits."),
    async grade(ev: Evidence) {
      const [common, behavior, source] = await Promise.all([
        checksTypeScript(ev, new Set(scope)),
        runFixtureCheck(ev.repoDir, "bun", ["--no-env-file", "run", "-"], probe),
        checkSource?.(ev.repoDir) ?? true,
      ]);

      return buildCoderGradeResult({ ...common, [check]: behavior && source }, [], { timedOut: ev.timedOut });
    },
  };
}

export const sseChunkCrlf = typeScriptTask({
  id: "coder-ts-sse-chunk-crlf",
  category: "framing",
  scope: ["src/sse.ts", "src/merge.ts"],
  prompt: `
Fix parseSSE so it frames events across arbitrary byte chunks, including split UTF-8 and CRLF.
Join multiple data lines with a newline and strip at most one space after the colon.
Ignore non-data fields and discard events without a final blank line.
Keep sparse part indices in mergeChunk. In citedText, interpret start and end as UTF-8 byte offsets
into the selected part. Add tests through the existing exports.
`,
  files: {
    "src/sse.ts": String.raw`export async function* parseSSE(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  for await (const chunk of chunks) {
    for (const event of decoder.decode(chunk).split("\n\n")) {
      const line = event.split("\n").find((field) => field.startsWith("data:"));
      if (line) yield line.slice(5).trim();
    }
  }
}
`,
    "src/merge.ts": `interface Part {
  readonly index: number;
  readonly text: string;
}

export function mergeChunk(parts: string[], chunk: readonly Part[]): void {
  for (const part of chunk) parts.push(part.text);
}

export function citedText(parts: readonly string[], part: number, start: number, end: number): string {
  return parts[part]?.slice(start, end) ?? "";
}
`,
    "tests/sse.test.ts": String.raw`import { expect, test } from "bun:test";
import { parseSSE } from "../src/sse.ts";

test("joins data lines within one event", async () => {
  async function* chunks() {
    yield new TextEncoder().encode("data: first\ndata: second\n\n");
  }
  expect(await Array.fromAsync(parseSSE(chunks()))).toEqual(["first\nsecond"]);
});
`,
  },
  check: "framing_and_sparse_citations",
  probe: String.raw`
import assert from "node:assert/strict";
import { parseSSE } from "./src/sse.ts";
import { mergeChunk, citedText } from "./src/merge.ts";

const wire = new TextEncoder().encode(":heartbeat\r\nid: 1\r\ndata: café🙂\r\ndata:  next \r\n\r\ndata:\n\n" +
  "data: final\n\n" + "data: incomplete\r\n");
for (const size of [1, 2, 3, 7, 64]) {
  async function* chunks() {
    for (let index = 0; index < wire.length; index += size) yield wire.slice(index, index + size);
  }
  assert.deepEqual(await Array.fromAsync(parseSSE(chunks())), ["café🙂\n next ", "", "final"]);
}
const parts: string[] = [];
mergeChunk(parts, [{ index: 5, text: "π🙂tail" }, { index: 1, text: "other" }]);
mergeChunk(parts, [{ index: 5, text: "!" }]);
assert.equal(parts[1], "other");
assert.equal(parts[2], undefined);
assert.equal(parts[5], "π🙂tail!");
assert.equal(citedText(parts, 5, 2, 6), "🙂");
assert.equal(citedText(parts, 5, 6, 10), "tail");
`,
});

export const shellHeredocSubst = typeScriptTask({
  id: "coder-ts-shell-heredoc-subst",
  category: "parser",
  timeoutSeconds: 300,
  scope: ["src/shell.ts", "src/validator.ts"],
  prompt: `
Inspect shell text without evaluating or executing it.
In tokenizeShell, return the raw body of each outermost command substitution as a substitution token.
Keep parentheses and dollar signs in heredoc bodies from changing substitution boundaries.
Support quoted and unquoted delimiters, tab stripping with <<-, and backslash-newline folding
when matching unquoted delimiters. Keep raw source text unchanged in emitted tokens.
In inspectSubstitutions, return outer and nested executable substitution bodies in preorder,
but do not treat heredoc data or quoted literals as executable substitutions.
Do not interpret arithmetic shifts in ((1 << 2)) or $((1 << 2)) as heredocs.
Add text-only tests.
`,
  files: {
    "src/shell.ts": String.raw`export interface Substitution {
  readonly kind: "substitution";
  readonly text: string;
}

export function tokenizeShell(source: string): Substitution[] {
  return Array.from(source.matchAll(/\$\(([^)]*)\)/gu), (match) => ({
    kind: "substitution", text: match[1] ?? "",
  }));
}
`,
    "src/validator.ts": `import { tokenizeShell } from "./shell.ts";

export function inspectSubstitutions(source: string): string[] {
  return tokenizeShell(source).map(({ text }) => text);
}
`,
    "tests/shell.test.ts": String.raw`import { expect, test } from "bun:test";
import { inspectSubstitutions } from "../src/validator.ts";

test("skips parentheses in heredoc data", () => {
  const body = "cat <<'EOF'\n)\nEOF\n";
  expect(inspectSubstitutions("echo $(" + body + ")")).toEqual([body]);
});
`,
  },
  check: "heredoc_boundaries",
  probe: String.raw`
import assert from "node:assert/strict";
import { tokenizeShell } from "./src/shell.ts";
import { inspectSubstitutions } from "./src/validator.ts";

const cases = [
  { body: "cat <<'END'\n) $(data)\nEN\\\nD\nEND\nprintf ok", nested: [] },
  { body: "cat <<END\n) $(data)\nEN\\\nD\nprintf $(inner)", nested: ["inner"] },
  { body: "cat <<-END\n\t) $(data)\n\tEND\nprintf $(other)", nested: ["other"] },
  { body: " ((1 << 2)); echo $((1 << 2)); echo $(outer $(inner))", nested: ["outer $(inner)", "inner"] },
  { body: "printf '%s' '$(literal)' \"$(within)\"", nested: ["within"] },
];
for (const { body, nested } of cases) {
  const source = "printf %s \"$(" + body + ")\" $(after)";
  assert.deepEqual(tokenizeShell(source), [
    { kind: "substitution", text: body }, { kind: "substitution", text: "after" },
  ]);
  assert.deepEqual(inspectSubstitutions(source), [body, ...nested, "after"]);
}
`,
});

async function decoderSourcePasses(repoDir: string): Promise<boolean> {
  try {
    const path = join(repoDir, "src/decoder.ts");

    assertNoSymlinkBoundary(path);

    const { program, errors } = parseSync(path, await readFile(path, "utf8"), { lang: "ts", sourceType: "module" });

    if (errors.length > 0) return false;

    let forbidden = false;
    let formatter: { start: number; end: number } | undefined;
    const switches: { start: number; end: number }[] = [];

    new Visitor({
      FunctionDeclaration(node) {
        if (node.id?.name === "formatEvent") formatter = node;
      },
      VariableDeclarator(node) {
        if (node.id.type === "Identifier" && node.id.name === "formatEvent") formatter = node;
      },
      TSAsExpression(node) {
        const isConst = node.typeAnnotation.type === "TSTypeReference"
          && node.typeAnnotation.typeName.type === "Identifier"
          && node.typeAnnotation.typeName.name === "const";

        if (!isConst) forbidden = true;
      },
      TSTypeAssertion() { forbidden = true; },
      UnaryExpression(node) {
        if (node.operator === "typeof") forbidden = true;
      },
      SwitchStatement(node) {
        const value = node.discriminant;

        const usesKind = value.type === "Identifier" && value.name === "kind" ||
          value.type === "MemberExpression" && (value.computed
            ? value.property.type === "Literal" && value.property.value === "kind"
            : value.property.type === "Identifier" && value.property.name === "kind");

        if (!usesKind) return;

        const labels = new Set(node.cases.flatMap(({ test }) => test?.type === "Literal" ? [test.value] : []));

        if (labels.has("ready") && labels.has("error")) switches.push(node);
      },
    }).visit(program);

    const format = formatter;

    return !forbidden && format !== undefined && switches.some(({ start, end }) => start >= format.start && end <= format.end);
  } catch {
    return false;
  }
}

export const boundaryDecoderHttp = typeScriptTask({
  id: "coder-ts-boundary-decoder-http",
  category: "boundary-safety",
  scope: ["src/decoder.ts", "src/client.ts"],
  prompt: `
Validate JSON in decodeEvent before returning a ConfigEvent. Reject malformed JSON, non-objects,
unsupported kinds, ready ports outside the integer range 1..65535, and empty error messages.
Use predicates, not casts or runtime typeof. In formatEvent, use an exhaustive switch on event.kind:
format ready events as "Listening on <port>" and include event.message for error events.
Keep fetchEvent's URL interface, but reject non-2xx responses with an error that includes the HTTP
status. Validate successful response bodies with decodeEvent. Test HTTP behavior on loopback only.
`,
  files: {
    "src/decoder.ts": `export type ConfigEvent =
  | { readonly kind: "ready"; readonly port: number }
  | { readonly kind: "error"; readonly message: string };

export function decodeEvent(text: string): ConfigEvent {
  return JSON.parse(text);
}

export function formatEvent(event: ConfigEvent): string {
  return event.kind === "ready" ? "Listening on " + event.port : "Unknown error";
}
`,
    "src/client.ts": `import { decodeEvent, type ConfigEvent } from "./decoder.ts";

export async function fetchEvent(url: URL): Promise<ConfigEvent> {
  const response = await fetch(url);
  return decodeEvent(await response.text());
}
`,
    "tests/decoder.test.ts": `import { expect, test } from "bun:test";
import { decodeEvent } from "../src/decoder.ts";

test("rejects a non-numeric port", () => {
  expect(() => decodeEvent('{"kind":"ready","port":"80"}')).toThrow();
});
`,
  },
  check: "boundary_decoding_and_http",
  checkSource: decoderSourcePasses,
  probe: String.raw`
import assert from "node:assert/strict";
import { decodeEvent, formatEvent } from "./src/decoder.ts";
import { fetchEvent } from "./src/client.ts";

for (const port of [1, 8080, 65535]) {
  assert.deepEqual(decodeEvent(JSON.stringify({ kind: "ready", port })), { kind: "ready", port });
}
for (const input of [
  "{", "null", "[]", "true", "42", '"ready"', "{}", '{"kind":"unknown"}',
  '{"kind":"ready"}', '{"kind":"ready","port":0}', '{"kind":"ready","port":65536}',
  '{"kind":"ready","port":"80"}', '{"kind":"ready","port":80.5}', '{"kind":"ready","port":true}',
  '{"kind":"error","message":""}', '{"kind":"error","message":42}',
]) {
  assert.throws(() => decodeEvent(input));
}
assert.deepEqual(decodeEvent('{"kind":"error","message":"offline"}'), { kind: "error", message: "offline" });
assert.equal(formatEvent({ kind: "ready", port: 8080 }), "Listening on 8080");
assert.match(formatEvent({ kind: "error", message: "offline" }), /offline/u);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    switch (new URL(request.url).pathname) {
      case "/ok": return Response.json({ kind: "ready", port: 8080 });
      case "/bad-json": return new Response("{");
      case "/bad-event": return Response.json({ kind: "ready", port: 0 });
      case "/fail": return Response.json({ kind: "ready", port: 8080 }, { status: 503 });
      default: return new Response(null, { status: 404 });
    }
  },
});
try {
  assert.deepEqual(await fetchEvent(new URL("/ok", server.url)), { kind: "ready", port: 8080 });
  await assert.rejects(() => fetchEvent(new URL("/bad-json", server.url)));
  await assert.rejects(() => fetchEvent(new URL("/bad-event", server.url)));
  await assert.rejects(() => fetchEvent(new URL("/fail", server.url)), /503/u);
} finally {
  await server.stop(true);
}
`,
});
