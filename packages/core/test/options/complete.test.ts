import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { complete, describe as describeName } from "../../src/index.js";

const at = (text: string) => {
  const offset = text.indexOf("|");
  return complete(text.replace("|", ""), offset);
};
const labels = (text: string) => at(text).map((c) => c.label);

describe("completion of options", () => {
  test("offers the settings of the engine whose SETTINGS the cursor is in", () => {
    const mergeTree = at("CREATE TABLE t (x UInt64) ENGINE = MergeTree ORDER BY x SETTINGS index_gr|");
    assert.deepEqual(mergeTree.map((c) => c.label), ["index_granularity", "index_granularity_bytes"]);
    assert.equal(mergeTree[0]!.detail, "UInt64 · MergeTree setting");
    assert.match(mergeTree[0]!.documentation!, /^`UInt64`, default `8192`/);
    assert.ok(labels("CREATE TABLE t (x UInt64) ENGINE = Kafka SETTINGS kafka_|").includes("kafka_num_consumers"));
    assert.ok(labels("CREATE TABLE t (x UInt64) ENGINE = Memory SETTINGS |").slice(0, 5).includes("max_rows_to_keep"));
    assert.ok(labels("CREATE DATABASE d ENGINE = Replicated('a', 'b', 'c') SETTINGS |").includes("max_broken_tables_ratio"));
    assert.ok(labels("BACKUP TABLE t TO Null SETTINGS |").slice(0, 40).includes("structure_only"));
    assert.ok(labels("ALTER TABLE t MODIFY SETTING index_gr|").includes("index_granularity"));
    assert.deepEqual(labels("CREATE TABLE t (x UInt64 SETTINGS (|"), ["max_compress_block_size", "min_compress_block_size"]);
    assert.deepEqual(labels("CREATE TABLE t ENGINE = Memory AS SELECT 1 SETTINGS index_gr|"), []);
    assert.ok(labels("EXPLAIN PLAN actions = 1, |").includes("indexes"));
    assert.ok(labels("EXPLAIN QUERY TREE |").includes("dump_passes"));
  });

  test("offers the values a setting takes", () => {
    assert.ok(labels("SET join_algorithm = |").includes("'grace_hash'"));
    assert.deepEqual(labels("SET use_uncompressed_cache = |").slice(0, 2), ["0", "1"]);
    assert.ok(labels("CREATE TABLE t (x UInt64) ENGINE = MergeTree ORDER BY x SETTINGS deduplicate_merge_projection_mode = |").includes("'rebuild'"));
    assert.ok(labels("SET session_timezone = |").includes("'Europe/Berlin'"));
  });

  test("offers codecs, their parameters, index types, statistics types and database engines", () => {
    const codecs = at("CREATE TABLE t (x UInt64 CODEC(Delta, |");
    assert.ok(codecs.every((c) => c.kind === "codec"));
    assert.ok(codecs.some((c) => c.label === "ZSTD" && /Good compression/.test(c.documentation ?? "")));
    assert.ok(!codecs.some((c) => c.label === "Multiple"));
    assert.deepEqual(labels("CREATE TABLE t (x UInt64 CODEC(T64(|"), ["'bit'", "'byte'"]);
    const indexes = at("CREATE TABLE t (x String, INDEX i x TYPE |");
    assert.ok(indexes.some((c) => c.label === "bloom_filter" && c.kind === "index type" && c.detail === "bloom_filter([false_positive_rate])"));
    assert.ok(!indexes.some((c) => c.label === "hypothesis"));
    assert.ok(labels("CREATE TABLE t (x UInt64 STATISTICS(|").includes("tdigest"));
    assert.ok(labels("ALTER TABLE t ADD STATISTICS x TYPE tdigest, |").includes("uniq"));
    const databases = at("CREATE DATABASE d ENGINE = |");
    assert.ok(databases.some((c) => c.label === "Atomic" && c.kind === "database engine"));
    assert.ok(!databases.some((c) => c.label === "MergeTree"));
    assert.ok(labels("SELECT 1 INTO OUTFILE 'f' COMPRESSION |").includes("'gzip'"));
  });

  test("describes codecs, index types, statistics types and database engines", () => {
    assert.match(describeName("zstd", "codec")!.documentation, /Good compression/);
    assert.equal(describeName("zstd", "codec")!.name, "ZSTD");
    assert.match(describeName("bloom_filter")!.documentation, /INDEX name expr TYPE bloom_filter/);
    assert.match(describeName("tdigest", "statistics type")!.documentation, /percentiles/);
    assert.match(describeName("Replicated", "database engine")!.documentation, /ENGINE = Replicated/);
  });
});
