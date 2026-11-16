// Statements that ClickHouse master d45f558 changed outside SELECT; verdicts and messages are what its binary reports.
import { describe } from "node:test";

import { accepts, rejects } from "./helpers.js";

describe("Bareword literals as type names", () => {
  rejects([
    ["CREATE TABLE t (x `true`) ENGINE = Memory", 24, "Expected type name"],
    ["CREATE TABLE t (x Nullable(`nan`)) ENGINE = Memory", 32, "Expected type name"],
    ["CREATE TABLE t (x Infinity) ENGINE = Memory", 26, "Expected type name"],
    ["CREATE TABLE t (x `False`) ENGINE = Memory", 25, "Expected type name"],
    ["SELECT CAST(1 AS `Inf`)", 22, "Expected one of: AS, token, Comma, type name"],
  ]);
});

describe("Profile events as quota limits", () => {
  accepts([
    "CREATE QUOTA q FOR INTERVAL 1 day MAX S3GetObject = 100000, FailedQuery = 50 TO default",
    "ALTER QUOTA q FOR INTERVAL 1 day S3GetObject MAX 5",
    "CREATE QUOTA q FOR INTERVAL 1 day MAX S3GetObject = 1.5",
  ]);

  rejects([
    [
      "CREATE QUOTA q FOR INTERVAL 1 day MAX NoSuchEvent = 1",
      50,
      "Quota limit cannot be set for `NoSuchEvent`. Expected one of the predefined resource types (e.g. 'queries', " +
        "'errors', 'read_rows') or the name of a profile event (see the `system.events` table)",
    ],
    ["CREATE QUOTA q FOR INTERVAL 1 day MAX queries = 1, s3getobject = 2", 63, "Quota limit cannot be set for `s3getobject`…"],
    // Without `=` an unknown name only ends the limits.
    ["CREATE QUOTA q FOR INTERVAL 1 day nosuch MAX 5", 41, "Expected end of query"],
    ["CREATE QUOTA q FOR INTERVAL 1 day MAX S3GetObject = '1x'", 52, "Cannot parse input: expected 'eof' before: 'x'"],
  ]);
});

describe("SYSTEM AMBER", () => {
  accepts([
    "SYSTEM DROP AMBER NODE 'n'",
    "SYSTEM DROP AMBER NODE IF EXISTS 'n'",
    "SYSTEM ALLOCATE AMBER VOLUME IN CLUSTER 1",
    "SYSTEM CREATE AMBER VOLUME 1 IN CLUSTER 2 SHARDS 3 SEGMENTS 4",
    "SYSTEM DROP AMBER VOLUME 1 FROM CLUSTER 2",
  ]);

  rejects([
    ["SYSTEM DROP AMBER", 17, "Expected one of: NODE, VOLUME"],
    ["SYSTEM DROP AMBER NODE n", 23, "Expected one of: IF EXISTS, string literal"],
    ["SYSTEM ALLOCATE AMBER VOLUME IN CLUSTER -1", 40, "Expected unsigned integer"],
    ["SYSTEM CREATE AMBER VOLUME 1 IN CLUSTER 2 SHARDS 3", 50, "Expected SEGMENTS"],
    ["SYSTEM DROP AMBER VOLUME 1 FROM", 31, "Expected CLUSTER"],
    ["SYSTEM xyz", 7, "Expected one of: …"],
  ]);
});

describe("TimeSeries targets", () => {
  accepts(["CREATE TABLE ts ENGINE = TimeSeries DATA INNER UUID '10000000-0000-0000-0000-000000000000'"]);

  rejects([
    ["CREATE TABLE ts ENGINE = TimeSeries DATA INNER UUID '00000000-0000-0000-0000-000000000000'", 52, "DATA INNER UUID cannot use a Nil UUID"],
    ["CREATE TABLE ts ENGINE = TimeSeries TAGS INNER UUID '00000000000000000000000000000000'", 52, "TAGS INNER UUID cannot use a Nil UUID"],
    ["CREATE TABLE ts ENGINE = TimeSeries METRICS INNER UUID '00000000-0000-0000-0000-000000000000'", 55, "METRICS INNER UUID cannot use a Nil UUID"],
    ["CREATE TABLE ts ENGINE = TimeSeries DATA {db:Identifier}.t", 41, "Expected one of: INNER UUID, INNER COLUMNS, INNER, storage definition, …"],
    ["CREATE TABLE ts ENGINE = TimeSeries DATA d.{t:Identifier}", 43, "Expected one of: Colon, Caret, At, identifier, end of query"],
  ]);
});

describe("New privileges", () => {
  accepts([
    "GRANT AI FUNCTIONS ON *.* TO u",
    "GRANT aiGenerate, aiClassify ON *.* TO john",
    "GRANT HANDLER ADMIN ON *.* TO u",
    "REVOKE HANDLER ADMIN ON *.* FROM u",
    "GRANT SYSTEM DROP AMBER NODE ON *.* TO u",
  ]);
});

describe("WITH before INSERT", () => {
  rejects([
    [
      "WITH 1 AS a INSERT INTO t SELECT 1 UNION ALL (WITH 2 AS b SELECT b SETTINGS max_threads = 1)",
      92,
      "Only one WITH should be presented, either before INSERT or SELECT.",
    ],
  ]);
});
