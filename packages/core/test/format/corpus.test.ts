import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { format } from "../../src/format/index.js";
import { tokenize } from "../../src/lexer/index.js";
import { check } from "../../src/parser/index.js";
import { type KeywordCase, TokenKind } from "../../src/types.js";

// Statements of ClickHouse's tests with the format() output that ClickHouse read as the same query.
// `npm run oracle:format -- --clickhouse <binary> --update-sample` writes it again.
const SAMPLE = JSON.parse(readFileSync(new URL("./fixtures/corpus-sample.json", import.meta.url), "utf8")) as {
  statements: { file: string; line: number; sql: string; formatted: string }[];
};

function contents(sql: string): string[] {
  return tokenize(sql)
    .filter((t) => t.kind !== TokenKind.Whitespace)
    .map((t) => (t.kind === TokenKind.BareWord ? sql.slice(t.start, t.end).toUpperCase() : sql.slice(t.start, t.end)));
}

test("format() gives the output that ClickHouse confirmed", () => {
  assert.ok(SAMPLE.statements.length > 300);
  for (const { file, line, sql, formatted } of SAMPLE.statements) {
    assert.equal(format(sql), formatted, `${file}:${line}`);
  }
});

test("format() is idempotent, keeps tokens and comments and stays valid, in every keyword case", () => {
  for (const keywordCase of ["upper", "lower", "preserve"] as KeywordCase[]) {
    for (const { file, line, sql } of SAMPLE.statements) {
      const where = `${file}:${line} (${keywordCase})`;
      const output = format(sql, { keywordCase });
      assert.equal(format(output, { keywordCase }), output, where);
      assert.deepEqual(contents(output), contents(sql), where);
      assert.deepEqual(check(output), [], where);
    }
  }
});
