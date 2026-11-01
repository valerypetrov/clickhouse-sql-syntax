import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { checkWithRoles, ParseCache } from "../../src/parser/index.js";
import { selectionRanges } from "../../src/structure/index.js";

/** The text of each range around the offset where `marker` starts, plus `shift`. */
function grow(sql: string, marker: string, shift = 0): string[] {
  const at = sql.indexOf(marker);
  assert.ok(at >= 0, marker);
  return selectionRanges(sql, [at + shift])[0]!.map((r) => sql.slice(r.start, r.end));
}

const QUERY = "-- Top.\nSELECT a, f(b + 1, c) AS x FROM db.t WHERE y IN (SELECT z FROM u WHERE z > 1) ORDER BY a;";
const STATEMENT = QUERY.slice(8, -1);

describe("selectionRanges()", () => {
  test("grows from a token through its expression, call, list and clause to the statement", () => {
    assert.deepEqual(grow(QUERY, "b +"), [
      "b",
      "b + 1",
      "b + 1, c",
      "(b + 1, c)",
      "f(b + 1, c)",
      "f(b + 1, c) AS x",
      "a, f(b + 1, c) AS x",
      "SELECT a, f(b + 1, c) AS x",
      STATEMENT,
      `${STATEMENT};`,
      QUERY,
    ]);
  });

  test("goes out of a subquery through its brackets", () => {
    assert.deepEqual(grow(QUERY, "z >").slice(0, 8), [
      "z",
      "z > 1",
      "WHERE z > 1",
      "SELECT z FROM u WHERE z > 1",
      "(SELECT z FROM u WHERE z > 1)",
      "y IN (SELECT z FROM u WHERE z > 1)",
      "WHERE y IN (SELECT z FROM u WHERE z > 1)",
      STATEMENT,
    ]);
    assert.deepEqual(grow("SELECT * FROM (SELECT 1) AS s JOIN t ON s.k = t.k", "t.k").slice(0, 4), ["t", "t.k", "s.k = t.k", "JOIN t ON s.k = t.k"]);
  });

  test("starts at the word that the cursor is right after, else at the token it is in", () => {
    assert.deepEqual(grow("SELECT ab, c", ",").slice(0, 1), ["ab"]);
    assert.deepEqual(grow("SELECT f(x)", "(").slice(0, 1), ["f"]);
    assert.deepEqual(grow("SELECT 'a b' /* c */, 1", "b'").slice(0, 1), ["'a b'"]);
    assert.deepEqual(grow("SELECT 'a b' /* c */, 1", "c */").slice(0, 2), ["/* c */", "'a b' /* c */, 1"]);
    // Between tokens, the smallest piece around the cursor.
    assert.deepEqual(grow("SELECT f(a,  b)", "  b", 1).slice(0, 1), ["a,  b"]);
  });

  test("goes through the columns, types and clauses of CREATE TABLE", () => {
    const sql = "CREATE TABLE t (id UInt64, s Nullable(String)) ENGINE = MergeTree ORDER BY (id, s)";
    assert.deepEqual(grow(sql, "String").slice(0, 6), ["String", "(String)", "Nullable(String)", "s Nullable(String)", "id UInt64, s Nullable(String)", "(id UInt64, s Nullable(String))"]);
    assert.deepEqual(grow(sql, "s)").slice(0, 4), ["s", "id, s", "(id, s)", "ORDER BY (id, s)"]);
  });

  test("gives one chain per offset, and none between statements", () => {
    const sql = "SELECT 1;\n\nSELECT 2";
    const chains = selectionRanges(sql, [7, 10, 18, -5, 99]);
    assert.deepEqual(
      chains.map((chain) => chain.map((r) => sql.slice(r.start, r.end))),
      [["1", "SELECT 1", "SELECT 1;"], [], ["2", "SELECT 2"], ["SELECT", "SELECT 1", "SELECT 1;"], ["2", "SELECT 2"]],
    );
  });

  test("reads inline data as one piece, and comments between statements as a paragraph", () => {
    assert.deepEqual(grow("INSERT INTO t VALUES (1, 'a;'), (2, 'b')", "'b'"), ["(1, 'a;'), (2, 'b')", "INSERT INTO t VALUES (1, 'a;'), (2, 'b')"]);
    assert.deepEqual(grow("-- one\n-- two\n\nSELECT 1", "two"), ["-- two", "-- one\n-- two"]);
  });

  test("still finds the brackets of a statement that does not parse or nests too deep", () => {
    // A bracket that is never closed runs to the end.
    assert.deepEqual(grow("SELECT f(a, (b", "b"), ["b", "f(a, (b", "SELECT f(a, (b"]);
    // As while a name is typed.
    assert.deepEqual(grow("SELECT * FROM db.", "db"), ["db", "db.", "FROM db.", "SELECT * FROM db."]);
    assert.deepEqual(grow("SYSTEM FROM 'x')", "x"), ["'x'", "SYSTEM FROM 'x')"]);
    for (const depth of [983, 5000]) {
      const sql = `SELECT ${"[".repeat(depth)}1${"]".repeat(depth)}`;
      const chain = grow(sql, "1");
      assert.equal(chain[0], "1");
      assert.ok(chain.length > depth, `${chain.length} ranges at depth ${depth}`);
    }
  });

  test("each range holds the one before it and the offset", () => {
    const sql = [
      "WITH a AS (SELECT 1 AS x) SELECT x, count() OVER (PARTITION BY x ORDER BY x) FROM a ARRAY JOIN [1, 2] AS y",
      "CREATE TABLE t (k UInt8, v String CODEC(ZSTD(1)), INDEX i v TYPE bloom_filter) ENGINE = MergeTree ORDER BY k TTL now() + INTERVAL 1 DAY",
      "ALTER TABLE t ADD COLUMN w UInt8 AFTER v, DROP COLUMN x, UPDATE v = 'a' WHERE k = 1",
      "SELECT CASE WHEN a THEN [b, c] ELSE map('k', {p:String}) END FROM t SETTINGS max_threads = 1 FORMAT JSON",
    ].join(";\n");
    const offsets = Array.from({ length: sql.length + 1 }, (_, i) => i);
    selectionRanges(sql, offsets).forEach((chain, at) => {
      let previous = { start: at, end: at };
      for (const range of chain) {
        assert.ok(range.start <= previous.start && previous.end <= range.end, `${at}: ${JSON.stringify([previous, range])}`);
        assert.ok(range.end - range.start > previous.end - previous.start || previous.start === at, `${at}: the same range twice`);
        previous = range;
      }
    });
  });

  test("parses nothing again when the cache already has the statements", () => {
    const heavy = "SELECT((((((((((SELECT(((((((((SELECT((((((((((SELECT(((((((((SELECT((((((((((SELECT(((((((((SELECT 1+)))))))))))))))))))))))))))))))))))))))))))))))))))))))))";
    const sql = `SELECT a FROM t;\n${heavy}`;
    const cache = new ParseCache();
    const start = performance.now();
    checkWithRoles(sql, cache);
    const parseMs = performance.now() - start;
    const again = performance.now();
    const cached = selectionRanges(sql, [7, 30], cache);
    const selectMs = performance.now() - again;
    assert.deepEqual(cached, selectionRanges(sql, [7, 30]));
    assert.ok(selectMs < parseMs / 5, `${parseMs.toFixed(0)} ms to parse, then ${selectMs.toFixed(0)} ms`);
  });
});
