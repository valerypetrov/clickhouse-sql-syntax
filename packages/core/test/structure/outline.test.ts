import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { checkWithRoles, ParseCache } from "../../src/parser/index.js";
import { outline } from "../../src/structure/index.js";
import type { OutlineSymbol } from "../../src/types.js";

/** Each symbol as "kind name", with its children after it. */
function tree(sql: string): unknown[] {
  const walk = (symbol: OutlineSymbol): unknown =>
    symbol.children.length ? [`${symbol.kind} ${symbol.name}`, symbol.children.map(walk)] : `${symbol.kind} ${symbol.name}`;
  return outline(sql).map(walk);
}

/** The text of each statement's range and of its name. */
function texts(sql: string): [string, string][] {
  return outline(sql).map((s) => [sql.slice(s.start, s.end), sql.slice(s.nameStart, s.nameEnd)]);
}

describe("outline()", () => {
  test("has no symbols without statements", () => {
    assert.deepEqual(outline(""), []);
    assert.deepEqual(outline("-- a comment\n/* and another */;\n;"), []);
  });

  test("names a statement by its leading keywords and the name after them", () => {
    const sql = [
      "create table if not exists db.events (id UInt64) engine = Memory",
      "DROP TABLE IF EXISTS t SYNC",
      "INSERT INTO db.t (a) VALUES (1)",
      "SET max_threads = 1",
      "SYSTEM FLUSH LOGS",
      "ALTER TABLE t ON CLUSTER c ADD COLUMN x UInt8",
      "KILL QUERY WHERE query_id = 'x'",
      "GRANT SELECT ON db.* TO u",
      "CREATE FUNCTION f AS (x) -> x + 1",
      "CREATE MATERIALIZED VIEW mv TO dst AS SELECT 1",
      "CREATE DATABASE d ENGINE = Atomic",
      "EXPLAIN PLAN header = 1 SELECT a FROM t",
      "selec 1",
    ].join(";\n");
    assert.deepEqual(tree(sql), [
      ["table CREATE TABLE db.events", ["column id"]],
      "statement DROP TABLE t",
      "statement INSERT INTO db.t",
      "statement SET max_threads",
      "statement SYSTEM FLUSH LOGS",
      "statement ALTER TABLE t",
      "statement KILL QUERY",
      "statement GRANT SELECT",
      "function CREATE FUNCTION f",
      "view CREATE MATERIALIZED VIEW mv",
      "database CREATE DATABASE d",
      "statement EXPLAIN PLAN SELECT … FROM t",
      "statement selec",
    ]);
  });

  test("names a query after the first table of its FROM", () => {
    const sql = [
      "SELECT a, b FROM db.t AS x JOIN u USING a WHERE b",
      "SELECT count() FROM numbers(10)",
      "SELECT * FROM (SELECT 1 FROM inner_table)",
      "SELECT 1",
      "WITH 1 AS x SELECT x FROM `my table`",
      "(SELECT 1 FROM a) UNION ALL (SELECT 2 FROM b)",
      "SELECT a IS DISTINCT FROM b, * EXCEPT (c) FROM t",
      "SELECT * FROM {table:Identifier}",
    ].join(";\n");
    assert.deepEqual(tree(sql), [
      "query SELECT … FROM db.t",
      "query SELECT … FROM numbers(…)",
      "query SELECT … FROM (…)",
      "query SELECT …",
      "query SELECT … FROM `my table`",
      "query SELECT … FROM a",
      "query SELECT … FROM t",
      "query SELECT … FROM {table:Identifier}",
    ]);
  });

  test("covers each statement up to its ';', and points at the name where it is written", () => {
    const sql = "-- The table.\nCREATE TABLE t (a UInt8) ENGINE = Memory; -- after\nWITH x AS (SELECT 1)\nSELECT * FROM x\n";
    assert.deepEqual(texts(sql), [
      ["CREATE TABLE t (a UInt8) ENGINE = Memory;", "t"],
      ["WITH x AS (SELECT 1)\nSELECT * FROM x", "SELECT"],
    ]);
    const [, query] = outline(sql);
    const [cte] = query!.children;
    assert.deepEqual([sql.slice(cte!.start, cte!.end), sql.slice(cte!.nameStart, cte!.nameEnd)], ["x AS (SELECT 1)", "x"]);
    assert.deepEqual(texts("SYSTEM FLUSH LOGS"), [["SYSTEM FLUSH LOGS", "SYSTEM FLUSH LOGS"]]);
  });

  test("lists the CTEs of a statement, each one inside the CTE that holds it", () => {
    const sql = [
      "WITH a AS (SELECT 1), b (x) AS MATERIALIZED (WITH c AS (SELECT 2) SELECT * FROM c), 1 AS d, (SELECT 3) AS e",
      "SELECT * FROM a, (WITH f AS (SELECT 4) SELECT * FROM f)",
    ].join(" ");
    assert.deepEqual(tree(sql), [["query SELECT … FROM a", ["cte a", ["cte b", ["cte c"]], "cte f"]]]);
    assert.deepEqual(tree("INSERT INTO t WITH g AS (SELECT 1) SELECT * FROM g"), [["statement INSERT INTO t", ["cte g"]]]);
    assert.deepEqual(tree("CREATE VIEW v AS WITH h AS (SELECT 1) SELECT * FROM h"), [["view CREATE VIEW v", ["cte h"]]]);
  });

  test("lists the columns of CREATE TABLE, VIEW and DICTIONARY, and no index or constraint", () => {
    const table = [
      "CREATE TABLE t (",
      "  id UInt64,",
      "  `user name` String DEFAULT 'x' COMMENT 'who',",
      "  index UInt8,",
      "  INDEX i id TYPE minmax,",
      "  CONSTRAINT c CHECK id > 0,",
      "  PROJECTION p (SELECT id ORDER BY id),",
      "  PRIMARY KEY id",
      ") ENGINE = MergeTree ORDER BY id",
    ].join("\n");
    assert.deepEqual(tree(table), [["table CREATE TABLE t", ["column id", "column `user name`", "column index"]]]);
    const [created] = outline(table);
    assert.equal(table.slice(created!.children[1]!.start, created!.children[1]!.end), "`user name` String DEFAULT 'x' COMMENT 'who'");
    assert.deepEqual(tree("CREATE MATERIALIZED VIEW mv TO dst (a UInt8, b String) AS SELECT a, b FROM src"), [
      ["view CREATE MATERIALIZED VIEW mv", ["column a", "column b"]],
    ]);
    assert.deepEqual(tree("CREATE VIEW v (a, b) AS SELECT 1, 2"), [["view CREATE VIEW v", ["column a", "column b"]]]);
    assert.deepEqual(tree("CREATE DICTIONARY d (id UInt64, v String DEFAULT '') PRIMARY KEY id SOURCE(NULL()) LAYOUT(FLAT()) LIFETIME(0)"), [
      ["dictionary CREATE DICTIONARY d", ["column id", "column v"]],
    ]);
    assert.deepEqual(tree("CREATE TABLE t2 AS t ENGINE = Memory"), ["table CREATE TABLE t2"]);
  });

  test("reads a statement that does not parse by ClickHouse's keywords", () => {
    assert.deepEqual(tree("CREATE TABLE events (id UInt64, x"), ["table CREATE TABLE events"]);
    assert.deepEqual(tree("WITH a AS (SELECT 1) SELECT FROM"), [["query SELECT …", ["cte a"]]]);
    // analyze() reads this one to its end too.
    assert.deepEqual(tree("SYSTEM FROM 'x' WITH y"), ["statement SYSTEM FROM"]);
  });

  test("covers inline data with its INSERT", () => {
    const sql = "INSERT INTO t FORMAT CSV\n1,'a;'\n\nSELECT 1";
    assert.deepEqual(texts(sql), [
      ["INSERT INTO t FORMAT CSV\n1,'a;'", "t"],
      ["SELECT 1", "SELECT"],
    ]);
  });

  test("parses nothing again when the cache already has the statements", () => {
    const heavy = "SELECT((((((((((SELECT(((((((((SELECT((((((((((SELECT(((((((((SELECT((((((((((SELECT(((((((((SELECT 1+)))))))))))))))))))))))))))))))))))))))))))))))))))))))))";
    const sql = `CREATE TABLE t (a UInt8);\n${heavy};\nSELECT a FROM t`;
    const cache = new ParseCache();
    const start = performance.now();
    checkWithRoles(sql, cache);
    const parseMs = performance.now() - start;
    const again = performance.now();
    const cached = outline(sql, cache);
    const outlineMs = performance.now() - again;
    assert.deepEqual(cached, outline(sql));
    assert.ok(outlineMs < parseMs / 5, `${parseMs.toFixed(0)} ms to parse, then ${outlineMs.toFixed(0)} ms`);
  });
});
