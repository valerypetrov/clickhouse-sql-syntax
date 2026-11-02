# clickhouse-sql-syntax

A VS Code extension and a TypeScript library that read [ClickHouse](https://github.com/ClickHouse/ClickHouse) SQL the way ClickHouse's own parser does.

- **Highlighting**: keywords, functions, types and names get their colours from how the parser reads them.
- **Error checking**: the syntax errors that ClickHouse would report, shown as you type.
- **Formatting**: queries laid out as `clickhouse format` does.
- **Autocomplete**: keywords, functions, types, settings, engines and formats that fit where you type.
- **Engine arguments**: in `ENGINE = Name(...)`, what the argument at the cursor takes, and the engine's parameters as you type.
- **Function arguments**: what ClickHouse's documentation says the argument at the cursor takes, such as a unit, a data type, a time zone, a format or a JSONPath, and in `JSON(...)` its parameters.
- **Outline**: each statement with its CTEs and columns, in the Outline view and breadcrumbs.
- **Folding**: statements, subqueries and comments of several lines, and `-- #region` blocks.
- **Expand Selection**: grows from a word to its expression, call, clause, subquery and statement.
- **Go to definition and rename**: aliases, CTEs, table aliases and lambda and query parameters, scoped as ClickHouse scopes them.
- **Server check** (optional): your own ClickHouse server checks the names, functions and types in your queries.

## Use it in VS Code

1. Build the extension (needs Node.js 22 or newer):

   ```sh
   git clone https://github.com/valerypetrov/clickhouse-sql-syntax.git
   cd clickhouse-sql-syntax
   npm install && npm run build && npm run package:vscode
   ```

2. Install it in VS Code 1.90 or newer: `code --install-extension packages/vscode/clickhouse-sql-0.1.0.vsix`,
   or **Install from VSIX...** in the Extensions view.
3. Open a `.chsql` or `.clickhouse.sql` file. For `.sql` files, add `"files.associations": { "*.sql": "clickhouse-sql" }` to your settings.
4. Optional: to check against a server, set `clickhouseSql.server.enabled` to `true` and `clickhouseSql.server.url` to its
   HTTP address, then run **ClickHouse SQL: Set Server Password**. The [extension's page](packages/vscode/README.md) lists every setting.

## Use the library

```ts
import { check, format } from "clickhouse-sql-syntax";
check("SELECT a FROM t GROUP a"); // [{ message: "Expected one of: BY, end of query", line: 1, col: 23, ... }]
format("select a, count() from t group by a"); // "SELECT\n    a,\n    count()\nFROM t\nGROUP BY a"
```

The [library's page](packages/core/README.md) describes the whole API.

## How it is tested

Tested against ClickHouse 26.11 on the 217,536 statements of its own tests: `check()` accepts all 217,156 valid ones and rejects 367 of the 380 invalid ones (the 274 that ClickHouse places at its position, with its message), and `format()` changes the meaning of none.

To work on it, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache License 2.0 with the Commons Clause](LICENSE): free to use, modify and share, but not to sell. Parts come from ClickHouse; see [NOTICE](NOTICE).
