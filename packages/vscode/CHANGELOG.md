# Changelog

## 0.1.0

First release.

- The `clickhouse-sql` language for `.chsql` and `.clickhouse.sql` files.
- Highlighting by a TextMate grammar generated from ClickHouse's keyword and data type lists, and semantic
  highlighting by how the parser reads each word.
- Syntax errors as you type, from `clickhouse-sql-syntax`.
- Format Document and Format Selection, with the `clickhouseSql.format.keywordCase` setting.
- Autocomplete, hover documentation and signature help for ClickHouse's keywords, functions, data types, settings,
  table engines, formats and table functions.
- An optional check against a ClickHouse server, with completion of its databases, tables and columns.
