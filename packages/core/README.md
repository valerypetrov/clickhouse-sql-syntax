# clickhouse-sql-syntax

Tokenizer, syntax highlighter and syntax checker for [ClickHouse](https://github.com/ClickHouse/ClickHouse) SQL.
No runtime dependencies; works in Node.js and in the browser.

```sh
npm install clickhouse-sql-syntax
```

```ts
import { check, highlight, tokenize } from "clickhouse-sql-syntax";

tokenize("SELECT 1"); // every token, whitespace included, ending with EndOfStream
highlight("SELECT 1"); // [{ start: 0, end: 6, scope: "keyword.other.sql" }, ...]
check("SELECT 1 +"); // syntax errors with offsets, line and column; [] when valid
```

- `tokenize(sql)` splits the input exactly like ClickHouse's lexer (`src/Parsers/Lexer.cpp`).
- `highlight(sql)` gives TextMate scope names, so any editor theme can colour them.
- `check(sql)` checks every `;`-separated statement and aims to accept exactly what ClickHouse's
  parser accepts. It is tested against the real parser on ClickHouse's own test queries.

Offsets are UTF-16 code units, as JavaScript strings count them; lines and columns start at 1.
The types are documented in [`src/types.ts`](src/types.ts).

## License

Apache License 2.0.
