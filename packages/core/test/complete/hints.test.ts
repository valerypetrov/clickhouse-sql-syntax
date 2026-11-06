import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parameterHints } from "../../src/index.js";

/** Each hint as the parameter's name and the text of the argument from where it starts. */
function hints(sql: string): string[] {
  return parameterHints(sql).map((h) => `${h.name}: ${sql.slice(h.offset).split(/[,)]/)[0]}`);
}

describe("parameterHints()", () => {
  test("names the arguments of a function by its documented syntax", () => {
    assert.deepEqual(hints("SELECT dateDiff('day', a, b)"), ["unit: 'day'", "startdate: a", "enddate: b"]);
    assert.deepEqual(hints("SELECT JSONExtract(j, 'a', 'String')"), ["json: j", "indices_or_keys: 'a'", "return_type: 'String'"]);
  });

  test("leaves out an argument that is a name equal to the parameter", () => {
    assert.deepEqual(hints("SELECT dateDiff(unit, t.startdate, b)"), ["enddate: b"]);
    assert.deepEqual(hints("SELECT dateDiff(UNIT, `startdate`, b)"), ["enddate: b"]);
  });

  test("leaves out calls with one argument, and the arguments of a repeated parameter", () => {
    assert.deepEqual(hints("SELECT toDate(x), quantile(0.5)(x), tuple(1, 2), concat(a, b)"), []);
  });

  test("names the arguments of table functions and engines", () => {
    assert.deepEqual(hints("SELECT * FROM numbers(1, 10)"), ["offset: 1", "count: 10"]);
    assert.deepEqual(hints("CREATE TABLE t (a Int, v UInt64, d UInt8) ENGINE = ReplacingMergeTree(v, d) ORDER BY a"), [
      "ver: v", "is_deleted: d",
    ]);
  });

  test("only where the parser reads a function or an engine", () => {
    assert.deepEqual(hints("CREATE TABLE file (x Int, y Decimal(10, 2)) ENGINE = Memory"), []);
    assert.deepEqual(hints("SELECT 1 IN (1, 2), (a, b)"), []);
    assert.deepEqual(hints("SELECT dateDiff('day', a, b) +"), []);
  });

  test("in each statement, with offsets in the whole text", () => {
    const sql = "SELECT 1;\nSELECT round(v, 2);\nINSERT INTO t VALUES (round(1, 2))";
    assert.deepEqual(parameterHints(sql), [{ offset: sql.indexOf("v, 2"), name: "x" }, { offset: sql.indexOf("2)"), name: "N" }]);
  });
});
