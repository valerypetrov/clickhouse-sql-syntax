// Cases where check() or tokenize() still differ from ClickHouse 26.11, or take super-linear time.
// Each test is skipped until the problem it names is fixed; the reason says what is wrong today.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { tokenize } from "../src/lexer/index.js";
import { check } from "../src/parser/index.js";

/** start and message of every diagnostic. */
function errors(sql: string): [number, string][] {
  return check(sql).map((d) => [d.start, d.message]);
}

function repeat(text: string, count: number, separator = ""): string {
  return Array.from({ length: count }, () => text).join(separator);
}

/** Milliseconds that `work` takes. */
function time(work: () => unknown): number {
  const start = performance.now();
  work();
  return performance.now() - start;
}

const TOO_DEEP_AST = "AST is too deep. Maximum: 1000";

/** A table with one column of this type. */
function column(type: string): string {
  return `CREATE TABLE t (a ${type}) ENGINE = Memory`;
}

describe("where a statement begins", () => {
  // clickhouse-client skips only ASCII whitespace, so U+1680 (which /\s/ matches) is an error token.
  test("reports U+1680 before a statement as an unrecognized token", () => {
    assert.deepEqual(errors("\u1680SELECT 1"), [[0, "Unrecognized token"]]);
    assert.deepEqual(errors("\u1680"), [[0, "Unrecognized token"]]);
    assert.deepEqual(errors("SELECT 1;\u1680SELECT 2"), [[9, "Unrecognized token"]]);
  });

  test("counts bracket positions from a no-break space that starts the statement", () => {
    assert.deepEqual(errors("\u00a0SELECT ("), [[9, "Unmatched parentheses: '(' at position 10 is never closed."]]);
    assert.deepEqual(errors("SELECT 1;\u00a0SELECT ("), [[18, "Unmatched parentheses: '(' at position 10 is never closed."]]);
    assert.deepEqual(errors("\u2003SELECT ("), [[9, "Unmatched parentheses: '(' at position 11 is never closed."]]);
    assert.deepEqual(errors("\u2003SELECT 1"), []);
  });

  // The client gives a comment on the line of the ';' to the query before it (adjustQueryEnd).
  test("starts the next statement after a comment on the same line as the ';'", () => {
    assert.deepEqual(errors("SELECT 1; -- c\nSELECT ("), [[23, "Unmatched parentheses: '(' at position 8 is never closed."]]);
    assert.deepEqual(errors("SELECT 1; /* a */ -- b\nSELECT ("), [[31, "Unmatched parentheses: '(' at position 8 is never closed."]]);
  });
});

describe("AST depth", () => {
  // tryParseQuery() calls checkDepth(max_parser_depth) on the parsed AST: TOO_DEEP_AST, code 167.
  const cases: [name: string, fits: string, tooDeep: string][] = [
    ["a chain of +", `SELECT ${repeat("1", 498, " + ")}`, `SELECT ${repeat("1", 499, " + ")}`],
    ["a chain of NOT", `SELECT ${repeat("NOT ", 497)}1`, `SELECT ${repeat("NOT ", 498)}1`],
    ["nested calls", `SELECT ${repeat("f(", 497)}1${repeat(")", 497)}`, `SELECT ${repeat("f(", 498)}1${repeat(")", 498)}`],
    ["nested column types", `CREATE TABLE t (a ${repeat("Array(", 497)}UInt8${repeat(")", 497)}) ENGINE = Memory`, `CREATE TABLE t (a ${repeat("Array(", 498)}UInt8${repeat(")", 498)}) ENGINE = Memory`],
    // ClickHouse makes each (t JOIN t ...) a subquery, seven levels deep.
    ["joins in brackets", `SELECT * FROM ${repeat("(", 141)}t${repeat(" JOIN t USING (a))", 141)}`, `SELECT * FROM ${repeat("(", 142)}t${repeat(" JOIN t USING (a))", 142)}`],
    // ClickHouse reads (EXPLAIN SELECT ...) as SELECT * FROM viewExplain(..., (SELECT ...)), and (VALUES ...) likewise.
    ["calls in an EXPLAIN subquery", `SELECT * FROM (EXPLAIN SELECT ${repeat("f(", 489)}1${repeat(")", 489)})`, `SELECT * FROM (EXPLAIN SELECT ${repeat("f(", 490)}1${repeat(")", 490)})`],
    ["calls in a VALUES subquery", `SELECT * FROM (VALUES (${repeat("f(", 492)}1${repeat(")", 492)}))`, `SELECT * FROM (VALUES (${repeat("f(", 493)}1${repeat(")", 493)}))`],
    // A typed path of JSON is four levels below the JSON type, and max_dynamic_paths=N a call of equals.
    ["nested JSON paths", column(`${repeat("JSON(k ", 248)}UInt8${repeat(")", 248)}`), column(`${repeat("JSON(k ", 249)}UInt8${repeat(")", 249)}`)],
    ["nested SHARED JSON paths", column(`${repeat("JSON(SHARED k ", 248)}UInt8${repeat(")", 248)}`), column(`${repeat("JSON(SHARED k ", 249)}UInt8${repeat(")", 249)}`)],
    ["JSON paths in arrays", column(`${repeat("Array(JSON(k ", 165)}UInt8${repeat("))", 165)}`), column(`${repeat("Array(JSON(k ", 166)}UInt8${repeat("))", 166)}`)],
    ["SKIP under nested JSON paths", column(`${repeat("JSON(k ", 248)}JSON(SKIP a)${repeat(")", 248)}`), column(`${repeat("JSON(k ", 249)}JSON(SKIP a)${repeat(")", 249)}`)],
    ["max_dynamic_paths under nested JSON paths", column(`${repeat("JSON(k ", 247)}JSON(max_dynamic_paths=1)${repeat(")", 247)}`), column(`${repeat("JSON(k ", 248)}JSON(max_dynamic_paths=1)${repeat(")", 248)}`)],
    ["max_types in nested arrays", column(`${repeat("Array(", 495)}Dynamic(max_types=1)${repeat(")", 495)}`), column(`${repeat("Array(", 496)}Dynamic(max_types=1)${repeat(")", 496)}`)],
  ];
  const calls = (n: number) => `${repeat("f(", n)}1${repeat(")", n)}`;
  const arrays = (n: number) => `${repeat("Array(", n)}UInt8${repeat(")", n)}`;
  // Parts of statements that the depth did not count, each with the first n at which ClickHouse rejects it.
  const statements: [name: string, statement: (n: number) => string, n: number][] = [
    ["a column type in ALTER TABLE ... ADD COLUMN", (n) => `ALTER TABLE t ADD COLUMN a ${arrays(n)}`, 498],
    ["a DEFAULT in ALTER TABLE ... MODIFY COLUMN", (n) => `ALTER TABLE t MODIFY COLUMN a UInt8 DEFAULT ${calls(n)}`, 498],
    ["a CODEC in ALTER TABLE ... MODIFY COLUMN", (n) => `ALTER TABLE t MODIFY COLUMN a UInt8 CODEC(ZSTD(${calls(n)}))`, 496],
    ["ALTER TABLE ... UPDATE", (n) => `ALTER TABLE t UPDATE a = ${calls(n)} WHERE 1`, 498],
    ["ALTER TABLE ... DELETE WHERE", (n) => `ALTER TABLE t DELETE WHERE ${calls(n)}`, 499],
    ["ALTER TABLE ... DELETE IN PARTITION", (n) => `ALTER TABLE t DELETE IN PARTITION tuple(${calls(n)}) WHERE 1`, 497],
    ["ALTER TABLE ... MODIFY TTL", (n) => `ALTER TABLE t MODIFY TTL ${calls(n)}`, 498],
    ["ALTER TABLE ... ADD INDEX", (n) => `ALTER TABLE t ADD INDEX i ${calls(n)} TYPE minmax`, 498],
    ["ALTER TABLE ... ADD PROJECTION", (n) => `ALTER TABLE t ADD PROJECTION p (SELECT ${calls(n)})`, 497],
    ["ALTER TABLE ... MODIFY ORDER BY", (n) => `ALTER TABLE t MODIFY ORDER BY ${calls(n)}`, 499],
    ["ALTER TABLE ... MODIFY QUERY", (n) => `ALTER TABLE t MODIFY QUERY SELECT ${calls(n)}`, 497],
    ["CREATE VIEW ... AS SELECT", (n) => `CREATE VIEW v AS SELECT ${calls(n)}`, 498],
    ["the engine of a materialized view", (n) => `CREATE MATERIALIZED VIEW v ENGINE = MergeTree ORDER BY ${calls(n)} AS SELECT 1`, 499],
    ["CREATE FUNCTION", (n) => `CREATE FUNCTION g AS x -> ${calls(n)}`, 499],
    ["the engine arguments of CREATE TABLE", (n) => `CREATE TABLE t (a UInt8) ENGINE = MergeTree(${calls(n)})`, 498],
    ["the ORDER BY of CREATE TABLE", (n) => `CREATE TABLE t (a UInt8) ENGINE = MergeTree ORDER BY ${calls(n)}`, 499],
    ["a DESC key in the ORDER BY of CREATE TABLE", (n) => `CREATE TABLE t (a UInt8) ENGINE = MergeTree ORDER BY (${calls(n)} DESC, a)`, 498],
    ["the PARTITION BY of CREATE TABLE", (n) => `CREATE TABLE t (a UInt8) ENGINE = MergeTree PARTITION BY ${calls(n)} ORDER BY a`, 499],
    ["the TTL of CREATE TABLE", (n) => `CREATE TABLE t (a UInt8) ENGINE = MergeTree ORDER BY a TTL ${calls(n)}`, 498],
    ["CREATE TABLE ... AS SELECT", (n) => `CREATE TABLE t ENGINE = Memory AS SELECT ${calls(n)}`, 498],
    ["an INDEX in CREATE TABLE", (n) => `CREATE TABLE t (a UInt8, INDEX i ${calls(n)} TYPE minmax) ENGINE = Memory`, 498],
    ["DELETE FROM", (n) => `DELETE FROM t WHERE ${calls(n)}`, 500],
    ["UPDATE", (n) => `UPDATE t SET a = ${calls(n)} WHERE 1`, 499],
    ["an attribute type in CREATE DICTIONARY", (n) => `CREATE DICTIONARY d (a ${arrays(n)}) PRIMARY KEY a SOURCE(NULL()) LIFETIME(0) LAYOUT(FLAT())`, 499],
    ["the SOURCE of CREATE DICTIONARY", (n) => `CREATE DICTIONARY d (a UInt8) PRIMARY KEY a SOURCE(CLICKHOUSE(query ${calls(n)})) LIFETIME(0) LAYOUT(FLAT())`, 498],
    ["GROUP BY", (n) => `SELECT 1 GROUP BY ${calls(n)}`, 498],
    ["ORDER BY", (n) => `SELECT 1 ORDER BY ${calls(n)}`, 498],
    ["LIMIT", (n) => `SELECT 1 LIMIT ${calls(n)}`, 499],
    ["a window", (n) => `SELECT count() OVER (ORDER BY ${calls(n)})`, 496],
    ["JOIN ... ON", (n) => `SELECT 1 FROM t JOIN u ON ${calls(n)}`, 497],
    ["ARRAY JOIN", (n) => `SELECT 1 FROM t ARRAY JOIN ${calls(n)} AS a`, 497],
    ["* REPLACE", (n) => `SELECT * REPLACE (${calls(n)} AS a) FROM t`, 496],
    ["a WITH subquery", (n) => `WITH c AS (SELECT ${calls(n)}) SELECT 1`, 495],
    // x > ANY (q) is x > (SELECT min(*) FROM q), and x < ALL (array) arrayAll(_a -> x < _a, array).
    ["a comparison with ANY (subquery)", (n) => `SELECT 1 > ANY (SELECT ${calls(n)})`, 491],
    ["a comparison with ALL (array)", (n) => `SELECT ${calls(n)} < ALL ([1])`, 495],
    ["DATE_ADD with a unit", (n) => `SELECT DATE_ADD(YEAR, ${calls(n)}, d)`, 496],
    // Each pipe operator makes the query before it a subquery of a new SELECT, seven levels deep.
    ["pipe operators", (n) => `FROM t${repeat(" |> WHERE 1", n)}`, 142],
    ["INSERT INTO FUNCTION", (n) => `INSERT INTO FUNCTION null(${calls(n)}) SELECT 1`, 499],
    ["DESCRIBE (SELECT ...)", (n) => `DESCRIBE (SELECT ${calls(n)})`, 497],
    ["KILL QUERY", (n) => `KILL QUERY WHERE ${calls(n)}`, 500],
    ["OPTIMIZE ... PARTITION", (n) => `OPTIMIZE TABLE t PARTITION tuple(${calls(n)})`, 498],
    ["CREATE INDEX", (n) => `CREATE INDEX i ON t (${calls(n)}) TYPE minmax`, 499],
    ["the engine arguments of CREATE DATABASE", (n) => `CREATE DATABASE d ENGINE = Replicated(${calls(n)})`, 498],
    ["the destination of BACKUP", (n) => `BACKUP TABLE t TO Disk(${calls(n)})`, 499],
    ["SNAPSHOT", (n) => `SNAPSHOT TABLE t TO Disk(${calls(n)})`, 499],
    ["EXECUTE AS", (n) => `EXECUTE AS u SELECT ${calls(n)}`, 498],
    ["CREATE HANDLER", (n) => `CREATE HANDLER h URL '/a' AS SELECT ${calls(n)}`, 498],
    ["VALID FOR of CREATE USER", (n) => `CREATE USER u VALID FOR ${calls(n)}`, 500],
  ];
  for (const [name, statement, n] of statements) cases.push([name, statement(n - 1), statement(n)]);
  for (const [name, fits, tooDeep] of cases) {
    test(`rejects ${name} one level deeper than ClickHouse allows`, () => {
      assert.deepEqual(check(fits), []);
      const found = check(tooDeep);
      assert.equal(found.length, 1);
      assert.ok(found[0]!.message.startsWith(TOO_DEEP_AST), found[0]!.message);
    });
  }

  // ClickHouse keeps the filter of a row policy and the partition of CHECK TABLE out of the AST it checks.
  test("accepts the parts that ClickHouse does not count, however deep", () => {
    assert.deepEqual(check(`CREATE ROW POLICY p ON t USING ${calls(600)}`), []);
    assert.deepEqual(check(`CHECK TABLE t PARTITION tuple(${calls(600)})`), []);
  });

  test("checks the statements after one with too deep an AST", () => {
    const found = errors(`SELECT ${repeat("1", 499, " + ")}; SELECT 1 +`);
    assert.equal(found.length, 2);
    assert.ok(found[0]![1].startsWith(TOO_DEEP_AST), found[0]![1]);
  });

  // readsInput() in insert.ts recurses over the AST; its RangeError is shown as the parser depth error.
  test("reports an INSERT ... SELECT too deep for the JavaScript stack as too deep an AST", () => {
    const found = check(`INSERT INTO t SELECT ${repeat("1", 20000, " + ")}`);
    assert.equal(found.length, 1);
    assert.ok(found[0]!.message.startsWith(TOO_DEEP_AST), found[0]!.message);
  });
});

describe("time in proportion to the input", () => {
  // node:test cannot stop synchronous code at its timeout, so these measure the time themselves.
  test(
    "INSERT data that ends inside a token of the first lexing",
    { skip: "every such INSERT lexes the rest of the input again: 14.6 s here for 8,000 of them" },
    () => {
      const sql = repeat("INSERT INTO t FORMAT TSV\nit's\n", 8000, "\n");
      let found: [number, string][] = [];
      const ms = time(() => (found = errors(sql)));
      assert.deepEqual(found, []);
      assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
    },
  );

  test(
    "many statements that each leave a bracket open",
    { skip: "each one matches brackets up to the end of the input: 5.8 s here for 16,000 of them" },
    () => {
      const sql = repeat("SELECT (", 16000, ";\n");
      let count = 0;
      const ms = time(() => (count = check(sql).length));
      assert.equal(count, 16000);
      assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
    },
  );

  test(
    "an unmatched-bracket message that lists brackets on many lines",
    { skip: "each bracket position is counted from the statement start: 3.2 s here for 16,000 lines" },
    () => {
      const sql = `SELECT ${repeat("f(\n", 16000)}1`;
      let count = 0;
      const ms = time(() => (count = check(sql).length));
      assert.equal(count, 1);
      assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
    },
  );

  // ClickHouse searches the same way, but max_query_size bounds it there.
  test(
    "tokenize() over many $tag$ words that never close",
    { skip: "each one searches the rest of the input for its closing tag: 2.6 s here for 32,000" },
    () => {
      const sql = `SELECT ${Array.from({ length: 32000 }, (_, i) => `$t${i}$`).join(" ")}`;
      let count = 0;
      const ms = time(() => (count = tokenize(sql).length));
      assert.equal(count, 64002);
      assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
    },
  );
});
