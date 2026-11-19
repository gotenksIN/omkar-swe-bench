import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseSync, Visitor, type Expression } from "oxc-parser";

import type { CheckOutcomes, Evidence } from "../../graders/types.ts";
import { assertNoSymlinkBoundary } from "../../util/fs.ts";
import { isString } from "../../util/json.ts";
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
  readonly extraChecks?: (ev: Evidence, common: CheckOutcomes) => Promise<CheckOutcomes>;
}

function typeScriptTask({
  id, category, timeoutSeconds = 240, files, scope, prompt, check, probe, checkSource, extraChecks,
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

      const extra = extraChecks ? await extraChecks(ev, common) : {};

      return buildCoderGradeResult({ ...common, [check]: behavior && source, ...extra }, [], { timedOut: ev.timedOut });
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
Keep sparse part indices in mergeChunk, appending incoming text to any existing text at the same index.
In citedText, interpret start and end as UTF-8 byte offsets into the selected part. Add tests through the existing exports.
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

const DEFAULT_MODEL_LITERALS = new Set([
  "openai/gpt-fast#medium",
  "openrouter/anthropic/claude-core#high",
  "google/gemini-pro#medium",
]);

const MODEL_MUTANT_WRAPPERS: readonly string[] = [
  `export * from "./models.impl.ts";
import * as impl from "./models.impl.ts";

export function validateModels(specs: readonly string[], providers: readonly impl.CatalogProvider[]): void {
  const swapped = providers.map((provider) => ({
    ...provider,
    models: provider.models.map((model) => ({ ...model, id: model.wireModel })),
  }));

  impl.validateModels(specs, swapped);
}
`,
  `export * from "./models.impl.ts";
import * as impl from "./models.impl.ts";

export function validateModels(specs: readonly string[], providers: readonly impl.CatalogProvider[]): void {
  const allEnabled = providers.map((provider) => ({
    ...provider,
    models: provider.models.map((model) => ({ ...model, enabled: true })),
  }));

  impl.validateModels(specs, allEnabled);
}
`,
  `export * from "./models.impl.ts";
import * as impl from "./models.impl.ts";

function rejectMultiSlash(spec: string): void {
  const parsed = impl.parseModelSpec(spec);

  if (parsed.modelID.includes("/")) throw new Error(\`Invalid model spec: \${spec}\`);
}

export function parseModelSpec(spec: string): impl.ModelSpec {
  rejectMultiSlash(spec);

  return impl.parseModelSpec(spec);
}

export function toSessionModel(spec: string): { readonly providerID: string; readonly modelID: string } {
  rejectMultiSlash(spec);

  return impl.toSessionModel(spec);
}

export function validateModels(specs: readonly string[], providers: readonly impl.CatalogProvider[]): void {
  for (const spec of specs) rejectMultiSlash(spec);

  impl.validateModels(specs, providers);
}
`,
];

async function collectTsFiles(rootDir: string, relativeDir: string): Promise<string[]> {
  const fullDir = join(rootDir, relativeDir);

  assertNoSymlinkBoundary(fullDir, rootDir);

  const files: string[] = [];

  try {
    for (const entry of await readdir(fullDir, { withFileTypes: true })) {
      const relPath = `${relativeDir}/${entry.name}`;

      if (entry.isSymbolicLink()) throw new Error(`Symlink not allowed in tests: ${relPath}`);

      if (entry.isDirectory()) {
        files.push(...await collectTsFiles(rootDir, relPath));
      } else if (entry.isFile() && /\.tsx?$/u.test(entry.name)) {
        files.push(relPath);
      }
    }
  } catch (cause) {
    if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") throw cause;
  }

  return files;
}

function unwrapExpression(expression: Expression): Expression {
  let current = expression;

  while (
    current.type === "ParenthesizedExpression"
    || current.type === "TSAsExpression"
    || current.type === "TSTypeAssertion"
    || current.type === "TSSatisfiesExpression"
  ) {
    current = current.expression;
  }

  return current;
}

function isDefaultModelsRef(expression: Expression): boolean {
  const expr = unwrapExpression(expression);

  if (expr.type === "Identifier") return expr.name === "DEFAULT_MODELS";

  if (expr.type === "ArrayExpression" && expr.elements.length === 1) {
    const first = expr.elements[0];

    return first?.type === "SpreadElement" && isDefaultModelsRef(first.argument);
  }

  if (
    expr.type === "CallExpression"
    && expr.callee.type === "MemberExpression"
    && !expr.callee.computed
    && expr.callee.object.type === "Identifier"
    && expr.callee.object.name === "Array"
    && expr.callee.property.type === "Identifier"
    && expr.callee.property.name === "from"
    && expr.arguments[0]
    && expr.arguments[0].type !== "SpreadElement"
  ) {
    return isDefaultModelsRef(expr.arguments[0]);
  }

  return false;
}

function isDefaultModelsIndexAccess(expression: Expression): boolean {
  const expr = unwrapExpression(expression);

  return expr.type === "MemberExpression" && isDefaultModelsRef(expr.object);
}

function isStringArrayLiteral(expression: Expression, literalArrayNames: ReadonlySet<string>): boolean {
  const expr = unwrapExpression(expression);

  if (expr.type === "Identifier") return literalArrayNames.has(expr.name);

  if (expr.type !== "ArrayExpression" || expr.elements.length === 0) return false;

  return expr.elements.every((el) => {
    if (el === null || el.type === "SpreadElement") return false;

    const item = unwrapExpression(el);

    return item.type === "Literal" && isString(item.value);
  });
}

function defaultModelLiteralValue(expression: Expression): string | null {
  const expr = unwrapExpression(expression);

  return expr.type === "Literal" && isString(expr.value) && DEFAULT_MODEL_LITERALS.has(expr.value)
    ? expr.value
    : null;
}

function hasTautologicalDefaultModelsTest(path: string, source: string): boolean {
  const { program, errors } = parseSync(path, source, {
    lang: path.endsWith(".tsx") ? "tsx" : "ts",
    sourceType: "module",
  });

  if (errors.length > 0) return true;

  const literalArrayNames = new Set<string>();

  new Visitor({
    VariableDeclarator(node) {
      if (
        node.id.type === "Identifier"
        && node.init
        && isStringArrayLiteral(node.init, literalArrayNames)
      ) {
        literalArrayNames.add(node.id.name);
      }
    },
  }).visit(program);

  let tautological = false;
  const equalityMatchers = new Set(["toEqual", "toStrictEqual", "toMatchObject"]);
  const containMatchers = new Set(["toContain", "toContainEqual"]);
  const snapshotMatchers = new Set(["toMatchSnapshot", "toMatchInlineSnapshot"]);
  const assertDeepMethods = new Set(["deepEqual", "deepStrictEqual"]);
  const containedDefaults = new Set<string>();

  new Visitor({
    CallExpression(node) {
      if (tautological) return;

      const callee = unwrapExpression(node.callee);

      if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") {
        const method = callee.property.name;
        const receiver = unwrapExpression(callee.object);

        if (
          receiver.type === "CallExpression"
          && receiver.callee.type === "Identifier"
          && receiver.callee.name === "expect"
          && receiver.arguments[0]
          && receiver.arguments[0].type !== "SpreadElement"
        ) {
          const subject = receiver.arguments[0];
          const firstArg = node.arguments[0];

          if (isDefaultModelsRef(subject)) {
            if (snapshotMatchers.has(method)) {
              tautological = true;

              return;
            }

            if (equalityMatchers.has(method) && firstArg && firstArg.type !== "SpreadElement"
              && isStringArrayLiteral(firstArg, literalArrayNames)) {
              tautological = true;

              return;
            }

            if (containMatchers.has(method) && firstArg && firstArg.type !== "SpreadElement") {
              const literal = defaultModelLiteralValue(firstArg);

              if (literal !== null) {
                containedDefaults.add(literal);

                if (containedDefaults.size >= 2) {
                  tautological = true;

                  return;
                }
              }
            }
          }

          if (
            isDefaultModelsIndexAccess(subject)
            && (method === "toBe" || method === "toEqual" || method === "toStrictEqual")
            && firstArg
            && firstArg.type !== "SpreadElement"
            && defaultModelLiteralValue(firstArg) !== null
          ) {
            tautological = true;

            return;
          }
        }

        if (assertDeepMethods.has(method) && node.arguments.length >= 2) {
          const left = node.arguments[0];
          const right = node.arguments[1];

          if (
            left && right && left.type !== "SpreadElement" && right.type !== "SpreadElement"
            && (
              isDefaultModelsRef(left) && isStringArrayLiteral(right, literalArrayNames)
              || isDefaultModelsRef(right) && isStringArrayLiteral(left, literalArrayNames)
            )
          ) {
            tautological = true;

            return;
          }
        }
      }
    },
  }).visit(program);

  return tautological;
}

async function noTautologicalDefaultModelsTests(repoDir: string): Promise<boolean> {
  try {
    const testPaths = await collectTsFiles(repoDir, "tests");

    if (testPaths.length === 0) return false;

    for (const relPath of testPaths) {
      const fullPath = join(repoDir, relPath);

      assertNoSymlinkBoundary(fullPath, repoDir);

      if (hasTautologicalDefaultModelsTest(fullPath, await readFile(fullPath, "utf8"))) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

async function runTestsAgainstModelWrapper(
  trialDir: string,
  modelImplSource: string,
  testContents: ReadonlyArray<readonly [string, string]>,
  wrapperSource: string,
): Promise<boolean> {
  const sandboxDir = await mkdtemp(join(trialDir, "ts-mutant-"));

  try {
    await mkdir(join(sandboxDir, "src"), { recursive: true });
    await writeFile(join(sandboxDir, "package.json"), TS_FILES["package.json"]);
    await writeFile(join(sandboxDir, "tsconfig.json"), TS_FILES["tsconfig.json"]);
    await writeFile(join(sandboxDir, "src/models.impl.ts"), modelImplSource);
    await writeFile(join(sandboxDir, "src/models.ts"), wrapperSource);

    for (const [relPath, content] of testContents) {
      const target = join(sandboxDir, relPath);

      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }

    return await runFixtureCheck(sandboxDir, "bun", ["--no-env-file", "test"]);
  } finally {
    await rm(sandboxDir, { recursive: true, force: true });
  }
}

async function testsKillModelMutants(ev: Evidence, bunTestsPass: boolean): Promise<boolean> {
  if (!bunTestsPass) return false;

  try {
    const modelsPath = join(ev.repoDir, "src/models.ts");

    assertNoSymlinkBoundary(modelsPath, ev.repoDir);

    const [modelImplSource, testPaths] = await Promise.all([
      readFile(modelsPath, "utf8"),
      collectTsFiles(ev.repoDir, "tests"),
    ]);

    if (testPaths.length === 0) return false;

    const testContents: Array<readonly [string, string]> = [];

    for (const relPath of testPaths) {
      const fullPath = join(ev.repoDir, relPath);

      assertNoSymlinkBoundary(fullPath, ev.repoDir);
      testContents.push([relPath, await readFile(fullPath, "utf8")]);
    }

    const mutantResults = await Promise.all(
      MODEL_MUTANT_WRAPPERS.map((wrapper) => runTestsAgainstModelWrapper(ev.trialDir, modelImplSource, testContents, wrapper)),
    );

    return mutantResults.every((passed) => !passed);
  } catch {
    return false;
  }
}

export const catalogAliasAndTestRigor = typeScriptTask({
  id: "coder-ts-catalog-alias-and-test-rigor",
  category: "test-rigor",
  scope: ["src/models.ts"],
  prompt: `
Fix parseModelSpec and validateModels in src/models.ts so catalog validation matches the public session model contract:
- Keep DEFAULT_MODELS and the existing exported functions unchanged in signature.
- In parseModelSpec, split an optional #variant suffix on the first # and split the base on the first / so multi-slash model IDs such as openrouter/anthropic/claude-core#high parse into providerID "openrouter", modelID "anthropic/claude-core", and variant "high".
- Reject specs with an empty providerID, empty modelID, empty variant, multiple # characters, or internal whitespace by throwing an Error starting with "Invalid model spec: ".
- In validateModels, match provider entries by entry.id (not entry.wireModel) so validated specs match toSessionModel.
- Reject disabled models (!entry.enabled) by throwing an Error starting with "Disabled model: ". Keep the existing "Unknown provider: ", "Unknown model: ", and "Unknown variant: " error prefixes.
- Replace the tautological DEFAULT_MODELS literal-copy test and inverted wireModel test in tests/models.test.ts with behavioral contract tests through the existing exports.
`,
  files: {
    "AGENTS.md": `${TS_FILES["AGENTS.md"]}Do not write tautological tests that duplicate exported constant arrays or mirror broken behavior.\nVerify public contracts through exported interfaces so tests fail when contract logic breaks.\n`,
    "src/models.ts": `export interface CatalogModel {
  readonly id: string;
  readonly wireModel: string;
  readonly enabled: boolean;
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
  "openrouter/anthropic/claude-core#high",
  "google/gemini-pro#medium",
] as const;

const SPEC_PATTERN = /^([^/#]+)\\/([^/#]+)(?:#([^/#]+))?$/u;

export function parseModelSpec(spec: string): ModelSpec {
  const match = SPEC_PATTERN.exec(spec.trim());

  if (!match?.[1] || !match[2]) throw new Error(\`Invalid model spec: \${spec}\`);

  return match[3] === undefined
    ? { providerID: match[1], modelID: match[2] }
    : { providerID: match[1], modelID: match[2], variant: match[3] };
}

export function toSessionModel(spec: string): { readonly providerID: string; readonly modelID: string } {
  const { providerID, modelID } = parseModelSpec(spec);

  return { providerID, modelID };
}

export function validateModels(specs: readonly string[], providers: readonly CatalogProvider[]): void {
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

import { DEFAULT_MODELS, validateModels } from "../src/models.ts";

test("keeps default model specs", () => {
  expect(DEFAULT_MODELS).toEqual([
    "openai/gpt-fast#medium",
    "openrouter/anthropic/claude-core#high",
    "google/gemini-pro#medium",
  ]);
});

test("validates models using wireModel", () => {
  const providers = [
    {
      id: "openai",
      models: [
        { id: "gpt-fast", wireModel: "gpt-wire-v1", enabled: false, variants: ["medium"] },
      ],
    },
  ];

  expect(() => validateModels(["openai/gpt-wire-v1#medium"], providers)).not.toThrow();
  expect(() => validateModels(["openai/gpt-fast#medium"], providers)).toThrow();
});
`,
  },
  check: "catalog_contract",
  extraChecks: async (ev, common) => {
    const [testsKillMutants, noTautological] = await Promise.all([
      testsKillModelMutants(ev, common.bun_tests_pass === true),
      noTautologicalDefaultModelsTests(ev.repoDir),
    ]);

    return {
      tests_kill_mutants: testsKillMutants,
      no_tautological_tests: noTautological,
    };
  },
  probe: String.raw`
import assert from "node:assert/strict";
import { DEFAULT_MODELS, parseModelSpec, toSessionModel, validateModels } from "./src/models.ts";

assert.deepEqual(DEFAULT_MODELS, [
  "openai/gpt-fast#medium",
  "openrouter/anthropic/claude-core#high",
  "google/gemini-pro#medium",
]);

assert.deepEqual(parseModelSpec("openrouter/anthropic/claude-core#high"), {
  providerID: "openrouter",
  modelID: "anthropic/claude-core",
  variant: "high",
});
assert.deepEqual(toSessionModel("openrouter/anthropic/claude-core#high"), {
  providerID: "openrouter",
  modelID: "anthropic/claude-core",
});

for (const bad of ["", "openai", "openai/", "/gpt-fast", "openai/gpt-fast#", "openai/gpt-fast#a#b", "openai/gpt fast"]) {
  assert.throws(() => parseModelSpec(bad), /Invalid model spec:/u);
}

const providers = [
  {
    id: "openai",
    models: [
      { id: "gpt-fast", wireModel: "gpt-wire-v1", enabled: true, variants: ["medium"] },
      { id: "gpt-retired", wireModel: "gpt-retired-wire", enabled: false, variants: ["medium"] },
    ],
  },
  {
    id: "openrouter",
    models: [
      { id: "anthropic/claude-core", wireModel: "or-claude-wire", enabled: true, variants: ["high"] },
    ],
  },
  {
    id: "google",
    models: [
      { id: "gemini-pro", wireModel: "gem-wire", enabled: true, variants: ["medium"] },
    ],
  },
];

validateModels(DEFAULT_MODELS, providers);
assert.throws(() => validateModels(["openai/gpt-wire-v1#medium"], providers), /Unknown model:/u);
assert.throws(() => validateModels(["openai/gpt-retired#medium"], providers), /Disabled model:/u);
assert.throws(() => validateModels(["openai/gpt-fast#low"], providers), /Unknown variant:/u);
assert.throws(() => validateModels(["missing/gpt-fast"], providers), /Unknown provider:/u);
`,
});
