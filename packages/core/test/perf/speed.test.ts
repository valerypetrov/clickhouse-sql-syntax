// Time budgets for 1 MB inputs, about ten times what they take here, so that only work that grows
// faster than the input fails them. Each test takes the fastest of 3 runs, so warm-up does not count.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { gunzipSync } from "node:zlib";

import { check, checkWithRoles, complete, format, highlight, ParseCache, references, rename, roles, tokenize } from "../../src/index.js";

const CORPUS = new URL("../../../../oracle/fixtures/corpus.jsonl.gz", import.meta.url);

/**
 * 10,000 statements that ClickHouse accepts, from the oracle's sample of its tests: about 1 MB.
 * A blank line ends each one, so inline data ends there, as in the test files.
 */
function corpusFile(): string {
  const statements = gunzipSync(readFileSync(CORPUS))
    .toString("utf8")
    .split("\n")
    .slice(1)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { sql: string; valid: boolean; mutation?: string })
    .filter((entry) => entry.valid && !entry.mutation)
    .slice(0, 10_000)
    .map((entry) => entry.sql);
  assert.equal(statements.length, 10_000);
  return statements.join(";\n\n") + ";\n\n";
}

/** One SELECT of 1 MB with a long list of columns, some of them computed. */
function wideStatement(): string {
  const columns: string[] = [];
  for (let i = 0, length = 0; length < 1_000_000; i++) {
    const column = i % 10 === 0 ? `toDate(c${i}) AS d${i}` : `c${i}`;
    columns.push(column);
    length += column.length + 2;
  }
  return `SELECT ${columns.join(", ")} FROM t WHERE c0 IN (1, 2, 3)`;
}

const INPUTS = { "10,000 statements": corpusFile(), "a 1 MB statement": wideStatement() };

/** Milliseconds that `run` takes, the fastest of `times` runs. */
function fastest(times: number, run: () => unknown): number {
  let best = Infinity;
  for (let i = 0; i < times; i++) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

for (const [name, sql] of Object.entries(INPUTS)) {
  describe(`speed on ${name}`, () => {
    const budgets: [string, number, () => unknown][] = [
      ["tokenize()", 300, () => tokenize(sql)],
      ["check()", 3000, () => check(sql)],
      ["roles()", 3000, () => roles(sql)],
      ["highlight()", 4000, () => highlight(sql)],
      ["format()", 8000, () => format(sql)],
    ];
    for (const [what, budget, run] of budgets) {
      test(`${what} within ${budget} ms`, (t) => {
        const ms = fastest(3, run);
        t.diagnostic(`${ms.toFixed(0)} ms`);
        assert.ok(ms < budget, `took ${ms.toFixed(0)} ms`);
      });
    }
  });
}

describe("completion speed", () => {
  // Completion parses only the statement at the cursor, so in a file of many statements it is quick.
  test("within 150 ms at the end and in the middle of 10,000 statements", (t) => {
    const sql = INPUTS["10,000 statements"];
    const half = sql.indexOf(";\n\n", sql.length / 2) + 3;
    const typed = `${sql.slice(0, half)}SELECT * FROM t WHERE to;\n${sql.slice(half)}SELECT * FROM t WHERE to`;
    const middle = half + "SELECT * FROM t WHERE to".length;
    for (const [where, offset] of [["end", typed.length], ["middle", middle]] as const) {
      const ms = fastest(5, () => assert.ok(complete(typed, offset).some((c) => c.label === "toDate")));
      t.diagnostic(`${where}: ${ms.toFixed(0)} ms`);
      assert.ok(ms < 150, `${where} took ${ms.toFixed(0)} ms`);
    }
  });

  // The parser stops here at the backtrack budget of completion, which bounds the time.
  test("within 1000 ms at the end of a 1 MB statement", (t) => {
    const sql = `${INPUTS["a 1 MB statement"]} AND to`;
    const ms = fastest(3, () => complete(sql, sql.length));
    t.diagnostic(`${ms.toFixed(0)} ms`);
    assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
  });
});

describe("names speed", () => {
  // As in an editor, the diagnostics parsed the text into the cache before a name is asked about, here
  // without SET statements, which may change how names resolve.
  const corpus = INPUTS["10,000 statements"].split(";\n\n").filter((sql) => !/^SET\b/i.test(sql)).join(";\n\n");
  const middle = corpus.indexOf(";\n\n", corpus.length / 2) + 3;
  const typed = `${corpus.slice(0, middle)}SELECT number + 1 AS n FROM numbers(3) WHERE n > 1;\n\n${corpus.slice(middle)}`;
  const wide = INPUTS["a 1 MB statement"];
  // As in ClickHouse's test 03094_one_thousand_joins.
  let joins = "SELECT * FROM (SELECT 1 AS x) t1";
  for (let i = 2; i <= 1000; i++) joins += ` JOIN (SELECT 1 AS x) t${i} ON t1.x = t${i}.x`;
  const cases: [string, string, number, number, number][] = [
    ["a name among 10,000 statements", typed, typed.indexOf("n FROM numbers", middle), 700, 1500],
    ["a name of a 1 MB statement", wide, wide.indexOf("AS d10,") + 3, 4000, 8000],
    ["a table alias of 1,000 joins", joins, joins.indexOf("t500 ON"), 4000, 8000],
  ];
  for (const [what, sql, offset, findBudget, renameBudget] of cases) {
    test(`references() and rename() of ${what} within ${findBudget} and ${renameBudget} ms`, (t) => {
      const cache = new ParseCache();
      checkWithRoles(sql, cache);
      // Shifted by more spaces each time, so that the cache keeps the statements but no analysis is kept.
      let shift = 0;
      const find = fastest(3, () => {
        shift++;
        assert.ok(references(" ".repeat(shift) + sql, offset + shift, { cache }).length >= 1);
      });
      // A refused rename takes as long as the analysis, and one that is done checks the result too.
      const renamed = fastest(3, () => {
        shift++;
        rename(" ".repeat(shift) + sql, offset + shift, "renamed", { cache });
      });
      t.diagnostic(`references ${find.toFixed(0)} ms, rename ${renamed.toFixed(0)} ms`);
      assert.ok(find < findBudget, `references() took ${find.toFixed(0)} ms`);
      assert.ok(renamed < renameBudget, `rename() took ${renamed.toFixed(0)} ms`);
    });
  }
});
