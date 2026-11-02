# Changelog

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
