import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { highlight } from "../../src/highlight/index.js";
import { tokenize } from "../../src/lexer/index.js";
import { TokenKind, type Scope } from "../../src/types.js";
import { GOLDEN_PATH, type GoldenEntry } from "../lexer/golden.js";

/** The text and scope of every span. */
function spans(sql: string): [string, Scope][] {
  return highlight(sql).map((span) => [sql.slice(span.start, span.end), span.scope]);
}

/** The scope of each listed word or symbol, in order; `sql` may hold other tokens in between. */
function assertScopes(sql: string, expected: [string, Scope][]): void {
  const actual = spans(sql);
  let from = 0;
  for (const [text, scope] of expected) {
    const found = actual.findIndex(([t], i) => i >= from && t === text);
    assert.ok(found >= 0, `${JSON.stringify(text)} not found after span ${from} in ${JSON.stringify(actual)}`);
    assert.equal(actual[found]![1], scope, `scope of ${JSON.stringify(text)} in ${JSON.stringify(sql)}`);
    from = found + 1;
  }
}

/** Checks the promises of highlight(): sorted spans that cover every token but whitespace. */
function assertWellFormed(sql: string): void {
  const result = highlight(sql);
  let end = 0;
  for (const span of result) {
    assert.ok(span.start >= end && span.end > span.start, `bad span ${JSON.stringify(span)} in ${JSON.stringify(sql)}`);
    end = span.end;
  }
  for (const token of tokenize(sql)) {
    if (token.kind === TokenKind.EndOfStream) continue;
    const span = result.find((s) => s.start <= token.start && token.end <= s.end);
    const inParameter = span?.scope === "variable.parameter.sql";
    if (token.kind === TokenKind.Whitespace) assert.ok(!span || inParameter, `whitespace covered in ${JSON.stringify(sql)}`);
    else assert.ok(span, `${token.kind} at ${token.start} not covered in ${JSON.stringify(sql)}`);
  }
}

describe("spans are sorted and cover every token but whitespace", () => {
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as GoldenEntry[];
  test("the lexer's golden inputs", () => {
    for (const entry of golden) assertWellFormed(entry.sql);
  });

  test("random input", () => {
    const pieces = ["SELECT", "x", "UInt8", "(", ")", "{", "}", "::", ":", ".", ",", ";", "AS", "CAST", "'s", "'", " ", "\n", "/*", "*/", "--", "1", "$$"];
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let i = 0; i < 2000; i++) {
      let sql = "";
      for (let length = 1 + random(15); length > 0; length--) sql += pieces[random(pieces.length)];
      assertWellFormed(sql);
    }
  });
});

describe("scopes", () => {
  test("each kind of token", () => {
    assert.deepEqual(spans("SELECT 1.5e3, 'it''s', $doc$ text $doc$, NULL, true, x, `y` FROM t; -- done"), [
      ["SELECT", "keyword.other.sql"],
      ["1.5e3", "constant.numeric.sql"],
      [",", "punctuation.sql"],
      ["'it''s'", "string.quoted.single.sql"],
      [",", "punctuation.sql"],
      ["$doc$ text $doc$", "string.unquoted.heredoc.sql"],
      [",", "punctuation.sql"],
      ["NULL", "constant.language.sql"],
      [",", "punctuation.sql"],
      ["true", "constant.language.sql"],
      [",", "punctuation.sql"],
      ["x", "variable.other.sql"],
      [",", "punctuation.sql"],
      ["`y`", "variable.other.sql"],
      ["FROM", "keyword.other.sql"],
      ["t", "variable.other.sql"],
      [";", "punctuation.sql"],
      ["-- done", "comment.line.sql"],
    ]);
  });

  test("comments", () => {
    assert.deepEqual(spans("/* a /* b */ c */ # hash\n#!shebang\n// slashes"), [
      ["/* a /* b */ c */", "comment.block.sql"],
      ["# hash", "comment.line.sql"],
      ["#!shebang", "comment.line.sql"],
      ["// slashes", "comment.line.sql"],
    ]);
  });

  test("operators and punctuation", () => {
    const sql = "a || b -> c <=> d |> e :: f != g ? h : i % j [1] {} . \\G";
    for (const [text, scope] of spans(sql)) {
      const expected = /^[a-j1]$/.test(text) ? "variable.other.sql" : /^[[\]{}.]$|^\\G$/.test(text) ? "punctuation.sql" : "keyword.operator.sql";
      if (text !== "1") assert.equal(scope, expected, text);
    }
  });

  test("error tokens", () => {
    assert.deepEqual(spans("SELECT 1 ! 2 & é 'open"), [
      ["SELECT", "keyword.other.sql"],
      ["1", "constant.numeric.sql"],
      ["!", "invalid.illegal.sql"],
      ["2", "constant.numeric.sql"],
      ["&", "invalid.illegal.sql"],
      ["é", "invalid.illegal.sql"],
      ["'open", "invalid.illegal.sql"],
    ]);
  });

  test("a query parameter is one span, with what is inside it", () => {
    assert.deepEqual(spans("SELECT {id:UInt64}, {m:Map(String, Array(UInt8)) /* c */} FROM {db:Identifier}.t"), [
      ["SELECT", "keyword.other.sql"],
      ["{id:UInt64}", "variable.parameter.sql"],
      [",", "punctuation.sql"],
      ["{m:Map(String, Array(UInt8)) /* c */}", "variable.parameter.sql"],
      ["FROM", "keyword.other.sql"],
      ["{db:Identifier}", "variable.parameter.sql"],
      [".", "punctuation.sql"],
      ["t", "variable.other.sql"],
    ]);
    assert.deepEqual(spans("{a}"), [
      ["{", "punctuation.sql"],
      ["a", "variable.other.sql"],
      ["}", "punctuation.sql"],
    ]);
  });
});

describe("bare words", () => {
  test("keywords, phrases and names", () => {
    assertScopes("SELECT number FROM system.numbers ORDER BY number DESC LIMIT 1", [
      ["SELECT", "keyword.other.sql"],
      ["number", "variable.other.sql"],
      ["FROM", "keyword.other.sql"],
      ["system", "variable.other.sql"],
      ["numbers", "variable.other.sql"],
      ["ORDER", "keyword.other.sql"],
      ["BY", "keyword.other.sql"],
      ["DESC", "keyword.other.sql"],
      ["LIMIT", "keyword.other.sql"],
    ]);
  });

  test("a keyword next to a dot is a name", () => {
    assertScopes("SELECT t.key, default.table", [
      ["key", "variable.other.sql"],
      ["default", "variable.other.sql"],
      ["table", "variable.other.sql"],
    ]);
  });

  test("without a parse, a name before ( on the same line is a function", () => {
    assertScopes("SELECT count(), sum (x), max\n(y), quantile(0.5)(z) FROM numbers(10) WHERE", [
      ["count", "entity.name.function.sql"],
      ["sum", "entity.name.function.sql"],
      ["x", "variable.other.sql"],
      ["max", "keyword.other.sql"],
      ["y", "variable.other.sql"],
      ["quantile", "entity.name.function.sql"],
      ["numbers", "entity.name.function.sql"],
    ]);
  });

  test("keywords before ( and tables before their columns are not functions", () => {
    assertScopes("INSERT INTO t (a) SELECT * FROM x WHERE a IN (1) AND NOT (b) GROUP BY ROLLUP(a)", [
      ["t", "variable.other.sql"],
      ["IN", "keyword.other.sql"],
      ["AND", "keyword.other.sql"],
      ["NOT", "keyword.other.sql"],
      ["ROLLUP", "keyword.other.sql"],
    ]);
    assertScopes("CREATE TABLE IF NOT EXISTS db.t ON CLUSTER c (x UInt8)", [
      ["t", "variable.other.sql"],
      ["c", "variable.other.sql"],
    ]);
  });

  test("a keyword is a name after AS and before a comparison", () => {
    assertScopes("SELECT 1 AS key, 2 AS s FROM t WHERE name = 'x' AND type != 1 AND (id < 3)", [
      ["key", "variable.other.sql"],
      ["s", "variable.other.sql"],
      ["name", "variable.other.sql"],
      ["type", "variable.other.sql"],
      ["id", "variable.other.sql"],
    ]);
    assertScopes("CREATE VIEW v AS SELECT 1", [["SELECT", "keyword.other.sql"]]);
  });

  test("a short unit is a keyword only after a number or a string", () => {
    assertScopes("SELECT d, INTERVAL 1 D, INTERVAL '2' S, INTERVAL 3 DAY > INTERVAL 1 HOUR", [
      ["d", "variable.other.sql"],
      ["D", "keyword.other.sql"],
      ["S", "keyword.other.sql"],
      ["DAY", "keyword.other.sql"],
      ["HOUR", "keyword.other.sql"],
    ]);
  });

  test("the engine is a name or a function", () => {
    assertScopes("CREATE TABLE t (x UInt8) ENGINE = Null; CREATE TABLE u (x UInt8) ENGINE = Join(ANY, LEFT, x)", [
      ["ENGINE", "keyword.other.sql"],
      ["Null", "variable.other.sql"],
      ["ENGINE", "keyword.other.sql"],
      ["Join", "entity.name.function.sql"],
    ]);
  });

  test("SYSTEM commands are keywords, and what follows them is a name", () => {
    assertScopes("SYSTEM STOP MERGES t; SYSTEM FLUSH LOGS; SYSTEM DROP DNS CACHE", [
      ["SYSTEM", "keyword.other.sql"],
      ["STOP", "keyword.other.sql"],
      ["MERGES", "keyword.other.sql"],
      ["t", "variable.other.sql"],
      ["FLUSH", "keyword.other.sql"],
      ["LOGS", "keyword.other.sql"],
      ["DROP", "keyword.other.sql"],
      ["DNS", "keyword.other.sql"],
      ["CACHE", "keyword.other.sql"],
    ]);
  });

  test("access entities are keywords", () => {
    assertScopes("DROP USER IF EXISTS u; SHOW POLICIES", [
      ["USER", "keyword.other.sql"],
      ["u", "variable.other.sql"],
      ["POLICIES", "keyword.other.sql"],
    ]);
  });
});

describe("data types", () => {
  test("after ::, in CAST and inside other types", () => {
    assertScopes("SELECT x::Array(Nullable(UInt8)), CAST(y AS DateTime64(3, 'UTC')), CAST(z, 'String')", [
      ["Array", "storage.type.sql"],
      ["Nullable", "storage.type.sql"],
      ["UInt8", "storage.type.sql"],
      ["CAST", "entity.name.function.sql"],
      ["y", "variable.other.sql"],
      ["AS", "keyword.other.sql"],
      ["DateTime64", "storage.type.sql"],
      ["3", "constant.numeric.sql"],
      ["CAST", "entity.name.function.sql"],
      ["'String'", "string.quoted.single.sql"],
    ]);
  });

  test("multi-word types", () => {
    assertScopes("SELECT x::DOUBLE PRECISION, y::INT UNSIGNED", [
      ["DOUBLE", "storage.type.sql"],
      ["PRECISION", "storage.type.sql"],
      ["INT", "storage.type.sql"],
      ["UNSIGNED", "storage.type.sql"],
    ]);
  });

  test("column definitions", () => {
    assertScopes(
      "CREATE TABLE t (ts DateTime DEFAULT now(), user_id UInt64 CODEC(ZSTD(1)), `tags` Array(String)) ENGINE = MergeTree",
      [
        ["t", "variable.other.sql"],
        ["ts", "variable.other.sql"],
        ["DateTime", "storage.type.sql"],
        ["DEFAULT", "keyword.other.sql"],
        ["now", "entity.name.function.sql"],
        ["user_id", "variable.other.sql"],
        ["UInt64", "storage.type.sql"],
        ["CODEC", "keyword.other.sql"],
        ["ZSTD", "entity.name.function.sql"],
        ["`tags`", "variable.other.sql"],
        ["Array", "storage.type.sql"],
        ["String", "storage.type.sql"],
        ["MergeTree", "variable.other.sql"],
      ],
    );
    assertScopes("ALTER TABLE t ADD COLUMN IF NOT EXISTS c LowCardinality(String), MODIFY COLUMN d Date", [
      ["c", "variable.other.sql"],
      ["LowCardinality", "storage.type.sql"],
      ["String", "storage.type.sql"],
      ["d", "variable.other.sql"],
      ["Date", "storage.type.sql"],
    ]);
  });

  test("named tuple elements, even when they are named like a type", () => {
    assertScopes("SELECT x::Tuple(a UInt8, date Date)", [
      ["Tuple", "storage.type.sql"],
      ["a", "variable.other.sql"],
      ["UInt8", "storage.type.sql"],
      ["date", "variable.other.sql"],
      ["Date", "storage.type.sql"],
    ]);
  });

  test("without a parse, a type name elsewhere is a name or a function", () => {
    assertScopes("SELECT String, Date, toDate(x), Array(1) FROM t WHERE", [
      ["String", "variable.other.sql"],
      ["Date", "keyword.other.sql"],
      ["toDate", "entity.name.function.sql"],
      ["Array", "entity.name.function.sql"],
    ]);
  });
});
