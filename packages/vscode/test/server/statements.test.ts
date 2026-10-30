import * as assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseError } from "../../src/server/client.js";
import { namedSpan, selectQueries } from "../../src/server/statements.js";

/** The texts selectQueries() would send to the server. */
function queries(text: string): string[] {
  return selectQueries(text).map((q) => text.slice(q.start, q.end));
}

/** The text of the span namedSpan() finds for `message` in the only query of `text`. */
function named(text: string, message: string): string | undefined {
  const [query] = selectQueries(text);
  const span = namedSpan(text, query!, message);
  return span && text.slice(span.start, span.end);
}

describe("selectQueries", () => {
  test("takes SELECT and WITH statements whole", () => {
    assert.deepEqual(queries("SELECT 1; with 1 AS x select x;\n-- note\nSELECT 2 FORMAT JSON"), [
      "SELECT 1",
      "with 1 AS x select x",
      "SELECT 2 FORMAT JSON",
    ]);
  });

  test("takes the SELECT of CREATE ... AS SELECT and INSERT ... SELECT", () => {
    assert.deepEqual(
      queries(
        [
          "CREATE MATERIALIZED VIEW db.mv ON CLUSTER '{cluster}' TO db.t AS SELECT a AS b FROM db.src GROUP BY b;",
          "CREATE TABLE t (x UInt8 ALIAS 1) ENGINE = MergeTree ORDER BY tuple() AS WITH 1 AS y SELECT y;",
          "CREATE VIEW v AS SELECT 1 COMMENT 'one';",
          "INSERT INTO t (a, b) SELECT 1, 2;",
          "INSERT INTO t WITH 1 AS x SELECT x;",
        ].join("\n"),
      ),
      ["SELECT a AS b FROM db.src GROUP BY b", "WITH 1 AS y SELECT y", "SELECT 1", "SELECT 1, 2", "WITH 1 AS x SELECT x"],
    );
  });

  test("skips other statements and statements with syntax errors", () => {
    const text =
      "SHOW TABLES; DROP TABLE t; CREATE TABLE t2 AS t; WITH 1 AS x INSERT INTO t SELECT x; SELECT (1; CREATE VIEW v TO TO t AS SELECT 2; SELECT 3";
    assert.deepEqual(queries(text), ["SELECT 3"]);
  });

  test("leaves out INTO OUTFILE, which only the client can do", () => {
    assert.deepEqual(queries("SELECT 1 INTO OUTFILE 'x.csv' FORMAT CSV"), ["SELECT 1"]);
  });

  test("never reads the inline data of an INSERT as statements", () => {
    const text = [
      "INSERT INTO t VALUES (1, ';SELECT 2'), (3);",
      "SELECT 4;",
      "INSERT INTO t FORMAT TSV",
      "a;SELECT 5",
      "b';SELECT 6",
      "",
      "SELECT 7;",
      "INSERT INTO t SELECT * FROM input('x String') FORMAT CSV",
      "x;SELECT 8",
      "",
      "INSERT INTO t SELECT format FROM u;",
      "SELECT 9",
    ].join("\n");
    assert.deepEqual(queries(text), ["SELECT 4", "SELECT 7", "SELECT format FROM u", "SELECT 9"]);
  });
});

describe("namedSpan", () => {
  test("finds the identifier a message names", () => {
    const sql = "SELECT Timestamp AS timestamp, mapKeys(message) AS message_keys FROM logs.t GROUP BY timestamp, message_key";
    assert.equal(named(sql, "Unknown expression identifier `message_key`. Maybe you meant: ['message_keys']. In scope SELECT ..."), "message_key");
    assert.equal(named("SELECT `weird name` FROM t", "Unknown expression identifier `weird name`. In scope SELECT"), "`weird name`");
    assert.equal(named("SELECT foo(1)", "Function with name `foo` does not exist. In scope SELECT foo(1)."), "foo");
    assert.equal(named("SELECT toYear('a')", "Arguments of function toYear do not match its signature: In scope"), "toYear");
    assert.equal(named("SELECT * FROM nopefunc(1)", "Unknown table function nopefunc."), "nopefunc");
    assert.equal(named("SELECT 1 FROM nodb.t", "Database nodb does not exist."), "nodb");
  });

  test("spans compound names, or the longest tail of them that the query spells out", () => {
    assert.equal(named("SELECT 1 FROM logs . nope", "Unknown table expression identifier 'logs.nope'. Maybe you meant system.one?"), "logs . nope");
    assert.equal(named("SELECT nope.x FROM t", "Unknown expression identifier `nope.x`. In scope SELECT nope.x FROM t."), "nope.x");
    assert.equal(
      named("SELECT a, count() FROM db.t", "Column 'db.t.a' is not under aggregate function and not in GROUP BY keys. In query SELECT a"),
      "a",
    );
  });

  test("gives nothing when no name is in the message or in the query", () => {
    assert.equal(named("SELECT 1 + 'a'", "Illegal types UInt8 and String of arguments of function plus: In scope SELECT 1 + 'a'."), undefined);
    assert.equal(named("SELECT 'a' IN (1)", "Cannot convert string 'a' to type UInt8."), undefined);
    assert.equal(named("SELECT x FROM t", "Unknown expression identifier `y`. In scope SELECT x FROM t."), undefined);
  });
});

describe("parseError", () => {
  test("keeps the message of the first line and the error name", () => {
    const body =
      "Code: 47. DB::Exception: Unknown expression identifier `x`. In scope SELECT x. (UNKNOWN_IDENTIFIER) (version 26.11.1.1)\n";
    assert.deepEqual(parseError(body), { message: "Unknown expression identifier `x`. In scope SELECT x.", codeName: "UNKNOWN_IDENTIFIER" });
    const official = "Code: 47. DB::Exception: Unknown expression identifier `x`. (UNKNOWN_IDENTIFIER) (version 26.10.2.103 (official build))";
    assert.deepEqual(parseError(official), { message: "Unknown expression identifier `x`.", codeName: "UNKNOWN_IDENTIFIER" });
    assert.deepEqual(parseError("Code: 516. DB::Exception: u: Authentication failed. (AUTHENTICATION_FAILED)\nstack"), {
      message: "u: Authentication failed.",
      codeName: "AUTHENTICATION_FAILED",
    });
  });
});
