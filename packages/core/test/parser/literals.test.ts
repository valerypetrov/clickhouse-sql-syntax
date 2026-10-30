import assert from "node:assert/strict";
import { describe, test } from "node:test";
import v8 from "node:v8";
import { runInNewContext } from "node:vm";

import { quotedIdentifierName, stringLiteralValue, unquote } from "../../src/parser/literals.js";

describe("Values of quoted names and strings", () => {
  // As readAnyQuotedString reads them: undefined where it does not read the whole text.
  const strings: [text: string, value: string | undefined][] = [
    ["'abc'", "abc"],
    ["''", ""],
    ["'it''s'", "it's"],
    ["''''", "'"],
    ["'\\a\\b\\e\\f\\n\\r\\t\\v\\0'", "\x07\b\x1b\f\n\r\t\v\0"],
    ["'\\\\ \\' \\\" \\` \\/ \\='", "\\ ' \" ` / ="],
    ["'\\x41\\x4a\\x0g\\xzz'", "AJ\0\0"],
    ["'a\\Nb'", "ab"],
    ["'\\d\\w\\.\\😀'", "\\d\\w\\.\\😀"],
    ["'a\\\nb'", "a\nb"],
    ["'π ∑ 😀'", "π ∑ 😀"],
    ["'a'b'", undefined],
    ["'abc", undefined],
    ["'", undefined],
    ["'abc\\'", undefined],
    ["'\\", undefined],
    ["'\\x4'", undefined],
    ["\"a\"", undefined],
  ];
  for (const [text, value] of strings) {
    test(`${JSON.stringify(text)} reads as ${JSON.stringify(value)}`, () => assert.equal(stringLiteralValue(text), value));
  }

  test("doubled quotes are an error where SQL style is off", () => {
    assert.equal(unquote("'a''b'", "'", false), undefined);
    assert.equal(unquote("'a\\'b'", "'", false), "a'b");
    assert.equal(unquote("'ab'", "'", false), "ab");
  });

  test("names in backticks and double quotes", () => {
    assert.equal(quotedIdentifierName("`a``b`"), "a`b");
    assert.equal(quotedIdentifierName('"a""b\\"c"'), 'a"b"c');
    assert.equal(quotedIdentifierName("`a\\x41`"), "aA");
    assert.equal(quotedIdentifierName("``"), undefined);
    assert.equal(quotedIdentifierName("“a”"), "a");
  });

  test("hexadecimal and binary strings", () => {
    assert.equal(stringLiteralValue("x'414a'"), "AJ");
    assert.equal(stringLiteralValue("X'ff0'"), "\xff\0");
    assert.equal(stringLiteralValue("b'0100000101001010'"), "AJ");
    assert.equal(stringLiteralValue("B'1'"), "\x01");
    assert.equal(stringLiteralValue("x''"), "");
  });

  // Adding one character at a time to a string keeps dozens of bytes per character in V8.
  test("10 MB of quoted text is read in 200 ms and kept in at most 4 bytes per character", (t) => {
    v8.setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    const bytesPerCharacter = (read: (text: string) => string | undefined, text: string): number => {
      gc();
      const before = process.memoryUsage().heapUsed;
      const value = read(text)!;
      gc();
      return (process.memoryUsage().heapUsed - before) / value.length;
    };
    const plain = "a".repeat(10_000_000);
    const escaped = `${"a".repeat(999)}\\n`.repeat(10_000);
    const reads: [string, string, (text: string) => string | undefined, number?][] = [
      ["a name", `\`${plain}\``, quotedIdentifierName, 200],
      ["a string", `'${plain}'`, stringLiteralValue, 200],
      ["a string with escapes", `'${escaped}'`, stringLiteralValue, 200],
      // parseInt() of each byte takes most of the time here.
      ["a hexadecimal string", `x'${"4a".repeat(5_000_000)}'`, stringLiteralValue],
    ];
    const problems: string[] = [];
    for (const [what, text, read, budget] of reads) {
      let ms = Infinity;
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        read(text);
        ms = Math.min(ms, performance.now() - start);
      }
      const bytes = bytesPerCharacter(read, text);
      t.diagnostic(`${what}: ${ms.toFixed(0)} ms, ${bytes.toFixed(1)} bytes per character`);
      if (budget && ms >= budget) problems.push(`${what} took ${ms.toFixed(0)} ms`);
      if (bytes > 4) problems.push(`${what} keeps ${bytes.toFixed(1)} bytes per character`);
    }
    assert.deepEqual(problems, []);
  });
});
