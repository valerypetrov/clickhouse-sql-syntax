import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { definition, isSignificant, ParseCache, prepareRename, references, rename, TokenKind, tokenize } from "../../src/index.js";

/** The offsets of the words of `sql` that are the name `name`, quoted or not. */
function spots(sql: string, name: string): number[] {
  return tokenize(sql)
    .filter((token) => isSignificant(token.kind))
    .filter((token) => {
      const text = sql.slice(token.start, token.end);
      if (token.kind === TokenKind.BareWord) return text === name;
      if (token.kind === TokenKind.QuotedIdentifier) return text.slice(1, -1) === name;
      return false;
    })
    .map((token) => token.start);
}

/** What references() finds from the `from`-th spot of `name`: spot numbers, definitions with a star. */
function found(sql: string, name: string, from = 0): string {
  const all = spots(sql, name);
  assert.ok(from < all.length, `${name} is not in ${sql} ${from + 1} times`);
  return references(sql, all[from]!)
    .map((place) => {
      const n = all.indexOf(place.start);
      assert.ok(n >= 0, `a reference at ${place.start} is not ${name}`);
      return `${n}${place.definition ? "*" : ""}`;
    })
    .join(" ");
}

/** The text after renaming the `from`-th spot of `name` to `to`, or the error. */
function renamed(sql: string, name: string, to: string, from = 0): string {
  const result = rename(sql, spots(sql, name)[from]!, to);
  if (result.error !== undefined) return `error: ${result.error}`;
  let text = sql;
  for (const edit of [...result.edits].sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.newText + text.slice(edit.end);
  return text;
}

/** The error that prepareRename() gives for the `from`-th spot of `name`. */
function refusal(sql: string, name: string, from = 0): string {
  const result = prepareRename(sql, spots(sql, name)[from]!);
  return result.error ?? "";
}

describe("aliases", () => {
  test("an alias is visible in every clause of its query", () => {
    const sql = "SELECT a + 1 AS x FROM t WHERE x > 0 GROUP BY x HAVING x < 9 ORDER BY x LIMIT 1 BY x";
    assert.equal(found(sql, "x"), "0* 1 2 3 4 5");
    assert.equal(found(sql, "x", 3), "0* 1 2 3 4 5");
  });

  test("an alias is visible before it is defined", () => {
    assert.equal(found("SELECT y + 1 AS z, x * 2 AS y FROM t", "y"), "0 1*");
  });

  test("an alias inside an expression is visible in the whole query", () => {
    assert.equal(found("SELECT (a + 1 AS y) * 2 AS z, y FROM t WHERE y > 0", "y", 2), "0* 1 2");
  });

  test("an implicit alias", () => {
    assert.equal(found("SELECT a + 1 x, x * 2 FROM t", "x", 1), "0* 1");
  });

  test("inside its own expression a name is the column, not the alias", () => {
    const sql = "SELECT number + 1 AS number FROM numbers(3) WHERE number > 1";
    assert.equal(found(sql, "number", 1), "1* 2");
    assert.deepEqual(definition(sql, spots(sql, "number")[0]!), []);
    assert.equal(renamed(sql, "number", "n", 1), "SELECT number + 1 AS n FROM numbers(3) WHERE n > 1");
  });

  test("aliases that refer to each other in a cycle are ambiguous", () => {
    const sql = "SELECT a + 1 AS b, b * 2 AS a FROM t";
    assert.match(refusal(sql, "a", 1), /may read it as something else/);
    assert.match(refusal(sql, "b", 0), /may read it as something else/);
    assert.equal(found(sql, "a"), "");
  });

  test("the same alias defined twice is one name", () => {
    assert.equal(found("SELECT tuple(1 AS x), tuple(1 AS x)", "x"), "0* 1*");
  });

  test("a WITH alias is an alias of the query", () => {
    const sql = "WITH 10 AS n SELECT number + n FROM numbers(n) WHERE number < n";
    assert.equal(found(sql, "n"), "0* 1 2 3");
  });

  test("a lambda with an alias is called by its name", () => {
    const sql = "WITH x -> x + 1 AS f SELECT f(1), f(f(2))";
    assert.equal(found(sql, "f"), "0* 1 2 3");
    assert.equal(renamed(sql, "f", "inc"), "WITH x -> x + 1 AS inc SELECT inc(1), inc(inc(2))");
  });

  test("an alias may name the result of a subquery", () => {
    assert.equal(found("SELECT (SELECT 1) AS s, s + 1", "s"), "0* 1");
  });
});

describe("subqueries", () => {
  test("a subquery has its own aliases, which shadow the outer ones", () => {
    const sql = "SELECT 1 AS x, (SELECT 2 AS x, x * 10) + x";
    assert.equal(found(sql, "x"), "0* 3");
    assert.equal(found(sql, "x", 1), "1* 2");
  });

  test("a subquery without tables sees the aliases of the query around it", () => {
    assert.equal(found("SELECT 1 AS x, (SELECT x + 1)", "x"), "0* 1");
  });

  test("a subquery over a table of the database may read a column of it instead", () => {
    const sql = "SELECT 1 AS x, (SELECT x FROM t)";
    assert.match(refusal(sql, "x"), /may read it as something else/);
    assert.deepEqual(definition(sql, spots(sql, "x")[1]!), []);
  });

  test("columns of a subquery in FROM are its aliases", () => {
    const sql = "SELECT n + 1 FROM (SELECT number AS n FROM numbers(3)) WHERE n > 0";
    assert.equal(found(sql, "n"), "0 1* 2");
    assert.equal(renamed(sql, "n", "k", 1), "SELECT k + 1 FROM (SELECT number AS k FROM numbers(3)) WHERE k > 0");
  });

  test("columns pass through nested subqueries", () => {
    const sql = "SELECT v FROM (SELECT v FROM (SELECT 1 AS v)) WHERE v = 1";
    assert.equal(found(sql, "v", 2), "0 1 2* 3");
  });

  test("an alias of the outer query hides a column of a subquery", () => {
    const sql = "SELECT x * 2 AS y FROM (SELECT 1 AS y, 2 AS x) WHERE y > 0";
    assert.equal(found(sql, "y"), "0* 2");
    assert.equal(found(sql, "y", 1), "1*");
  });

  test("a qualified column of a subquery", () => {
    const sql = "SELECT s.a FROM (SELECT 1 AS a) AS s WHERE s.a = 1";
    assert.equal(found(sql, "a"), "0 1* 2");
    assert.equal(found(sql, "s"), "0 1* 2");
  });

  test("the columns of a UNION are those of its first SELECT", () => {
    const sql = "SELECT x FROM (SELECT 1 AS x UNION ALL SELECT 2 AS x)";
    assert.equal(found(sql, "x"), "0 1*");
    assert.equal(found(sql, "x", 2), "2*");
  });

  test("an element name of a tuple that a subquery gives cannot be renamed", () => {
    assert.match(refusal("SELECT (SELECT 1 AS a, 2 AS b) AS t, t.a", "a"), /element of the tuple/);
    assert.equal(refusal("SELECT 1 IN (SELECT 1 AS a, 2 AS b)", "a"), "");
  });
});

describe("CTEs", () => {
  test("a CTE is read by its name in FROM and as a qualifier", () => {
    const sql = "WITH c AS (SELECT 1 AS a) SELECT c.a FROM c WHERE a = 1";
    assert.equal(found(sql, "c"), "0* 1 2");
    assert.equal(found(sql, "a"), "0* 1 2");
    assert.equal(renamed(sql, "c", "cte"), "WITH cte AS (SELECT 1 AS a) SELECT cte.a FROM cte WHERE a = 1");
  });

  test("inside its own definition a CTE name is the table of the database", () => {
    const sql = "WITH t AS (SELECT * FROM t) SELECT * FROM t";
    assert.equal(found(sql, "t"), "0* 2");
    assert.equal(found(sql, "t", 1), "");
  });

  test("a CTE name hides the table of the database", () => {
    assert.equal(found("WITH numbers AS (SELECT 1 AS n) SELECT n FROM numbers", "numbers"), "0* 1");
  });

  test("a CTE is visible in subqueries", () => {
    const sql = "WITH c AS (SELECT 1 AS a) SELECT (SELECT max(a) FROM c), a FROM c";
    assert.equal(found(sql, "c"), "0* 1 2");
    assert.equal(found(sql, "a"), "0* 1 2");
  });

  test("column names of a CTE replace its aliases", () => {
    const sql = "WITH c(x) AS (SELECT 1 AS a) SELECT x FROM c";
    assert.equal(found(sql, "x"), "0* 1");
    assert.equal(found(sql, "a"), "0*");
  });

  test("a recursive CTE reads its first SELECT's columns", () => {
    const sql = "WITH RECURSIVE r AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM r WHERE n < 3) SELECT n FROM r";
    assert.equal(found(sql, "n"), "0* 1 2 3");
    assert.equal(found(sql, "r"), "0* 1 2");
  });
});

describe("table aliases", () => {
  test("a table alias qualifies columns and asterisks", () => {
    const sql = "SELECT t.a, t.* FROM tbl AS t WHERE t.b > 0";
    assert.equal(found(sql, "t"), "0 1 2* 3");
    assert.equal(renamed(sql, "t", "u", 2), "SELECT u.a, u.* FROM tbl AS u WHERE u.b > 0");
  });

  test("a table of the database is not a name of the query", () => {
    const sql = "SELECT tbl.a FROM db.tbl AS t";
    assert.match(refusal(sql, "tbl"), /not defined in this query/);
    assert.match(refusal(sql, "a"), /not defined in this query/);
  });

  test("tables joined with ON", () => {
    const sql = "SELECT l.x, r.y FROM (SELECT 1 AS x) AS l JOIN (SELECT 1 AS y) AS r ON l.x = r.y";
    assert.equal(found(sql, "l"), "0 1* 2");
    assert.equal(found(sql, "x"), "0 1* 2");
    assert.equal(found(sql, "y"), "0 1* 2");
  });

  test("a name that both sides of a join may give is the left side's", () => {
    assert.equal(found("SELECT x FROM (SELECT 1 AS x) AS a JOIN t ON a.x = t.id", "x"), "0 1* 2");
    assert.match(refusal("SELECT x FROM t JOIN (SELECT 1 AS x) AS a ON a.x = t.id", "x", 1), /may read it as something else/);
  });

  test("a column that both sides of USING give is joined by name", () => {
    const sql = "SELECT k FROM (SELECT 1 AS k) AS a JOIN (SELECT 1 AS k) AS b USING (k)";
    assert.match(refusal(sql, "k", 1), /USING/);
    assert.match(refusal(sql, "k", 2), /USING/);
  });
});

describe("ARRAY JOIN", () => {
  test("an ARRAY JOIN alias names the elements", () => {
    const sql = "SELECT a FROM numbers(1) ARRAY JOIN [1, 2] AS a WHERE a > 1";
    assert.equal(found(sql, "a"), "0 1* 2");
  });

  test("an ARRAY JOIN alias hides a column of the same name", () => {
    const sql = "SELECT x FROM (SELECT [1, 2] AS arr, 0 AS x) ARRAY JOIN arr AS x";
    assert.equal(found(sql, "x"), "0 2*");
  });

  test("an array joined without an alias is still the column", () => {
    const sql = "SELECT arr FROM (SELECT [1, 2] AS arr) ARRAY JOIN arr";
    assert.equal(found(sql, "arr", 1), "0 1* 2");
  });
});

describe("lambdas", () => {
  test("a lambda parameter is visible in the lambda only", () => {
    const sql = "SELECT 1 AS x, arrayMap(x -> x + 1, [x])";
    assert.equal(found(sql, "x", 1), "1* 2");
    assert.equal(found(sql, "x"), "0* 3");
  });

  test("an inner lambda hides the parameter of an outer one", () => {
    const sql = "SELECT arrayMap(x -> arrayMap(x -> x * 2, x), [[1]])";
    assert.equal(found(sql, "x"), "0* 3");
    assert.equal(found(sql, "x", 1), "1* 2");
  });

  test("several parameters", () => {
    assert.equal(found("SELECT arrayMap((a, b) -> a + b, [1], [2])", "b"), "0* 1");
  });

  test("an alias of the query keeps its meaning inside a lambda with a parameter of the same name", () => {
    const sql = "SELECT number + 1 AS n, arrayMap(number -> number + n, [1, 2]) FROM numbers(2)";
    assert.equal(found(sql, "n"), "0* 1");
    assert.equal(found(sql, "number", 2), "1* 2");
    assert.deepEqual(definition(sql, spots(sql, "number")[0]!), []);
  });

  test("an alias may read a lambda parameter where nothing else has its name", () => {
    const sql = "WITH t LIKE '%_1%' AS issue SELECT arrayFilter((t, t2) -> NOT issue, col_1, col_2) FROM test";
    assert.match(refusal(sql, "t", 1), /may read it as something else/);
  });
});

describe("query parameters", () => {
  test("every use of a parameter is one name, defined where it is first used", () => {
    const sql = "SELECT {p:UInt8} + {p:UInt8}, {q:String}";
    assert.equal(found(sql, "p", 1), "0* 1");
    assert.deepEqual(definition(sql, spots(sql, "p")[1]!), [{ start: spots(sql, "p")[0]!, end: spots(sql, "p")[0]! + 1, definition: true }]);
    assert.equal(renamed(sql, "p", "value"), "SELECT {value:UInt8} + {value:UInt8}, {q:String}");
  });

  test("a parameter name is a plain word", () => {
    assert.match(renamed("SELECT {p:UInt8}", "p", "a b"), /plain word/);
  });

  test("parameters belong to their statement", () => {
    assert.equal(found("SELECT {p:UInt8}; SELECT {p:UInt8}", "p", 1), "1*");
  });
});

describe("prefer_column_name_to_alias", () => {
  test("an alias with the name of a column is read as the alias by default", () => {
    assert.equal(found("SELECT number * 2 AS number FROM numbers(3) WHERE number > 2", "number", 1), "1* 2");
  });

  test("where the setting may be on, a name that both the alias and a column give is ambiguous", () => {
    const sql = "SELECT number * 2 AS number FROM numbers(3) WHERE number > 2 SETTINGS prefer_column_name_to_alias = 1";
    assert.match(refusal(sql, "number", 1), /may read it as something else/);
    const after = "SET prefer_column_name_to_alias = 1; SELECT number * 2 AS number FROM numbers(3) WHERE number > 2";
    assert.match(refusal(after, "number", 1), /may read it as something else/);
  });

  test("where the setting may be on, an alias that no column has is still the alias", () => {
    const sql = "SELECT number * 2 AS doubled FROM numbers(3) WHERE doubled > 2 SETTINGS prefer_column_name_to_alias = 1";
    assert.equal(found(sql, "doubled"), "0* 1");
  });

  test("other settings that change name resolution turn the analysis off", () => {
    assert.match(refusal("SELECT 1 AS x, x SETTINGS enable_analyzer = 0", "x"), /enable_analyzer/);
  });
});

describe("rename", () => {
  test("quotes a name that needs it, as ClickHouse writes it", () => {
    assert.equal(renamed("SELECT 1 AS x, x + 1", "x", "my col"), "SELECT 1 AS `my col`, `my col` + 1");
    assert.equal(renamed("SELECT 1 AS x, x + 1", "x", "from"), "SELECT 1 AS `from`, `from` + 1");
    assert.equal(renamed("SELECT 1 AS x, x + 1", "x", "a`b"), "SELECT 1 AS `a\\`b`, `a\\`b` + 1");
  });

  test("keeps the quotes a name was written with", () => {
    assert.equal(renamed('SELECT 1 AS "x", x + 1', "x", "y"), 'SELECT 1 AS "y", y + 1');
  });

  test("takes a name typed in quotes", () => {
    assert.equal(renamed("SELECT 1 AS x, x + 1", "x", "`a b`"), "SELECT 1 AS `a b`, `a b` + 1");
  });

  test("quotes a name that would read as something else unquoted", () => {
    assert.equal(renamed("SELECT 1 x, x + 1", "x", "where"), "SELECT 1 `where`, `where` + 1");
  });

  test("refuses a name that another name of the query would take", () => {
    assert.match(renamed("SELECT a + 1 AS x, b FROM t WHERE x > 0", "x", "b"), /already used/);
  });

  test("refuses a column, a table, a function and a keyword", () => {
    const sql = "SELECT a, count() FROM t";
    assert.match(refusal(sql, "a"), /not defined in this query/);
    assert.match(refusal(sql, "t"), /not defined in this query/);
    assert.match(refusal(sql, "count"), /not defined in this query/);
    assert.match(refusal(sql, "FROM"), /not a name that this query defines|Place the cursor/);
  });

  test("refuses a statement with a syntax error", () => {
    assert.match(refusal("SELECT 1 AS x, x +", "x"), /without syntax errors/);
  });

  test("refuses the columns of a view", () => {
    assert.match(refusal("CREATE VIEW v AS SELECT number AS n FROM numbers(3) WHERE n > 0", "n"), /creates/);
  });

  test("refuses names that matchers read by name", () => {
    assert.match(refusal("SELECT * EXCEPT (x) FROM (SELECT 1 AS x, 2 AS y)", "x", 1), /matched by name/);
  });

  test("renames nothing outside the statement", () => {
    assert.equal(renamed("SELECT 1 AS x, x; SELECT 2 AS x, x", "x", "y", 2), "SELECT 1 AS x, x; SELECT 2 AS y, y");
  });

  test("an unchanged name gives no edits", () => {
    assert.deepEqual(rename("SELECT 1 AS x, x", 12, "x"), { edits: [] });
  });

  test("uses the cache of checkWithRoles()", () => {
    const cache = new ParseCache();
    const sql = "SELECT 1 AS x, x";
    assert.equal(references(sql, 12, { cache }).length, 2);
    assert.equal(references(sql, 15, { cache }).length, 2);
  });
});

describe("more scoping", () => {
  test("a CTE reads the aliases of the query that reads it", () => {
    const sql = "WITH 1 AS one, c AS (SELECT one + 1 AS two) SELECT two FROM c";
    assert.equal(found(sql, "one"), "0* 1");
    assert.equal(found(sql, "two"), "0* 1");
  });

  test("an inner WITH hides a CTE of the same name", () => {
    const sql = "WITH c AS (SELECT 1 AS a) SELECT * FROM (WITH c AS (SELECT 2 AS a) SELECT a FROM c), c";
    assert.equal(found(sql, "c"), "0* 3");
    assert.equal(found(sql, "c", 1), "1* 2");
  });

  test("a CTE may read an earlier one", () => {
    const sql = "WITH a AS (SELECT 1 AS x), b AS (SELECT x FROM a) SELECT x FROM b";
    assert.equal(found(sql, "x"), "0* 1 2");
    assert.equal(found(sql, "a"), "0* 1");
  });

  test("IN reads a CTE by its name", () => {
    assert.equal(found("WITH c AS (SELECT 1 AS x) SELECT 1 IN c", "c"), "0* 1");
  });

  test("a lambda alias passed by its name to a higher-order function", () => {
    assert.equal(found("WITH x -> x * 2 AS f SELECT arrayMap(f, [1, 2])", "f"), "0* 1");
  });

  test("a constant alias as an argument of a table function", () => {
    assert.equal(found("WITH 3 AS n SELECT * FROM numbers(n)", "n"), "0* 1");
    assert.match(refusal("WITH 1 + 2 AS n SELECT * FROM numbers(n)", "n"), /may read it as something else/);
  });

  test("an alias in an ON condition is an alias of the query", () => {
    const sql = "SELECT k FROM (SELECT 1 AS a) AS l JOIN (SELECT 1 AS b) AS r ON (l.a + 0 AS k) = r.b";
    assert.equal(found(sql, "k"), "0 1*");
  });

  test("windows, LIMIT BY and WITH FILL use the aliases of the query", () => {
    const sql = "SELECT number % 3 AS g, sum(number) OVER (PARTITION BY g ORDER BY g) FROM numbers(9) ORDER BY g WITH FILL FROM g LIMIT 1 BY g";
    assert.equal(found(sql, "g"), "0* 1 2 3 4 5");
  });

  test("INTERPOLATE is not followed", () => {
    const sql = "SELECT number AS n, n * 2 AS v FROM numbers(3) ORDER BY n WITH FILL INTERPOLATE (v AS v + 1)";
    assert.match(refusal(sql, "v"), /INTERPOLATE/);
  });

  test("joined tables in brackets are not followed", () => {
    const sql = "SELECT * FROM (SELECT 1 AS x) AS a JOIN ((SELECT 1 AS y) AS b CROSS JOIN (SELECT 2 AS z) AS c) ON a.x = b.y";
    assert.equal(found(sql, "x"), "0* 1");
    assert.match(refusal(sql, "y"), /not followed/);
  });

  test("pipe operators are not followed", () => {
    assert.match(refusal("FROM (SELECT 1 AS x) |> WHERE x > 0 |> SELECT x", "x"), /not followed|may read it as something else/);
  });

  test("a parameter of a parameterized view cannot be renamed", () => {
    assert.match(refusal("CREATE VIEW v AS SELECT number FROM numbers(10) WHERE number > {p:UInt64}", "p"), /parameter of what the statement creates/);
  });

  test("an identifier given by a query parameter may be any name", () => {
    assert.match(refusal("SELECT 1 AS x, {c:Identifier} FROM t", "x"), /query parameter/);
  });

  test("a scalar subquery may read the columns of the query around it", () => {
    const sql = "SELECT (SELECT max(t.v)) AS m FROM (SELECT 1 AS v) AS t";
    assert.equal(found(sql, "v"), "0 1*");
    assert.equal(found(sql, "t"), "0 1*");
  });

  test("an alias of the outer query is resolved again in the subquery that uses it", () => {
    // Inside the subquery, number is the column of numbers(2), so the alias stands for something else there.
    const sql = "SELECT number + 1 AS n, (SELECT max(n) FROM numbers(2)) FROM numbers(5)";
    assert.equal(found(sql, "n"), "0* 1");
  });

  test("names of other statements of the text", () => {
    const sql = "SELECT 1 AS x, x;\nSELECT x FROM t;\nWITH 2 AS x SELECT x";
    assert.equal(found(sql, "x"), "0* 1");
    assert.equal(found(sql, "x", 2), "");
    assert.equal(found(sql, "x", 3), "3* 4");
  });
});

describe("what the corpus oracle found", () => {
  test("the WITH of the first SELECT of a UNION goes to the others", () => {
    assert.equal(found("WITH 1 AS x SELECT x UNION ALL SELECT x", "x"), "0* 1 2");
    const ctes = "SELECT * FROM (WITH c AS (SELECT 1 AS a) SELECT a FROM c UNION ALL SELECT a FROM c)";
    assert.equal(found(ctes, "c"), "0* 1 2");
  });

  test("the columns of view() are those of its SELECT", () => {
    const sql = "SELECT d FROM view(SELECT toString(number) AS d FROM numbers(2)) WHERE d = '1'";
    assert.equal(found(sql, "d"), "0 1* 2");
  });

  test("a recursive CTE whose second part is a UNION, or which has column names", () => {
    const nested = "WITH RECURSIVE f AS (SELECT 1 AS i UNION ALL (SELECT i + 1 FROM f WHERE i < 3 UNION ALL SELECT i + 1 FROM f WHERE i < 2)) SELECT * FROM f";
    assert.equal(found(nested, "f"), "0* 1 2 3");
    assert.equal(found(nested, "i"), "0* 1 2 3 4");
    const named = "WITH RECURSIVE d (lp) AS (SELECT 1 UNION ALL SELECT lp + 1 FROM d WHERE lp < 5) SELECT lp FROM d";
    assert.equal(found(named, "lp"), "0* 1 2 3");
  });

  test("names that a column name, a matcher or formatRow() writes cannot be renamed", () => {
    assert.match(refusal("SELECT `plus(x, 1)` FROM (SELECT 1 AS x, x + 1)", "x"), /part of a column name/);
    assert.match(refusal("SELECT COLUMNS('a') + 1 FROM (SELECT 1 AS a)", "a"), /matched by name/);
    assert.match(refusal("SELECT formatRow('JSONEachRow', d) FROM (SELECT 1 AS d)", "d", 1), /formatRow/);
  });

  test("a call of a lambda parameter and lambda() itself", () => {
    assert.match(refusal("WITH (f, x) -> f(x) AS apply SELECT apply(y -> y + 1, 1)", "f"), /may read it as something else/);
    assert.equal(found("WITH x -> x + 1 AS lambda SELECT arrayMap(lambda(tuple(x), x + 1), [1]), lambda(1)", "lambda", 0), "0* 2");
  });

  test("USING with an alias and IN with brackets", () => {
    assert.match(refusal("SELECT * FROM numbers(2) AS l JOIN (SELECT number + 1 AS dummy FROM numbers(1)) AS r USING (number AS dummy)", "dummy"), /does not follow/);
    assert.equal(found("WITH t AS (SELECT number FROM numbers(5)) SELECT * FROM numbers(8) WHERE number IN (t)", "t"), "0* 1");
  });

  test("a column that two joined tables have gets a name with its table", () => {
    const sql = "SELECT t2.a FROM (SELECT * FROM (SELECT 1 AS a) AS t1 JOIN (SELECT 2 AS a) AS t2 ON true)";
    assert.match(refusal(sql, "a", 2), /another table of the join/);
    assert.match(refusal(sql, "t2", 1), /qualifies column names/);
  });

  test("an ARRAY JOIN alias that hides a column", () => {
    assert.match(refusal("SELECT * FROM (SELECT [5] AS id) AS s ARRAY JOIN [1, 2] AS id", "id"), /hidden by an ARRAY JOIN/);
  });

  test("lambdas in a query with GROUP BY, and inside an alias defined twice", () => {
    assert.match(refusal("SELECT arrayMap(x -> x + number, [1]) AS m FROM numbers(2) GROUP BY number, arrayMap(x -> x + number, [1])", "x"), /GROUP BY/);
    assert.match(refusal("WITH x -> x + 1 AS f, x -> x + 1 AS f SELECT f(1)", "x"), /defined more than once/);
  });

  test("settings that name columns in strings turn the analysis off", () => {
    assert.match(refusal("SELECT a FROM (SELECT number AS a FROM numbers(3) SETTINGS select = 'a')", "a"), /select/);
    assert.match(refusal("SELECT * FROM system.numbers AS t LIMIT 5 SETTINGS additional_table_filters = {'t': 'number > 1'}", "t"), /additional_table_filters/);
  });
});

test("a query parameter that a setting gives its value cannot be renamed", () => {
  assert.match(refusal("SELECT {x:UInt64} AS y SETTINGS param_x = '1'", "x"), /param_x/);
  assert.match(refusal("SET param_x = 1; SELECT {x:UInt64}", "x"), /param_x/);
});

test("a.b reads the alias a only where its value has b, so the table alias a may be meant", () => {
  const sql = "SELECT number AS t, t.number AS q FROM (SELECT * FROM numbers(3)) AS t";
  assert.match(refusal(sql, "t"), /may read it as something else/);
  assert.match(refusal(sql, "t", 2), /may read it as something else/);
});

test("an operand of the function composition | may be a lambda alias", () => {
  assert.equal(found("WITH (x -> x + 1) AS inc SELECT arrayMap(inc | inc, [1, 2])", "inc"), "0* 1 2");
});
