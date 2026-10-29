// SHARED paths of JSON came after the build that labels the oracle corpus, which rejects them.
// Positions and messages are what ClickHouse 26.11 at 1230fe66203 reports.
import { describe } from "node:test";

import { accepts, rejects } from "./helpers.js";

describe("JSON SHARED paths", () => {
  accepts([
    "CREATE TABLE t (x UInt64, json JSON(SHARED a UInt64, SHARED b String, SHARED c Array(UInt8))) ENGINE = MergeTree ORDER BY x",
    "ALTER TABLE t ADD COLUMN j JSON(a Tuple(b String), SHARED a.b Int64)",
    `SELECT '{"a":8}'::JSON(SHARED a UInt64)`,
    "CREATE TABLE t (j JSON(max_dynamic_paths = 2, SHARED j JSON(SHARED k UInt8), SKIP z)) ENGINE = Memory",
    // A path named shared, when the path and its type end the argument.
    "CREATE TABLE t (j JSON(shared DOUBLE PRECISION)) ENGINE = Memory",
    "CREATE TABLE t (j JSON(SHARED UInt64)) ENGINE = Memory",
  ]);

  rejects([
    ["CREATE TABLE t (j JSON(SHARED)) ENGINE = Memory", 29, "Expected one of: token sequence, Dot, token, data type, identifier, compound identifier"],
    ["CREATE TABLE t (j JSON(SHARED 1 UInt64)) ENGINE = Memory", 30, "Expected one of: token sequence, Dot, token, data type, identifier, compound identifier"],
    ["CREATE TABLE t (j JSON(SHARED a = 5)) ENGINE = Memory", 32, "Expected one of: token sequence, Dot, token, data type, identifier"],
    ["CREATE TABLE t (j JSON(SHARED SHARED a UInt64)) ENGINE = Memory", 39, "Expected one of: token sequence, Dot, token, data type, identifier"],
    ["CREATE TABLE t (j JSON(SHARED a UInt64 extra)) ENGINE = Memory", 39, "Expected one of: SIGNED, UNSIGNED"],
    [
      "CREATE TABLE t (j JSON(SHARED a.b. UInt64)) ENGINE = Memory",
      41,
      "Expected one of: ParserArrayOfJSONIdentifierDelimiter, token sequence, OpeningSquareBracket, Dot, token, data type, identifier",
    ],
  ]);
});
