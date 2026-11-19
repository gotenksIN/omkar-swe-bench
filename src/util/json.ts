export type JsonPrimitive = string | number | boolean | null;

export type JsonArray = readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

function checkJsonValue(value: unknown, ancestors: Set<object>): value is JsonValue {
  if (value === null) {
    return true;
  }

  const boxed: object = Object(value);

  if (value !== boxed) {
    const tag = Object.prototype.toString.call(value);

    return tag === "[object String]" || tag === "[object Boolean]" || Number.isFinite(value);
  }

  const array = Array.isArray(value);

  if (!array) {
    const prototype = Object.getPrototypeOf(boxed);

    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
  }

  if (ancestors.has(boxed)) {
    return false;
  }

  ancestors.add(boxed);

  try {
    if (array) {
      for (let index = 0; index < value.length; index += 1) {
        const entry = Object.getOwnPropertyDescriptor(value, index);

        if (!entry || !Object.hasOwn(entry, "value") || !checkJsonValue(entry.value, ancestors)) {
          return false;
        }
      }
    } else {
      for (const key of Object.getOwnPropertyNames(boxed)) {
        const entry = Object.getOwnPropertyDescriptor(boxed, key);

        if (!entry || !Object.hasOwn(entry, "value") || !checkJsonValue(entry.value, ancestors)) {
          return false;
        }
      }
    }

    return true;
  } finally {
    ancestors.delete(boxed);
  }
}

export function isString(value: unknown): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

export function isFiniteNumber(value: unknown): value is number {
  return Number.isFinite(value);
}

export function isInteger(value: unknown): value is number {
  return Number.isInteger(value);
}

export function isJsonRecord(value: JsonValue): value is JsonObject {
  return value !== null && !Array.isArray(value) && Object(value) === value;
}

export function isJsonValue(value: unknown): value is JsonValue {
  return checkJsonValue(value, new Set());
}

export function isJsonObject(value: unknown): value is JsonObject {
  if (value === null || Array.isArray(value)) {
    return false;
  }

  const boxed: object = Object(value);

  if (value !== boxed) {
    return false;
  }

  const prototype = Object.getPrototypeOf(boxed);

  return (prototype === Object.prototype || prototype === null) && checkJsonValue(value, new Set());
}

export function isJsonArray(value: unknown): value is JsonArray {
  return Array.isArray(value) && checkJsonValue(value, new Set());
}

export function parseJsonText(text: string): JsonValue {
  try {
    const parsed = JSON.parse(text);

    if (isJsonValue(parsed)) {
      return parsed;
    }
  } catch (cause) {
    throw new SyntaxError("Invalid JSON text.", { cause });
  }

  throw new SyntaxError("JSON text contains a value that cannot be represented as JSON.");
}

function stripJsonc(text: string): string {
  const output: string[] = [];
  let inString = false;
  let escaped = false;
  let lastToken = "";
  let trailingComma: number | undefined;

  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);

    if (inString) {
      output.push(char);

      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }

      continue;
    }

    const next = text.charAt(index + 1);

    if (char === "/" && next === "/") {
      while (index + 1 < text.length && !"\r\n".includes(text.charAt(index + 1))) {
        index += 1;
      }

      output.push(" ");
      continue;
    }

    if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);

      if (end === -1) {
        throw new SyntaxError("Unterminated block comment in JSONC text.");
      }

      index = end + 1;
      output.push(" ");
      continue;
    }

    if (!" \t\r\n".includes(char)) {
      if (trailingComma !== undefined && (char === "]" || char === "}")) {
        output[trailingComma] = "";
      }

      trailingComma = char === "," && lastToken !== "" && !"[{,:".includes(lastToken)
        ? output.length
        : undefined;
      inString = char === '"';
      lastToken = char;
    }

    output.push(char);
  }

  return output.join("");
}

export function parseJsoncObject(text: string): JsonObject {
  const value = parseJsonText(stripJsonc(text));

  if (isJsonRecord(value)) {
    return value;
  }

  throw new SyntaxError("Expected a JSONC object at the root.");
}

export function canonicalJsonStringify(value: JsonValue): string {
  if (Array.isArray(value)) {
    const entries: string[] = [];

    for (let index = 0; index < value.length; index += 1) {
      entries.push(canonicalJsonStringify(value[index] ?? null));
    }

    return `[${entries.join(",")}]`;
  }

  if (isJsonRecord(value)) {
    const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);

    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJsonStringify(entry)}`).join(",")}}`;
  }

  return JSON.stringify(value);
}
