// Positions and messages are what ClickHouse 26.11 reports; where it gives no position, check() points at the clause.
import { describe } from "node:test";

import { accepts, rejects } from "./helpers.js";

describe("CREATE", () => {
  accepts([
    "CREATE TABLE t (a UInt8, b String DEFAULT 'x' CODEC(ZSTD(1)) COMMENT 'b', c Nullable(Int64) TTL d + INTERVAL 1 DAY) ENGINE = MergeTree ORDER BY a",
    "CREATE TABLE IF NOT EXISTS db.t ON CLUSTER c (a UInt8) ENGINE = ReplicatedMergeTree('/p', '{replica}') PARTITION BY a PRIMARY KEY a ORDER BY (a, b) SAMPLE BY a TTL d DELETE SETTINGS index_granularity = 8192",
    "CREATE TABLE t (a UInt8, INDEX i a TYPE minmax GRANULARITY 1, CONSTRAINT c CHECK a > 0, PROJECTION p (SELECT a ORDER BY a)) ENGINE = MergeTree ORDER BY a",
    "CREATE TABLE t (a UInt8 PRIMARY KEY, b UInt8 NOT NULL, c UInt8 MATERIALIZED a + 1, d UInt8 ALIAS a, e UInt8 EPHEMERAL) ENGINE = Memory",
    "CREATE TEMPORARY TABLE t (a UInt8)",
    "CREATE OR REPLACE TABLE t ENGINE = Memory AS SELECT 1",
    "CREATE TABLE t AS other ENGINE = Log",
    "CREATE TABLE t AS remote('host', db, t)",
    "CREATE TABLE t (a UInt8) ENGINE = MergeTree ORDER BY a COMMENT 'table'",
    "CREATE TABLE t EMPTY AS SELECT 1",
    "ATTACH TABLE t",
    "CREATE DATABASE db ENGINE = Atomic COMMENT 'db'",
    "CREATE DATABASE IF NOT EXISTS db ON CLUSTER c",
    "CREATE VIEW v AS SELECT 1",
    "CREATE OR REPLACE VIEW v (a UInt8) AS SELECT 1 AS a",
    "CREATE MATERIALIZED VIEW mv TO dst AS SELECT * FROM src",
    "CREATE MATERIALIZED VIEW mv ENGINE = MergeTree ORDER BY a POPULATE AS SELECT a FROM src",
    "CREATE MATERIALIZED VIEW mv REFRESH EVERY 1 HOUR APPEND TO dst AS SELECT 1",
    "CREATE VIEW v SQL SECURITY INVOKER AS SELECT 1",
    "CREATE DICTIONARY d (id UInt64, name String DEFAULT '') PRIMARY KEY id SOURCE(CLICKHOUSE(TABLE 'src')) LIFETIME(MIN 0 MAX 300) LAYOUT(HASHED())",
    "CREATE NAMED COLLECTION nc AS key1 = 'a', key2 = 2 NOT OVERRIDABLE",
    "CREATE FUNCTION f AS (x) -> x + 1",
    "CREATE INDEX i ON t (a) TYPE minmax GRANULARITY 1",
  ]);

  rejects([
    ["CREATE TABLE t (a UInt8", 23, "Unmatched parentheses: '(' at position 16 is never closed."],
    ["CREATE TABLE t (a) ENGINE = Memory", 17, "Expected one of: NULL, NOT, DEFAULT, MATERIALIZED, EPHEMERAL, ALIAS, AUTO_INCREMENT, TTL, PRIMARY KEY, data type, identifier"],
    ["CREATE TABLE t (a UInt8) ENGINE", 31, "Expected one of: token, Equals, identifier with optional parameters, identifier with parameters, identifier, end of query"],
    ["CREATE TABLE t (a UInt8) ENGINE = MergeTree ORDER", 49, "Expected one of: BY, end of query"],
    ["CREATE TABLE (a UInt8)", 13, "Expected one of: IF NOT EXISTS, compound identifier, identifier"],
    ["CREATE TABLE t (a UInt8 DEFAULT) ENGINE = Memory", 31, "Expected one of: lambda expression, CAST operator, NOT, INTERVAL, CASE, DATE, TIMESTAMP, tuple, coll…"],
    ["CREATE TABLE t (a UInt8) ENGINE = Memory COMMENT 'x' AS SELECT 1 COMMENT 'y'", 65, "Comment for a table cannot be specified both before and after AS; please use only one"],
    ["CREATE TABLE t (a UInt8, PRIMARY KEY 1) ENGINE = Memory", 38, "Expected one of: token, DoubleColon, OR, AND, IS NOT DISTINCT FROM, IS DISTINCT FROM, IS NOT UNKNOWN…"],
    ["CREATE VIEW v", 13, "Expected one of: token sequence, Dot, token, UUID, ON, REFRESH, OpeningRoundBracket, sql security, DEFINER, SQL SECURITY, COMMENT, AS"],
    ["CREATE VIEW v AS", 16, "Expected one of: SELECT query, possibly with UNION, list of union elements, SELECT query, subquery…"],
    ["CREATE MATERIALIZED VIEW mv TO dst ENGINE = Memory AS SELECT 1", 35, "When creating a materialized view you can't declare both 'TO [db].[table]' and 'ENGINE'"],
    ["CREATE DICTIONARY d (id UInt64) PRIMARY KEY id SOURCE(CLICKHOUSE()) LIFETIME(xyz) LAYOUT(FLAT())", 80, "Expected one of: function, function name, compound identifier, identifier, literal, NULL, number, Bo…"],
    ["CREATE DATABASE", 15, "Expected one of: IF NOT EXISTS, identifier"],
    ["CREATE TABL t (a UInt8)", 7, "Maybe you meant: TABLE. Expected one of: TOKEN, OR REPLACE, TEMPORARY, TABLE, DATABASE, sql security…"],
    ["CREATE FUNCTION f AS", 20, "Expected lambda expression"],
    ["CREATE INDEX i ON t", 19, "Expected one of: ON, index declaration in create index, token, OpeningRoundBracket, lambda expression"],
  ]);
});
