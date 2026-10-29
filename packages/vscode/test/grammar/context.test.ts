import * as assert from "node:assert/strict";
import { describe, test } from "node:test";
import { highlight } from "clickhouse-sql-syntax";
import { grammarScopes } from "./textmate.js";

const KEYWORD = "keyword.other.sql";
const NAME = "variable.other.sql";
const FUNCTION = "entity.name.function.sql";

/** The scope of the first character of every word outside strings, in order. */
function wordScopes(sql: string, scopes: (string | undefined)[]): [string, string | undefined][] {
  const outsideStrings = sql.replace(/'[^']*'/g, (text) => " ".repeat(text.length));
  return [...outsideStrings.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].map((m) => [m[0], scopes[m.index]]);
}

/** The scope highlight() gives each offset of `sql`. */
function libraryScopes(sql: string): (string | undefined)[] {
  const scopes: (string | undefined)[] = new Array(sql.length).fill(undefined);
  for (const span of highlight(sql)) scopes.fill(span.scope, span.start, span.end);
  return scopes;
}

// Words that are keywords in one place and names in another, coloured as highlight() colours them.
const CASES: [string, [string, string][]][] = [
  [
    "SELECT s, d FROM t WHERE x > now() - INTERVAL 1 d",
    [
      ["SELECT", KEYWORD], ["s", NAME], ["d", NAME], ["FROM", KEYWORD], ["t", NAME], ["WHERE", KEYWORD],
      ["x", NAME], ["now", FUNCTION], ["INTERVAL", KEYWORD], ["d", KEYWORD],
    ],
  ],
  ["SELECT INTERVAL '1' h", [["SELECT", KEYWORD], ["INTERVAL", KEYWORD], ["h", KEYWORD]]],
  [
    "SYSTEM FLUSH LOGS; system stop merges db.t",
    [
      ["SYSTEM", KEYWORD], ["FLUSH", KEYWORD], ["LOGS", KEYWORD],
      ["system", KEYWORD], ["stop", KEYWORD], ["merges", KEYWORD], ["db", NAME], ["t", NAME],
    ],
  ],
];

describe("words coloured by what is around them", () => {
  for (const [sql, expected] of CASES) {
    test(JSON.stringify(sql), async () => {
      assert.deepEqual(wordScopes(sql, await grammarScopes(sql)), expected);
      assert.deepEqual(wordScopes(sql, libraryScopes(sql)), expected);
    });
  }

  // The grammar takes these names for keywords; highlight() and the semantic tokens take them from the parser.
  test("keywords used as names", async () => {
    const sql = "SELECT * FROM t WHERE table IN (1); INSERT INTO index VALUES (1)";
    const words = (name: string): [string, string][] => [
      ["SELECT", KEYWORD], ["FROM", KEYWORD], ["t", NAME], ["WHERE", KEYWORD], ["table", name], ["IN", KEYWORD],
      ["INSERT", KEYWORD], ["INTO", KEYWORD], ["index", name], ["VALUES", KEYWORD],
    ];
    assert.deepEqual(wordScopes(sql, await grammarScopes(sql)), words(KEYWORD));
    assert.deepEqual(wordScopes(sql, libraryScopes(sql)), words(NAME));
  });

  // highlight() takes a unit only after a number or a string, so it leaves out the one after TO.
  test("the second unit of INTERVAL '1 2' DAY TO H", async () => {
    const sql = "SELECT INTERVAL '1 2' DAY TO h";
    assert.deepEqual(wordScopes(sql, await grammarScopes(sql)), [
      ["SELECT", KEYWORD], ["INTERVAL", KEYWORD], ["DAY", KEYWORD], ["TO", KEYWORD], ["h", KEYWORD],
    ]);
  });
});
