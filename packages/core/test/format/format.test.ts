import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { gunzipSync } from "node:zlib";

import { check } from "../../src/parser/index.js";
import { format } from "../../src/format/index.js";
import { sameTokens } from "../../src/format/format.js";
import { tokenize } from "../../src/lexer/index.js";
import { type KeywordCase, TokenKind, isErrorKind } from "../../src/types.js";
import { GOLDEN } from "./golden.js";

/** The significant tokens of a text, keywords in upper case, and its comments. */
function contents(sql: string): { tokens: string[]; comments: string[] } {
  const tokens: string[] = [];
  const comments: string[] = [];
  for (const t of tokenize(sql)) {
    const text = sql.slice(t.start, t.end);
    if (t.kind === TokenKind.Comment) comments.push(text.replace(/\r$/, ""));
    else if (t.kind !== TokenKind.Whitespace) tokens.push(t.kind === TokenKind.BareWord ? text.toUpperCase() : text);
  }
  return { tokens, comments: comments.sort() };
}

/** format() and the checks that hold for every input: idempotent, same contents, still valid. */
function formats(input: string, expected: string, options?: Parameters<typeof format>[1]): void {
  const output = format(input, options);
  assert.equal(output, expected);
  assert.equal(format(output, options), output, "format() is idempotent");
  // Inline data such as CSV with a lone quote does not lex as SQL; the outputs above pin it.
  if (!tokenize(input).some((t) => isErrorKind(t.kind))) assert.deepEqual(contents(output), contents(input), "the tokens and comments are kept");
  if (check(input).length === 0) assert.deepEqual(check(output), [], "the output is still valid");
}

describe("format() lays out each kind of statement", () => {
  for (const [name, input, expected] of GOLDEN) {
    test(name, () => formats(input, expected));
  }
});

describe("format() keeps what it does not lay out", () => {
  test("names, quoted identifiers and the case of functions and types", () => {
    formats(
      'select "MyCol", `from`, CoUnT(x), toStartOfDay(d), Lower(s), CAST(x AS String), y::DateTime64(3) from "Db"."T"',
      'SELECT\n    "MyCol",\n    `from`,\n    CoUnT(x),\n    toStartOfDay(d),\n    Lower(s),\n    CAST(x AS String),\n    y::DateTime64(3)\nFROM "Db"."T"',
    );
  });

  test("columns named like keywords", () => {
    formats("select key, value, date, type, id from t where key = 1", "SELECT\n    key,\n    value,\n    date,\n    type,\n    id\nFROM t\nWHERE key = 1");
    formats("select a from t format Null", "SELECT a\nFROM t\nFORMAT Null");
    formats("create table t (a UInt8) engine = Null", "CREATE TABLE t\n(\n    a UInt8\n)\nENGINE = Null");
  });

  test("strings, heredocs, numbers and query parameters", () => {
    formats(
      "select 'it''s -- not a comment', $tag$ x; -- y $tag$, $$z$$, 1e-3, 0x1F, 1_000, {p: Array(String)} from t",
      "SELECT\n    'it''s -- not a comment',\n    $tag$ x; -- y $tag$,\n    $$z$$,\n    1e-3,\n    0x1F,\n    1_000,\n    {p: Array(String)}\nFROM t",
    );
    formats("select 'a\nb' as s", "SELECT 'a\nb' AS s");
  });

  test("query parameters wherever they are, as ClickHouse reads the type from its text", () => {
    for (const sql of [
      "SELECT {a:Identifier}.{b:Dynamic(max_types=2)}",
      "SELECT 1 .{x:x}",
      "ALTER TABLE tbl (UPDATE x = 1 WHERE {p:Time64(0)})",
      "SELECT x FROM a STREAM WATERMARK FOR x AS f({p:Dynamic(max_types=6)})",
      "SELECT 1 LIMIT UNTIL {p:Dynamic(max_types=10)}",
      "ATTACH TABLE x UUID 'c0d9e426-805d-a116-8c7d-e0c53859a441' AS REPLICATED (x Array ALIAS ({x:Array()}))",
      "(FROM (x, x) JOIN x USING (1) ARRAY JOIN (({x:x})))",
      "SELECT * APPLY lambda(tuple(x), isNull(x)) EXCEPT STRICT (`a`), toInt16OrNull({p:DateTime64(7)}) FROM t",
    ]) {
      const parameters = sql.match(/\{[^{}]*\}/g)!;
      const output = format(sql);
      for (const parameter of parameters) assert.ok(output.includes(parameter), `${sql}\n${output}`);
    }
  });

  // A query parameter with spaces in place of each number of statements of ClickHouse's tests.
  test("query parameters in place of the numbers of ClickHouse's tests", () => {
    const parameter = "{p : Dynamic( max_types=2 )}";
    const statements = gunzipSync(readFileSync(new URL("../../../../oracle/fixtures/corpus.jsonl.gz", import.meta.url)))
      .toString("utf8")
      .split("\n")
      .slice(1)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { sql: string; valid: boolean })
      .filter((entry) => entry.valid && entry.sql.length < 2000)
      .map((entry) => entry.sql);
    let tried = 0;
    const changed: string[] = [];
    for (const sql of statements) {
      const numbers = tokenize(sql).filter((t) => t.kind === TokenKind.Number);
      if (numbers.length === 0) continue;
      const number = numbers[sql.length % numbers.length]!;
      const replaced = sql.slice(0, number.start) + parameter + sql.slice(number.end);
      if (check(replaced).length > 0) continue;
      tried++;
      if (!format(replaced).includes(parameter)) changed.push(replaced);
    }
    assert.ok(tried > 3000, `only ${tried} statements`);
    assert.deepEqual(changed, []);
  });

  test("literals that ClickHouse casts from their text", () => {
    formats("select [1,2]::Array(UInt8), - 1::Int8, CAST([ 1,2 ] AS Array(UInt8))", "SELECT\n    [1,2]::Array(UInt8),\n    - 1::Int8,\n    CAST([ 1,2 ] AS Array(UInt8))");
  });

  test("the literal of CAST(x, 'T') too, but not of CAST(x, T)", () => {
    formats(
      "select CAST([1.5,2.5,  3.5], 'Array(Decimal64(2))'), cast([1,2], t)",
      "SELECT\n    CAST([1.5,2.5,  3.5], 'Array(Decimal64(2))'),\n    cast([1, 2], t)",
    );
    formats("SELECT CAST([2,3],'Array(Int128)')", "SELECT CAST([2,3], 'Array(Int128)')");
  });

  test("INSERT data after VALUES", () => {
    formats("insert into t values (1,'x;y'),( 2 ,  'it''s' );", "INSERT INTO t VALUES (1,'x;y'),( 2 ,  'it''s' );");
    formats("insert into t values\n(1), -- one\n(2);\nselect 1", "INSERT INTO t VALUES\n(1), -- one\n(2);\n\nSELECT 1");
    formats("insert into t format Values (1),(2)", "INSERT INTO t FORMAT Values (1),(2)");
    // A table called format: script splitters still read FORMAT Values by its spelling.
    formats("insert into table format Values (1);\nselect 1", "INSERT INTO TABLE format Values (1);\n\nSELECT 1");
  });

  test("INSERT data after FORMAT, up to an empty line", () => {
    formats(
      "insert into t format CSV\n1,'a\n2,\"b;\"\n\nselect 1",
      "INSERT INTO t FORMAT CSV\n1,'a\n2,\"b;\"\n\nSELECT 1",
    );
    formats("insert into t format TSV 1\t2\n", "INSERT INTO t FORMAT TSV 1\t2\n");
    // Data that runs to the end keeps every byte: an empty last column, spaces, its line breaks.
    formats("INSERT INTO t FORMAT TSV\n1\t2\t\n", "INSERT INTO t FORMAT TSV\n1\t2\t\n");
    formats("insert into t format CSV\n1,2\n  ", "INSERT INTO t FORMAT CSV\n1,2\n  ");
    formats("INSERT INTO format FORMAT TabSeparated\r\n\tJKL\n", "INSERT INTO format FORMAT TabSeparated\r\n\tJKL\n");
    formats(
      "insert into t select * from input('a UInt8') format CSV\n1\n",
      "INSERT INTO t\nSELECT *\nFROM input('a UInt8')\nFORMAT CSV\n1\n",
    );
  });

  test("a statement that check() rejects, and only that one", () => {
    formats("select 1;select (  1;\nselect  2", "SELECT 1;\n\nselect (  1;\n\nSELECT 2");
    formats("SELECT 1 FROM\n", "SELECT 1 FROM\n");
    formats("'\n", "'\n");
  });

  test("an INSERT that ends in its target", () => {
    const sqls = ["insert into", "insert into -- x", "insert into table", "insert into db.", "insert into {", "INSERT INTO {x"];
    for (const sql of [...sqls, "EXPLAIN INSERT INTO", "WITH 1 AS x INSERT INTO"]) formats(sql, sql);
    formats("SELECT 1; INSERT INTO", "SELECT 1;\n\nINSERT INTO");
  });

  test("a byte order mark at the start", () => {
    formats("\uFEFFselect 1\n", "\uFEFFSELECT 1\n");
  });

  test("empty and blank input", () => {
    assert.equal(format(""), "");
    assert.equal(format("  \n\t\n"), "  \n\t\n");
  });
});

describe("format() re-cases only the words that the parser reads as keywords", () => {
  // ClickHouse names are case-sensitive, so a name spelled like a keyword keeps its case.
  const cases: [string, string][] = [
    ["update metrics set value = 42 where id = 1", "UPDATE metrics SET value = 42 WHERE id = 1"],
    ["select case offset when 0 then 'first' else 'later' end from kafka", "SELECT CASE offset WHEN 0 THEN 'first' ELSE 'later' END\nFROM kafka"],
    ["select * except format from t", "SELECT * EXCEPT format\nFROM t"],
    ["select URL, uniq(s) as all from hits group by URL order by all desc, URL", "SELECT\n    URL,\n    uniq(s) AS all\nFROM hits\nGROUP BY URL\nORDER BY\n    all DESC,\n    URL"],
    ["select toDateTime('2017-01-01 00:00:00') + interval as mcs from t", "SELECT toDateTime('2017-01-01 00:00:00') + interval AS mcs\nFROM t"],
    ["select 1 interpolate", "SELECT 1 interpolate"],
    ["set final", "SET final"],
    ["set limit", "SET limit"],
    ["set readonly", "SET readonly"],
    ["set compression", "SET compression"],
    ["rename table x to disk", "RENAME TABLE x TO disk"],
    ["truncate table sync", "TRUNCATE TABLE sync"],
    ["drop table t, comment", "DROP TABLE t, comment"],
    ["alter table t add index index a type minmax", "ALTER TABLE t ADD INDEX index a TYPE minmax"],
    ["SELECT f(select)", "SELECT f(select)"],
    ["select (with, a)", "SELECT (with, a)"],
    ["SELECT CASE from WHEN 1 THEN 2 END FROM t", "SELECT CASE from WHEN 1 THEN 2 END\nFROM t"],
    ["INSERT INTO t (null) VALUES (1)", "INSERT INTO t (null) VALUES (1)"],
    ["SHOW TABLES FROM final", "SHOW TABLES FROM final"],
    ["desc table cleanup", "DESC TABLE cleanup"],
    ["exists table strict", "EXISTS TABLE strict"],
    ["show create table pull", "SHOW CREATE TABLE pull"],
    ["GRANT SELECT ON t TO all", "GRANT SELECT ON t TO all"],
    ["select arrayMap(select -> select + 1, [1])", "SELECT arrayMap(select -> select + 1, [1])"],
    ["select 1 key from t", "SELECT 1 key\nFROM t"],
  ];
  for (const [input, expected] of cases) {
    test(input, () => formats(input, expected));
  }

  test("in upper and lower case", () => {
    // A statement and the part of it with a name that keeps its case.
    const cases: [string, string][] = [
      ["SELECT 1 WINDOW w AS (rows)", "(rows)"],
      ["SELECT 1 WINDOW w AS (range)", "(range)"],
      ["SELECT 1 WINDOW w AS (groups)", "(groups)"],
      ["SYSTEM FLUSH LOGS ON CLUSTER default query_log", " default query_log"],
      ["SYSTEM FLUSH LOGS ON CLUSTER all t", " all t"],
      ["SYSTEM RELOAD DICTIONARY ON CLUSTER c d", " c d"],
      ["SHOW TABLES FORMAT Null", " Null"],
      ["SHOW TABLES FORMAT Values", " Values"],
      ["BACKUP TABLE t TO Disk('b', 'x') SETTINGS base_backup = DEFAULT", " = DEFAULT"],
      ["SET ROLE", " ROLE"],
    ];
    for (const [sql, name] of cases) {
      for (const keywordCase of ["upper", "lower"] as const) {
        const output = format(sql, { keywordCase });
        assert.ok(output.includes(name), `${keywordCase}: ${output}`);
        formats(sql, output, { keywordCase });
      }
    }
  });

  test("the safety net rejects a re-cased word that is not a keyword", () => {
    const keywordAt = (start: number) => start === 0;
    assert.equal(sameTokens("update metrics", "UPDATE metrics", keywordAt), true);
    assert.equal(sameTokens("update metrics", "UPDATE METRICS", keywordAt), false);
  });
});

describe("format() keeps every comment", () => {
  test("after list items, clauses and keywords", () => {
    formats(
      "SELECT a, -- first\n  b /* second */, c\nFROM t -- the table\nWHERE /* before */ x = 1 AND -- and\n  y = 2",
      "SELECT\n    a, -- first\n    b /* second */,\n    c\nFROM t -- the table\nWHERE /* before */ x = 1 AND -- and\n    y = 2",
    );
  });

  test("on lines of their own", () => {
    formats(
      "SELECT\n  -- a line\n  a,\n  /* a block */\n  b\nFROM t\n-- before WHERE\nWHERE c",
      "SELECT\n    -- a line\n    a,\n    /* a block */\n    b\nFROM t\n-- before WHERE\nWHERE c",
    );
  });

  test("inside calls, subqueries and column lists", () => {
    formats("select count(/* all */ x) from t", "SELECT count(/* all */ x)\nFROM t");
    formats(
      "select a from ( -- why\n select 1 as a\n -- last\n) as s",
      "SELECT a\nFROM ( -- why\n    SELECT 1 AS a\n    -- last\n) AS s",
    );
    formats(
      "create table t ( -- columns\n a UInt8, -- the a\n -- before b\n b String\n) engine = Memory -- engine",
      "CREATE TABLE t\n( -- columns\n    a UInt8, -- the a\n    -- before b\n    b String\n)\nENGINE = Memory -- engine",
    );
  });

  test("that span lines", () => {
    formats("select\n/* one\n   two */\n1", "SELECT\n    /* one\n   two */\n    1");
  });

  test("before a semicolon, between statements and at the end", () => {
    formats("select 1 -- one\n;", "SELECT 1 -- one\n;");
    formats(
      "-- file header\n\n-- about the first\nselect 1; -- after it\n-- about the second\nselect 2;\n-- the end\n",
      "-- file header\n\n-- about the first\nSELECT 1; -- after it\n\n-- about the second\nSELECT 2;\n-- the end\n",
    );
    formats("-- only a comment", "-- only a comment");
    formats("# hash\nselect 1 // slash", "# hash\nSELECT 1 // slash");
  });

  test("next to each other", () => {
    formats("select a /* one */ /* two */ from t", "SELECT a /* one */ /* two */\nFROM t");
  });
});

describe("format() separates statements", () => {
  test("with a semicolon and an empty line", () => {
    formats("select 1;select 2;\n\n\n\nselect 3", "SELECT 1;\n\nSELECT 2;\n\nSELECT 3");
  });

  test("keeping a stray semicolon", () => {
    formats("select 1;;", "SELECT 1;;");
  });

  test("ending with a line break when the input does", () => {
    assert.equal(format("select 1\n"), "SELECT 1\n");
    assert.equal(format("select 1"), "SELECT 1");
  });
});

describe("format() options", () => {
  const sql = "select a, b from t where x in (select 1)";

  test("keywordCase", () => {
    formats(sql, "select\n    a,\n    b\nfrom t\nwhere x in (\n    select 1\n)", { keywordCase: "lower" });
    formats("Select a From t", "Select a\nFrom t", { keywordCase: "preserve" });
    formats("select a from t", "SELECT a\nFROM t", { keywordCase: "upper" });
    // A value from an editor setting may be anything.
    formats("select a from t", "SELECT a\nFROM t", { keywordCase: "Lower" as KeywordCase });
  });

  test("indentSize", () => {
    formats(sql, "SELECT\n  a,\n  b\nFROM t\nWHERE x IN (\n  SELECT 1\n)", { indentSize: 2 });
    formats(sql, "SELECT\na,\nb\nFROM t\nWHERE x IN (\nSELECT 1\n)", { indentSize: 0 });
    assert.equal(format(sql, { indentSize: -1 }), format(sql));
  });
});

describe("format() keeps the line endings of the input", () => {
  test("CRLF", () => {
    formats(
      "select a, -- one\r\n b from t;\r\nselect 2\r\n",
      "SELECT\r\n    a, -- one\r\n    b\r\nFROM t;\r\n\r\nSELECT 2\r\n",
    );
  });

  test("CRLF inside strings and comments stays as written", () => {
    formats("select 'a\r\nb', /* c\r\nd */ 1\r\n", "SELECT\r\n    'a\r\nb', /* c\r\nd */\r\n    1\r\n");
  });

  test("CRLF after a line comment that ends a statement with an error", () => {
    formats("select (; -- c\r\nselect 1\r\n", "select (; -- c\r\n\r\nSELECT 1\r\n");
    formats("select 1\r\nselect (; -- c\r\n", "select 1\r\nselect (; -- c\r\n");
  });

  test("LF when the first line break is LF", () => {
    assert.equal(format("select 1;\nselect 2;\r\n"), "SELECT 1;\n\nSELECT 2;\n");
  });

  test("from line breaks between tokens, not those in strings and literals kept as written", () => {
    formats("select 'a\nb' as s, c\r\nfrom t\r\n", "SELECT\r\n    'a\nb' AS s,\r\n    c\r\nFROM t\r\n");
    formats("SELECT\r\n[(0.0, 0.0),\n(1.0, 1.0)]::Ring AS g FORMAT JSON", "SELECT [(0.0, 0.0),\n(1.0, 1.0)]::Ring AS g\r\nFORMAT JSON");
  });

  test("CR alone", () => {
    formats("select a, b\rfrom t\r", "SELECT\r    a,\r    b\rFROM t\r");
    formats("-- x\r", "-- x\r");
  });

  test("LF instead of a lone CR that would leave a line comment open", () => {
    // A line comment ends only at "\n": after "-- c\r\r" the next statement would be a part of the comment.
    formats("select 1;\rselect 2; -- c\nselect 3", "SELECT 1;\n\nSELECT 2; -- c\n\nSELECT 3");
  });

  test("a CR at the end that is not a line break of a line comment", () => {
    formats("select 1;\r\n'abc\r", "SELECT 1;\r\n\r\n'abc\r");
    formats("select 1;\r\ninsert into t values (1) -- c\n", "SELECT 1;\r\n\r\nINSERT INTO t VALUES (1) -- c\r\n");
  });

  test("mixed line breaks", () => {
    formats("\nSELECT -- c\r\nx, y", "SELECT -- c\r\n    x,\r\n    y");
    formats("\r\nSELECT /* a\nb */ 1\n", "SELECT /* a\nb */ 1\n");
    formats("SELECT '\n' AS x\r\nFROM t", "SELECT '\n' AS x\r\nFROM t");
  });

  test("the CR at the end of a line comment is a part of the line break after it", () => {
    formats("select\na -- c\r\nfrom t where x", "SELECT a -- c\nFROM t\nWHERE x");
  });
});

describe("format() speed", () => {
  // Quadratic work would take minutes here.
  test("takes time in proportion to the input", { timeout: 20_000 }, () => {
    const sql = Array.from({ length: 10000 }, (_, i) => `select a, b, count() from t${i} where x in (${i}, 2) group by a, b order by a;`).join("\n");
    const output = format(sql);
    assert.equal(output.split(";\n\n").length, 10000);
  });
});
