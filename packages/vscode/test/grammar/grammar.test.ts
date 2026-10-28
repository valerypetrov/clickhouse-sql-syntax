import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { highlight } from "clickhouse-sql-syntax";
import { GRAMMAR_PATH, grammarText } from "../../scripts/generate-grammar.js";
import { grammarScopes, grammarTokens } from "./textmate.js";

test("the committed grammar is what the generator writes", () => {
  assert.equal(readFileSync(GRAMMAR_PATH, "utf8"), grammarText(), "run `npm run generate -w packages/vscode`");
});

// Each case lists the runs of text with the same scope; whitespace outside tokens has none.
const CASES: [string, [string, string][]][] = [
  [
    "-- line\n# hash\n#!/usr/bin/env clickhouse-local\n/* a /* nested */ b */",
    [
      ["-- line", "comment.line.sql"],
      ["# hash", "comment.line.sql"],
      ["#!/usr/bin/env clickhouse-local", "comment.line.sql"],
      ["/* a /* nested */ b */", "comment.block.sql"],
    ],
  ],
  [
    "SELECT 'it''s', 'a\\'b', x'4142', b'0101', ‘curly’",
    [
      ["SELECT", "keyword.other.sql"],
      ["'it''s'", "string.quoted.single.sql"],
      [",", "punctuation.sql"],
      ["'a\\'b'", "string.quoted.single.sql"],
      [",", "punctuation.sql"],
      ["x'4142'", "string.quoted.single.sql"],
      [",", "punctuation.sql"],
      ["b'0101'", "string.quoted.single.sql"],
      [",", "punctuation.sql"],
      ["‘curly’", "string.quoted.single.sql"],
    ],
  ],
  [
    "SELECT '\nmulti\nline'",
    [
      ["SELECT", "keyword.other.sql"],
      ["'", "string.quoted.single.sql"],
      ["multi", "string.quoted.single.sql"],
      ["line'", "string.quoted.single.sql"],
    ],
  ],
  [
    "SELECT $$it's$$, $tag$ a $$ b $tag$, $1",
    [
      ["SELECT", "keyword.other.sql"],
      ["$$it's$$", "string.unquoted.heredoc.sql"],
      [",", "punctuation.sql"],
      ["$tag$ a $$ b $tag$", "string.unquoted.heredoc.sql"],
      [",", "punctuation.sql"],
      ["$1", "variable.other.sql"],
    ],
  ],
  [
    'SELECT "col", `odd``name`, “curly”',
    [
      ["SELECT", "keyword.other.sql"],
      ['"col"', "variable.other.sql"],
      [",", "punctuation.sql"],
      ["`odd``name`", "variable.other.sql"],
      [",", "punctuation.sql"],
      ["“curly”", "variable.other.sql"],
    ],
  ],
  [
    "SELECT 1_000, 0x1F, 0b101, 1.5e-3, .5, 0x1p4",
    [
      ["SELECT", "keyword.other.sql"],
      ["1_000", "constant.numeric.sql"],
      [",", "punctuation.sql"],
      ["0x1F", "constant.numeric.sql"],
      [",", "punctuation.sql"],
      ["0b101", "constant.numeric.sql"],
      [",", "punctuation.sql"],
      ["1.5e-3", "constant.numeric.sql"],
      [",", "punctuation.sql"],
      [".5", "constant.numeric.sql"],
      [",", "punctuation.sql"],
      ["0x1p4", "constant.numeric.sql"],
    ],
  ],
  [
    "SELECT x.1.2, db.t.c, (1, 2).2",
    [
      ["SELECT", "keyword.other.sql"],
      ["x", "variable.other.sql"],
      [".", "punctuation.sql"],
      ["1", "constant.numeric.sql"],
      [".", "punctuation.sql"],
      ["2", "constant.numeric.sql"],
      [",", "punctuation.sql"],
      ["db", "variable.other.sql"],
      [".", "punctuation.sql"],
      ["t", "variable.other.sql"],
      [".", "punctuation.sql"],
      ["c", "variable.other.sql"],
      [",", "punctuation.sql"],
      ["(", "punctuation.sql"],
      ["1", "constant.numeric.sql"],
      [",", "punctuation.sql"],
      ["2", "constant.numeric.sql"],
      [").", "punctuation.sql"],
      ["2", "constant.numeric.sql"],
    ],
  ],
  [
    "SELECT a <=> b || c, x -> x != 2, a::UInt8",
    [
      ["SELECT", "keyword.other.sql"],
      ["a", "variable.other.sql"],
      ["<=>", "keyword.operator.sql"],
      ["b", "variable.other.sql"],
      ["||", "keyword.operator.sql"],
      ["c", "variable.other.sql"],
      [",", "punctuation.sql"],
      ["x", "variable.other.sql"],
      ["->", "keyword.operator.sql"],
      ["x", "variable.other.sql"],
      ["!=", "keyword.operator.sql"],
      ["2", "constant.numeric.sql"],
      [",", "punctuation.sql"],
      ["a", "variable.other.sql"],
      ["::", "keyword.operator.sql"],
      ["UInt8", "storage.type.sql"],
    ],
  ],
  [
    "SELECT {id:UInt64}, { name: Array(String) }, {1 : 'a'}",
    [
      ["SELECT", "keyword.other.sql"],
      ["{id:UInt64}", "variable.parameter.sql"],
      [",", "punctuation.sql"],
      ["{ name: Array(String) }", "variable.parameter.sql"],
      [",", "punctuation.sql"],
      ["{", "punctuation.sql"],
      ["1", "constant.numeric.sql"],
      [":", "keyword.operator.sql"],
      ["'a'", "string.quoted.single.sql"],
      ["}", "punctuation.sql"],
    ],
  ],
  [
    "SELECT NULL, true, count(), if(a, 1, 2) FROM t WHERE a IN (1)",
    [
      ["SELECT", "keyword.other.sql"],
      ["NULL", "constant.language.sql"],
      [",", "punctuation.sql"],
      ["true", "constant.language.sql"],
      [",", "punctuation.sql"],
      ["count", "entity.name.function.sql"],
      ["(),", "punctuation.sql"],
      ["if", "entity.name.function.sql"],
      ["(", "punctuation.sql"],
      ["a", "variable.other.sql"],
      [",", "punctuation.sql"],
      ["1", "constant.numeric.sql"],
      [",", "punctuation.sql"],
      ["2", "constant.numeric.sql"],
      [")", "punctuation.sql"],
      ["FROM", "keyword.other.sql"],
      ["t", "variable.other.sql"],
      ["WHERE", "keyword.other.sql"],
      ["a", "variable.other.sql"],
      ["IN", "keyword.other.sql"],
      ["(", "punctuation.sql"],
      ["1", "constant.numeric.sql"],
      [")", "punctuation.sql"],
    ],
  ],
  [
    "CREATE TABLE t (d Date, `key` String, n Nullable(Int64)) ENGINE = Memory",
    [
      ["CREATE", "keyword.other.sql"],
      ["TABLE", "keyword.other.sql"],
      ["t", "variable.other.sql"],
      ["(", "punctuation.sql"],
      ["d", "variable.other.sql"],
      ["Date", "storage.type.sql"],
      [",", "punctuation.sql"],
      ["`key`", "variable.other.sql"],
      ["String", "storage.type.sql"],
      [",", "punctuation.sql"],
      ["n", "variable.other.sql"],
      ["Nullable", "storage.type.sql"],
      ["(", "punctuation.sql"],
      ["Int64", "storage.type.sql"],
      ["))", "punctuation.sql"],
      ["ENGINE", "keyword.other.sql"],
      ["=", "keyword.operator.sql"],
      ["Memory", "variable.other.sql"],
    ],
  ],
  [
    "ALTER TABLE t MODIFY COLUMN key String",
    [
      ["ALTER", "keyword.other.sql"],
      ["TABLE", "keyword.other.sql"],
      ["t", "variable.other.sql"],
      ["MODIFY", "keyword.other.sql"],
      ["COLUMN", "keyword.other.sql"],
      ["key", "variable.other.sql"],
      ["String", "storage.type.sql"],
    ],
  ],
  [
    "SELECT CAST(x AS Decimal(9, 2)) FORMAT JSON",
    [
      ["SELECT", "keyword.other.sql"],
      ["CAST", "entity.name.function.sql"],
      ["(", "punctuation.sql"],
      ["x", "variable.other.sql"],
      ["AS", "keyword.other.sql"],
      ["Decimal", "storage.type.sql"],
      ["(", "punctuation.sql"],
      ["9", "constant.numeric.sql"],
      [",", "punctuation.sql"],
      ["2", "constant.numeric.sql"],
      ["))", "punctuation.sql"],
      ["FORMAT", "keyword.other.sql"],
      ["JSON", "variable.other.sql"],
    ],
  ],
  [
    "SELECT 1 ! 2 & é \\G",
    [
      ["SELECT", "keyword.other.sql"],
      ["1", "constant.numeric.sql"],
      ["!", "invalid.illegal.sql"],
      ["2", "constant.numeric.sql"],
      ["&", "invalid.illegal.sql"],
      ["é", "invalid.illegal.sql"],
      ["\\G", "punctuation.sql"],
    ],
  ],
];

describe("grammar scopes", () => {
  for (const [sql, expected] of CASES) {
    test(JSON.stringify(sql), async () => {
      assert.deepEqual(await grammarTokens(sql), expected);
    });
  }
});

/** The scope highlight() gives each offset of `sql`. */
function libraryScopes(sql: string): (string | undefined)[] {
  const scopes: (string | undefined)[] = new Array(sql.length).fill(undefined);
  for (const span of highlight(sql)) scopes.fill(span.scope, span.start, span.end);
  return scopes;
}

// highlight() also looks at the grammar around a word, so only the cases above are compared.
// Line breaks are left out: TextMate scopes lines without their line break.
describe("the grammar agrees with highlight()", () => {
  for (const [sql] of CASES) {
    test(JSON.stringify(sql), async () => {
      const expected = libraryScopes(sql);
      const actual = await grammarScopes(sql);
      for (let i = 0; i < sql.length; i++) {
        if (sql[i] === "\n" || sql[i] === "\r" || actual[i] === expected[i]) continue;
        const context = JSON.stringify(sql.slice(Math.max(0, i - 20), i + 20));
        assert.fail(`offset ${i} in ${context}: grammar says ${actual[i]}, highlight() says ${expected[i]}`);
      }
    });
  }
});
