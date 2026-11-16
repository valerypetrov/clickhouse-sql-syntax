// Positions and messages are what ClickHouse 26.11 reports; where it gives no position, check() points at the clause.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { roles } from "../../src/parser/index.js";
import { accepts, rejects } from "./helpers.js";

describe("SELECT and expressions", () => {
  accepts([
    "SELECT 1",
    "SELECT a, b AS c, t.* FROM db.t AS t WHERE a > 1 AND b IN (1, 2) GROUP BY a HAVING count() > 1 ORDER BY a DESC NULLS LAST LIMIT 10 OFFSET 5",
    "WITH x AS (SELECT 1 AS a) SELECT a FROM x",
    "WITH 1 AS one SELECT one",
    "SELECT * FROM t1 INNER JOIN t2 ON t1.id = t2.id LEFT JOIN t3 USING (id)",
    "SELECT * FROM t1 GLOBAL ANY LEFT JOIN t2 USING id",
    "SELECT * FROM t ARRAY JOIN arr AS a",
    "SELECT x -> x + 1, arrayMap((x, y) -> x * y, [1, 2], [3, 4])",
    "SELECT CAST(1 AS String), 1::UInt8, CAST('1', 'UInt8')",
    "SELECT CASE WHEN a THEN 1 WHEN b THEN 2 ELSE 3 END, if(a, 1, 2), a ? 1 : 2",
    "SELECT INTERVAL 1 DAY, INTERVAL '1 hour', toStartOfInterval(t, INTERVAL 1 MONTH)",
    "SELECT {p:UInt8}, {name:String}",
    "SELECT count(*) OVER (PARTITION BY a ORDER BY b ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) FROM t",
    "SELECT sum(x) FILTER (WHERE x > 0), quantiles(0.5, 0.9)(x), countIf(x > 1) FROM t",
    "SELECT * EXCEPT (a) REPLACE (b + 1 AS b) APPLY (toString) FROM t",
    "SELECT COLUMNS('^a') FROM t",
    "SELECT 1 UNION ALL SELECT 2 UNION DISTINCT SELECT 3 EXCEPT SELECT 4 INTERSECT SELECT 5",
    "SELECT * FROM numbers(10) SETTINGS max_threads = 1 FORMAT JSONEachRow",
    "SELECT 1 INTO OUTFILE 'out.csv' TRUNCATE FORMAT CSV",
    "SELECT * FROM t PREWHERE a = 1 WHERE b = 2 QUALIFY row_number() OVER () = 1",
    "SELECT a FROM t GROUP BY GROUPING SETS ((a), (b), ()) WITH TOTALS",
    "SELECT * FROM t ORDER BY a WITH FILL FROM 1 TO 10 STEP 1 INTERPOLATE (b AS b + 1)",
    "SELECT DISTINCT ON (a) a, b FROM t",
    "SELECT * FROM t STREAM WATERMARK FOR a AS 1 IDLE TIMEOUT INTERVAL 5 SECOND",
    "SELECT extract(DAY FROM d), substring(s FROM 1 FOR 2), trim(BOTH 'x' FROM s), position('a' IN s)",
    "SELECT a NOT BETWEEN 1 AND 2, b NOT LIKE 'x%', c ILIKE 'y', d IS NOT NULL, e NOT IN (1)",
    "SELECT x FROM (SELECT 1 AS x) AS sub",
    "SELECT (SELECT max(a) FROM t) AS m",
    "SELECT * FROM t WHERE EXISTS (SELECT 1)",
    "FROM t SELECT a",
    "SELECT 1 FROM t |> WHERE a > 1 |> SELECT a",
    "SELECT @@version",
    "SELECT DATE '2020-01-01', TIMESTAMP '2020-01-01 00:00:00'",
    "SELECT x -> FROM t",
    "SELECT 0x",
  ]);

  rejects([
    ["SELECT [1, 2], (1, 'a'), map('k', 1), {'k': 1}, tuple()", 39, "Expected one of: substitution name (identifier), end of query"],
    ["SELECT * FROM t SAMPLE 1 / 10 OFFSET 1 / 2 FINAL", 43, "Expected one of: STREAM, table, table function, subquery or list of joined tables, array join, LEFT…"],
    ["SELECT * FROM t LIMIT 1 BY a LIMIT 10 WITH TIES", 43, "Can not use WITH TIES without ORDER BY"],
    ["SELECT 1 +", 10, "Expected one of: token, DoubleColon, OR, AND, IS NOT DISTINCT FROM, IS DISTINCT FROM, IS NOT UNKNOWN…"],
    ["SELECT * FROM t STREAM WATERMARK FOR a AS 1 IDLE_TIMEOUT INTERVAL 5 SECOND", 44, "Expected one of: token, DoubleColon, OR, AND, IS NOT DISTINCT FROM, IS DISTINCT FROM, IS NOT UNKNOWN…"],
    ["SELECT (1", 9, "Unmatched parentheses: '(' at position 8 is never closed."],
    ["SELECT 1)", 8, "Unmatched parentheses: ')' at position 9 has no matching opening bracket."],
    ["SELEC 1", 0, "Maybe you meant: SELECT. Expected one of: Query, Query with output, EXPLAIN, SELECT query, possibly…"],
    ["SELECT 'abc", 7, "Single quoted string is not closed"],
    ["SELECT a b c", 11, "Expected one of: token, Comma, FROM, PREWHERE, WHERE, GROUP BY, WITH, HAVING, WINDOW, QUALIFY, ORDER…"],
    ["SELECT * FROM", 13, "Expected one of: table, table function, subquery or list of joined tables, table or subquery or tabl…"],
    ["SELECT 1 FROM t WHERE", 21, "Expected one of: expression with optional alias, element of expression with optional alias, lambda expression"],
    ["SELECT [1, 2", 12, "Unmatched parentheses: '[' at position 8 is never closed."],
    ["SELECT f(", 9, "Unmatched parentheses: '(' at position 9 is never closed."],
    ["SELECT 1 2", 9, "Expected one of: token, DoubleColon, OR, AND, IS NOT DISTINCT FROM, IS DISTINCT FROM, IS NOT UNKNOWN…"],
    ["SELECT * FROM t ORDER", 21, "Expected one of: BY, end of query"],
    ["SELECT * FROM t GROUP BY", 24, "Expected one of: ROLLUP, CUBE, GROUPING SETS, ALL, not empty list of expressions, list of expression…"],
    ["SELECT * FROM t LIMIT", 21, "Expected one of: AFTER, UNTIL, expression with optional alias, element of expression with optional alias, lambda expression"],
    ["SELECT CASE WHEN 1 THEN 2", 25, "Expected one of: token, DoubleColon, end of query"],
    ["SELECT * FROM t1 JOIN t2", 24, "Expected one of: token sequence, Dot, token, OpeningRoundBracket, UUID, alias, AS, identifier, FINAL…"],
    ["SELECT 1 FORMAT", 15, "Expected identifier"],
    ["SELECT 1 SETTINGS", 17, "Expected one of: SET query, compound identifier, identifier"],
    ["WITH x AS SELECT 1 SELECT 1", 17, "Expected one of: token, Comma, FROM, SELECT, INSERT INTO"],
    ["SELECT 1 UNION SELECT", 21, "Expected one of: ALL, DISTINCT ON, DISTINCT, TOP, not empty list of expressions, list of expressions…"],
    ["SELECT CAST(1 AS)", 16, "Expected one of: identifier, data type"],
    ["SELECT 1 ? 2", 12, "Expected one of: token, DoubleColon"],
    ["SELECT a FROM t WHERE a = = 1", 26, "Expected one of: CAST operator, ANY, SOME, ALL, NOT, INTERVAL, CASE, DATE, TIMESTAMP, tuple, collect…"],
    ["SELECT ,a FROM t", 8, "Expected one of: ALL, DISTINCT ON, DISTINCT, TOP, not empty list of expressions, list of expressions…"],
    ["SELECT a,, b FROM t", 11, "Expected end of query"],
    ["SELECT 1 !", 9, "Exclamation mark can only occur in !=, !~ and !~* operators"],
    ["SELECT 1 & 2", 9, "Unrecognized token"],
    ["SELECT * FROM t SAMPLE", 22, "Expected Sample ratio or offset"],
  ]);
});

// ClickHouse reads (EXPLAIN ...) and (VALUES ...) as SELECT * FROM a table function, so view() bails out on them as on (SELECT ...).
describe("view() over a subquery", () => {
  accepts([
    "SELECT * FROM view((EXPLAIN SELECT 1) UNION ALL SELECT 2)",
    "SELECT * FROM view((EXPLAIN SELECT 1) UNION ALL (VALUES (1)))",
    "SELECT * FROM ((EXPLAIN SELECT 1))",
    "SELECT 1 IN ((EXPLAIN SELECT 1))",
    "SELECT view((EXPLAIN SELECT 1))",
    "INSERT INTO t SELECT * FROM (EXPLAIN SELECT * FROM input('x UInt8')) FORMAT Values (1)",
  ]);

  rejects([
    ["SELECT * FROM view((SELECT 1))", 29, "Expected one of: UNION, EXCEPT, INTERSECT"],
    ["SELECT * FROM view((EXPLAIN SELECT 1))", 37, "Expected one of: UNION, EXCEPT, INTERSECT"],
    ["SELECT * FROM view(((EXPLAIN SELECT 1)))", 39, "Expected one of: UNION, EXCEPT, INTERSECT"],
    ["SELECT * FROM view((EXPLAIN SELECT 1) AS x)", 38, "Expected one of: UNION, EXCEPT, INTERSECT"],
    ["SELECT * FROM view((EXPLAIN CURRENT TRANSACTION))", 48, "Expected one of: UNION, EXCEPT, INTERSECT"],
    ["SELECT * FROM view((VALUES (1)))", 31, "Expected one of: UNION, EXCEPT, INTERSECT"],
    ["SELECT * FROM viewIfPermitted((EXPLAIN SELECT 1) ELSE null('x UInt8'))", 49, "Expected one of: UNION, EXCEPT, INTERSECT"],
    ["SELECT * FROM obfuscate((EXPLAIN SELECT 1))", 42, "Expected one of: UNION, EXCEPT, INTERSECT, alias, AS, identifier, FINAL, SAMPLE, STREAM, table, tabl…"],
    ["SELECT * FROM view(EXPLAIN SELECT 1)", 27, "Expected one of: token, Comma"],
  ]);
});

// ClickHouse master d45f558: SHUFFLE, FETCH without ORDER BY and LOCAL before JOIN.
describe("SHUFFLE, FETCH and LOCAL JOIN", () => {
  accepts([
    "SELECT a FROM t WHERE x SHUFFLE LIMIT 3",
    "SELECT a FROM t shuffle",
    "SELECT a FROM t AS shuffle",
    "SELECT a FROM t FETCH FIRST 3 ROWS ONLY",
    "SELECT a FROM t OFFSET 1 ROW FETCH NEXT 3 ROWS ONLY",
    "SELECT a FROM t local JOIN u USING a",
    "SELECT a FROM t local local JOIN u USING a",
    "SELECT a FROM t local LEFT ARRAY JOIN x",
    "SELECT a FROM t local INNER ARRAY JOIN x",
    "SELECT a FROM t local, u",
    "SELECT 1 local",
  ]);

  rejects([
    ["SELECT a FROM t SHUFFLE ORDER BY a", 24, "Expected one of: LIMIT, OFFSET, FETCH, SETTINGS, UNION, EXCEPT, INTERSECT, INTO OUTFILE, FORMAT, ParallelWithClause, PARALLEL WITH, end of query"],
    ["SELECT a FROM t WHERE x y", 24, "Expected one of: token sequence, Dot, token, OR, AND, IS NOT DISTINCT FROM, IS DISTINCT FROM, IS NOT UNKNOWN, IS UNKNOWN, IS NOT FALSE, IS FALSE, IS NOT TRUE, IS TRUE, IS NULL, IS NOT NULL, BETWEEN, NOT BETWEEN, LIKE, ILIKE, NOT LIKE, NOT ILIKE, REGEXP, IN, NOT IN, GLOBAL IN, GLOBAL NOT IN, SIMILAR TO, NOT SIMILAR TO, AT TIME ZONE, MOD, DIV, alias, AS, GROUP BY, WITH, HAVING, WINDOW, QUALIFY, ORDER BY, SHUFFLE, LIMIT, OFFSET, FETCH, SETTINGS, UNION, EXCEPT, INTERSECT, INTO OUTFILE, FORMAT, ParallelWithClause, PARALLEL WITH, end of query"],
    ["SELECT a FROM t SHUFFLE LIMIT 3 WITH TIES", 37, "Can not use WITH TIES without ORDER BY"],
    ["SELECT a FROM t FETCH FIRST 1 ROW WITH TIES", 39, "Can not use WITH TIES without ORDER BY"],
    ["SELECT a fetch FROM t", 15, "Expected one of: FIRST, NEXT"],
    ["SELECT a FROM t local x", 22, "Expected one of: FINAL, SAMPLE, STREAM, table, table function, subquery or list of joined tables, array join, LEFT ARRAY JOIN, INNER, ARRAY JOIN, GLOBAL, LOCAL, NATURAL, ANY, ALL, ASOF, SEMI, ANTI, ONLY, LEFT, RIGHT, FULL, CROSS, PASTE, JOIN, token, OpeningRoundBracket, PREWHERE, WHERE, GROUP BY, WITH, HAVING, WINDOW, QUALIFY, ORDER BY, SHUFFLE, LIMIT, OFFSET, FETCH, SETTINGS, UNION, EXCEPT, INTERSECT, INTO OUTFILE, FORMAT, ParallelWithClause, PARALLEL WITH, end of query"],
    ["SELECT ARRAY[1; SELECT 1, 2]", 14, "Expected one of: token, DoubleColon, Comma, ClosingSquareBracket, OR, AND…"],
  ]);

  test("reads LOCAL before JOIN as a keyword, and before ARRAY JOIN as an alias", () => {
    const roleOf = (sql: string, word: string) => roles(sql).find((span) => sql.slice(span.start, span.end) === word)?.role;
    assert.equal(roleOf("SELECT a FROM t local JOIN u USING a", "local"), "keyword");
    assert.equal(roleOf("SELECT a FROM t local LEFT JOIN u USING a", "local"), "keyword");
    assert.equal(roleOf("SELECT a FROM t local LEFT ARRAY JOIN x", "local"), "identifier");
    assert.equal(roleOf("SELECT a FROM t local INNER ARRAY JOIN x", "local"), "identifier");
    assert.equal(roleOf("SELECT a FROM t shuffle", "shuffle"), "keyword");
  });
});
