import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { objectDefinitions, objectReferences, objects, ParseCache } from "../../src/index.js";

/** The objects of `sql` as `kind database.name`, `kind name` or `temporary kind name`. */
function made(sql: string): string[] {
  return objects(sql).map((o) => `${o.temporary ? "temporary " : ""}${o.kind} ${o.database === undefined ? "" : `${o.database}.`}${o.name}`);
}

/** The references of `sql` as `kind database.name@text`, with the text they cover. */
function named(sql: string): string[] {
  return objectReferences(sql).map((r) => `${r.kind} ${r.database === undefined ? "" : `${r.database}.`}${r.name}@${sql.slice(r.start, r.end)}`);
}

describe("objects", () => {
  test("finds what CREATE makes, by kind", () => {
    const sql = [
      "CREATE TABLE IF NOT EXISTS db.t (x UInt8) ENGINE = Memory",
      "CREATE OR REPLACE VIEW v AS SELECT 1",
      "CREATE MATERIALIZED VIEW db.mv TO db.t AS SELECT 1 AS x",
      "CREATE DICTIONARY d (k UInt64, v String) PRIMARY KEY k SOURCE(NULL()) LAYOUT(FLAT()) LIFETIME(0)",
      "CREATE FUNCTION plus_one AS (x) -> x + 1",
      "CREATE DATABASE IF NOT EXISTS logs",
      "REPLACE TABLE `my table` (x UInt8) ENGINE = Memory",
      "CREATE TEMPORARY TABLE tmp (x UInt8)",
      "SELECT 1",
    ].join(";\n");
    assert.deepEqual(made(sql), [
      "table db.t", "view v", "materialized view db.mv", "dictionary d", "function plus_one", "database logs", "table my table", "temporary table tmp",
    ]);
    const [first] = objects(sql);
    assert.equal(sql.slice(first!.nameStart, first!.nameEnd), "db.t");
    assert.equal(first!.start, 0);
  });

  test("an earlier USE gives the database of a name without one", () => {
    const sql = "CREATE TABLE a (x UInt8) ENGINE = Memory; USE db1; CREATE TABLE b (x UInt8) ENGINE = Memory; USE DATABASE db2; CREATE VIEW c AS SELECT 1; CREATE TABLE other.d (x UInt8) ENGINE = Memory; CREATE TEMPORARY TABLE e (x UInt8); CREATE FUNCTION f AS () -> 1";
    assert.deepEqual(made(sql), ["table a", "table db1.b", "view db2.c", "table other.d", "temporary table e", "function f"]);
  });

  test("a parameter for the database is kept as written, and a parameter for the name makes nothing", () => {
    assert.deepEqual(made("CREATE TABLE {CLICKHOUSE_DATABASE:Identifier}.t (x UInt8) ENGINE = Memory; CREATE TABLE {name:Identifier} (x UInt8) ENGINE = Memory"), [
      "table {CLICKHOUSE_DATABASE:Identifier}.t",
    ]);
  });

  test("inline data and comments do not make objects", () => {
    const sql = "INSERT INTO t FORMAT CSV\n1,'CREATE TABLE fake (x UInt8) ENGINE = Memory;\n\n-- CREATE TABLE commented (x UInt8)\nCREATE TABLE real (x UInt8) ENGINE = Memory";
    assert.deepEqual(made(sql), ["table real"]);
  });
});

describe("objectReferences", () => {
  test("finds the tables that statements name", () => {
    const sql = [
      "SELECT t.x, extract(DAY FROM d) FROM db.t JOIN u ON t.x = u.x",
      "INSERT INTO db.t VALUES (1)",
      "INSERT INTO TABLE u SELECT * FROM v",
      "ALTER TABLE t DELETE WHERE 1",
      "DROP TABLE IF EXISTS a, b",
      "TRUNCATE c",
      "OPTIMIZE TABLE e FINAL",
      "RENAME TABLE f TO g",
      "EXCHANGE TABLES h AND i",
      "DESCRIBE j",
      "SHOW CREATE TABLE k",
      "EXISTS TABLE l",
      "CREATE TABLE m AS n",
      "CREATE MATERIALIZED VIEW o TO p AS SELECT 1 FROM q",
    ].join(";\n");
    assert.deepEqual(named(sql), [
      "database db@db", "table db.t@db.t", "table u@u",
      "database db@db", "table db.t@db.t",
      "table u@u", "table v@v",
      "table t@t",
      "table a@a", "table b@b",
      "table c@c",
      "table e@e",
      "table f@f", "table g@g",
      "table h@h", "table i@i",
      "table j@j",
      "table k@k",
      "table l@l",
      "table m@m", "table n@n",
      "table o@o", "table p@p", "table q@q",
    ]);
  });

  test("an earlier USE gives the database, and USE names a database", () => {
    assert.deepEqual(named("SELECT * FROM a; USE db1; SELECT * FROM b; USE DATABASE db2; SELECT * FROM other.c"), [
      "table a@a", "database db1@db1", "table db1.b@b", "database db2@db2", "database other@other", "table other.c@other.c",
    ]);
  });

  test("leaves out a name that a CTE of the statement takes, and statements that do not parse", () => {
    assert.deepEqual(named("WITH t AS (SELECT 1) SELECT * FROM t JOIN db.t USING (x); SELECT * FROM u WHERE; SELECT * FROM `v w`"), [
      "database db@db", "table db.t@db.t", "table v w@`v w`",
    ]);
  });

  test("takes the statements from the cache", () => {
    const cache = new ParseCache();
    assert.deepEqual(objectReferences("SELECT * FROM t", { cache }), objectReferences("SELECT * FROM t"));
  });
});

describe("objectDefinitions", () => {
  const texts = new Map([
    ["a.sql", "USE db1; CREATE TABLE t (x UInt8) ENGINE = Memory; CREATE TABLE t2 (x UInt8) ENGINE = Memory; CREATE DATABASE db1"],
    ["b.sql", "CREATE TABLE db1.t (x UInt8) ENGINE = Memory; CREATE TABLE db2.t (x UInt8) ENGINE = Memory; CREATE TEMPORARY TABLE t2 (x UInt8); SELECT * FROM t2; USE db2; SELECT * FROM t2; SELECT * FROM db1.t2"],
    ["c.sql", "CREATE TABLE t (x UInt8) ENGINE = Memory; CREATE TABLE t (y UInt8) ENGINE = Memory; CREATE FUNCTION t AS () -> 1; SELECT * FROM t"],
    ["d.sql", "SELECT * FROM t; SELECT * FROM db2.t; SELECT * FROM t2; SELECT * FROM db1.t; USE db1; SELECT * FROM t"],
  ]);
  const files = new Map([...texts].map(([file, sql]) => [file, objects(sql)]));
  /** Where the object is created, as file:database.name@offset. */
  const where = (file: string, written: string, nth = 0) => {
    const sql = texts.get(file)!;
    const object = objects(sql).filter((o) => sql.slice(o.nameStart, o.nameEnd) === written)[nth]!;
    return `${file}:${object.database ?? ""}.${object.name}@${object.nameStart}`;
  };
  /** The definitions of the `nth` reference to `written` in `file`. */
  const of = (file: string, written: string, nth = 0) => {
    const sql = texts.get(file)!;
    const reference = objectReferences(sql).filter((r) => sql.slice(r.start, r.end) === written)[nth];
    assert.ok(reference, `${written} is referenced ${nth + 1} times in ${file}`);
    return objectDefinitions(reference, file, files).map(({ file, object }) => `${file}:${object.database ?? ""}.${object.name}@${object.nameStart}`);
  };

  test("a database written or set by USE finds the tables of that database", () => {
    assert.deepEqual(of("d.sql", "db2.t"), [where("b.sql", "db2.t")]);
    assert.deepEqual(of("d.sql", "t", 1), [where("a.sql", "t"), where("b.sql", "db1.t")]);
  });

  test("a name in the session's database may be any table of that name, but not a function", () => {
    assert.deepEqual(of("d.sql", "t"), [where("a.sql", "t"), where("b.sql", "db1.t"), where("b.sql", "db2.t"), where("c.sql", "t"), where("c.sql", "t", 1)]);
  });

  test("in the same file, the last CREATE before the name", () => {
    assert.deepEqual(of("c.sql", "t", 2), [where("c.sql", "t", 1)]);
  });

  test("a temporary table is found only from its own file, before the tables of the database", () => {
    assert.deepEqual(of("b.sql", "t2"), [where("b.sql", "t2")]);
    assert.deepEqual(of("b.sql", "t2", 1), [where("b.sql", "t2")]);
    assert.deepEqual(of("b.sql", "db1.t2"), [where("a.sql", "t2")]);
    assert.deepEqual(of("d.sql", "t2"), [where("a.sql", "t2")]);
  });

  test("a database name finds CREATE DATABASE", () => {
    assert.deepEqual(of("d.sql", "db1"), [where("a.sql", "db1")]);
  });
});
