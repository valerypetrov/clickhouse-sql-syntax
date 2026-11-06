import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { check, checkOptions } from "../../src/index.js";

/** The messages of checkOptions() for one statement, each after its severity. */
const problems = (sql: string) => checkOptions(sql).map((d) => `${d.severity}: ${d.message}`);
const at = (sql: string) => checkOptions(sql).map((d) => sql.slice(d.start, d.end));

describe("checkOptions", () => {
  test("refuses unknown settings of queries as ClickHouse does", () => {
    assert.deepEqual(problems("SET max_threads = 4, zz_unknown = 1"), ["error: Unknown setting 'zz_unknown'."]);
    assert.deepEqual(at("SELECT 1 SETTINGS zz_unknown = 1"), ["zz_unknown"]);
    assert.deepEqual(problems("CREATE USER u SETTINGS zz_unknown = 1"), ["error: Unknown setting 'zz_unknown'."]);
    // DEFAULT, query parameters, the custom_ prefix and profile are taken without a check.
    assert.deepEqual(problems("SET zz = DEFAULT, param_x = 1, custom_y = 2, profile = 'p'"), []);
  });

  test("checks each value against the type of its setting", () => {
    assert.deepEqual(problems("SET max_threads = 'abc'"), [
      "error: Cannot parse input: expected 'eof' before: 'abc': while setting 'max_threads' to value 'abc'.",
    ]);
    assert.deepEqual(problems("SET use_uncompressed_cache = 2"), ["error: Field value 2 is out of range of bool type: while setting 'use_uncompressed_cache' to value 2."]);
    assert.deepEqual(problems("SET join_use_nulls = 'on'"), ["error: Cannot parse bool from string 'on': while setting 'join_use_nulls' to value 'on'."]);
    assert.match(problems("SET join_algorithm = 'zzz'")[0]!, /^error: Unexpected value of JoinAlgorithm: 'zzz'\. Must be one of \['full_sorting_merge', /);
    assert.deepEqual(problems("SET log_comment = 1"), ["error: Bad get: has UInt64, requested String: while setting 'log_comment' to value 1."]);
    assert.deepEqual(problems("SET max_block_size = 0"), ["error: A setting's value has to be greater than 0: while setting 'max_block_size' to value 0."]);
    assert.deepEqual(problems("SET session_timezone = 'Foo/Bar'"), ["error: Invalid time zone: Foo/Bar: while setting 'session_timezone' to value 'Foo/Bar'."]);
    // Values ClickHouse takes.
    for (const ok of ["SET max_threads = 10.7", "SET max_memory_usage = '10G'", "SET use_uncompressed_cache = 'TRUE'", "SET join_algorithm = 'hash,grace_hash'",
      "SET max_threads = 'auto(4)'", "SET additional_table_filters = {'t': 'x > 1'}", "SET session_timezone = 'Europe/Berlin'", "SET max_threads = true"])
      assert.deepEqual(problems(ok), [], ok);
  });

  test("checks the settings of each table and database engine", () => {
    assert.deepEqual(problems("CREATE TABLE t (x UInt64) ENGINE = MergeTree ORDER BY x SETTINGS zz = 1, index_granularity = 'abc', max_threads = 2"), [
      "error: Unknown setting 'zz': for storage MergeTree.",
      "error: Cannot parse input: expected 'eof' before: 'abc': while setting 'index_granularity' to value 'abc'.",
    ]);
    assert.deepEqual(problems("CREATE TABLE t (x UInt64) ENGINE = Kafka('b', 't', 'g', 'CSV') SETTINGS kafka_num_consumers = 'a'"), [
      "error: Cannot parse input: expected 'eof' before: 'a': while setting 'kafka_num_consumers' to value 'a'.",
    ]);
    assert.deepEqual(problems("CREATE TABLE t (x UInt64) ENGINE = Memory SETTINGS zz = 1"), ["error: Unknown setting 'zz': for storage Memory."]);
    assert.deepEqual(problems("CREATE TABLE t (x UInt64) ENGINE = Log SETTINGS disk = 'd'"), []);
    assert.deepEqual(problems("CREATE TABLE t (x UInt64) ENGINE = Join(ANY, LEFT, x) SETTINGS zz = 1"), ["error: Unknown setting zz for storage Join."]);
    assert.match(problems("CREATE TABLE t (x UInt64) ENGINE = Null SETTINGS a = 1")[0]!, /^error: Engine Null doesn't support SETTINGS clause\./);
    assert.deepEqual(problems("CREATE DATABASE d ENGINE = Atomic SETTINGS zz = 1"), ["error: Unknown setting 'zz'."]);
    assert.deepEqual(problems("CREATE TABLE t (x UInt64 SETTINGS (index_granularity = 1)) ENGINE = MergeTree ORDER BY x"), [
      "error: Setting index_granularity is unknown or not supported at column level, supported settings: max_compress_block_size, min_compress_block_size.",
    ]);
    // A query after AS SELECT has the settings of queries, and a table without ENGINE may get another default engine.
    assert.deepEqual(problems("CREATE TABLE t ENGINE = Memory AS SELECT 1 SETTINGS max_threads = 1"), []);
    assert.deepEqual(problems("CREATE TABLE t (x UInt64) ORDER BY x SETTINGS zz = 1"), []);
    assert.deepEqual(problems("ALTER TABLE t MODIFY SETTING zz = 1"), ["error: Unknown setting 'zz'."]);
    assert.deepEqual(problems("ALTER TABLE t MODIFY SETTING index_granularity = 8192, s3queue_processing_threads_num = 2"), []);
  });

  test("checks EXPLAIN, BACKUP and RESTORE settings", () => {
    assert.match(problems("EXPLAIN PLAN zz = 1 SELECT 1")[0]!, /^error: Unknown setting "zz" for EXPLAIN PLAN query\. Supported settings: actions, /);
    assert.deepEqual(problems("EXPLAIN PLAN actions = 2 SELECT 1"), ['error: Invalid value 2 for setting "actions". Expected boolean type.']);
    assert.deepEqual(problems("EXPLAIN QUERY TREE passes = 3 SELECT 1"), []);
    assert.deepEqual(problems("SELECT * FROM (EXPLAIN SYNTAX oneline = 1 SELECT 1)"), []);
    assert.deepEqual(problems("BACKUP TABLE t TO Null SETTINGS zz = 1"), ["error: Unknown setting 'zz'."]);
    assert.deepEqual(problems("RESTORE TABLE t FROM Null SETTINGS structure_only = 'x'"), [
      "error: Cannot parse bool from string 'x': while setting 'structure_only' to value 'x'.",
    ]);
  });

  test("checks codecs and their parameters", () => {
    const table = (codec: string, type = "UInt64") => `CREATE TABLE t (x ${type} CODEC(${codec})) ENGINE = MergeTree ORDER BY x`;
    assert.deepEqual(problems(table("Zzz")), ["error: Unknown codec family: Zzz."]);
    assert.deepEqual(problems(table("ZSTD(23)")), ["error: ZSTD codec can't have level more than 22, given 23."]);
    assert.deepEqual(problems(table("Delta(3), LZ4")), ["error: Delta value for delta codec can be 1, 2, 4 or 8, given 3."]);
    assert.deepEqual(problems(table("T64('zz'), LZ4")), ["error: Wrong modification for T64: zz."]);
    assert.deepEqual(problems(table("FPC(30)", "Float64")), ["error: Codec 'FPC' level must be between 1 and 28."]);
    for (const ok of ["Delta(4), ZSTD(3)", "zstd", "LZ4HC(13)", "ZSTD(-1)", "Default", "GCD, LZ4", "T64('bit'), LZ4"]) assert.deepEqual(problems(table(ok)), [], ok);
    // What allow_suspicious_codecs allows is a warning, as a profile may allow it.
    assert.deepEqual(problems(table("ZSTD, Delta")).map((p) => p.slice(0, 58)), ["warning: The combination of compression codecs ZSTD, Delta"]);
    assert.deepEqual(problems(`SET allow_suspicious_codecs = 1; ${table("ZSTD, Delta")}`), []);
    assert.deepEqual(problems(`ATTACH TABLE t (x UInt64 CODEC(Zzz)) ENGINE = MergeTree ORDER BY x`), []);
  });

  test("checks skipping index and statistics types", () => {
    const table = (index: string, type = "String") => `CREATE TABLE t (x ${type}, INDEX i x TYPE ${index}) ENGINE = MergeTree ORDER BY tuple()`;
    assert.match(problems(table("zz GRANULARITY 1"))[0]!, /^error: Unknown Index type 'zz'\. Available index types: /);
    assert.deepEqual(problems(table("bloom_filter(2) GRANULARITY 1")), ["error: The BloomFilter false positive must be a double number between 0 and 1."]);
    assert.deepEqual(problems(table("ngrambf_v1(3, 256, 2) GRANULARITY 1")), ["error: `ngrambf` index must have exactly 4 arguments."]);
    assert.deepEqual(problems(table("set(100) GRANULARITY 0")), ["error: Index GRANULARITY must be a positive integer."]);
    for (const ok of ["bloom_filter(0.01) GRANULARITY 1", "MINMAX GRANULARITY 1", "ngrambf_v1(3, 256, 2, 0) GRANULARITY 1", "text(tokenizer = splitByNonAlpha)"])
      assert.deepEqual(problems(table(ok)), [], ok);
    assert.deepEqual(problems("CREATE TABLE t (x UInt64, PROJECTION p INDEX x TYPE basic) ENGINE = MergeTree ORDER BY x"), []);
    assert.match(problems("CREATE TABLE t (x UInt64 STATISTICS(tdigest, zz)) ENGINE = MergeTree ORDER BY x")[0]!, /^error: Unknown statistics type: zz\./);
    assert.match(problems("ALTER TABLE t ADD STATISTICS x TYPE zz")[0]!, /^error: Unknown statistics type: zz\./);
    assert.deepEqual(problems("CREATE TABLE t (x UInt64 STATISTICS(TDigest, uniq)) ENGINE = MergeTree ORDER BY x"), []);
  });

  test("checks formats and compression methods", () => {
    assert.deepEqual(problems("SELECT 1 FORMAT Zzz"), ["error: Unknown format Zzz."]);
    assert.deepEqual(problems("SELECT 1 FORMAT json"), []);
    assert.match(problems("SELECT 1 INTO OUTFILE 'f' COMPRESSION 'zz'")[0]!, /^warning: Unknown compression method 'zz'\./);
    assert.deepEqual(problems("SELECT 1 INTO OUTFILE 'f' COMPRESSION 'gz'"), []);
  });

  test("leaves statements with syntax errors to check()", () => {
    const sql = "SET max_threads = 'abc' FROM";
    assert.equal(check(sql).length, 1);
    assert.deepEqual(checkOptions(sql), []);
  });

  test("gives positions as check() does", () => {
    const [d] = checkOptions("SELECT 1;\nSET\n  zz = 1");
    assert.deepEqual([d!.line, d!.col, d!.start, d!.end], [3, 3, 16, 18]);
  });
});
