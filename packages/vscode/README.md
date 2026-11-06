# ClickHouse SQL

Support for [ClickHouse](https://github.com/ClickHouse/ClickHouse) SQL that reads your queries the way ClickHouse's own parser does.

## Features

- **Highlighting.** Words are coloured by how the parser reads them, so a column called `timestamp` or `key` looks like a name, not a keyword.
- **Syntax errors as you type**, in ClickHouse's words, such as `Expected one of: BY, end of query`.
- **Options.** Settings of queries, MergeTree, Kafka and the other engines, databases, columns, EXPLAIN and BACKUP, with their values; codecs and their parameters, index and statistics types, database engines, formats and compression methods: autocomplete, hover, and an error where ClickHouse would refuse one, such as `max_threads = 'abc'` or `CODEC(ZSTD(23))`.
- **Formatting.** Format Document and Format Selection lay out queries like `clickhouse format`, changing only whitespace and the case of keywords.
- **Autocomplete** of the keywords that fit at the cursor and of ClickHouse's functions, types, settings, table engines and formats.
- **Engine arguments.** In `ENGINE = Name(...)`, autocomplete offers what the argument at the cursor takes, such as a ZooKeeper path, a column of the table of a type that fits, a format or a cluster, and signature help shows the engine's parameters.
- **Function arguments.** In a function's brackets, autocomplete offers what its documentation says the argument takes, such as `'day'` in `dateDiff`, a type in `JSONExtract` or `CAST(x, 'T')`, a time zone, a format or `'$.'`, with the columns of a fitting type first; in `JSON(...)` it offers the type's parameters, and after a JSON column its typed paths.
- **Outline and breadcrumbs** list each statement, such as `CREATE TABLE db.t` or `SELECT … FROM db.t`, with its CTEs and the columns it defines.
- **Folding** of statements, subqueries and comments of several lines, and of `-- #region` ... `-- #endregion` blocks.
- **Expand Selection** grows from the word at the cursor to its expression, call, clause, subquery and statement, and Shrink Selection goes back.
- **Table function arguments.** Calls such as `file`, `s3` and `cluster` show their arguments and suggest formats, compression methods and names from the server. Aggregate combinators such as `sumIf` and window functions also have signature help.
- **Hover and signature help** show ClickHouse's documentation of functions, settings, engines and formats, and the arguments of the function you are typing.
- **Go to definition, references and rename** of aliases, CTEs, table aliases and lambda and query parameters, scoped as ClickHouse scopes them; a name that ClickHouse could read otherwise is left alone.
- **Workspace symbols and tables across files.** Go to Symbol in Workspace (Ctrl+T) finds the tables, views, materialized views, dictionaries, functions and databases that the CREATE statements of the folder's ClickHouse SQL files make. From a table in `FROM db.t`, `JOIN t`, `INSERT INTO t`, `ALTER TABLE t` and the other places that name one, go to definition and Find All References reach its CREATE statement and its uses in any of those files. A name without a database means the one that an earlier `USE db` sets, as in ClickHouse; where that is not known, every table of that name is offered.
- **Query parameters.** Autocomplete offers the types after `{name:`, only `Identifier` where a name goes, as in `FROM {table:Identifier}`, the parameters of the file after `{`, and `param_name` in `SET` and `SETTINGS`. Hover over `{name:Type}` or `param_name` says how ClickHouse reads the value and where it can come from: `SET param_name = 'value'`, `SETTINGS param_name = 'value'`, `--param_name='value'` of `clickhouse-client` and `clickhouse local`, or `param_name=value` in the URL of the HTTP interface.
- **Test hints and tags** of ClickHouse's own tests. In `-- { serverError UNKNOWN_TABLE }` and the other hints of `clickhouse-client` (`clientError`, `error`, `echo`, `echoOn`, `echoOff`, `retry N until|while`), autocomplete offers the commands and error names, hover gives the code of each error, and a hint that would make `clickhouse-client` stop, such as an unknown error name, is marked in its words. A `serverError` hint on a statement that the client rejects is marked too. In `-- Tags:` lines, autocomplete and hover know the tags that `clickhouse-test` reads, and mark `no-stress`, which it refuses, and tags it ignores; `-- Random settings limits:` lines are checked as it reads them.
- **Other dialects.** After `SET dialect = 'kusto'`, `'prql'` or another dialect, statements get no syntax errors until `SET dialect = 'clickhouse'`, as `clickhouse-client` parses them in that dialect.
- **Server check** (off by default). Your ClickHouse server checks the names, functions and types in each SELECT, with the values that `SET param_name` gives earlier in the file, and autocomplete offers its databases, tables and columns.

## Install

Search for **ClickHouse SQL** in the Extensions view and select **Install**, or run
`code --install-extension valerypetrov.clickhouse-sql`. It needs VS Code 1.90 or newer.

Files ending in `.chsql` or `.clickhouse.sql` open as ClickHouse SQL. For other files, add a
`files.associations` entry such as `"*.sql": "clickhouse-sql"`, or pick **ClickHouse SQL** with **Change Language Mode**.

## Settings

Set them in **Settings** (search for `clickhouseSql`) or in `settings.json`, where a value of the wrong type, out of
range or not in the list is marked. A wrong value is not used: the setting keeps its default, and a message says why,
or for a server setting the status bar does.

The `clickhouseSql.server` settings count only in your user settings, never in a workspace's, so that a folder you
open cannot send your SQL or your user name to another server. The server check sends only `EXPLAIN QUERY TREE` of
your SELECTs and reads of `system.databases`, `system.tables` and `system.columns`, always with `readonly=1`; the
password stays in VS Code's secret storage.

<!-- settings: generated from package.json by scripts/generate-readme.ts -->

### `clickhouseSql.format.keywordCase`

Default `"upper"`; `"upper"`, `"lower"`, `"preserve"`; user or workspace settings, also per language.

The case of keywords when **Format Document** and **Format Selection** lay out ClickHouse SQL. Only words that the parser reads as keywords change; names, strings and comments stay as written.

For example, `"lower"` formats `SELECT a FROM t` as `select a from t`. It can differ per language, as in `"[clickhouse-sql]": { "clickhouseSql.format.keywordCase": "lower" }`.

- `"upper"`: `SELECT`, `FROM`, `WHERE`
- `"lower"`: `select`, `from`, `where`
- `"preserve"`: Keywords keep the case they are written in

### `clickhouseSql.maxFileSize`

Default `5000000`; integer, at least 0; user settings only.

Files longer than this many characters get no syntax check, semantic highlighting, formatting, outline, folding, Expand Selection, completion, hover, signature help, go to definition, references, rename, workspace symbols or server check, which would slow VS Code down; a message says so once per file. The TextMate highlighting still works.

For example, `20000000` lets files of up to 20 million characters in.

### `clickhouseSql.server.enabled`

Default `false`; boolean; user settings only.

Check names, functions and types against a ClickHouse server, and complete its databases, tables and columns. Each SELECT, and the SELECT of `CREATE ... AS SELECT` and `INSERT ... SELECT`, is sent as `EXPLAIN QUERY TREE` with `readonly=1`, so nothing is changed; the server still runs its scalar subqueries, within limits of 2 s, rows, bytes and memory. The names come from `system.databases`, `system.tables` and `system.columns`.

The values that `SET param_x = ...` gives earlier in the file are sent with the queries that use `{x:Type}`. Only your user settings count, never a workspace's, so that a folder you open cannot send your SQL to another server.

### `clickhouseSql.server.url`

Default `"http://localhost:8123"`; string; user settings only.

The [HTTP interface](https://clickhouse.com/docs/interfaces/http) of the ClickHouse server: `http://` or `https://`, the host and the HTTP port, which is 8123 by default and 8443 with TLS. For example `http://localhost:8123` or `https://abc123.eu-west-1.aws.clickhouse.cloud:8443`.

The native port 9000, which `clickhouse-client` uses, does not answer HTTP. Only your user settings count, never a workspace's, so that a folder you open cannot send your SQL to another server.

### `clickhouseSql.server.user`

Default `"default"`; string; user settings only.

The ClickHouse user, such as `default` or `readonly_user`. Set its password with the **ClickHouse SQL: Set Server Password** command; it is kept in VS Code's secret storage for this user at this URL. Only your user settings count, never a workspace's, so that a folder you open cannot send your SQL to another server.

### `clickhouseSql.server.database`

Default `""`; string; user settings only.

The database of table names written without one, as `USE` sets it in `clickhouse-client`, such as `logs`; empty for the default database of the user. A database the server does not have is shown as a connection problem. Only your user settings count, never a workspace's, so that a folder you open cannot send your SQL to another server.

### `clickhouseSql.server.timeoutMs`

Default `5000`; integer, at least 1 and at most 2147483647; user settings only.

How long to wait for each answer of the server, in milliseconds, such as `5000` for 5 seconds. Queries also stop on the server after 2 seconds, or after this time when it is shorter. Only your user settings count, never a workspace's, so that a folder you open cannot send your SQL to another server.

<!-- end of settings -->

## Commands

In the Command Palette:

<!-- commands: generated from package.json by scripts/generate-readme.ts -->

- **ClickHouse SQL: Set Server Password** (`clickhouseSql.server.setPassword`): asks for the password of `clickhouseSql.server.user` at `clickhouseSql.server.url` and keeps it in VS Code's secret storage, for that user at that URL only; an empty password removes it.
- **ClickHouse SQL: Refresh Schema** (`clickhouseSql.server.refreshSchema`): reads the server's databases, tables and columns again, forgets the results of the server check and checks the open files again.

<!-- end of commands -->

When the server check cannot reach the server, or a server setting is wrong, the status bar shows
**ClickHouse** with a crossed-out plug. Its tooltip says what is wrong, such as
`Cannot connect to http://localhost:8123, which clickhouseSql.server.url names: ...` or
`http://localhost:9000 answered HTTP 400 Bad Request: Port 9000 is for clickhouse-client program. ...`, and selecting
it opens the setting to change. The **ClickHouse Server** output channel keeps each problem, and notes when the server
answers again.

## License

[Apache License 2.0 with the Commons Clause](LICENSE): free to use, modify and share, but not to sell. See [NOTICE](NOTICE).
