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

## Use it in VS Code

The extension is not on the Marketplace yet, so you build the `.vsix` file once and install it from disk.

1. **Build it** (needs Node.js 22 or newer):

   ```sh
   git clone https://github.com/valerypetrov/clickhouse-sql-syntax.git
   cd clickhouse-sql-syntax
   npm install
   npm run build
   npm run package:vscode
   ```

   This writes `packages/vscode/clickhouse-sql-0.1.0.vsix`.

2. **Install it** (needs VS Code 1.90 or newer), in either of two ways:
   - In VS Code, open the Extensions view (`Cmd+Shift+X` on macOS, `Ctrl+Shift+X` elsewhere), click `...` at the
     top of the view, choose **Install from VSIX...** and pick the file.
   - From a terminal: `code --install-extension packages/vscode/clickhouse-sql-0.1.0.vsix`

3. **Open a ClickHouse file.** Files ending in `.chsql` or `.clickhouse.sql` use the extension automatically.
   For `.sql` files, add this to your `settings.json`:

   ```json
   "files.associations": {
     "*.sql": "clickhouse-sql"
   }
   ```

   For a single file, run **Change Language Mode** (`Cmd+K M` / `Ctrl+K M`) and pick **ClickHouse SQL**.

4. **Read the errors.** Syntax errors show up as red squiggles while you type, in ClickHouse's own words. Hover
   over one to read it, or open the Problems panel (`Cmd+Shift+M` / `Ctrl+Shift+M`) to see them all. Only syntax
   is checked, as `clickhouse format` does: unknown tables, functions or settings are fine, and inline data
   after `INSERT ... VALUES` or `FORMAT` is skipped.

To update, pull the repository and repeat steps 1 and 2; installing a newer `.vsix` replaces the old one. To
remove it, open the Extensions view, select **ClickHouse SQL** and click **Uninstall**.

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

[Apache License 2.0 with the Commons Clause](LICENSE): you may use, modify and share it, but not sell it. Parts are derived from ClickHouse (Apache License 2.0); see [NOTICE](NOTICE).
