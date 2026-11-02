import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { type CompletionCandidate, type CompletionSchema, complete, describe as describeName, engineArgument } from "../../src/index.js";
import { readSignature } from "../../src/complete/engines.js";
import { TABLE_ENGINES } from "../../src/generated/table-engines.js";

const schema: CompletionSchema = {
  databases: ["default", "logs"],
  tables: [
    { database: "default", name: "hits", columns: [{ name: "id", type: "UInt64" }, { name: "url", type: "String" }, { name: "ts", type: "DateTime" }] },
    { database: "logs", name: "events", columns: [{ name: "x", type: "UInt8" }] },
  ],
  clusters: ["prod", "test-cluster"],
};

const COLUMNS = "k UInt64, ver UInt32, day Date, i Int64, f Float64, d UInt8, b Bool, s Int8, t TINYINT, n Nullable(UInt64), lc LowCardinality(UInt64), str String, dec Decimal(9, 2)";

function at(text: string, options: { schema?: CompletionSchema } = { schema }): CompletionCandidate[] {
  const offset = text.indexOf("|");
  return complete(text.slice(0, offset) + text.slice(offset + 1), offset, options);
}

function labels(text: string, options?: { schema?: CompletionSchema }): string[] {
  return at(text, options).map((c) => c.label);
}

/** The suggestions before the first generic one, the keywords and functions of any expression. */
function engineLabels(text: string, options?: { schema?: CompletionSchema }): string[] {
  const found = labels(text, options);
  const generic = found.findIndex((label) => label === "CASE" || label === "abs");
  // At the first argument, the generic keywords start with ALL.
  return generic < 0 ? found : found.slice(0, found[generic - 1] === "ALL" ? generic - 1 : generic);
}

function argumentAt(text: string) {
  const offset = text.indexOf("|");
  return engineArgument(text.slice(0, offset) + text.slice(offset + 1), offset);
}

describe("engine signatures", () => {
  test("reads the syntax of every engine written as ENGINE = Name", () => {
    const unread = TABLE_ENGINES.filter((info) => !readSignature(info)).map((info) => info.name);
    assert.deepEqual(unread, ["Elasticsearch", "Loop", "MaterializedView", "Obfuscate", "QueryRunner", "View"]);
    for (const info of TABLE_ENGINES) if (info.syntax?.startsWith(`ENGINE = ${info.name}`)) assert.ok(readSignature(info), info.name);
  });

  test("lists the arguments that optional parts and alternatives allow", () => {
    const lists = (name: string) =>
      readSignature(TABLE_ENGINES.find((e) => e.name === name)!)!.lists.map((l) => l.parameters.map((p) => p.name).join(", ") + (l.repeats ? " ..." : ""));
    assert.deepEqual(lists("ReplicatedReplacingMergeTree"), ["zoo_path, replica_name", "zoo_path, replica_name, ver", "zoo_path, replica_name, ver, is_deleted"]);
    assert.deepEqual(lists("File"), ["format", "format, path", "format, fd"]);
    assert.deepEqual(lists("Join"), ["join_strictness, join_type, k1", "join_strictness, join_type, k1, k2 ..."]);
    assert.deepEqual(lists("Alias"), ["target_table", "target_db, target_table"]);
    // A compression comes only after a format, which ClickHouse would read it as.
    const s3 = lists("S3");
    assert.ok(s3.includes("url, NOSIGN, format, compression"));
    assert.ok(s3.includes("url, access_key_id, secret_access_key, session_token, format"));
    assert.ok(s3.includes("url, format, compression"));
    assert.ok(!s3.includes("url, compression"));
    assert.ok(!s3.includes("url, NOSIGN, compression"));
    assert.deepEqual(lists("AzureBlobStorage").slice(0, 2), [
      "connection_string, container_name, blobpath, format",
      "connection_string, container_name, blobpath, format, compression",
    ]);
    assert.deepEqual(lists("Memory"), [""]);
    assert.deepEqual(lists("Kafka"), [""]);
  });

  test("describe() gives the call and its parameters for signature help", () => {
    const s3 = describeName("S3", "table engine")!;
    assert.equal(s3.syntax, "S3(url [, NOSIGN | access_key_id, secret_access_key [, session_token]] [, format] [, compression])");
    assert.deepEqual(s3.arguments?.map((a) => a.name), ["url", "NOSIGN", "access_key_id", "secret_access_key", "session_token", "format", "compression"]);
    assert.match(s3.documentation, /^```sql\nENGINE = S3\(/);
    assert.equal(describeName("Memory", "table engine")!.syntax, "Memory");
    assert.deepEqual(describeName("Memory", "table engine")!.arguments, []);
    const view = describeName("View", "table engine")!;
    assert.equal(view.syntax, "CREATE VIEW name AS SELECT ...");
    assert.equal(view.arguments, undefined);
  });
});

describe("engineArgument()", () => {
  test("names the parameters that the argument at the offset may be, by the arguments before it", () => {
    assert.deepEqual(argumentAt("CREATE TABLE t (a UInt8) ENGINE = ReplicatedReplacingMergeTree('/p', 'r', |)"), {
      engine: "ReplicatedReplacingMergeTree",
      parameters: ["ver"],
    });
    assert.deepEqual(argumentAt("CREATE TABLE t (a UInt8) ENGINE = S3('u', |)")?.parameters, ["NOSIGN", "access_key_id", "format"]);
    assert.deepEqual(argumentAt("CREATE TABLE t (a UInt8) ENGINE = S3('u', NOSIGN, |)")?.parameters, ["format"]);
    assert.deepEqual(argumentAt("CREATE TABLE t (a UInt8) ENGINE = S3('u', 'CSV', |)")?.parameters, ["compression"]);
    assert.deepEqual(argumentAt("CREATE TABLE t (a UInt8) ENGINE = S3('u', 'key', |)")?.parameters, ["secret_access_key"]);
    assert.deepEqual(argumentAt("CREATE TABLE t (a UInt8) ENGINE = Join(ANY, LEFT, a, b, |)")?.parameters, ["k2"]);
    assert.deepEqual(argumentAt("CREATE TABLE t (a UInt8) ENGINE = ReplicatedMergeTree('/p', 'r', |)")?.parameters, []);
    assert.deepEqual(argumentAt("CREATE TABLE t (a UInt8) ENGINE = ReplicatedMergeTree('/p|')")?.parameters, ["zoo_path"]);
    assert.equal(argumentAt("CREATE TABLE t (a UInt8) ENGINE=MergeTree(|)")?.engine, "MergeTree");
  });

  test("is undefined outside the top level of an engine's brackets", () => {
    assert.equal(argumentAt("SELECT toDate(|)"), undefined);
    assert.equal(argumentAt("CREATE TABLE t (a UInt8) ENGINE = Distributed(c, db, t, cityHash64(|))"), undefined);
    assert.equal(argumentAt("CREATE DATABASE d ENGINE = MySQL(|)"), undefined);
    assert.equal(argumentAt("CREATE TABLE t (a UInt8) ENGINE = Memory|"), undefined);
    assert.equal(argumentAt("CREATE TABLE t (a UInt8) ENGINE = NoSuchEngine(|)"), undefined);
  });
});

describe("completion in the arguments of an engine", () => {
  test("offers ZooKeeper paths, with the replica name too, first in ReplicatedMergeTree", () => {
    const found = at("CREATE TABLE t (k UInt64) ENGINE = ReplicatedMergeTree(|) ORDER BY k");
    assert.deepEqual(
      found.slice(0, 4).map((c) => [c.label, c.kind]),
      [
        ["'/clickhouse/tables/{shard}/{database}/{table}', '{replica}'", "value"],
        ["'/clickhouse/tables/{uuid}/{shard}', '{replica}'", "value"],
        ["'/clickhouse/tables/{shard}/{database}/{table}'", "value"],
        ["'/clickhouse/tables/{uuid}/{shard}'", "value"],
      ],
    );
    // The expressions that any argument takes follow.
    for (const label of ["ALL", "CASE", "NULL", "abs", "concat"]) assert.ok(found.some((c) => c.label === label), label);
    assert.deepEqual(engineLabels("CREATE TABLE t (k UInt64) ENGINE = ReplicatedMergeTree('/p', |) ORDER BY k"), ["'{replica}'"]);
    assert.deepEqual(engineLabels("CREATE TABLE t (k UInt64) ENGINE = ReplicatedMergeTree('/p', '{replica}', |) ORDER BY k"), []);
  });

  test("offers the columns that ClickHouse takes for the version, is_deleted and sign columns, the best types first", () => {
    const table = `CREATE TABLE t (${COLUMNS}) ENGINE`;
    assert.deepEqual(engineLabels(`${table} = ReplicatedReplacingMergeTree('/p', 'r', |) ORDER BY k`), ["d", "day", "k", "ver", "b", "f", "i", "lc", "s", "t"]);
    assert.deepEqual(engineLabels(`${table} = ReplacingMergeTree(ver, |) ORDER BY k`), ["b", "d"]);
    assert.deepEqual(engineLabels(`${table} = ReplacingMergeTree(d, |) ORDER BY k`), ["b"]);
    assert.deepEqual(engineLabels(`${table} = CollapsingMergeTree(|) ORDER BY k`), ["s", "t"]);
    assert.deepEqual(engineLabels(`${table} = VersionedCollapsingMergeTree(s, |) ORDER BY k`), ["d", "day", "k", "ver", "b", "f", "i", "lc", "t"]);
    const ver = at(`${table} = ReplacingMergeTree(|) ORDER BY k`).find((c) => c.label === "ver")!;
    assert.deepEqual([ver.kind, ver.detail], ["column", "UInt32"]);
    assert.equal(labels(`${table} = ReplacingMergeTree(v|) ORDER BY k`)[0], "ver");
  });

  test("offers the columns to sum outside the keys, numbers first, and the columns of the table it is made AS", () => {
    assert.deepEqual(
      engineLabels("CREATE TABLE t (k UInt64, p UInt8, v UInt64, x Float32, s String) ENGINE = SummingMergeTree(|) PARTITION BY p ORDER BY k"),
      ["v", "x", "s"],
    );
    assert.deepEqual(engineLabels("CREATE TABLE t AS hits ENGINE = ReplacingMergeTree(|) ORDER BY id"), ["id", "ts"]);
    assert.deepEqual(engineLabels("CREATE TABLE t AS default.hits ENGINE = ReplacingMergeTree(|) ORDER BY id", {}), []);
    const quoted = at("CREATE TABLE t (`my sign` Int8) ENGINE = CollapsingMergeTree(|) ORDER BY tuple()")[0]!;
    assert.deepEqual([quoted.label, quoted.insertText], ["my sign", "`my sign`"]);
  });

  test("offers clusters, databases, tables and integer columns or rand() in Distributed", () => {
    const table = "CREATE TABLE d AS hits ENGINE = Distributed(";
    assert.deepEqual(engineLabels(`${table}|)`), ["'{cluster}'", "prod", "test-cluster"]);
    assert.equal(at(`${table}|)`).find((c) => c.label === "test-cluster")!.insertText, "`test-cluster`");
    assert.deepEqual(engineLabels(`${table}|)`, {}), ["'{cluster}'"]);
    assert.deepEqual(engineLabels(`${table}prod, |)`), ["currentDatabase", "default", "logs"]);
    assert.deepEqual(engineLabels(`${table}prod, logs, |)`), ["events"]);
    assert.deepEqual(engineLabels(`${table}prod, currentDatabase(), |)`), ["events", "hits"]);
    assert.deepEqual(engineLabels(`${table}prod, default, hits, |)`), ["id", "rand", "ts"]);
  });

  test("says what the macros of the server stand for", () => {
    const withMacros = { schema: { ...schema, macros: [{ name: "replica", value: "r1" }] } };
    const replica = at("CREATE TABLE t (k UInt64) ENGINE = ReplicatedMergeTree('/p', |)", withMacros)[0]!;
    assert.equal(replica.documentation, "`{replica}` is `r1` on the server.");
    const path = at("CREATE TABLE t (k UInt64) ENGINE = ReplicatedMergeTree(|)", withMacros)[0]!;
    assert.equal(path.documentation, "`{shard}` is not a macro of the server.\n\n`{replica}` is `r1` on the server.");
    assert.equal(at("CREATE TABLE t (k UInt64) ENGINE = ReplicatedMergeTree('/p', |)")[0]!.documentation, undefined);
  });

  test("offers NOSIGN, formats in quotes and compression methods where S3 takes them", () => {
    const second = at("CREATE TABLE t (a UInt8) ENGINE = S3('https://b/k.csv', |)");
    assert.deepEqual([second[0]!.label, second[0]!.kind], ["NOSIGN", "keyword"]);
    const csv = second.find((c) => c.label === "CSV")!;
    assert.deepEqual([csv.kind, csv.insertText], ["format", "'CSV'"]);
    assert.ok(!second.some((c) => c.label === "gzip"));
    const afterFormat = engineLabels("CREATE TABLE t (a UInt8) ENGINE = S3('https://b/k.csv', 'CSV', |)");
    assert.deepEqual(afterFormat, ["auto", "br", "bz2", "deflate", "gzip", "lz4", "none", "snappy", "xz", "zstd"]);
    assert.equal(at("CREATE TABLE t (a UInt8) ENGINE = S3('u', CSV, |)")[0]!.insertText, "'auto'");
    assert.ok(labels("CREATE TABLE t (a UInt8) ENGINE = S3('u', NOSIGN, |)").includes("Parquet"));
    assert.ok(!labels("CREATE TABLE t (a UInt8) ENGINE = S3('u', NOSIGN, |)").includes("gzip"));
    assert.deepEqual(engineLabels("CREATE TABLE t (a UInt8) ENGINE = S3('u', 'key', |)"), []);
    assert.deepEqual(labels("CREATE TABLE t (a UInt8) ENGINE = File(Pa|)").slice(0, 3), ["Parquet", "ParquetMetadata", "parseDateTime"]);
    assert.equal(labels("CREATE TABLE t (a UInt8) ENGINE = S3('u', nos|)")[0], "nosign");
    assert.ok(labels("CREATE TABLE t (a UInt8) ENGINE = S3(conn, format = |)").includes("Parquet"));
  });

  test("offers the strictness, the join kinds it allows and the key columns in Join", () => {
    const table = "CREATE TABLE t (k UInt8, v String) ENGINE = Join(";
    assert.deepEqual(engineLabels(`${table}|)`).slice(0, 4), ["ALL", "ANTI", "ANY", "SEMI"]);
    assert.deepEqual(engineLabels(`${table}SEMI, |)`), ["LEFT", "RIGHT"]);
    assert.deepEqual(engineLabels(`${table}any, |)`), ["INNER", "LEFT", "RIGHT"]);
    assert.deepEqual(engineLabels(`${table}ALL, FULL, |)`), ["k", "v"]);
    assert.deepEqual(engineLabels(`${table}ALL, FULL, k, |)`), ["v"]);
  });

  test("offers nothing special where an engine takes no arguments, and only at the top level of its brackets", () => {
    for (const text of [
      "CREATE TABLE t (a UInt8) ENGINE = Memory(|)",
      "CREATE TABLE t (a UInt8) ENGINE = Kafka(|) SETTINGS kafka_broker_list = 'h:9092'",
      "CREATE TABLE t (a UInt8) ENGINE = MergeTree(|) ORDER BY a",
      "CREATE TABLE t (a UInt8) ENGINE = ReplacingMergeTree(cityHash64(|)) ORDER BY a",
      "CREATE TABLE t (a UInt8) ENGINE = ReplacingMergeTree(a |) ORDER BY a",
      "CREATE DATABASE d ENGINE = MySQL(|)",
    ])
      assert.ok(at(text)[0]!.kind !== "value" && !at(text).some((c) => c.kind === "value" || c.label === "NOSIGN"), text);
    assert.deepEqual(engineLabels("CREATE TABLE t (a UInt8) ENGINE = Memory(|)"), []);
  });
});
