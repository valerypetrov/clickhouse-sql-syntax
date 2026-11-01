# ClickHouse SQL

Support for [ClickHouse](https://github.com/ClickHouse/ClickHouse) SQL that reads your queries the way ClickHouse's own parser does.

## Features

- **Highlighting.** Words are coloured by how the parser reads them, so a column called `timestamp` or `key` looks like a name, not a keyword.
- **Syntax errors as you type**, in ClickHouse's words, such as `Expected one of: BY, end of query`.
- **Formatting.** Format Document and Format Selection lay out queries like `clickhouse format`, changing only whitespace and the case of keywords.
- **Autocomplete** of the keywords that fit at the cursor and of ClickHouse's functions, types, settings, table engines and formats.
- **Outline and breadcrumbs** list each statement, such as `CREATE TABLE db.t` or `SELECT … FROM db.t`, with its CTEs and the columns it defines.
- **Folding** of statements, subqueries and comments of several lines, and of `-- #region` ... `-- #endregion` blocks.
- **Expand Selection** grows from the word at the cursor to its expression, call, clause, subquery and statement, and Shrink Selection goes back.
- **Hover and signature help** show ClickHouse's documentation of functions, settings, engines and formats, and the arguments of the function you are typing.
- **Server check** (off by default). Your ClickHouse server checks the names, functions and types in each SELECT, and autocomplete offers its databases, tables and columns.

## Install

The extension is not on the Marketplace yet: build `clickhouse-sql-0.1.0.vsix` as the
[repository](https://github.com/valerypetrov/clickhouse-sql-syntax#use-it-in-vs-code) shows, then run
**Extensions: Install from VSIX...** in VS Code 1.90 or newer.

Files ending in `.chsql` or `.clickhouse.sql` open as ClickHouse SQL. For other files, add a
`files.associations` entry such as `"*.sql": "clickhouse-sql"`, or pick **ClickHouse SQL** with **Change Language Mode**.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `clickhouseSql.format.keywordCase` | `upper` | The case of keywords when formatting: `upper`, `lower` or `preserve`. |
| `clickhouseSql.maxFileSize` | `5000000` | Longer files, in characters, get none of the features; a user setting only. |
| `clickhouseSql.server.enabled` | `false` | Turns the server check on. |
| `clickhouseSql.server.url` | `http://localhost:8123` | The HTTP interface of the server. |
| `clickhouseSql.server.user` | `default` | The ClickHouse user. Set its password with **ClickHouse SQL: Set Server Password**. |
| `clickhouseSql.server.database` | empty | The database of table names without one; empty means the user's default. |
| `clickhouseSql.server.timeoutMs` | `5000` | How long to wait for the server, in milliseconds. |

The `clickhouseSql.server` settings count only in your user settings, never in a workspace's.

**ClickHouse SQL: Refresh Schema** reads the server's databases, tables and columns again.

The server check sends only `EXPLAIN QUERY TREE` of your SELECTs and reads of `system.databases`, `system.tables` and `system.columns`, always with `readonly=1`; the password stays in VS Code's secret storage.

## License

[Apache License 2.0 with the Commons Clause](LICENSE): free to use, modify and share, but not to sell. See [NOTICE](NOTICE).
