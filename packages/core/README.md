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

`roles(sql)` gives what the parser reads each word of the valid statements as, and `checkWithRoles(sql, cache?)`
gives both in one pass. A `ParseCache` given to it keeps the statements it checked, so that a later call parses only
the ones that changed, with the same result; an editor keeps one per document.

### format(sql, options?)

```ts
format("select a, count() from t group by a"); // "SELECT\n    a,\n    count()\nFROM t\nGROUP BY a"
format("select a from t", { keywordCase: "lower", indentSize: 2 }); // "select a\nfrom t"
```

`keywordCase` is `"upper"` (the default), `"lower"` or `"preserve"`, and `indentSize` is 4 by default.
Each clause starts a line, lists of several items go one item per line, and subqueries are indented.
Only whitespace and the case of keywords change: names, strings, numbers, comments and inline data stay as written,
and a statement with a syntax error is left as it is. A word changes case only where `roles()` reads it as a keyword.
Line breaks follow the first one between tokens, LF, CRLF or CR (LF where a line comment needs one to end), and
`format(format(sql))` equals `format(sql)`.
`split(sql)` gives the units that `format()` lays out one by one: each statement with its comments and inline data,
or a paragraph of comments.

### complete(sql, offset, options?) and describe(name, kind?)

`complete()` gives the keywords that are valid at the cursor, and the functions, data types, settings, table engines,
formats or table functions that fit there.

```ts
complete("SELECT count() FROM t GR", 24); // [{ label: "GROUP BY", kind: "keyword" }]
complete("SELECT * FROM t SETTINGS max_th", 31)[0]; // { label: "max_threads", kind: "setting", detail: "MaxThreads", documentation: "..." }
```

With `{ schema: { databases, tables } }` it also offers your databases, tables and columns; columns come from the tables
the statement uses. In `ENGINE = Name(...)`, the suggestions for the argument at the cursor come first, by what the
engine's syntax names it, such as ZooKeeper paths, columns of a type that fits, formats, and the `clusters` and
`macros` of the schema; `engineArgument(sql, offset)` names the parameters that argument may be. `describe()` gives the documentation of a function, setting, table engine, format, table function or
combinator, and the syntax and arguments of a function or table engine:

```ts
describe("toDate"); // { name: "toDate", kind: "function", syntax: "toDate(x)", arguments: [{ name: "x", ... }], documentation: "..." }
```

### outline(sql, cache?)

Each statement with its kind and a short name, for an editor's outline, with its CTEs and the columns that
CREATE TABLE, VIEW or DICTIONARY defines as children. `start` and `end` cover the statement up to its `;`, and
`nameStart` and `nameEnd` its name; for a query, its `SELECT`. With the `ParseCache` of `checkWithRoles()`, nothing
is parsed again.

```ts
outline("CREATE TABLE db.t (id UInt64) ENGINE = Memory");
// [{ name: "CREATE TABLE db.t", kind: "table", start: 0, end: 45, nameStart: 13, nameEnd: 17,
//    children: [{ name: "id", kind: "column", start: 19, end: 28, nameStart: 19, nameEnd: 21, children: [] }] }]
```

### foldingRanges(sql)

The lines an editor can fold: statements, bracket groups and block comments of several lines, runs of line comments,
and `-- #region` ... `-- #endregion` blocks. Lines count from 1, and `startLine` stays in view.

```ts
foldingRanges("SELECT *\nFROM (\n    SELECT 1\n)"); // [{ startLine: 1, endLine: 4 }, { startLine: 2, endLine: 3 }]
```

### selectionRanges(sql, offsets, cache?)

For each offset, the ranges around it for an editor's Expand Selection, each one holding the one before: the token
there, then the names, calls, bracket groups, expressions, list items, clauses and queries around it, then the
statement. Like `outline()`, it takes the `ParseCache` of `checkWithRoles()`.

```ts
selectionRanges("SELECT f(a + 1) FROM t", [9]).map((r) => r.map(({ start, end }) => [start, end]));
// [[[9, 10], [9, 14], [8, 15], [7, 15], [0, 15], [0, 22]]]: a, a + 1, (a + 1), f(a + 1), SELECT f(a + 1), the statement
```

### definition(sql, offset, options?), references(), prepareRename() and rename()

For the names a statement defines: aliases, CTEs and their columns, table aliases, lambda parameters and query parameters.

```ts
references("SELECT a + 1 AS x FROM t WHERE x > 0", 31); // [{ start: 16, end: 17, definition: true }, { start: 31, end: 32, definition: false }]
rename("SELECT a + 1 AS x FROM t WHERE x > 0", 31, "total sum"); // { edits: [{ start: 16, end: 17, newText: "`total sum`" }, ...] }
prepareRename("SELECT a FROM t", 7); // { error: "`a` is not defined in this query: ..." }
```

Names resolve as ClickHouse's analyzer resolves them: an alias anywhere in its query, before or after it is defined,
and inside its own expression the column of that name; a lambda parameter first; inner queries hiding outer names; a
CTE read again at each place it is used. Where ClickHouse could read a name in more than one way, as when a table of
the database may have a column of that name, there are no results, and `rename()` gives the reason. `rename()` quotes
the new name where ClickHouse would, and refuses one that would change what the query means. With `{ cache }`, the
statements come from the `ParseCache` of `checkWithRoles()`.

### highlight(sql) and tokenize(sql)

```ts
highlight("SELECT key FROM t"); // [{ start: 0, end: 6, scope: "keyword.other.sql" }, { start: 7, end: 10, scope: "variable.other.sql" }, ...]
tokenize("SELECT 1").map((token) => token.kind); // ["BareWord", "Whitespace", "Number", "EndOfStream"]
```

`highlight()` gives TextMate scope names, so any editor theme can colour them; in a statement that parses, each word's
scope comes from how the parser reads it. `tokenize()` splits the input as ClickHouse's lexer does, whitespace and comments included.

## License

Apache License 2.0 with the Commons Clause: free to use, modify and share, but not to sell. See LICENSE and NOTICE.
