import assert from "node:assert/strict";
import { test } from "node:test";

import { MUTATIONS, mutate, mutateAll } from "../src/mutate.js";

const SQL = "SELECT a, count() FROM t WHERE (b = 1) GROUP BY a ORDER BY a LIMIT 10";

test("every mutation changes the statement", () => {
  for (const mutation of MUTATIONS) {
    const result = mutate(SQL, mutation, "seed");
    assert.ok(result !== undefined && result !== SQL, mutation);
  }
});

test("mutations are deterministic", () => {
  for (const mutation of MUTATIONS) assert.equal(mutate(SQL, mutation, "seed"), mutate(SQL, mutation, "seed"));
});

test("a mutation that has nothing to work on is skipped", () => {
  assert.equal(mutate("SELECT 1", "drop-close", "seed"), undefined);
  assert.equal(mutate("SELECT", "truncate", "seed"), undefined);
});

test("drop-close removes exactly one closing bracket", () => {
  const result = mutate(SQL, "drop-close", "seed")!;
  const count = (text: string): number => text.split(")").length - 1;
  assert.equal(count(result), count(SQL) - 1);
  assert.equal(result.length, SQL.length - 1);
});

test("mutateAll returns new texts only, at most the count asked for", () => {
  const sources = [SQL, "SELECT (1 + 2) * 3", "CREATE TABLE t (a Int32) ENGINE = Memory"];
  const result = mutateAll(sources, 2, new Set(sources));
  assert.equal(result.length, 2);
  for (const m of result) {
    assert.ok(!sources.includes(m.sql));
    assert.ok(sources.includes(m.source));
  }
  assert.deepEqual(mutateAll(sources, 2, new Set(sources)), result);
});
