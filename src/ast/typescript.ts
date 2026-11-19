import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseSync, visitorKeys } from "oxc-parser";

import type { Comment, Expression, Node, ParamPattern, TSType, TSTypeAliasDeclaration, TSTypeParameter } from "oxc-parser";
import { assertNoSymlinkBoundary } from "../util/fs.ts";
import { isString } from "../util/json.ts";

export interface TypeScriptViolation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly rule: string;
  readonly message: string;
}

export interface TypeScriptAstReport {
  readonly passed: boolean;
  readonly violations: readonly TypeScriptViolation[];
}

type Assertion = Extract<Node, { type: "TSAsExpression" | "TSTypeAssertion" }>;

type TypeBinding = TSTypeAliasDeclaration | TSTypeParameter | null;

interface TypeBindings {
  readonly scopes: WeakMap<Node, Map<string, TypeBinding>>;
  readonly parents: WeakMap<Node, Node>;
}

interface AliasExpansion {
  readonly declaration: TSTypeAliasDeclaration;
  readonly arguments: ReadonlyMap<TSTypeParameter, TypeInput>;
  readonly outer?: AliasExpansion | undefined;
}

interface TypeInput {
  readonly type: TSType;
  readonly expansion?: AliasExpansion | undefined;
}

type ReportViolation = (offset: number, rule: string, message: string) => void;

const EQUALITY_OPERATORS = new Set(["===", "!==", "==", "!="]);
const MOCK_METHODS = new Set(["mock", "doMock", "unstable_mockModule"]);
const SAFETY_COMMENT = /(?:^|[^\p{L}\p{N}_])SAFETY\s*:\s*\S/u;

function* children(node: Node): Iterable<Node> {
  for (const key of visitorKeys[node.type] ?? []) {
    // SAFETY: Parser visitor keys identify only child nodes and arrays of child nodes.
    const child = Object.getOwnPropertyDescriptor(node, key)?.value as Node | (Node | null)[] | null | undefined;

    if (Array.isArray(child)) {
      for (const entry of child) {
        if (entry) yield entry;
      }
    } else if (child) {
      yield child;
    }
  }
}

function walk(node: Node, visit: (node: Node, ancestors: readonly Node[]) => void, ancestors: Node[] = []): void {
  visit(node, ancestors);
  ancestors.push(node);

  for (const child of children(node)) walk(child, visit, ancestors);

  ancestors.pop();
}

function isAliasScope({ type }: Node): boolean {
  return type === "Program" || type === "BlockStatement" || type === "TSModuleBlock" || type === "SwitchStatement";
}

function collectTypeBindings(program: Node): TypeBindings {
  const scopes = new WeakMap<Node, Map<string, TypeBinding>>();
  const parents = new WeakMap<Node, Node>();

  function bind(scope: Node | undefined, name: string, binding: TypeBinding): void {
    if (!scope) return;

    let entries = scopes.get(scope);

    if (!entries) {
      entries = new Map();
      scopes.set(scope, entries);
    }

    entries.set(name, binding);
  }

  walk(program, (node, ancestors) => {
    const parent = ancestors.at(-1);

    if (parent) parents.set(node, parent);

    if (node.type === "TSTypeParameter" && parent?.type === "TSTypeParameterDeclaration") {
      bind(ancestors.at(-2), node.name.name, node);
    } else if (node.type === "TSTypeAliasDeclaration") {
      bind(ancestors.findLast(isAliasScope), node.id.name, node);
    } else if ((node.type === "TSInterfaceDeclaration" || node.type === "ClassDeclaration" ||
      node.type === "TSEnumDeclaration" || node.type === "TSImportEqualsDeclaration") && node.id) {
      bind(ancestors.findLast(isAliasScope), node.id.name, null);
    }
  });

  return { scopes, parents };
}

function resolveBinding(node: Node, name: string, { scopes, parents }: TypeBindings): TypeBinding | undefined {
  for (let scope: Node | undefined = node; scope; scope = parents.get(scope)) {
    const binding = scopes.get(scope)?.get(name);

    if (binding !== undefined) return binding;
  }

  return undefined;
}

function isExpanding(alias: TSTypeAliasDeclaration, expansion: AliasExpansion | undefined): boolean {
  for (let frame = expansion; frame; frame = frame.outer) {
    if (frame.declaration === alias) return true;
  }

  return false;
}

function resolvesTo(
  type: TSType,
  bindings: TypeBindings,
  matches: (type: TSType) => boolean,
  throughPromise = false,
): boolean {
  const pending: TypeInput[] = [{ type }];
  const seen = new Map<TSType, Set<AliasExpansion | undefined>>();

  while (pending.length) {
    const input = pending.pop();

    if (!input) break;

    const { type: current, expansion } = input;
    let frames = seen.get(current);

    if (!frames) {
      frames = new Set();
      seen.set(current, frames);
    }

    if (frames.has(expansion)) continue;

    frames.add(expansion);

    if (matches(current)) return true;

    if (current.type === "TSParenthesizedType") pending.push({ type: current.typeAnnotation, expansion });

    if (current.type === "TSUnionType") {
      for (const member of current.types) pending.push({ type: member, expansion });
    }

    if (current.type !== "TSTypeReference" || current.typeName.type !== "Identifier") continue;

    const name = current.typeName.name;
    const binding = resolveBinding(current, name, bindings);
    const args = current.typeArguments?.params;

    if (binding?.type === "TSTypeParameter") {
      for (let frame = expansion; frame; frame = frame.outer) {
        const argument = frame.arguments.get(binding);

        if (argument) {
          pending.push(argument);
          break;
        }
      }
    } else if (binding?.type === "TSTypeAliasDeclaration" && !isExpanding(binding, expansion)) {
      const argumentsByParameter = new Map<TSTypeParameter, TypeInput>();
      const frame = { declaration: binding, arguments: argumentsByParameter, outer: expansion };

      for (const [index, parameter] of (binding.typeParameters?.params ?? []).entries()) {
        const arg = args?.[index];

        if (arg) argumentsByParameter.set(parameter, { type: arg, expansion });
        else if (parameter.default) {
          argumentsByParameter.set(parameter, { type: parameter.default, expansion: frame });
        }
      }

      pending.push({ type: binding.typeAnnotation, expansion: frame });
    } else if (binding === undefined && throughPromise && args?.[0] && (name === "Promise" || name === "PromiseLike")) {
      pending.push({ type: args[0], expansion });
    }
  }

  return false;
}

function isUnknown(type: TSType): boolean {
  return type.type === "TSUnknownKeyword";
}

function containsUnknown(node: Node): boolean {
  if (node.type === "TSUnknownKeyword") return true;

  return Iterator.from(children(node)).some(containsUnknown);
}

function parameterBinding(param: ParamPattern): ParamPattern {
  if (param.type === "TSParameterProperty") return parameterBinding(param.parameter);

  if (param.type === "AssignmentPattern") return parameterBinding(param.left);

  return param;
}

function checkSignature(node: Node, bindings: TypeBindings, report: ReportViolation): void {
  switch (node.type) {
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "TSDeclareFunction":
    case "TSEmptyBodyFunctionExpression":
    case "ArrowFunctionExpression":
    case "TSMethodSignature":
    case "TSFunctionType":
    case "TSConstructorType":
    case "TSCallSignatureDeclaration":
    case "TSConstructSignatureDeclaration": {
      const returnType = node.returnType?.typeAnnotation;

      const subject = returnType?.type === "TSTypePredicate" && returnType.parameterName.type === "Identifier"
        ? returnType.parameterName.name
        : null;

      for (const param of node.params) {
        const binding = parameterBinding(param);
        const name = binding.type === "Identifier" ? binding.name : null;
        const annotation = "typeAnnotation" in binding ? binding.typeAnnotation?.typeAnnotation : null;

        if (!annotation || name !== null && name === subject) continue;

        if (resolvesTo(annotation, bindings, (type) => type.type === "TSObjectKeyword")) {
          report(annotation.start, "no-object-parameters", "Use a concrete parameter type instead of object.");
        }

        if (!(name === "cause" && isUnknown(annotation)) &&
          (containsUnknown(annotation) || resolvesTo(annotation, bindings, isUnknown))) {
          report(annotation.start, "no-unknown-parameters", "Use a concrete parameter type instead of unknown.");
        }
      }

      if (returnType && returnType.type !== "TSTypePredicate" && resolvesTo(returnType, bindings, isUnknown, true)) {
        report(returnType.start, "no-unknown-returns", "Use a concrete return type instead of unknown.");
      }

      break;
    }
  }
}

function unsafeDictionaryValue(type: TSType): boolean {
  return type.type === "TSUnknownKeyword" || type.type === "TSAnyKeyword" ||
    type.type === "TSObjectKeyword" || type.type === "TSTypeLiteral" && type.members.length === 0;
}

function dictionaryValue(node: Node): TSType | null {
  if (node.type === "TSIndexSignature") return node.typeAnnotation.typeAnnotation;

  if (node.type === "TSMappedType") return node.typeAnnotation;

  if (node.type === "TSTypeReference" && node.typeName.type === "Identifier" && node.typeName.name === "Record") {
    return node.typeArguments?.params[1] ?? null;
  }

  return null;
}

function dictionaryExempt(node: Node, ancestors: readonly Node[]): boolean {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index];

    if (ancestor?.type === "TSTypePredicate") return true;

    if (ancestor?.type === "TSTypeParameter" && ancestor.constraint === (ancestors[index + 1] ?? node)) return true;
  }

  return false;
}

function withoutParens(expression: Expression): Expression {
  while (expression.type === "ParenthesizedExpression") expression = expression.expression;

  return expression;
}

function validTypeof(node: Node, ancestors: readonly Node[]): boolean {
  const parent = ancestors.findLast((ancestor) => ancestor.type !== "ParenthesizedExpression");

  if (parent?.type !== "BinaryExpression" || !EQUALITY_OPERATORS.has(parent.operator)) return false;

  const left = parent.left.type === "PrivateIdentifier" ? parent.left : withoutParens(parent.left);
  const right = withoutParens(parent.right);
  const other = left === node ? right : left;

  return (left === node || right === node) && other.type === "Literal" && other.value === "undefined";
}

function isAssertion(node: Node): node is Assertion {
  return node.type === "TSAsExpression" || node.type === "TSTypeAssertion";
}

function isConstAssertion({ typeAnnotation }: Assertion): boolean {
  return typeAnnotation.type === "TSTypeReference" &&
    typeAnnotation.typeName.type === "Identifier" && typeAnnotation.typeName.name === "const";
}

function lineStarts(source: string): number[] {
  const starts = [0];

  for (const match of source.matchAll(/\r\n?|[\n\u2028\u2029]/gu)) starts.push(match.index + match[0].length);

  return starts;
}

function atOrBefore(offsets: readonly number[], offset: number): number {
  let low = 0;
  let high = offsets.length;

  while (low < high) {
    const middle = (low + high) >>> 1;

    if ((offsets[middle] ?? Infinity) <= offset) low = middle + 1;
    else high = middle;
  }

  return low - 1;
}

function ownsComment(node: Node): boolean {
  return node.type.endsWith("Statement") || node.type.endsWith("Declaration") || node.type === "PropertyDefinition";
}

function safetyJustified(
  node: Assertion,
  ancestors: readonly Node[],
  source: string,
  lines: readonly number[],
  comments: readonly Comment[],
  commentStarts: readonly number[],
): boolean {
  const startLine = atOrBefore(lines, node.start);
  const endLine = atOrBefore(lines, node.end);

  for (let index = atOrBefore(commentStarts, lines[endLine + 1] === undefined
    ? source.length
    : (lines[endLine + 1] ?? 0) - 1); index >= 0; index -= 1) {
    const comment = comments[index];

    if (!comment || atOrBefore(lines, comment.end) < startLine) break;

    if (SAFETY_COMMENT.test(comment.value)) return true;
  }

  const ownerIndex = ancestors.findLastIndex(ownsComment);
  const owner = ancestors[ownerIndex];
  const parent = ancestors[ownerIndex - 1];

  let end = parent?.type === "ExportNamedDeclaration" || parent?.type === "ExportDefaultDeclaration"
    ? parent.start
    : owner?.start ?? node.start;

  const ownerLine = atOrBefore(lines, end);

  for (let index = atOrBefore(commentStarts, end - 1); index >= 0; index -= 1) {
    const comment = comments[index];

    if (!comment || comment.end > end || source.slice(comment.end, end).trim()) break;

    if (ownerLine - atOrBefore(lines, comment.end) > 2) break;

    const lineStart = lines[atOrBefore(lines, comment.start)] ?? 0;

    if (!source.slice(lineStart, comment.start).trim() && SAFETY_COMMENT.test(comment.value)) return true;

    end = comment.start;
  }

  return false;
}

function memberName(expression: Expression): string | null {
  if (expression.type !== "MemberExpression") return null;

  if (!expression.computed) return expression.property.type === "Identifier" ? expression.property.name : null;

  const property = withoutParens(expression.property);

  return property.type === "Literal" && isString(property.value) ? property.value : null;
}

function isModuleMock(expression: Expression): boolean {
  const callee = withoutParens(expression);

  if (callee.type !== "MemberExpression") return false;

  const property = memberName(callee);
  const receiver = withoutParens(callee.object);

  if (receiver.type === "Identifier") {
    return receiver.name === "mock" && property === "module" ||
      (receiver.name === "vi" || receiver.name === "jest") && property !== null && MOCK_METHODS.has(property);
  }

  if (property !== "module" || receiver.type !== "MemberExpression" || memberName(receiver) !== "mock") return false;

  const owner = withoutParens(receiver.object);

  return owner.type === "Identifier" && owner.name === "Bun";
}

function* typeScriptFiles(dir: string): Iterable<string> {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;

    const path = join(dir, entry.name);

    if (entry.isDirectory()) yield* typeScriptFiles(path);

    if (entry.isFile() && /\.tsx?$/u.test(entry.name)) yield path;
  }
}

function* existingTypeScriptFiles(repoDir: string, area: string): Iterable<string> {
  const dir = join(repoDir, area);
  const stat = lstatSync(dir, { throwIfNoEntry: false });

  if (!stat) return;

  assertNoSymlinkBoundary(dir, repoDir);

  if (stat.isDirectory()) yield* typeScriptFiles(dir);
}

export function analyzeTypeScriptRepo(repoDir: string): TypeScriptAstReport {
  assertNoSymlinkBoundary(repoDir);

  const violations: TypeScriptViolation[] = [];

  for (const area of ["src", "tests"]) {
    for (const path of existingTypeScriptFiles(repoDir, area)) {
      const file = relative(repoDir, path);
      const source = readFileSync(path, "utf8");

      const parsed = parseSync(path, source, {
        sourceType: "module", lang: path.endsWith(".tsx") ? "tsx" : "ts", preserveParens: true,
      });

      const lines = lineStarts(source);

      const report: ReportViolation = (offset, rule, message) => {
        const line = atOrBefore(lines, offset);

        violations.push({ file, line: line + 1, column: offset - (lines[line] ?? 0) + 1, rule, message });
      };

      if (parsed.errors.length) {
        for (const error of parsed.errors) report(error.labels[0]?.start ?? 0, "parse-error", error.message);

        continue;
      }

      const program = parsed.program;
      const comments = parsed.comments;
      const commentStarts = comments.map(({ start }) => start);
      const bindings = area === "src" ? collectTypeBindings(program) : null;

      walk(program, (node, ancestors) => {
        if (node.type === "TSAnyKeyword") report(node.start, "no-any", "Use a concrete type instead of any.");

        if (!bindings) {
          if (node.type === "CallExpression" && isModuleMock(node.callee)) {
            report(node.start, "no-module-mocking", "Test through public interfaces without mocking modules.");
          }

          return;
        }

        checkSignature(node, bindings, report);

        if (node.type === "TSTypeAliasDeclaration" && resolvesTo(node.typeAnnotation, bindings, isUnknown)) {
          report(node.start, "no-unknown-type-aliases", "Use a concrete alias instead of unknown.");
        }

        const value = dictionaryValue(node);

        if (value && !dictionaryExempt(node, ancestors) && resolvesTo(value, bindings, unsafeDictionaryValue)) {
          report(value.start, "no-unsafe-dictionary-type", "Use a concrete dictionary value type.");
        }

        if (node.type === "UnaryExpression" && node.operator === "typeof" && !validTypeof(node, ancestors)) {
          report(node.start, "no-runtime-typeof", "Use runtime typeof only to compare against \"undefined\".");
        }

        if (isAssertion(node)) {
          const inner = withoutParens(node.expression);
          const constant = isConstAssertion(node);

          if (isAssertion(inner) && (!constant || !isConstAssertion(inner))) {
            report(node.start, "no-chained-type-assertions", "Do not chain type assertions.");
          }

          if (!constant && !safetyJustified(node, ancestors, source, lines, comments, commentStarts)) {
            report(node.start, "require-safety-comment-for-type-assertion", "Explain the verified invariant in a SAFETY comment.");
          }
        }
      });
    }
  }

  return { passed: violations.length === 0, violations };
}
