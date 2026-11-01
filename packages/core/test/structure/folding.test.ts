import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { foldingRanges } from "../../src/structure/index.js";

/** Each range as [startLine, endLine], with its kind when it has one. */
function folds(sql: string): (number | string)[][] {
  return foldingRanges(sql).map((r) => (r.kind ? [r.startLine, r.endLine, r.kind] : [r.startLine, r.endLine]));
}

describe("foldingRanges()", () => {
  test("gives nothing for empty input and statements of one line", () => {
    assert.deepEqual(folds(""), []);
    assert.deepEqual(folds("SELECT 1; SELECT (2)"), []);
  });

  test("folds a statement of several lines from its first line to its last", () => {
    assert.deepEqual(folds("SELECT a,\n  b\nFROM t;\nSELECT 1;"), [[1, 3]]);
  });

  test("folds bracket groups and subqueries, leaving the line of the closing bracket in view", () => {
    // [1, 2] has no line to fold once its last line stays in view.
    const sql = "SELECT\n  f(\n    a\n  ),\n  (\n    SELECT 1\n  ) AS s,\n  [1,\n   2]\nFROM t";
    assert.deepEqual(folds(sql), [[1, 10], [2, 3], [5, 6]]);
  });

  test("folds block comments and runs of line comments on lines of their own", () => {
    const sql = "/* one\n   two */\n-- a\n# b\n\n-- c\nSELECT 1 -- d\n-- e";
    assert.deepEqual(folds(sql), [[1, 2, "comment"], [3, 4, "comment"]]);
  });

  test("folds -- #region blocks, nested ones too, with markers only on lines of their own", () => {
    const sql = "-- #region outer\n--#region inner\nSELECT 1;\n-- #endregion\nSELECT 2 -- #region not\n;\n-- #endregion";
    assert.deepEqual(folds(sql), [[1, 7, "region"], [2, 4, "region"], [5, 6]]);
    assert.deepEqual(folds("-- #endregion\nSELECT 1;\n-- #region"), []);
  });

  test("finds no brackets or markers inside strings and quoted names", () => {
    assert.deepEqual(folds("SELECT '(\n\n)' AS `x\n-- #region`\nFROM t"), [[1, 5]]);
  });

  test("never ends a fold inside a string or comment that goes on below it", () => {
    // The string runs into the line of the closing bracket, so that line folds too.
    assert.deepEqual(folds("SELECT\n  f(\n    'a\n  b')\nFROM t"), [[1, 5], [2, 4]]);
    // The comment after the statement goes on below its last line, so the statement cannot fold.
    assert.deepEqual(folds("SELECT\n  1; /* a\nb */"), [[2, 3, "comment"]]);
  });

  test("leaves inline data alone", () => {
    assert.deepEqual(folds("INSERT INTO t FORMAT CSV\n(1,\n2)\n"), [[1, 3]]);
    assert.deepEqual(folds("INSERT INTO t VALUES (1,\n'/*'),\n(2,\n3);\n/* a\n*/"), [[1, 4], [5, 6, "comment"]]);
  });

  test("keeps one range per line, and only ranges that nest", () => {
    assert.deepEqual(folds("SELECT (\n1); SELECT (\n2)"), [[1, 2]]);
    const sql = "SELECT ((\n1,\n2),\n3), ((4,\n5\n), 6\n)";
    const ranges = foldingRanges(sql);
    assert.ok(ranges.length > 0);
    for (const a of ranges) {
      for (const b of ranges) {
        if (a === b) continue;
        assert.notEqual(a.startLine, b.startLine);
        const disjoint = a.endLine < b.startLine || b.endLine < a.startLine;
        const nested = (a.startLine < b.startLine && b.endLine <= a.endLine) || (b.startLine < a.startLine && a.endLine <= b.endLine);
        assert.ok(disjoint || nested, JSON.stringify([a, b]));
      }
    }
  });

  test("counts lines as VS Code does, ending at \\n, \\r\\n or a lone \\r", () => {
    assert.deepEqual(folds("SELECT\r\n  1\r\nFROM t;\rSELECT\r2"), [[1, 3], [4, 5]]);
    // Only "\n" ends a line comment, so this one runs on into the next line of the editor.
    assert.deepEqual(folds("-- a\rb\nSELECT 1"), [[1, 2, "comment"]]);
  });
});
