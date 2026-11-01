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
  ];
  for (const [name, fits, tooDeep] of cases) {
    test(`rejects ${name} one level deeper than ClickHouse allows`, () => {
      assert.deepEqual(check(fits), []);
      const found = check(tooDeep);
      assert.equal(found.length, 1);
      assert.ok(found[0]!.message.startsWith(TOO_DEEP_AST), found[0]!.message);
    });
  }

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
