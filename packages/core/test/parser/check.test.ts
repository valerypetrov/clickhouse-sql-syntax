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

  test("matches brackets across statements, as ClickHouse looks at the rest of the input", () => {
    const found = errors("SELECT (1; SELECT 2)");
    assert.ok(found[0]![1].startsWith("Expected one of: comma or closing bracket"));
    assert.deepEqual(found[1], [19, "Unmatched parentheses: ')' at position 9 has no matching opening bracket."]);
    assert.deepEqual(errors("SELECT (1; SELECT 2"), [[9, "Unmatched parentheses: '(' at position 8 is never closed."]]);
  });

  // About 0.4 s here, and quadratic work would take half a minute. A { timeout } cannot stop synchronous code.
  test("takes time in proportion to the input, not to the number of statements times its length", () => {
    const sql = Array.from({ length: 20000 }, (_, i) => `SELECT ${i} FROM t WHERE x IN (${i});`).join("\n");
    const start = performance.now();
    assert.deepEqual(check(sql), []);
    const ms = performance.now() - start;
    assert.ok(ms < 5000, `took ${ms.toFixed(0)} ms`);
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

  // Measured with clickhouse local, which splits queries like clickhouse-client.
  test("ends FORMAT data only at \\n\\n, not at a line of spaces or at \\r\\n\\r\\n", () => {
    assert.deepEqual(check("INSERT INTO t FORMAT CSV\n1\n \nSELECT 1 +"), []);
    assert.deepEqual(check("INSERT INTO t FORMAT CSV\r\n1\r\n\r\nSELECT 1 +"), []);
  });

  test("lets a comment end a statement before its ';'", () => {
    const found = errors("SELECT 1 -- comment\n; SELECT 2 +");
    assert.equal(found.length, 1);
    assert.equal(found[0]![0], 32);
  });

  // Measured with clickhouse local, which applies adjustQueryEnd like clickhouse-client.
  test("gives the rest of the line after a ';' to the query before it", () => {
    const opened = (position: string) => `Unmatched parentheses: '(' at position ${position} is never closed.`;
    assert.deepEqual(errors("SELECT 1 -- c\n; -- d\nSELECT ("), [[29, opened("8")]]);
    assert.deepEqual(errors("INSERT INTO t VALUES (1); -- c\nSELECT ("), [[39, opened("8")]]);
    // Not when a query follows on the same line, or after the data of FORMAT.
    assert.deepEqual(errors("SELECT 1; SELECT 2 -- c\nSELECT ("), [[31, opened("22 (line 2, col 8)")]]);
    assert.deepEqual(errors("INSERT INTO t FORMAT CSV\n1\n\n-- c\nSELECT ("), [[41, opened("13 (line 2, col 8)")]]);
    // A comment that goes on to the next line is cut there, so the next query starts inside it.
    assert.deepEqual(errors("SELECT 1; /* a \n */ SELECT ("), [[27, opened("11")]]);
  });

  test("reads the rest of the input as part of COPY to an unsupported target, as ClickHouse does", () => {
    assert.deepEqual(check("COPY t TO 'file.csv'; garbage"), []);
  });

  // x BETWEEN a AND b uses x twice, so a chain of them shares nodes that must be measured once.
  test("measures the depth of a chain of BETWEEN in time in proportion to its length", () => {
    const sql = `SELECT 1 ${Array.from({ length: 30 }, () => "BETWEEN 1 AND 2").join(" ")}`;
    const start = performance.now();
    assert.deepEqual(check(sql), []);
    const ms = performance.now() - start;
    assert.ok(ms < 500, `took ${ms.toFixed(0)} ms`);
  });

  // Each statement reaches ClickHouse's limit of 1,000,000 backtracks, which takes about half a second.
  test("stops after about a second of backtracking and warns that the rest is not checked", () => {
    const slow = `SELECT ${"INTERVAL (".repeat(18)}+${") DAY".repeat(18)}`;
    const sql = Array.from({ length: 10 }, () => slow).join(";\n");
    const start = performance.now();
    const found = check(sql);
    const ms = performance.now() - start;
    assert.deepEqual(
      found.map((d) => [d.line, d.severity, d.message.slice(0, 34)]),
      [
        [1, "error", "Maximum amount of backtracking (10"],
        [2, "error", "Maximum amount of backtracking (10"],
        [3, "warning", "Not checked: checking took too lon"],
      ],
    );
    assert.ok(ms < 3000, `took ${ms.toFixed(0)} ms`);
  });

  test("reports too deep nesting instead of overflowing the stack", () => {
    const sql = "SELECT " + "(".repeat(2000) + "1" + ")".repeat(2000);
    assert.deepEqual(errors(sql), [[991, "Maximum parse depth (1000) exceeded. Consider rising max_parser_depth parameter."]]);
  });
});
