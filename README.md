# clickhouse-sql-syntax

Syntax highlighting and syntax checking for [ClickHouse](https://github.com/ClickHouse/ClickHouse) SQL,
written in TypeScript with no runtime dependencies.

- **Tokenizer** that splits a query exactly like ClickHouse's own lexer.
- **Highlighter** that turns tokens into TextMate scopes, so any editor theme can colour them.
- **Syntax checker**: a recursive-descent parser that follows ClickHouse's parser and reports
  syntax errors with a message and a line/column range. It is tested against the real ClickHouse
  parser on the statements of ClickHouse's own test suite.
- **VS Code extension** with a TextMate grammar for colours and the checker for live diagnostics.

## Packages

| Package | Path | What it is |
| --- | --- | --- |
| `clickhouse-sql-syntax` | [`packages/core`](packages/core) | The library: `tokenize`, `highlight`, `check`. |
| `clickhouse-sql` | [`packages/vscode`](packages/vscode) | The VS Code extension. |
| oracle | [`oracle`](oracle) | Compares the checker with the real ClickHouse parser. Not published. |

## Usage

```ts
import { check, highlight, tokenize } from "clickhouse-sql-syntax";

check("SELECT 1 +");
// [{ message: "Expected one of: ...", start: 10, end: 10, line: 1, col: 11, severity: "error" }]
```

The full API is described in [`packages/core/src/types.ts`](packages/core/src/types.ts).

## Development

Requires Node.js 22 or newer.

```sh
npm install
npm run build          # compile the library and bundle the extension
npm test               # unit tests, no network or ClickHouse needed
npm run oracle -- --clickhouse /path/to/clickhouse --corpus /path/to/ClickHouse/tests/queries/0_stateless
npm run package:vscode # build the .vsix
npm run test:vscode    # run the extension tests in a real VS Code
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces fit together.

## License

[Apache License 2.0](LICENSE), the same as ClickHouse. The lexer and parser follow the structure
of ClickHouse's parser in `src/Parsers`, and the keyword and data type lists are generated from it.
