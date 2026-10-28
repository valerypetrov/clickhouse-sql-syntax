import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { tokenize } from "../../src/lexer/index.js";
import { TokenKind } from "../../src/types.js";
import { GOLDEN_PATH, type GoldenEntry } from "./golden.js";

// Expected tokens come from ClickHouse itself; refresh them with update-golden.ts.
const entries = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as GoldenEntry[];

/** Tokens as [kind, start, end, text], so that a failure shows the text of each token. */
function withText(sql: string, tokens: [string, number, number][]): [string, number, number, string][] {
  return tokens.map(([kind, start, end]) => [kind, start, end, sql.slice(start, end)]);
}

describe("tokenize() matches ClickHouse's lexer", () => {
  test("the golden file has inputs", () => {
    assert.ok(entries.length > 100);
    assert.ok(entries.every((entry) => entry.sql === "" || entry.tokens.length > 0));
  });

  for (const entry of entries) {
    const name = entry.source === "edge case" ? JSON.stringify(entry.sql) : entry.source;
    test(name, () => {
      const actual = tokenize(entry.sql)
        .filter((token) => token.kind !== TokenKind.EndOfStream)
        .map((token): [string, number, number] => [token.kind, token.start, token.end]);
      assert.deepEqual(withText(entry.sql, actual), withText(entry.sql, entry.tokens));
    });
  }
});
