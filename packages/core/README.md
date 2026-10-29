# clickhouse-sql-syntax

Syntax checker, formatter, autocomplete, highlighter and tokenizer for [ClickHouse](https://github.com/ClickHouse/ClickHouse) SQL,
in TypeScript with no runtime dependencies.

## Install

It is not on npm yet. Build it from the [repository](https://github.com/valerypetrov/clickhouse-sql-syntax) (Node.js 22 or newer)
and install the folder in your project:

```sh
git clone https://github.com/valerypetrov/clickhouse-sql-syntax.git
cd clickhouse-sql-syntax && npm install && npm run build -w packages/core
cd ../your-project && npm install ../clickhouse-sql-syntax/packages/core
```

## API

Offsets count UTF-16 code units, as JavaScript strings do; lines and columns start at 1.
The types are in [src/types.ts](src/types.ts), and the functions below are also on the default export.

### check(sql)

The syntax errors of every `;`-separated statement, worded and placed as ClickHouse does; `[]` when all of it is valid.

```ts
check("SELECT a FROM t GROUP a");
// [{ message: "Expected one of: BY, end of query", start: 22, end: 23, line: 1, col: 23, severity: "error" }]
```

Only syntax is checked, as `clickhouse format` does: unknown tables, functions or settings are fine,
and the inline data of `INSERT ... VALUES` and `INSERT ... FORMAT` is skipped.

### format(sql, options?)

```ts
format("select a, count() from t group by a"); // "SELECT\n    a,\n    count()\nFROM t\nGROUP BY a"
format("select a from t", { keywordCase: "lower", indentSize: 2 }); // "select a\nfrom t"
```

`keywordCase` is `"upper"` (the default), `"lower"` or `"preserve"`, and `indentSize` is 4 by default.
Each clause starts a line, lists of several items go one item per line, and subqueries are indented.
Only whitespace and the case of keywords change: names, strings, numbers, comments and inline data stay as written,
and a statement with a syntax error is left as it is. Line breaks follow the first one of the input, LF or CRLF,
and `format(format(sql))` equals `format(sql)`.

### complete(sql, offset, options?) and describe(name, kind?)

`complete()` gives the keywords that are valid at the cursor, and the functions, data types, settings, table engines,
formats or table functions that fit there.

```ts
complete("SELECT count() FROM t GR", 24); // [{ label: "GROUP BY", kind: "keyword" }]
complete("SELECT * FROM t SETTINGS max_th", 31)[0]; // { label: "max_threads", kind: "setting", detail: "MaxThreads", documentation: "..." }
```

With `{ schema: { databases, tables } }` it also offers your databases, tables and columns; columns come from the tables
the statement uses. `describe()` gives the documentation of a function, setting, table engine, format, table function or
combinator, and the syntax and arguments of a function:

```ts
describe("toDate"); // { name: "toDate", kind: "function", syntax: "toDate(x)", arguments: [{ name: "x", ... }], documentation: "..." }
```

### highlight(sql) and tokenize(sql)

```ts
highlight("SELECT key FROM t"); // [{ start: 0, end: 6, scope: "keyword.other.sql" }, { start: 7, end: 10, scope: "variable.other.sql" }, ...]
tokenize("SELECT 1").map((token) => token.kind); // ["BareWord", "Whitespace", "Number", "EndOfStream"]
```

`highlight()` gives TextMate scope names, so any editor theme can colour them; in a statement that parses, each word's
scope comes from how the parser reads it. `tokenize()` splits the input as ClickHouse's lexer does, whitespace and comments included.

## License

Apache License 2.0 with the Commons Clause: free to use, modify and share, but not to sell. See LICENSE and NOTICE.
