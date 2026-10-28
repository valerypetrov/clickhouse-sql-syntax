import assert from "node:assert/strict";
import { test } from "node:test";

import { expectsSyntaxError, usesOtherDialect } from "../src/extract.js";
import { splitStatements } from "../src/split.js";

const texts = (sql: string): string[] => splitStatements(sql).map((s) => s.text);

test("splits at semicolons outside strings, comments and heredocs", () => {
  assert.deepEqual(texts("SELECT 1; SELECT 'a;b'; -- c;d\nSELECT /* ; */ 2;;"), ["SELECT 1", "SELECT 'a;b'", "SELECT /* ; */ 2"]);
  assert.deepEqual(texts("SELECT $$a;b$$, $tag$;$tag$; SELECT `x;y`, \"z;w\""), ["SELECT $$a;b$$, $tag$;$tag$", 'SELECT `x;y`, "z;w"']);
});

test("skips empty statements and lone comments", () => {
  assert.deepEqual(texts("-- only a comment\n;\n;  ; /* x */"), []);
});

test("keeps the line of each statement", () => {
  const statements = splitStatements("SELECT 1;\n\nSELECT\n2;\r\nSELECT 3");
  assert.deepEqual(
    statements.map((s) => [s.text, s.line]),
    [["SELECT 1", 1], ["SELECT\n2", 3], ["SELECT 3", 5]],
  );
});

test("INSERT ... VALUES data runs to the first semicolon outside brackets", () => {
  assert.deepEqual(texts("INSERT INTO t VALUES (1, ';'), (2; 3); SELECT 4"), ["INSERT INTO t VALUES (1, ';'), (2; 3)", "SELECT 4"]);
});

test("INSERT ... FORMAT data runs to the first empty line", () => {
  assert.deepEqual(texts('INSERT INTO t FORMAT JSONEachRow\n{"a": 1};\n{}\n\nSELECT 2;\nSELECT 3'), [
    'INSERT INTO t FORMAT JSONEachRow\n{"a": 1};\n{}',
    "SELECT 2",
    "SELECT 3",
  ]);
  assert.deepEqual(texts("INSERT INTO t FORMAT CSV 1;2\nSELECT 5"), ["INSERT INTO t FORMAT CSV 1;2\nSELECT 5"]);
  assert.deepEqual(texts("INSERT INTO t SELECT * FROM input('a Int') FORMAT CSV 1;2\n\nSELECT 8"), [
    "INSERT INTO t SELECT * FROM input('a Int') FORMAT CSV 1;2",
    "SELECT 8",
  ]);
});

test("INSERT ... FORMAT Values data ends at a semicolon, like VALUES", () => {
  assert.deepEqual(texts("INSERT INTO t FORMAT Values (1, ';'), (2); SELECT 4"), ["INSERT INTO t FORMAT Values (1, ';'), (2)", "SELECT 4"]);
});

test("a semicolon right after the format name stays in the statement, since ClickHouse rejects it", () => {
  assert.deepEqual(texts("INSERT INTO t FORMAT JSONEachRow;SELECT 7"), ["INSERT INTO t FORMAT JSONEachRow;", "SELECT 7"]);
});

test("INSERT ... SELECT and SELECT ... FORMAT have no inline data", () => {
  assert.deepEqual(texts("INSERT INTO t SELECT 1; SELECT 2"), ["INSERT INTO t SELECT 1", "SELECT 2"]);
  assert.deepEqual(texts("SELECT 1 FORMAT TSV; SELECT 2"), ["SELECT 1 FORMAT TSV", "SELECT 2"]);
});

test("reads test hints inside a statement and after it on the same line", () => {
  const statements = splitStatements("SELECT x; -- { clientError SYNTAX_ERROR }\nSELECT 10 -- { serverError 42 }\n;\nSELECT 11;");
  assert.deepEqual(
    statements.map((s) => s.hints),
    [["clientError SYNTAX_ERROR"], ["serverError 42"], []],
  );
  assert.equal(expectsSyntaxError(["clientError SYNTAX_ERROR"]), true);
  assert.equal(expectsSyntaxError(["clientError 62"]), true);
  assert.equal(expectsSyntaxError(["serverError SYNTAX_ERROR"]), false);
});

test("spots files that switch to another dialect", () => {
  assert.equal(usesOtherDialect("SET dialect = 'kusto';\nprint 1;"), true);
  assert.equal(usesOtherDialect("SELECT 1 SETTINGS dialect='prql'"), true);
  assert.equal(usesOtherDialect("SET dialect = 'clickhouse'; SELECT 1"), false);
});
