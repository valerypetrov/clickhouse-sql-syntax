import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { check, checkOptions, checkWithRoles, type Diagnostic, messageFixes, nameHints, ParseCache } from "../../src/index.js";

/** Each fix of the diagnostics of `sql` as the text it gives, with a * when it is preferred. */
function fixed(sql: string, diagnostics: Diagnostic[] = [...check(sql), ...checkOptions(sql)]): string[] {
  return diagnostics.flatMap((d) =>
    (d.fixes ?? []).map((fix) => {
      let text = sql;
      for (const edit of [...fix.edits].sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.newText + text.slice(edit.end);
      return `${fix.preferred ? "*" : ""}${text}`;
    }),
  );
}

describe("quick fixes", () => {
  test("write the keyword that a syntax error hints at, in the case of the word", () => {
    assert.deepEqual(fixed("SELEC 1"), ["*SELECT 1"]);
    assert.deepEqual(fixed("selec 1"), ["*select 1"]);
    assert.deepEqual(fixed("SELECT 1 FROM t WHER x"), []);
  });

  test("keep their offsets through the parse cache", () => {
    const cache = new ParseCache();
    const sql = "SELECT 1;\nSELECT 2 SETTINGS max_thread = 1;\nSELEC 3";
    checkWithRoles(sql, cache);
    const again = [...checkWithRoles(sql, cache).diagnostics, ...checkOptions(sql, cache)];
    assert.deepEqual(fixed(sql, again), ["*SELECT 1;\nSELECT 2 SETTINGS max_thread = 1;\nSELECT 3", "*SELECT 1;\nSELECT 2 SETTINGS max_threads = 1;\nSELEC 3"]);
  });

  test("rename unknown settings to the closest ones of their place", () => {
    assert.deepEqual(fixed("SELECT 1 SETTINGS max_thread = 1"), ["*SELECT 1 SETTINGS max_threads = 1"]);
    assert.deepEqual(fixed("SET Max_Threads = 1"), ["*SET max_threads = 1"]);
    assert.deepEqual(fixed("CREATE TABLE t (x UInt64) ENGINE = MergeTree ORDER BY x SETTINGS index_granularit = 1"), [
      "*CREATE TABLE t (x UInt64) ENGINE = MergeTree ORDER BY x SETTINGS index_granularity = 1",
    ]);
    assert.deepEqual(fixed("SET zz_nothing_like_it = 1"), []);
  });

  test("rename unknown codecs, index types, statistics, formats and compression methods", () => {
    assert.deepEqual(fixed("CREATE TABLE t (x UInt64 CODEC(ZST(3))) ENGINE = MergeTree ORDER BY x"), ["*CREATE TABLE t (x UInt64 CODEC(ZSTD(3))) ENGINE = MergeTree ORDER BY x"]);
    // Only index types that take the parameters written.
    assert.deepEqual(fixed("CREATE TABLE t (x UInt64, INDEX i x TYPE minmx) ENGINE = MergeTree ORDER BY x"), ["*CREATE TABLE t (x UInt64, INDEX i x TYPE minmax) ENGINE = MergeTree ORDER BY x"]);
    assert.deepEqual(fixed("CREATE TABLE t (s String, INDEX i s TYPE tokenbf_v2(256, 2, 0)) ENGINE = MergeTree ORDER BY s"), [
      "*CREATE TABLE t (s String, INDEX i s TYPE tokenbf_v1(256, 2, 0)) ENGINE = MergeTree ORDER BY s",
    ]);
    assert.deepEqual(fixed("CREATE TABLE t (x UInt64 STATISTICS(tdigst)) ENGINE = MergeTree ORDER BY x"), ["*CREATE TABLE t (x UInt64 STATISTICS(tdigest)) ENGINE = MergeTree ORDER BY x"]);
    assert.deepEqual(fixed("SELECT 1 FORMAT JSONEachRw"), ["*SELECT 1 FORMAT JSONEachRow", "SELECT 1 FORMAT BSONEachRow"]);
    // An INSERT takes the formats ClickHouse reads.
    assert.ok(!fixed("INSERT INTO t FORMAT Prety\n").some((text) => text.includes("Pretty")));
    assert.deepEqual(fixed("SELECT 1 INTO OUTFILE 'f' COMPRESSION 'zstdd'"), ["*SELECT 1 INTO OUTFILE 'f' COMPRESSION 'zstd'"]);
  });

  test("fix values: an enum value's typo, and a value that the setting takes as a string", () => {
    assert.deepEqual(fixed("SET join_algorithm = 'hsh'"), ["*SET join_algorithm = 'hash'"]);
    assert.deepEqual(fixed("SET join_algorithm = 'hash,grce_hash'"), ["*SET join_algorithm = 'hash,grace_hash'"]);
    assert.deepEqual(fixed("SET join_algorithm = 'has,hash'"), ["*SET join_algorithm = 'hash,hash'"]);
    assert.deepEqual(fixed("SET format_csv_delimiter = 1"), ["*SET format_csv_delimiter = '1'"]);
    // Quoted, these are still wrong, or may be: settings of strings such as format check their values further.
    assert.deepEqual(fixed("SET join_algorithm = 1"), []);
    assert.deepEqual(fixed("SET format_csv_delimiter = 12"), []);
    assert.deepEqual(fixed("SET format = 1"), []);
    assert.deepEqual(fixed("SET log_comment = NULL"), []);
  });

  test("add ENGINE where default_table_engine is None", () => {
    const none = "SET default_table_engine = 'None';\n";
    assert.deepEqual(checkOptions("CREATE TABLE t (x UInt64)"), []);
    assert.deepEqual(checkOptions(`${none}CREATE TABLE t (x UInt64)`).map((d) => d.message), ["Table engine is not specified in CREATE query."]);
    assert.deepEqual(fixed(`${none}CREATE TABLE t (x UInt64)`), [`*${none}CREATE TABLE t (x UInt64) ENGINE = MergeTree ORDER BY tuple()`]);
    assert.deepEqual(fixed(`${none}CREATE TABLE IF NOT EXISTS t (x UInt64) PRIMARY KEY x`), [`*${none}CREATE TABLE IF NOT EXISTS t (x UInt64) ENGINE = MergeTree PRIMARY KEY x`]);
    assert.deepEqual(fixed(`${none}CREATE OR REPLACE TABLE t AS SELECT 1 AS x ORDER BY x`), [`*${none}CREATE OR REPLACE TABLE t ENGINE = MergeTree ORDER BY tuple() AS SELECT 1 AS x ORDER BY x`]);
    // These do not need one: a temporary table, the engine of another table or of a table function, and after the setting is reset.
    for (const sql of ["CREATE TEMPORARY TABLE t (x UInt64)", "CREATE TABLE t AS other", "CREATE TABLE t AS numbers(1)", "CREATE TABLE t (x UInt64) ENGINE = Memory",
      "SET default_table_engine = DEFAULT; CREATE TABLE t (x UInt64)", "SET default_table_engine = 'Memory'; CREATE TABLE t (x UInt64)"])
      assert.deepEqual(checkOptions(`${none}${sql}`), [], sql);
  });

  test("nameHints follows ClickHouse's NamePrompter", () => {
    assert.deepEqual(nameHints("max_thread", ["max_threads", "max_insert_threads", "min_threads"]), [{ name: "max_threads", distance: 1 }, { name: "min_threads", distance: 3 }]);
    // A name much shorter or longer is no hint, however few edits apart.
    assert.deepEqual(nameHints("ab", ["abc"]), []);
  });

  test("messageFixes reads the hints of ClickHouse's messages", () => {
    const sql = "SELECT arrayMp(x -> x, [1]) FROM sytem.numbers";
    const at = (name: string) => [sql.indexOf(name), sql.indexOf(name) + name.length] as const;
    const titles = (start: number, end: number, message: string) => messageFixes(sql, start, end, message).map((f) => `${f.preferred ? "*" : ""}${f.title}`);
    assert.deepEqual(titles(...at("arrayMp"), "Function with name `arrayMp` does not exist. Maybe you meant: ['arrayMax','arrayMap']. In scope ..."), ["*Change to arrayMap", "Change to arrayMax"]);
    assert.deepEqual(titles(...at("arrayMp"), "Maybe you meant: ['arrayMax','arrayMan']"), ["Change to arrayMax", "Change to arrayMan"]);
    assert.deepEqual(titles(...at("sytem"), "Database sytem does not exist. Maybe you meant system?."), ["*Change to system"]);
    // Not a name: the whole query, when the message names nothing in it.
    assert.deepEqual(titles(0, sql.length, "Unknown data type family: Strng. Maybe you meant: ['String']"), []);
    assert.deepEqual(titles(...at("arrayMp"), "Function with name `arrayMp` does not exist."), []);
  });
});
