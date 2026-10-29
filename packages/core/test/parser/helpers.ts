import assert from "node:assert/strict";
import { test } from "node:test";

import { check } from "../../src/parser/index.js";

/** Each statement is valid. */
export function accepts(statements: string[]): void {
  for (const sql of statements) {
    test(`accepts ${JSON.stringify(sql)}`, () => {
      assert.deepEqual(check(sql), []);
    });
  }
}

/**
 * Each statement gets an error at `start` with `message`, as ClickHouse reports it.
 * A message that ends with "…" only has to start with the text before it.
 */
export function rejects(cases: [sql: string, start: number, message: string][]): void {
  for (const [sql, start, message] of cases) {
    test(`rejects ${JSON.stringify(sql)}`, () => {
      const [first] = check(sql);
      assert.ok(first, "no error reported");
      assert.equal(first.start, start, first.message);
      if (message.endsWith("…")) assert.ok(first.message.startsWith(message.slice(0, -1)), first.message);
      else assert.equal(first.message, message);
    });
  }
}
