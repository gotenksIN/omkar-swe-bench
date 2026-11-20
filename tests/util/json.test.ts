import { describe, expect, test } from "bun:test";

import {
  canonicalJsonStringify,
  isJsonArray,
  isJsonObject,
  parseJsoncObject,
  parseJsonText,
} from "../../src/util/json.ts";

describe("parseJsonText", () => {
  test("parses objects, arrays, and scalar roots", () => {
    expect(parseJsonText('{"key":[null,true,false,1.5,"text"]}')).toEqual({
      key: [null, true, false, 1.5, "text"],
    });
    expect(parseJsonText("[1,2]")).toEqual([1, 2]);
    expect(parseJsonText('"text"')).toBe("text");
    expect(parseJsonText("null")).toBeNull();
    expect(parseJsonText("0")).toBe(0);
    expect(parseJsonText("true")).toBe(true);
  });

  test.each(["", "{oops}", "null true", "[1,]", "{/* comment */}", "1e999"])(
    "rejects %j",
    (text) => {
      expect(() => parseJsonText(text)).toThrow(/JSON/u);
    }
  );
});

describe("parseJsoncObject", () => {
  test("handles comments and trailing commas at each nesting level", () => {
    const text = `{
      // Comment before a property.
      "nested": { "array": [1, /* inside array */ 2, /* after comma */ ], },
      "answer": 42, // Comment before the end.
    } // Comment at end of input.`;

    expect(parseJsoncObject(text)).toEqual({
      nested: { array: [1, 2] },
      answer: 42,
    });
    expect(parseJsoncObject("{// comment\r}")).toEqual({});
  });

  test("preserves comment-like text, commas, quotes, and backslashes in strings", () => {
    const value = {
      url: "https://example.com/a//b",
      'key"//': '/* literal */ ,] ,} \\" end\\',
    };

    expect(
      parseJsoncObject(`/* start */ ${JSON.stringify(value)} /* end */`)
    ).toEqual(value);
  });

  test.each(["[]", "null", "42", '"text"'])(
    "rejects a non-object root: %j",
    (text) => {
      expect(() => parseJsoncObject(text)).toThrow(
        "Expected a JSONC object at the root."
      );
    }
  );

  test.each([
    "{,}",
    '{"x":[,]}',
    '{"x":1,,}',
    '{"x":12/* note */34}',
    "{} /* unterminated",
  ])("does not repair malformed input: %j", (text) => {
    expect(() => parseJsoncObject(text)).toThrow(SyntaxError);
  });
});

describe("JSON predicates", () => {
  test("accepts valid nested primitives, arrays, and objects", () => {
    expect(
      isJsonArray([null, false, 1.25, "text", [], {}, { x: [{ y: 1 }] }])
    ).toBe(true);
    expect(
      isJsonObject({
        a: null,
        b: false,
        c: 1.25,
        d: "text",
        e: [],
        f: { y: 1 },
      })
    ).toBe(true);
  });

  test("rejects non-JSON values", () => {
    const sparse: string[] = [];
    sparse.length = 1;

    const invalidEntries = [
      undefined,
      Infinity,
      Number.NaN,
      Symbol("invalid"),
      1n,
      new Date(),
      new Object("boxed"),
      () => 1,
      [undefined],
      sparse,
      { x: undefined },
      { x: [{ y: Infinity }] },
    ];

    expect(
      invalidEntries.every(
        (entry) => !isJsonArray([entry]) && !isJsonObject({ entry })
      )
    ).toBe(true);
  });

  test("distinguishes objects from arrays and rejects invalid contents", () => {
    const data = [
      null,
      [],
      [1],
      [undefined],
      {},
      { x: null },
      { x: undefined },
    ];

    expect(data.map(isJsonObject)).toEqual([
      false,
      false,
      false,
      false,
      true,
      true,
      false,
    ]);
    expect(data.map(isJsonArray)).toEqual([
      false,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  test("rejects cycles but accepts repeated references", () => {
    const cycle: { children?: object }[] = [];
    const branch = { children: cycle };
    cycle.push(branch);
    const child = { x: 1 };

    expect(isJsonArray(cycle)).toBe(false);
    expect(isJsonObject({ a: child, b: child })).toBe(true);
  });
});

describe("canonicalJsonStringify", () => {
  test("sorts keys lexicographically at every level and preserves array order", () => {
    const value = parseJsonText(
      '{"z":[{"b":1,"a":2},0],"2":2,"10":10,"a":{"d":false,"c":null}}'
    );

    expect(canonicalJsonStringify(value)).toBe(
      '{"10":10,"2":2,"a":{"c":null,"d":false},"z":[{"a":2,"b":1},0]}'
    );
  });

  test("escapes keys and scalar values and preserves own __proto__ data", () => {
    const value = parseJsonText(
      '{"__proto__":{"z":1},"a\\"":"line\\n\\\\","Z":true}'
    );

    expect(canonicalJsonStringify(value)).toBe(
      '{"Z":true,"__proto__":{"z":1},"a\\"":"line\\n\\\\"}'
    );
    expect(canonicalJsonStringify(["\t", null, false, 1.5])).toBe(
      '["\\t",null,false,1.5]'
    );
    expect(canonicalJsonStringify("😊")).toBe('"😊"');
    expect(canonicalJsonStringify(null)).toBe("null");
  });
});
