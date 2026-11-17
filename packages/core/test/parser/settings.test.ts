import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { check, checkWithRoles, ParseCache, parsedStatements } from "../../src/parser/index.js";

const MAX_QUERY_SIZE = "Max query size exceeded (can be increased with the `max_query_size` setting)";

/** start and message of every diagnostic. */
function errors(sql: string, settings?: Parameters<typeof check>[1]): [number, string][] {
  return check(sql, settings).map((d) => [d.start, d.message]);
}

// A query of exactly 262144 bytes, ClickHouse's default max_query_size.
const FULL = `SELECT '${"a".repeat(262_144 - 9)}'`;

describe("check() with max_query_size", () => {
  // Verdicts and positions from `clickhouse format` of ClickHouse 26.11.
  test("takes a query of max_query_size bytes and rejects the token that ends past it", () => {
    assert.deepEqual(errors(FULL), []);
    assert.deepEqual(errors(`SELECT '${"a".repeat(262_144 - 8)}'`), [[7, MAX_QUERY_SIZE]]);
  });

  test("counts whitespace, comments and the ';' after the query too", () => {
    assert.deepEqual(errors(`${FULL}  `), [[262_144, MAX_QUERY_SIZE]]);
    assert.deepEqual(errors(`${FULL} -- c`), [[262_144, MAX_QUERY_SIZE]]);
    assert.deepEqual(errors(`${FULL};`), [[262_144, MAX_QUERY_SIZE]]);
  });

  test("counts UTF-8 bytes, from where each query begins", () => {
    assert.deepEqual(errors(`SELECT 'é${"a".repeat(262_144 - 11)}'`), []);
    assert.deepEqual(errors(`SELECT 1;${" ".repeat(270_000)}SELECT 2`), []);
    assert.deepEqual(errors(`SELECT 1; ${FULL}`), []);
  });

  test("leaves out the inline data of an INSERT", () => {
    assert.deepEqual(errors(`INSERT INTO t VALUES ('${"a".repeat(300_000)}')`), []);
    assert.deepEqual(errors(`INSERT INTO t SELECT '${"a".repeat(300_000)}'`), [[21, MAX_QUERY_SIZE]]);
  });

  test("takes another limit, or none for 0", () => {
    assert.deepEqual(errors("SELECT 12345", { maxQuerySize: 10 }), [[7, MAX_QUERY_SIZE]]);
    assert.deepEqual(errors(`${FULL}  `, { maxQuerySize: 0 }), []);
  });
});

describe("check() with implicit_select", () => {
  // Verdicts of formatQueryOrNull() in clickhouse local with implicit_select = 1 and 0.
  const queries: [string, boolean][] = [
    ["1 + 2", true],
    ["x FROM t", true],
    ["1 SETTINGS a=1", true],
    ["(1, 2)", true],
    ["DISTINCT 1", true],
    ["EXECUTE AS u 1", true],
    ["WITH 1 AS x x", false],
    ["1 + 2 FORMAT JSON", false],
    ["1 PARALLEL WITH 2", false],
    ["EXPLAIN 1", false],
  ];

  test("reads a query without SELECT as ClickHouse does with the setting", () => {
    for (const [sql, valid] of queries) assert.equal(check(sql, { implicitSelect: true }).length === 0, valid, sql);
  });

  test("is off by default, as in clickhouse format", () => {
    for (const [sql] of queries) assert.notEqual(check(sql).length, 0, sql);
  });
});

describe("check() with dialect", () => {
  test("skips the statements of another dialect up to SET dialect = 'clickhouse'", () => {
    const sql = "SET dialect = 'prql'; from t | take 1; SET dialect = 'clickhouse'; SELEC 1";
    assert.deepEqual(
      errors(sql).map(([start]) => start),
      [sql.indexOf("SELEC")],
    );
  });

  test("follows each SET dialect, and only SET statements change it", () => {
    const sql = [
      "SELECT 1;",
      "SET allow_experimental_kusto_dialect = 1, dialect = 'kusto';",
      "print 1;",
      "SET max_threads = 1;",
      "Customers | take 1;",
      "SET dialect = 'clickhouse';",
      "SELECT 2;",
      "SET dialect = 'prql';",
      "from t;",
      "SET dialect = DEFAULT;",
      "SELECT 3;",
      // The values are case-sensitive, so SET fails and nothing changes.
      "SET dialect = 'Kusto';",
      "SELECT 4",
    ].join("\n");
    const checked = parsedStatements(sql).map((s) => sql.slice(s.begin, s.end).trim());
    assert.deepEqual(checked.filter((s) => !s.startsWith("SET")), ["SELECT 1;", "SELECT 2;", "SELECT 3;", "SELECT 4"]);
    assert.equal(errors("SELECT 1 SETTINGS dialect = 'kusto'; from t | take 1").length, 1);
  });

  test("starts in the dialect of the settings, and goes back to ClickHouse at DEFAULT", () => {
    assert.deepEqual(errors("from t | take 1", { dialect: "prql" }), []);
    assert.equal(errors("SET dialect = DEFAULT; from t | take 1", { dialect: "kusto" }).length, 1);
    assert.equal(errors("SET dialect = 'nonsense'; from t | take 1", { dialect: "kusto" }).length, 0);
  });

  test("still checks the SET statements in another dialect", () => {
    assert.equal(errors("SET dialect = 'kusto'; SET x = ").length, 1);
  });

  test("leaves the statements of another dialect out of the roles and the parsed statements", () => {
    const cache = new ParseCache(100, { dialect: "kusto" });
    assert.deepEqual(checkWithRoles("t | take 1", cache), { diagnostics: [], spans: [] });
    assert.equal(parsedStatements("t | take 1; SET dialect = 'clickhouse'; SELECT 1", cache).length, 2);
  });
});
