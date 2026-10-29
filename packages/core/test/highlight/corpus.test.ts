import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import { highlight } from "../../src/highlight/index.js";
import { roles } from "../../src/parser/index.js";

// The statements of the oracle's sample of ClickHouse's tests that ClickHouse accepts.
const CORPUS = new URL("../../../../oracle/fixtures/corpus.jsonl.gz", import.meta.url);
const statements = gunzipSync(readFileSync(CORPUS))
  .toString("utf8")
  .split("\n")
  .slice(1)
  .filter(Boolean)
  .map((line) => JSON.parse(line) as { sql: string; valid: boolean; file: string; line: number })
  .filter((entry) => entry.valid);

// Each statement with its roles and the scope highlight() gives at each offset.
const analysed = statements.map((entry) => ({
  ...entry,
  spans: roles(entry.sql),
  scopes: new Map(highlight(entry.sql).map((span) => [span.start, span.scope])),
}));

test("highlight() never colours a word that the parser read as a name as a keyword", () => {
  let names = 0;
  for (const { sql, file, line, spans, scopes } of analysed) {
    for (const span of spans) {
      const scope = scopes.get(span.start);
      const word = `${JSON.stringify(sql.slice(span.start, span.end))} at ${file}:${line}`;
      if (span.role === "keyword") {
        assert.ok(scope === "keyword.other.sql" || scope === "constant.language.sql", `keyword ${word} is ${scope}`);
      } else {
        names++;
        assert.notEqual(scope, "keyword.other.sql", `${span.role} ${word}`);
      }
    }
  }
  assert.ok(names > 50_000, `only ${names} names`);
});

test("every statement that ClickHouse accepts gets roles", () => {
  assert.ok(analysed.length > 10_000);
  for (const { file, line, spans } of analysed) assert.ok(spans.length > 0, `${file}:${line}`);
});
