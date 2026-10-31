// Time budgets for 1 MB inputs, about ten times what they take here, so that only work that grows
// faster than the input fails them. Each test takes the fastest of 3 runs, so warm-up does not count.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { gunzipSync } from "node:zlib";

import { check, complete, format, highlight, roles, tokenize } from "../../src/index.js";

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
