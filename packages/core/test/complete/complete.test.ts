import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { gunzipSync } from "node:zlib";

import {
  check,
  type CompletionCandidate,
  type CompletionSchema,
  complete,
  describe as describeName,
  isSignificant,
  TokenKind,
  tokenize,
} from "../../src/index.js";
import { expectedAt } from "../../src/parser/index.js";

const CORPUS = new URL("../../../../oracle/fixtures/corpus.jsonl.gz", import.meta.url);

const schema: CompletionSchema = {
  databases: ["default", "logs"],
  tables: [
    {
      database: "default",
      name: "hits",
      columns: [
        { name: "event_time", type: "DateTime" },
        { name: "user_id", type: "UInt64" },
        { name: "url", type: "String" },
      ],
    },
    {
      database: "logs",
      name: "events",
      columns: [
        { name: "ts", type: "DateTime64(3)" },
        { name: "message", type: "String" },
        { name: "my col", type: "String" },
      ],
    },
  ],
};

/** The candidates at the "|" of `text`. */
function at(text: string, withSchema = true): CompletionCandidate[] {
  const offset = text.indexOf("|");
  assert.ok(offset >= 0, "the text marks the cursor with |");
  return complete(text.slice(0, offset) + text.slice(offset + 1), offset, withSchema ? { schema } : {});
}

function labels(text: string, withSchema = true): string[] {
  return at(text, withSchema).map((c) => c.label);
}

function kinds(text: string): Set<string> {
  return new Set(at(text).map((c) => c.kind));
}

describe("complete()", () => {
  test("offers the statement keywords at the start of the input", () => {
    const found = labels("|");
    for (const keyword of ["SELECT", "INSERT INTO", "CREATE", "ALTER TABLE", "SHOW", "SYSTEM", "WITH"]) assert.ok(found.includes(keyword), keyword);
    assert.deepEqual(kinds("|"), new Set(["keyword"]));
    assert.ok(!found.includes("toDate"));
  });

  test("filters by the prefix and writes keywords in its case", () => {
    assert.deepEqual(labels("sel|"), ["select"]);
    assert.deepEqual(labels("SEL|"), ["SELECT"]);
    assert.deepEqual(labels("Sel|"), ["SELECT"]);
    assert.deepEqual(labels("select 1 order b|"), ["by"]);
  });

  test("offers only the keywords that the parser accepts at the cursor", () => {
    const afterSelect = labels("SELECT |");
    assert.ok(afterSelect.includes("DISTINCT"));
    assert.ok(!afterSelect.includes("FROM"));
    const afterColumn = labels("SELECT a |");
    for (const keyword of ["FROM", "AS", "WHERE", "ORDER BY", "LIMIT", "SETTINGS", "FORMAT", "UNION"]) assert.ok(afterColumn.includes(keyword), keyword);
    assert.ok(!afterColumn.includes("SELECT"));
    assert.deepEqual(kinds("SELECT a |"), new Set(["keyword"]));
    assert.deepEqual(labels("SELECT 1 ORDER |"), ["BY"]);
    assert.ok(labels("SELECT * FROM t JOIN u |").includes("ON"));
  });

  test("puts the keywords that match the prefix first", () => {
    assert.equal(labels("SELECT a FR|")[0], "FROM");
    const found = at("SELECT * FROM hits WHERE n|");
    assert.equal(found[0]!.kind, "keyword");
    assert.ok(found.some((c) => c.label === "now" && c.kind === "function"));
  });

  test("offers columns, then keywords, then functions in an expression", () => {
    const found = at("SELECT | FROM hits");
    assert.deepEqual(
      found.slice(0, 3).map((c) => [c.label, c.kind, c.detail]),
      [
        ["event_time", "column", "DateTime"],
        ["url", "column", "String"],
        ["user_id", "column", "UInt64"],
      ],
    );
    const toDate = found.find((c) => c.label === "toDate")!;
    assert.equal(toDate.kind, "function");
    assert.equal(toDate.detail, "Type Conversion");
    assert.match(toDate.documentation!, /^```sql\ntoDate\(x\)\n```/);
    assert.ok(labels("SELECT * FROM hits WHERE |").includes("user_id"));
    assert.ok(labels("SELECT count() FROM hits GROUP BY |").includes("url"));
  });

  test("offers the columns of the tables in the statement it is in, including subqueries", () => {
    const inner = labels("SELECT * FROM (SELECT | FROM logs.events)");
    assert.deepEqual(inner.slice(0, 3), ["message", "my col", "ts"]);
    assert.ok(!inner.includes("url"));
    assert.ok(!labels("SELECT * FROM hits; SELECT |").includes("url"));
    assert.ok(labels("SELECT 1; SELECT | FROM hits").includes("url"));
    assert.deepEqual(labels("SELECT u| FROM hits AS h, logs.events e").slice(0, 2), ["url", "user_id"]);
    assert.ok(labels("SELECT | FROM hits AS h, logs.events e").includes("message"));
  });

  test("writes case-insensitive function names in capitals after a prefix in capitals", () => {
    assert.ok(labels("SELECT COU|").includes("COUNT"));
    assert.ok(labels("SELECT cou|").includes("count"));
    // toDate is case-sensitive, so it keeps its spelling.
    assert.ok(labels("SELECT TODATE|").includes("toDate"));
  });

  test("offers aggregate functions with combinators", () => {
    assert.deepEqual(labels("SELECT sumI|"), ["sumIf"]);
    const sum = at("SELECT sum|");
    assert.equal(sum[0]!.label, "sum");
    const sumState = sum.find((c) => c.label === "sumState")!;
    assert.equal(sumState.kind, "combinator");
    assert.equal(sumState.detail, "sum with State");
    assert.ok(labels("SELECT uniqStateI|").includes("uniqStateIf"));
    assert.ok(labels("SELECT sumIfOr|").includes("sumIfOrNull"));
    assert.ok(labels("SELECT SUMI|").includes("SUMIf"));
    // sumMap is a function of its own, offered once.
    assert.equal(sum.filter((c) => c.label === "sumMap").length, 1);
    assert.deepEqual(labels("SELECT toDateI|"), []);
  });

  test("offers functions and columns inside the arguments of a function", () => {
    const found = labels("SELECT toDate(| FROM hits");
    assert.ok(found.includes("event_time"));
    assert.ok(found.includes("now"));
    assert.ok(labels("SELECT f(a, |").includes("toString"));
    assert.ok(labels("SELECT quantile(0.5)(|").includes("ALL"));
  });

  test("offers tables, databases and table functions after FROM and JOIN", () => {
    const found = at("SELECT * FROM |");
    assert.deepEqual(
      found.slice(0, 4).map((c) => [c.label, c.kind]),
      [
        ["default", "database"],
        ["events", "table"],
        ["hits", "table"],
        ["logs", "database"],
      ],
    );
    assert.ok(found.some((c) => c.label === "numbers" && c.kind === "table function"));
    assert.ok(!found.some((c) => c.label === "toDate"));
    assert.ok(labels("SELECT * FROM hits LEFT JOIN |").includes("s3"));
    assert.ok(labels("SELECT * FROM hits, |").includes("events"));
    assert.deepEqual(labels("SELECT * FROM numb|"), ["numbers", "numbers_mt"]);
    assert.deepEqual(labels("SELECT * FROM numb|", false), ["numbers", "numbers_mt"]);
  });

  test("offers no tables or table functions after a whole table expression", () => {
    for (const text of [
      "SELECT * FROM t |",
      "SELECT * FROM t AS x |",
      "SELECT * FROM t FINAL |",
      "SELECT * FROM t JOIN u ON a = b |",
      "SELECT * FROM t JOIN u USING (x) |",
      "SELECT * FROM t ARRAY JOIN arr |",
    ]) {
      const found = at(text);
      assert.ok(!found.some((c) => c.kind === "table function" || c.kind === "table" || c.kind === "database"), text);
      assert.ok(found.some((c) => c.label === "JOIN"), text);
    }
  });

  test("offers table names where a statement takes one", () => {
    assert.ok(labels("INSERT INTO |").includes("hits"));
    assert.ok(labels("DROP TABLE |").includes("events"));
    assert.ok(labels("ALTER TABLE |").includes("hits"));
    assert.deepEqual(labels("USE |"), ["default", "logs"]);
    assert.deepEqual(labels("INSERT INTO hits (u|"), ["url", "user_id"]);
  });

  test("offers the columns of a table or alias and the tables of a database after a dot", () => {
    assert.deepEqual(labels("SELECT h.| FROM hits AS h"), ["event_time", "url", "user_id"]);
    assert.deepEqual(labels("SELECT h.u| FROM hits h"), ["url", "user_id"]);
    assert.deepEqual(labels("SELECT hits.| FROM default.hits"), ["event_time", "url", "user_id"]);
    assert.deepEqual(labels("SELECT * FROM logs.|"), ["events"]);
    assert.deepEqual(labels("SELECT * FROM logs.events WHERE logs.events.t|"), ["ts"]);
    const quoted = at("SELECT e.my| FROM logs.events e")[0]!;
    assert.deepEqual([quoted.label, quoted.insertText], ["my col", "`my col`"]);
    assert.deepEqual(labels("SELECT x.| FROM hits"), []);
    assert.deepEqual(labels("SELECT h.| FROM hits AS h", false), []);
  });

  test("offers table engines after ENGINE", () => {
    const found = at("CREATE TABLE t (a UInt8) ENGINE = |");
    assert.ok(found.some((c) => c.label === "MergeTree" && c.kind === "table engine"));
    assert.ok(found.some((c) => c.label === "Memory"));
    assert.match(found.find((c) => c.label === "MergeTree")!.documentation!, /ENGINE = MergeTree\(\) ORDER BY expr/);
    assert.deepEqual(labels("CREATE TABLE t (a UInt8) ENGINE = Merge|"), ["Merge", "MergeTree"]);
    assert.ok(labels("CREATE TABLE t (a UInt8) ENGINE Mem|").includes("Memory"));
  });

  test("offers output formats after FORMAT in a query and input formats in an INSERT", () => {
    const output = at("SELECT 1 FORMAT |");
    assert.ok(output.some((c) => c.label === "JSONEachRow" && c.kind === "format"));
    assert.ok(output.some((c) => c.label === "PrettyCompact"));
    assert.deepEqual(labels("SELECT 1 FORMAT JSONEachR|"), ["JSONEachRow", "JSONEachRowWithProgress"]);
    const input = labels("INSERT INTO hits FORMAT |");
    assert.ok(input.includes("CSV"));
    assert.ok(!input.includes("PrettyCompact"));
  });

  test("offers setting names after SETTINGS and SET", () => {
    const found = at("SELECT 1 SETTINGS max_th|");
    assert.deepEqual(
      found.map((c) => c.label),
      ["max_threads", "max_threads_for_indexes", "max_threads_min_free_memory_per_thread"],
    );
    assert.equal(found[0]!.kind, "setting");
    assert.equal(found[0]!.detail, "MaxThreads");
    assert.ok(labels("SELECT 1 SETTINGS max_threads = 1, max_memory|").includes("max_memory_usage"));
    assert.ok(labels("SELECT 1 SETTINGS a = {'k': 'v', 'j': 'w'}, max_memory|").includes("max_memory_usage"));
    assert.ok(labels("SET max_memory|").includes("max_memory_usage"));
    assert.ok(labels("SET a = 'x', max_memory|").includes("max_memory_usage"));
    assert.ok(!labels("SELECT f(a, max_memory|").includes("max_memory_usage"));
    assert.ok(!labels("SELECT 1 SETTINGS max_threads = |").some((label) => label.startsWith("max_")));
  });

  test("offers privileges where GRANT, REVOKE and CHECK GRANT take one", () => {
    for (const text of ["GRANT |", "CHECK GRANT |", "REVOKE |", "GRANT SELECT, |", "CREATE USER u IDENTIFIED BY 'p' GRANTS (|"]) {
      const found = labels(text);
      for (const privilege of ["SELECT", "INSERT", "ALTER UPDATE", "SHOW TABLES"]) assert.ok(found.includes(privilege), `${text} ${privilege}`);
    }
    assert.deepEqual(labels("GRANT SEL|"), ["SELECT"]);
    assert.ok(labels("grant alter|").includes("alter update"));
    assert.deepEqual(labels("grant address|"), ["addressToLine", "addressToLineWithInlines", "addressToSymbol"]);
    assert.ok(!labels("GRANT SELECT |").includes("INSERT"));
  });

  test("offers data types where a type is expected", () => {
    const column = at("CREATE TABLE t (a |");
    assert.ok(column.some((c) => c.label === "UInt64" && c.kind === "data type"));
    assert.ok(column.some((c) => c.label === "DEFAULT" && c.kind === "keyword"));
    assert.ok(labels("SELECT x::|").includes("String"));
    assert.deepEqual(labels("SELECT CAST(x AS Nul|"), ["Nullable"]);
    assert.ok(labels("CREATE TABLE t (a Nullable(|").includes("String"));
    assert.equal(at("SELECT x::BIGI|")[0]!.detail, "alias of Int64");
  });

  test("offers nothing inside strings, comments, quoted names and numbers", () => {
    assert.deepEqual(labels("SELECT 'ab|c'"), []);
    assert.deepEqual(labels("SELECT 'abc|"), []);
    assert.deepEqual(labels("SELECT 1 -- comm|"), []);
    assert.deepEqual(labels("SELECT 1 /* comm| */"), []);
    assert.deepEqual(labels("SELECT `ab|c`"), []);
    assert.deepEqual(labels("SELECT 12|"), []);
    assert.ok(labels("SELECT 1 /* c */ |").includes("FROM"));
    assert.ok(labels("SELECT 'abc' |").includes("FROM"));
  });

  test("offers no keyword that the parser then rejects", () => {
    const keywords = (text: string) => at(text).filter((c) => c.kind === "keyword").map((c) => c.label);
    assert.ok(!keywords("SELECT * FROM t WHERE x |").includes("FETCH"));
    assert.ok(keywords("SELECT * FROM t ORDER BY x |").includes("FETCH"));
    for (const keyword of ["SEMI", "ANTI", "ONLY"]) assert.ok(!keywords("SELECT * FROM t INNER |").includes(keyword), keyword);
    assert.ok(keywords("SELECT * FROM t LEFT |").includes("SEMI"));
    for (const keyword of ["PASTE", "CROSS"]) assert.ok(!keywords("SELECT * FROM t ANY |").includes(keyword), keyword);
    for (const keyword of ["END", "UNKNOWN"]) assert.ok(!keywords("SYSTEM |").includes(keyword), keyword);
    assert.ok(!keywords("SYSTEM STOP MERGES |").includes("PARALLEL WITH"));
    assert.ok(!keywords("SYSTEM FLUSH LOGS |").includes("PARALLEL WITH"));
    assert.ok(keywords("SYSTEM SHUTDOWN |").includes("PARALLEL WITH"));
  });

  // Cut statements of ClickHouse's tests anywhere: the parser takes every keyword offered there.
  test("offers only keywords that the parser takes next, in statements of ClickHouse's tests", () => {
    const statements = gunzipSync(readFileSync(CORPUS))
      .toString("utf8")
      .split("\n")
      .slice(1)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { sql: string; valid: boolean; mutation?: string })
      .filter((entry) => entry.valid && !entry.mutation && entry.sql.length < 300)
      .map((entry) => entry.sql);
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const rejected: string[] = [];
    for (let n = 0; n < 400; n++) {
      const sql = statements[Math.floor(random() * statements.length)]!;
      const tokens = tokenize(sql).filter((token) => isSignificant(token.kind) && token.kind !== TokenKind.EndOfStream);
      if (tokens.length < 2) continue;
      const cut = tokens[1 + Math.floor(random() * (tokens.length - 1))]!;
      const before = `${sql.slice(0, cut.start).trimEnd()} `;
      for (const candidate of complete(before, before.length)) {
        if (candidate.kind !== "keyword") continue;
        // The brackets still open are closed after the keyword.
        const keyword = before + candidate.label;
        const open: string[] = [];
        for (const token of tokenize(keyword)) {
          if (token.kind === TokenKind.OpeningRoundBracket) open.push(")");
          else if (token.kind === TokenKind.OpeningSquareBracket) open.push("]");
          else if (token.kind === TokenKind.ClosingRoundBracket || token.kind === TokenKind.ClosingSquareBracket) open.pop();
        }
        const closed = `${keyword} ${open.reverse().join("")}`;
        const onKeyword = [keyword, closed].every((text) => check(text).some((d) => d.start >= before.length && d.start < keyword.length));
        const expects = (text: string) => {
          const significant = tokenize(text).filter((token) => isSignificant(token.kind) && token.kind !== TokenKind.EndOfStream);
          return expectedAt(text, significant, text.length + 1).length > 0;
        };
        const goesOn = check(closed).length === 0 || expects(keyword) || expects(closed);
        if (onKeyword || !goesOn) rejected.push(keyword);
      }
    }
    assert.deepEqual(rejected, []);
  });

  test("finds the statement around the cursor after inline data, as check() does", () => {
    assert.ok(labels("INSERT INTO hits FORMAT TSV 1\n\nSELECT |").includes("DISTINCT"));
    assert.ok(labels("INSERT INTO hits FORMAT TSV it's\n\nSELECT * FROM hits WHERE |").includes("url"));
    assert.ok(labels("EXPLAIN INSERT INTO hits FORMAT TSV 1\n\nSEL|").includes("SELECT"));
    assert.ok(labels("INSERT INTO hits FORMAT TSV 1\n\n|").includes("SELECT"));
    assert.ok(labels("INSERT INTO hits VALUES (1); SEL|").includes("SELECT"));
    assert.deepEqual(labels("INSERT INTO hits FORMAT TSV |"), []);
    assert.deepEqual(labels("INSERT INTO hits FORMAT TSV 1\n|"), []);
    assert.deepEqual(labels("INSERT INTO hits VALUES (1, 2) |"), []);
    assert.deepEqual(labels("INSERT INTO hits FORMAT CS|"), ["CSV", "CSVWithNames", "CSVWithNamesAndTypes"]);
  });

  test("completes the word the cursor is in, from its start to the cursor", () => {
    assert.ok(labels("SELECT co|unt() FROM hits").includes("count"));
    assert.ok(labels("SELECT |count() FROM hits").includes("url"));
    assert.ok(complete("SELECT 1 ", 100).some((c) => c.label === "FROM"));
  });

  // Ten times what it takes here, for slower machines; the VS Code stress tests hold it to 50 ms.
  test("is fast at the end of a 1 MB file", () => {
    const statement = "SELECT a, toDate(b) AS c, 'x; y' FROM db.t WHERE d IN (1, 2, 3) -- note\n;\n";
    const sql = `${statement.repeat(Math.ceil(1_000_000 / statement.length))}SELECT * FROM t WHERE to`;
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      assert.ok(complete(sql, sql.length).some((c) => c.label === "toDate"));
      best = Math.min(best, performance.now() - start);
    }
    assert.ok(best < 250, `took ${best.toFixed(1)} ms`);
  });
});

describe("describe()", () => {
  test("gives the syntax, arguments and documentation of a function", () => {
    const toDate = describeName("toDate")!;
    assert.equal(toDate.kind, "function");
    assert.equal(toDate.syntax, "toDate(x)");
    assert.deepEqual(toDate.arguments?.map((a) => a.name), ["x"]);
    assert.match(toDate.documentation, /Converts an input value to type `Date`/);
    assert.match(toDate.documentation, /\*\*Returns\*\*/);
  });

  test("finds case-insensitive functions in any case and follows aliases", () => {
    assert.equal(describeName("COUNT")?.name, "count");
    assert.equal(describeName("TODATE"), undefined);
    const substr = describeName("substr")!;
    assert.equal(substr.name, "substr");
    assert.match(substr.documentation, /Alias of `substring`/);
    assert.equal(substr.syntax, describeName("substring")!.syntax);
    assert.deepEqual(describeName("quantile")?.parameters?.map((p) => p.name), ["level"]);
  });

  test("describes settings, table functions, engines, formats and combinators", () => {
    assert.match(describeName("max_threads")!.documentation, /^`MaxThreads`, default `auto\(\d+\)`/);
    assert.equal(describeName("numbers")?.kind, "table function");
    assert.equal(describeName("MergeTree")?.kind, "table engine");
    assert.equal(describeName("JSONEachRow")?.kind, "format");
    assert.equal(describeName("OrNull")?.kind, "combinator");
    assert.equal(describeName("no_such_name"), undefined);
  });

  test("looks only at the given kind when there is one", () => {
    assert.equal(describeName("Null")?.kind, "table engine");
    assert.equal(describeName("Null", "format")?.kind, "format");
    assert.equal(describeName("Null", "combinator"), undefined);
  });
});
