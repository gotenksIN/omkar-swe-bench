export type JsonPrimitive = string | number | boolean | null;

export type JsonArray = readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

const checkJsonValue = (
  value: unknown,
  ancestors: Set<object>
): value is JsonValue => {
  if (value === null) {
    return true;
  }

  const boxed = new Object(value);

  if (value !== boxed) {
    const tag = Object.prototype.toString.call(value);

    return (
      tag === "[object String]" ||
      tag === "[object Boolean]" ||
      Number.isFinite(value)
    );
  }

  const array = Array.isArray(value);

  if (!array) {
    const prototype: unknown = Object.getPrototypeOf(boxed);

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

        if (
          !entry ||
          !Object.hasOwn(entry, "value") ||
          !checkJsonValue(entry.value, ancestors)
        ) {
          return false;
        }
      }
    } else {
      for (const key of Object.getOwnPropertyNames(boxed)) {
        const entry = Object.getOwnPropertyDescriptor(boxed, key);

        if (
          !entry ||
          !Object.hasOwn(entry, "value") ||
          !checkJsonValue(entry.value, ancestors)
        ) {
          return false;
        }
      }
    }

    return true;
  } finally {
    ancestors.delete(boxed);
  }
};

export const isString = (value: unknown): value is string =>
  Object.prototype.toString.call(value) === "[object String]";

export const isFiniteNumber = (value: unknown): value is number =>
  Number.isFinite(value);

export const isInteger = (value: unknown): value is number =>
  Number.isInteger(value);

export const isJsonRecord = (value: JsonValue): value is JsonObject =>
  value !== null &&
  !Array.isArray(value) &&
  Object.prototype.toString.call(value) === "[object Object]";

const isJsonValue = (value: unknown): value is JsonValue =>
  checkJsonValue(value, new Set());

export const isJsonObject = (value: unknown): value is JsonObject => {
  if (value === null || Array.isArray(value)) {
    return false;
  }

  const boxed = new Object(value);

  if (value !== boxed) {
    return false;
  }

  const prototype: unknown = Object.getPrototypeOf(boxed);

  return (
    (prototype === Object.prototype || prototype === null) &&
    checkJsonValue(value, new Set())
  );
};

export const isJsonArray = (value: unknown): value is JsonArray =>
  Array.isArray(value) && checkJsonValue(value, new Set());

export const parseJsonText = (text: string): JsonValue => {
  try {
    const parsed: unknown = JSON.parse(text);

    if (isJsonValue(parsed)) {
      return parsed;
    }
  } catch (error) {
    throw new SyntaxError("Invalid JSON text.", { cause: error });
  }

  throw new SyntaxError(
    "JSON text contains a value that cannot be represented as JSON."
  );
};

const stripJsonc = (text: string): string => {
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
      while (
        index + 1 < text.length &&
        !"\r\n".includes(text.charAt(index + 1))
      ) {
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

      trailingComma =
        char === "," && lastToken !== "" && !"[{,:".includes(lastToken)
          ? output.length
          : undefined;
      inString = char === '"';
      lastToken = char;
    }

    output.push(char);
  }

  return output.join("");
};

export const parseJsoncObject = (text: string): JsonObject => {
  const value = parseJsonText(stripJsonc(text));

  if (isJsonRecord(value)) {
    return value;
  }

  throw new SyntaxError("Expected a JSONC object at the root.");
};

const compareStrings = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
};

const isJsonArrayValue = (value: JsonValue): value is JsonArray =>
  Array.isArray(value);

export const canonicalJsonStringify = (value: JsonValue): string => {
  if (isJsonArrayValue(value)) {
    const entries: string[] = [];

    for (const item of value) {
      entries.push(canonicalJsonStringify(item));
    }

    return `[${entries.join(",")}]`;
  }

  if (isJsonRecord(value)) {
    const entries = Object.entries(value).toSorted(([left], [right]) =>
      compareStrings(left, right)
    );

    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJsonStringify(entry)}`).join(",")}}`;
  }

  return JSON.stringify(value);
};
