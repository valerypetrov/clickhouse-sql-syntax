import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { highlight } from "../../src/highlight/index.js";
import { type Role, roles } from "../../src/parser/index.js";
import type { Scope } from "../../src/types.js";

/** The text and role of every word that has one. */
function wordRoles(sql: string): [string, Role][] {
  return roles(sql).map((span) => [sql.slice(span.start, span.end), span.role]);
}

/** The role of each listed word, in order; `sql` may hold other words in between. */
function assertRoles(sql: string, expected: [string, Role][]): void {
  const actual = wordRoles(sql);
  let from = 0;
  for (const [text, role] of expected) {
    const found = actual.findIndex(([t], i) => i >= from && t === text);
    assert.ok(found >= 0, `${JSON.stringify(text)} not found after word ${from} in ${JSON.stringify(actual)}`);
    assert.equal(actual[found]![1], role, `role of ${JSON.stringify(text)} in ${JSON.stringify(sql)}`);
    from = found + 1;
  }
}

/** The scope highlight() gives the first span with this text. */
function scopeOf(sql: string, text: string, nth = 0): Scope | undefined {
  return highlight(sql).filter((span) => sql.slice(span.start, span.end) === text)[nth]?.scope;
}

const USER_QUERY =
  "CREATE MATERIALIZED VIEW logs.mv on cluster '{cluster}' TO logs.t AS SELECT Timestamp as timestamp, " +
  "mapKeys(message) as message_keys\nFROM logs.src GROUP BY component_type, timestamp, message_key;";

describe("roles() of the user's query", () => {
  test("every word", () => {
    assert.deepEqual(wordRoles(USER_QUERY), [
      ["CREATE", "keyword"], ["MATERIALIZED", "keyword"], ["VIEW", "keyword"], ["logs", "identifier"], ["mv", "identifier"],
      ["on", "keyword"], ["cluster", "keyword"], ["TO", "keyword"], ["logs", "identifier"], ["t", "identifier"],
      ["AS", "keyword"], ["SELECT", "keyword"], ["Timestamp", "identifier"], ["as", "keyword"], ["timestamp", "identifier"],
      ["mapKeys", "function"], ["message", "identifier"], ["as", "keyword"], ["message_keys", "identifier"],
      ["FROM", "keyword"], ["logs", "identifier"], ["src", "identifier"], ["GROUP", "keyword"], ["BY", "keyword"],
      ["component_type", "identifier"], ["timestamp", "identifier"], ["message_key", "identifier"],
    ]);
  });

  test("highlight() colours Timestamp and timestamp as names", () => {
    assert.equal(scopeOf(USER_QUERY, "Timestamp"), "variable.other.sql");
    assert.equal(scopeOf(USER_QUERY, "timestamp", 0), "variable.other.sql");
    assert.equal(scopeOf(USER_QUERY, "timestamp", 1), "variable.other.sql");
    assert.equal(scopeOf(USER_QUERY, "mapKeys"), "entity.name.function.sql");
    assert.equal(scopeOf(USER_QUERY, "GROUP"), "keyword.other.sql");
  });
});

describe("keywords used as names", () => {
  test("in SELECT, WHERE, GROUP BY and ORDER BY", () => {
    assertRoles("SELECT key, type, name, user, timestamp, date, interval, table, values FROM t", [
      ["key", "identifier"], ["type", "identifier"], ["name", "identifier"], ["user", "identifier"],
      ["timestamp", "identifier"], ["date", "identifier"], ["interval", "identifier"], ["table", "identifier"],
      ["values", "identifier"], ["FROM", "keyword"],
    ]);
    assertRoles("SELECT x FROM t WHERE user = 'a' AND type IN (1) AND date > today()", [
      ["WHERE", "keyword"], ["user", "identifier"], ["AND", "keyword"], ["type", "identifier"], ["IN", "keyword"],
      ["date", "identifier"], ["today", "function"],
    ]);
    assertRoles("SELECT count() FROM t GROUP BY key, timestamp ORDER BY timestamp DESC, key LIMIT 1 BY user", [
      ["GROUP", "keyword"], ["key", "identifier"], ["timestamp", "identifier"], ["ORDER", "keyword"],
      ["timestamp", "identifier"], ["DESC", "keyword"], ["key", "identifier"], ["LIMIT", "keyword"], ["BY", "keyword"],
      ["user", "identifier"],
    ]);
  });

  test("as columns of CREATE TABLE", () => {
    assertRoles("CREATE TABLE t (key String, interval UInt32, user String, timestamp DateTime, date Date) ENGINE = Memory", [
      ["key", "identifier"], ["String", "type"], ["interval", "identifier"], ["UInt32", "type"], ["user", "identifier"],
      ["String", "type"], ["timestamp", "identifier"], ["DateTime", "type"], ["date", "identifier"], ["Date", "type"],
      ["ENGINE", "keyword"], ["Memory", "engine"],
    ]);
  });

  test("in ALTER", () => {
    assertRoles(
      "ALTER TABLE t ADD COLUMN user String, MODIFY COLUMN timestamp DateTime, DROP COLUMN type, " +
        "RENAME COLUMN key TO name, COMMENT COLUMN date 'x'",
      [
        ["ADD", "keyword"], ["COLUMN", "keyword"], ["user", "identifier"], ["String", "type"], ["MODIFY", "keyword"],
        ["timestamp", "identifier"], ["DateTime", "type"], ["DROP", "keyword"], ["type", "identifier"],
        ["RENAME", "keyword"], ["key", "identifier"], ["TO", "keyword"], ["name", "identifier"], ["COMMENT", "keyword"],
        ["date", "identifier"],
      ],
    );
  });

  test("as aliases and table names", () => {
    assertRoles("SELECT 1 AS key, x timestamp FROM t AS user", [
      ["AS", "keyword"], ["key", "identifier"], ["x", "identifier"], ["timestamp", "identifier"], ["FROM", "keyword"],
      ["t", "identifier"], ["AS", "keyword"], ["user", "identifier"],
    ]);
    assertRoles("INSERT INTO index VALUES (1)", [["INSERT", "keyword"], ["INTO", "keyword"], ["index", "identifier"], ["VALUES", "keyword"]]);
    assertRoles("SELECT * FROM t WHERE table IN (1)", [["table", "identifier"], ["IN", "keyword"]]);
  });

  test("a keyword stays a keyword where the parser reads one", () => {
    assertRoles("SELECT TIMESTAMP '2020-01-01', DATE '2020-01-01', timestamp('2020-01-01'), INTERVAL 1 day", [
      ["TIMESTAMP", "keyword"], ["DATE", "keyword"], ["timestamp", "function"], ["INTERVAL", "keyword"], ["day", "keyword"],
    ]);
  });
});

describe("other roles", () => {
  test("functions, even with the bracket on the next line", () => {
    assertRoles("SELECT max\n(y), quantile(0.5)(z), db.f(1) FROM numbers(10)", [
      ["max", "function"], ["y", "identifier"], ["quantile", "function"], ["db", "function"], ["f", "function"],
      ["numbers", "function"],
    ]);
  });

  test("data types", () => {
    assertRoles("SELECT CAST(x AS Nullable(Int64)), y::DOUBLE PRECISION, z::Tuple(date Date, Int8), String FROM t", [
      ["Nullable", "type"], ["Int64", "type"], ["DOUBLE", "type"], ["PRECISION", "type"], ["Tuple", "type"],
      ["date", "identifier"], ["Date", "type"], ["Int8", "type"], ["String", "identifier"],
    ]);
  });

  test("engines and settings", () => {
    assertRoles("CREATE TABLE t (j JSON(max_dynamic_paths = 2)) ENGINE = MergeTree() ORDER BY tuple() SETTINGS index_granularity = 8192", [
      ["JSON", "type"], ["max_dynamic_paths", "setting"], ["ENGINE", "keyword"], ["MergeTree", "engine"],
      ["tuple", "function"], ["SETTINGS", "keyword"], ["index_granularity", "setting"],
    ]);
    assertRoles("SET max_threads = 1", [["SET", "keyword"], ["max_threads", "setting"]]);
    assertRoles("SELECT 1 SETTINGS max_threads = 1, user = 2", [["max_threads", "setting"], ["user", "setting"]]);
  });

  test("query parameters, numbers and privileges", () => {
    assertRoles("SELECT {id:UInt64}, nan, -inf FROM {db:Identifier}.t", [
      ["id", "parameter"], ["UInt64", "parameter"], ["nan", "number"], ["inf", "number"], ["db", "parameter"],
      ["Identifier", "parameter"], ["t", "identifier"],
    ]);
    assertRoles("GRANT SELECT(x), ALTER UPDATE ON db.t TO user", [
      ["GRANT", "keyword"], ["SELECT", "keyword"], ["x", "identifier"], ["ALTER", "keyword"], ["UPDATE", "keyword"],
      ["ON", "keyword"], ["db", "identifier"],
    ]);
  });
});

describe("statements that do not parse", () => {
  test("have no roles, and highlight() colours them by what is around them", () => {
    const sql = "SELECT Timestamp FROM;\nSELECT Timestamp FROM t;";
    assert.deepEqual(wordRoles(sql), [["SELECT", "keyword"], ["Timestamp", "identifier"], ["FROM", "keyword"], ["t", "identifier"]]);
    assert.equal(roles(sql)[0]!.start, sql.indexOf("\n") + 1);
    assert.equal(scopeOf(sql, "Timestamp", 0), "keyword.other.sql");
    assert.equal(scopeOf(sql, "Timestamp", 1), "variable.other.sql");
  });

  test("the inline data of an INSERT has no roles", () => {
    assert.deepEqual(wordRoles("INSERT INTO t VALUES (key, user)"), [["INSERT", "keyword"], ["INTO", "keyword"], ["t", "identifier"], ["VALUES", "keyword"]]);
    assert.deepEqual(wordRoles("INSERT INTO t FORMAT CSV key,user\n"), [
      ["INSERT", "keyword"], ["INTO", "keyword"], ["t", "identifier"], ["FORMAT", "keyword"], ["CSV", "identifier"],
    ]);
  });
});

test("an attempt the parser gave up leaves no role behind", () => {
  // Each word is first tried as something else: a DATE literal, a SHARED path, a function, a keyword.
  // SHARED keeps the role of a name, as ClickHouse colours it.
  assertRoles("SELECT date, x::JSON(SHARED a UInt64), count, INTERVAL 1 DAY", [
    ["date", "identifier"], ["JSON", "type"], ["SHARED", "identifier"], ["a", "identifier"], ["UInt64", "type"],
    ["count", "identifier"], ["INTERVAL", "keyword"], ["DAY", "keyword"],
  ]);
});
