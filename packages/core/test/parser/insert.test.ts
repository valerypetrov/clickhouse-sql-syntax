// Positions and messages are what ClickHouse 26.11 reports; where it gives no position, check() points at the clause.
import { describe } from "node:test";

import { accepts, rejects } from "./helpers.js";

describe("INSERT", () => {
  accepts([
    "INSERT INTO t VALUES (1, 'a'), (2, 'b')",
    "INSERT INTO t (a, b) VALUES (1, 2)",
    "INSERT INTO TABLE db.t SELECT * FROM s",
    "INSERT INTO t SELECT 1 UNION ALL SELECT 2",
    "INSERT INTO FUNCTION file('a.csv') SELECT 1",
    "INSERT INTO t FORMAT CSV",
    "INSERT INTO t SETTINGS async_insert = 1 VALUES (1)",
    "INSERT INTO t FROM INFILE 'data.csv' COMPRESSION 'gzip' FORMAT CSV",
    "WITH 1 AS x INSERT INTO t SELECT x",
    "INSERT INTO t (*) VALUES (1)",
    "INSERT INTO t (a, b,) VALUES (1, 2)",
    "INSERT INTO t SELECT * FROM input('a UInt8') FORMAT CSV",
  ]);

  rejects([
    ["INSERT t VALUES (1)", 7, "Expected INTO"],
    ["INSERT INTO VALUES (1)", 20, "Expected one of: list of elements, insert element, COLUMNS matcher, COLUMNS, qualified asterisk, com…"],
    ["INSERT INTO t (a VALUES (1)", 17, "Unmatched parentheses: '(' at position 15 is never closed."],
    ["INSERT INTO t", 13, "Expected one of: token, Dot, OpeningRoundBracket, RETURNING, FROM INFILE, SETTINGS, VALUES, FORMAT, SELECT, WITH, FROM"],
    ["INSERT INTO t SELECT", 20, "Expected one of: ALL, DISTINCT ON, DISTINCT, TOP, not empty list of expressions, list of expressions…"],
    ["INSERT INTO t FORMAT", 20, "Expected identifier"],
    ["INSERT INTO FUNCTION VALUES (1)", 31, "Expected one of: FILTER, RESPECT NULLS, IGNORE NULLS, OVER, PARTITION BY, token, OpeningRoundBracket…"],
    ["INSERT INTO t FROM INFILE", 25, "Expected string literal"],
  ]);
});
