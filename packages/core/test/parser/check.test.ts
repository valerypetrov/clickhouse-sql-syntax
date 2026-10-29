import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { check } from "../../src/parser/index.js";

/** start and message of every diagnostic. */
function errors(sql: string): [number, string][] {
  return check(sql).map((d) => [d.start, d.message]);
}

const AFTER_OPERAND = "Expected one of: token, DoubleColon, OR, AND, IS NOT DISTINCT FROM, IS DISTINCT FROM";

describe("check()", () => {
  test("has nothing to say about empty input, comments and empty statements", () => {
    assert.deepEqual(check(""), []);
    assert.deepEqual(check("  \n -- just a comment\n"), []);
    assert.deepEqual(check(";;"), []);
    assert.deepEqual(check("SELECT 1;"), []);
  });

  test("reports one error per statement and carries on after the ';'", () => {
    const found = errors("SELECT 1 +; SELECT 2; SELECT (");
    assert.equal(found.length, 2);
    assert.equal(found[0]![0], 10);
    assert.ok(found[0]![1].startsWith("Expected one of: CAST operator, NOT, INTERVAL"));
    assert.deepEqual(found[1], [30, "Unmatched parentheses: '(' at position 8 is never closed."]);
  });

  test("gives the line and column, with \\r\\n line ends", () => {
    const [d] = check("SELECT 1\r\nFROM t WHERE\r\n");
    assert.deepEqual(
      { start: d!.start, end: d!.end, line: d!.line, col: d!.col, severity: d!.severity },
      { start: 24, end: 24, line: 3, col: 1, severity: "error" },
    );
  });

  test("covers the token it points at, and is empty at the end of the input", () => {
    const [atToken] = check("SELECT a,, b FROM t");
    assert.deepEqual([atToken!.start, atToken!.end], [11, 12]);
    const [atEnd] = check("SELECT * FROM t WHERE a = 'x' AND");
    assert.deepEqual([atEnd!.start, atEnd!.end, atEnd!.message], [33, 33, "Expected one of: OR, AND"]);
  });

  test("counts offsets in UTF-16 code units", () => {
    assert.equal(check("SELECT 'é' +")[0]!.start, 12);
    assert.equal(check("SELECT '😀' + ")[0]!.start, 14);
  });

  test("names the line and column of a bracket in a statement of several lines", () => {
    assert.deepEqual(errors("SELECT (1,\n  2"), [[14, "Unmatched parentheses: '(' at position 8 (line 1, col 8) is never closed."]]);
  });

  test("skips VALUES data up to a ';' outside brackets and strings", () => {
    const found = errors("INSERT INTO t VALUES ('a;b'), (1); SELECT 1 +");
    assert.equal(found.length, 1);
    assert.equal(found[0]![0], 45);
    assert.ok(found[0]![1].startsWith(AFTER_OPERAND));
  });

  test("never checks inline data, which runs to an empty line after FORMAT", () => {
    assert.deepEqual(check("INSERT INTO t FORMAT TSV\n)))garbage 'x\n"), []);
    assert.deepEqual(check("INSERT INTO t VALUES (1, 'x), (2)"), []);
    const found = errors("INSERT INTO t FORMAT CSV\n1,2\n3,4\n\nSELECT 1 +");
    assert.equal(found.length, 1);
    assert.equal(found[0]![0], 44);
  });

  test("lets a comment end a statement before its ';'", () => {
    const found = errors("SELECT 1 -- comment\n; SELECT 2 +");
    assert.equal(found.length, 1);
    assert.equal(found[0]![0], 32);
  });

  test("reads the rest of the input as part of COPY to an unsupported target, as ClickHouse does", () => {
    assert.deepEqual(check("COPY t TO 'file.csv'; garbage"), []);
  });

  test("reports too deep nesting instead of overflowing the stack", () => {
    const sql = "SELECT " + "(".repeat(2000) + "1" + ")".repeat(2000);
    assert.deepEqual(errors(sql), [[991, "Maximum parse depth (1000) exceeded. Consider rising max_parser_depth parameter."]]);
  });
});
