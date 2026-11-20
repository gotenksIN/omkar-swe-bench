import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import nodePath from "node:path";

import { analyzeTypeScriptRepo } from "../../src/ast/typescript.ts";

let repo: string;

beforeEach(() => {
  mkdirSync("/tmp/opencode", { recursive: true });
  repo = mkdtempSync("/tmp/opencode/typescript-ast-");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const write = (path: string, source: string): void => {
  const file = nodePath.join(repo, path);

  mkdirSync(nodePath.dirname(file), { recursive: true });
  writeFileSync(file, source);
};

const rules = (): string[] =>
  analyzeTypeScriptRepo(repo).violations.map(({ rule }) => rule);

test("recurses through source and tests and reports every any with a location", () => {
  write(
    "src/nested/example.tsx",
    "const heading = <p>💡</p>;\r\nconst x: Array<any> = [];\r\n"
  );
  write(
    "tests/nested/example.ts",
    "let values: any[]; const x = <any>values;\n"
  );
  write("ignored/example.ts", "type Ignored = any;");

  const report = analyzeTypeScriptRepo(repo);

  expect(report.passed).toBe(false);
  expect(
    report.violations.map(({ file, line, column, rule, message }) => ({
      file,
      line,
      column,
      rule,
      hasMessage: message.length > 0,
    }))
  ).toEqual([
    {
      file: "src/nested/example.tsx",
      line: 2,
      column: 16,
      rule: "no-any",
      hasMessage: true,
    },
    {
      file: "tests/nested/example.ts",
      line: 1,
      column: 13,
      rule: "no-any",
      hasMessage: true,
    },
    {
      file: "tests/nested/example.ts",
      line: 1,
      column: 31,
      rule: "no-any",
      hasMessage: true,
    },
  ]);
});

test("reports parse errors with position and continues scanning later files", () => {
  write("src/bad.ts", "const x = 1;\nconst = 2;\n");
  write("tests/later.ts", "type Later = any;");

  const report = analyzeTypeScriptRepo(repo);

  expect(report.passed).toBe(false);
  expect(
    report.violations.map(({ file, line, column, rule, message }) => ({
      file,
      line,
      column,
      rule,
      hasMessage: message.length > 0,
    }))
  ).toEqual([
    {
      file: "src/bad.ts",
      line: 2,
      column: 7,
      rule: "parse-error",
      hasMessage: true,
    },
    {
      file: "tests/later.ts",
      line: 1,
      column: 14,
      rule: "no-any",
      hasMessage: true,
    },
  ]);
});

test("rejects object and unknown parameters and resolves unions and local aliases", () => {
  write(
    "src/types.ts",
    `
type Obj = (object | null);
type More = Obj;
declare function setup(param: More): void;
const take = (value: Array<unknown>) => value.length;
const work = function (value: unknown = 1) { return value; };
interface Runner { run(value: object): void; }
type Callback = (...values: unknown[]) => void;
function badGuard(value: unknown, other: unknown): value is string { return false; }
`
  );

  expect(rules()).toEqual([
    "no-object-parameters",
    "no-unknown-parameters",
    "no-unknown-parameters",
    "no-object-parameters",
    "no-unknown-parameters",
    "no-unknown-parameters",
  ]);
});

test("rejects unknown aliases and unknown returns through unions, alias chains, and promises", () => {
  write(
    "src/types.ts",
    `
type Later = (Data | null);
type Data = unknown;
type Result = PromiseLike<Later>;
declare function read(): Promise<Result>;
const other = (): unknown => 1;
type Resolve = () => Promise<unknown>;
`
  );

  expect(rules()).toEqual([
    "no-unknown-type-aliases",
    "no-unknown-type-aliases",
    "no-unknown-returns",
    "no-unknown-returns",
    "no-unknown-returns",
  ]);
});

test("resolves aliases lexically and substitutes generic arguments", () => {
  write(
    "src/types.ts",
    `
type Input = string;
function nested() {
  type Input = object;
  const reject = (input: Input) => input;
}
const accept = (input: Input) => input;
type Identity<T> = T;
type Wrapper<T> = Identity<Identity<T>>;
type Cyclic<A = B, B = A> = A;
declare function get(): Promise<Wrapper<unknown>>;
declare function getCycle(): Cyclic;
type Unsafe = Record<string, Wrapper<object>>;
`
  );

  expect(rules()).toEqual([
    "no-object-parameters",
    "no-unknown-returns",
    "no-unsafe-dictionary-type",
  ]);
});

test("rejects unsafe Record, index signatures, and mapped dictionaries", () => {
  write(
    "src/types.ts",
    `
type Empty = {};
type Obj = object;
type StrMap = Record<string, string | Empty>;
type Indexed = { [key: string]: Obj };
type Mapped = { [P in "a" | "b"]: unknown };
type Wrapped = Record<string, any>;
type InvalidDefault<T extends Record<string, unknown> = Record<string, unknown>> = T;
`
  );

  expect(rules()).toEqual([
    "no-unsafe-dictionary-type",
    "no-unsafe-dictionary-type",
    "no-unsafe-dictionary-type",
    "no-unsafe-dictionary-type",
    "no-any",
    "no-unsafe-dictionary-type",
  ]);
});

test("accepts predicates, cause, map and constraint exceptions, recursive JSON, and type queries", () => {
  write(
    "src/types.ts",
    `
type JsonArray = readonly JsonValue[];
interface JsonObject { readonly [key: string]: JsonValue; }
type JsonValue = string | JsonArray | JsonObject;
type Allowed = Map<string, unknown> | ReadonlyMap<string, object>;
type AllowedConstraint<T extends Record<string, unknown>> = T;
declare function handle(cause: unknown): JsonValue;
declare function accepts(value: unknown): value is Record<string, unknown>;
declare function assertsType(value: unknown): asserts value is { readonly [key: string]: unknown };
declare function assertsValue(value: unknown): asserts value;
declare function acceptsObject(value: object): value is { tag: string };
const check = "undefined" == ((typeof missing));
const other = typeof missing !== ("undefined");
type Query = typeof check;
`
  );
  write(
    "tests/own.ts",
    'type Allowed = unknown; const check = typeof someValue === "string";\n'
  );

  expect(analyzeTypeScriptRepo(repo)).toEqual({ passed: true, violations: [] });
});

test("rejects runtime typeof except direct comparisons to the string undefined", () => {
  write(
    "src/typeof.ts",
    `
const a = typeof value;
const b = typeof value === "number";
const c = typeof value === undefined;
const d = (typeof value + "!") === "undefined";
const e = typeof value == "undefined";
`
  );

  expect(rules()).toEqual(Array.from({ length: 4 }, () => "no-runtime-typeof"));
});

test("requires nearby SAFETY comments for assertions and forbids chains", () => {
  write(
    "src/assertions.ts",
    `
const a = 1 as const;
const constChain = (1 as const) as const;
const inline = value as string; // SAFETY: The schema validated the string.
// SAFETY: The schema validated the string.

export const adjacent = value as string;
const c = value as string;
// UNSAFETY: Not a valid marker.
const d = <string>value;
const chain = (<string>value) as const; /* SAFETY: A validated value. */
// SAFETY: Not attached to the next assertion.
const unrelated = 1;
const e = value as string;
// SAFETY:
const f = <string>value;
`
  );

  expect(rules()).toEqual([
    "require-safety-comment-for-type-assertion",
    "require-safety-comment-for-type-assertion",
    "no-chained-type-assertions",
    "require-safety-comment-for-type-assertion",
    "require-safety-comment-for-type-assertion",
  ]);
});

test("detects all specified module mock calls only in tests", () => {
  write("src/normal.ts", 'vi.mock("x");\n');
  write(
    "tests/mocks.test.ts",
    `
mock.module("a", callback);
Bun.mock.module("b", callback);
vi.doMock("c");
jest.unstable_mockModule("d");
jest.mock("e");
vi["mock"]("f");
other.mock("g");
jest.spyOn(obj, "run");
const fn = vi.mock;
`
  );

  expect(rules()).toEqual(Array.from({ length: 6 }, () => "no-module-mocking"));
});
