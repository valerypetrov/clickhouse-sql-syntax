# Changelog

## Unreleased

- More values that ClickHouse refuses are marked: maps given to numbers and booleans, size suffixes and `inf` in float
  settings, URIs, `compatibility` versions, codecs on column types they do not take, the parameters of `Quantized`
  and `SZ3`, the arguments of the `text` and `vector_similarity` indexes, and the `LEVEL` of `INTO OUTFILE`.
- Quick fixes for errors that know the answer: the closest setting, codec, index or statistics type, format,
  compression method, enum value, keyword or test hint error name; the names in "Maybe you meant" of the server check;
  a number in quotes for a setting of one character; and `ENGINE = MergeTree` after
  `SET default_table_engine = 'None'`, which is now marked as ClickHouse refuses it.
- Inlay hints, off by default (`clickhouseSql.inlayHints.enabled`): the parameter names of the arguments of function,
  table function and engine calls, and the type of a query parameter after the `param_name` that sets it.
- Hover over SYSTEM commands and over the clauses of `CREATE` and `ALTER` `USER`, `ROLE`, `QUOTA`, `ROW POLICY` and
  `SETTINGS PROFILE` shows ClickHouse's documentation of them.
- Go to Symbol in Workspace finds the tables, views, materialized views, dictionaries, functions and databases that
  the CREATE statements of the workspace's ClickHouse SQL files make. Go to definition and Find All References of a
  table in a query reach the CREATE statement and the uses in every file, with the database that `USE` sets.

## 0.4.0

- Suggestions and signature help for the arguments of every documented function.
- Every setting is documented with examples, and the settings editor and `settings.json` mark a value of the wrong
  type, out of range, not in the list or, for `clickhouseSql.server.url`, not an `http://` or `https://` URL. A wrong
  value is not used: the setting keeps its default, with a message, or for a server setting, the status bar says why.
- A connection problem names the setting that would fix it, such as `clickhouseSql.server.url` for a server that
  does not answer or the native port 9000, whose answer it quotes; selecting the status bar item opens that setting.
- The README documents every setting and command, generated from `package.json`.
- Query parameters: autocomplete of the type after `{name:`, of `Identifier` where only a name goes, of the file's
  parameters after `{` and of `param_name` in `SET` and `SETTINGS`; hover over `{name:Type}` and `param_name`; the
  server check sends the values that `SET param_name` gives earlier in the file.
- Test hints such as `-- { serverError UNKNOWN_TABLE }`: autocomplete and hover of their commands and error names,
  and the problems that make `clickhouse-client` stop, in its words. `-- Tags:` lines: autocomplete and hover of the
  tags of `clickhouse-test`, and marks for `no-stress` and for tags it does not read; `-- Random settings limits:`
  lines are checked.
- Statements after `SET dialect = 'kusto'` and the other dialects get no syntax errors until
  `SET dialect = 'clickhouse'`.
- Options: autocomplete, hover and checks of the settings of queries, engines, databases, columns, EXPLAIN, BACKUP
  and RESTORE and of their values, of codecs and their parameters, index and statistics types, database engines,
  formats and compression methods, with ClickHouse's own messages. What only the server's settings could allow, such
  as a suspicious codec, is a warning.

## 0.3.0

- Autocomplete for the arguments of functions, by what ClickHouse's documentation of each one says: units and other
  listed values, data types, time zones, formats and JSONPaths, with the columns of a fitting type first, opening by
  itself after the comma before such an argument; the parameters of the JSON type and the typed paths of a JSON
  column; and signature help past optional and repeated arguments.

## 0.2.0

- Autocomplete and signature help for the arguments of table engines, read from their syntax in ClickHouse:
  ZooKeeper paths and replica names, columns of a type that fits, formats, compression methods, keywords such as
  NOSIGN, and the databases, tables, clusters and macros of the server.

## 0.1.0

First release.

- The `clickhouse-sql` language for `.chsql` and `.clickhouse.sql` files.
- Highlighting by a TextMate grammar generated from ClickHouse's keyword and data type lists, and semantic
  highlighting by how the parser reads each word.
- Syntax errors as you type, from `clickhouse-sql-syntax`.
- Format Document and Format Selection, with the `clickhouseSql.format.keywordCase` setting.
- Files longer than `clickhouseSql.maxFileSize`, 5,000,000 characters, are left alone with a message, instead of
  slowing VS Code down.
- Autocomplete, hover documentation and signature help for ClickHouse's keywords, functions, data types, settings,
  table engines, formats and table functions.
- Go to definition, references, highlights and rename of aliases, CTEs, table aliases and lambda and query
  parameters, scoped as ClickHouse's analyzer scopes them.
- An optional check against a ClickHouse server, with completion of its databases, tables and columns. Its
  queries run with `readonly=1` and limits of 2 s, rows, bytes and memory each, and a check of a file sends no
  new query after 10 s. Its settings count only in the user settings, so that a workspace cannot send its SQL
  to another server.
