# Architecture

The goal is a checker that accepts exactly what ClickHouse's parser accepts. The reference is the
real parser: `clickhouse format` and the `formatQuery` SQL function, at the ClickHouse version
recorded at the top of `packages/core/src/generated/*.ts`.

## Layout and ownership

Several people (or agents) work on this repository at the same time. Each path has one owner;
change only the paths you own, and ask the owner of a shared file for any change to it.

| Path | Owner | Contents |
| --- | --- | --- |
| `package.json`, `package-lock.json`, `tsconfig.base.json`, `.gitignore`, `.github/`, `LICENSE`, `README.md`, `ARCHITECTURE.md`, `scripts/` | architect | Workspace setup, CI, docs, the generator. |
| `packages/core/package.json`, `packages/core/tsconfig*.json`, `packages/core/LICENSE`, `packages/core/README.md`, `packages/core/src/index.ts`, `packages/core/src/types.ts`, `packages/core/src/generated/`, `packages/core/test/contract.test.ts` | architect | The public contract. |
| `packages/core/src/lexer/`, `packages/core/test/lexer/` | lexer | `tokenize()`. |
| `packages/core/src/highlight/`, `packages/core/test/highlight/` | lexer | `highlight()`. |
| `packages/core/src/parser/`, `packages/core/test/parser/` | parser | `check()`. |
| `packages/vscode/` (all of it, including its `package.json`) | vscode | The extension, its TextMate grammar and its tests. |
| `oracle/` (all of it, including its `package.json`) | oracle | Corpus extraction, ClickHouse classification, comparison. |

Rules:

- A module uses another module only through its `index.ts` (`../lexer/index.js`), never its inner files.
  Other packages import the library by its name, `clickhouse-sql-syntax`, which resolves to
  `packages/core/dist`, so run `npm run build -w packages/core` after pulling core changes.
- Only the vscode owner may add dependencies, and only to `packages/vscode`; that is the one other
  change allowed to `package-lock.json`. Everyone else asks first. Never run `npm ci` in a shared
  checkout: it deletes `node_modules` under the feet of everyone else.
  Already installed: `typescript` 7, `tsx` and `@types/node` at the root; `@types/vscode` 1.90,
  `@vscode/test-electron`, `@vscode/vsce`, `esbuild`, `vscode-textmate` and `vscode-oniguruma` in `packages/vscode`.
- Commit only your own paths (`git add <your paths>`, never `git add -A`).

## Public API

Defined in [`packages/core/src/types.ts`](packages/core/src/types.ts) and exported from
`packages/core/src/index.ts`, both as named exports and as one default object.

```ts
tokenize(sql: string): Token[]          // lexer/
highlight(sql: string): HighlightSpan[] // highlight/
check(sql: string): Diagnostic[]        // parser/
```

- `Token { kind: TokenKind, start, end, line, col }`. `TokenKind` mirrors `TokenType` of
  ClickHouse's `src/Parsers/Lexer.h` name by name. `ErrorMaxQuerySizeExceeded` is left out because
  there is no query size limit here, and `ErrorSinglePipeMark` because ClickHouse never produces it.
- `Diagnostic { message, start, end, line, col, severity }`.
- `HighlightSpan { start, end, scope }`, where `scope` is a TextMate scope name.
- Offsets are UTF-16 code units of the JavaScript string (what `String.prototype.slice` takes).
  Lines and columns start at 1, and a line ends at `\n`, `\r\n` or a lone `\r`, as in VS Code.
- Helpers: `isSignificant(kind)`, `isErrorKind(kind)`, `LEXER_ERROR_MESSAGES`.
- Generated data: `KEYWORDS` (from `src/Parsers/CommonParsers.h`, multi-word keywords kept whole)
  and `DATA_TYPES` (from `system.data_type_families`). Regenerate both with
  `npm run generate -- --src <ClickHouse checkout> --clickhouse <clickhouse binary>`.

## tokenize()

A port of `Lexer::nextToken()` from `src/Parsers/Lexer.cpp`:

- The result covers the input with no gaps: whitespace and comments are tokens too, and the
  last token is a zero-width `EndOfStream` at `sql.length`. Lexing never throws; bad input
  becomes `Error*` tokens.
- The previous significant token decides between `Dot` and a number like `.5`, and makes
  `x.1.1` lex as `x . 1 . 1`, exactly as in ClickHouse.
- ClickHouse works on UTF-8 bytes, and only ASCII letters, digits, `_` and `$` make words.
  Any other non-ASCII character is an `Error` token unless it is one of the special cases of
  the lexer: the minus sign U+2212, the quotes ‘ ’ “ ”, and Unicode whitespace.

## highlight()

Built on `tokenize()`, one span per significant token or comment, with a little look-around:

| Scope | Tokens | ClickHouse `Highlight` |
| --- | --- | --- |
| `keyword.other.sql` | bare words found in `KEYWORDS` | `keyword` |
| `entity.name.function.sql` | a name followed by `(` | `function` |
| `storage.type.sql` | names found in `DATA_TYPES` where a type is expected | - |
| `variable.other.sql` | other bare words and quoted identifiers | `identifier`, `alias` |
| `variable.parameter.sql` | a whole `{name:Type}` query parameter | `substitution` |
| `constant.numeric.sql` | numbers | `number` |
| `constant.language.sql` | `NULL`, `TRUE`, `FALSE` | `keyword` |
| `string.quoted.single.sql` | string literals | `string` |
| `string.unquoted.heredoc.sql` | heredocs | `string` |
| `comment.line.sql`, `comment.block.sql` | comments | - |
| `keyword.operator.sql` | symbolic operators | - |
| `punctuation.sql` | brackets, `,`, `.`, `;` | - |
| `invalid.illegal.sql` | error tokens | - |

The VS Code grammar emits the same scope names, which lets the extension tests compare the
grammar with `highlight()` on the same input.

## check()

`check()` follows `tryParseQuery()` and `splitMultipartQuery()` in `src/Parsers/parseQuery.cpp`.

1. Tokenize once and drop whitespace and comments.
2. Split into statements the way `clickhouse-client` does: a statement ends at a `;` token or
   at the end of the input, and empty statements (`;;`, a lone comment) are skipped.
   An `INSERT` with inline data is special. After `VALUES` the data runs to the first `;`
   outside brackets. After `FORMAT <name>` it is the rest of that line, or the whole next line
   when the name ends its line. The data is never checked.
3. Check each statement as `tryParseQuery()` does, in the same order:
   1. Unless the statement starts with `INSERT INTO`, the first error token in it is reported
      at once, with its `LEXER_ERROR_MESSAGES` text.
   2. Parse one query with the alternatives of `ParserQuery` and `ParserQueryWithOutput`, in the
      same order. Settings are the defaults of `clickhouse format`: no implicit `SELECT`,
      `allow_settings_after_format_in_insert` off, the `clickhouse` dialect.
   3. An error token where the parse stopped is a lexical error.
   4. Unmatched brackets give ClickHouse's "Unmatched parentheses" error.
   5. A failed parse is reported at the furthest token any alternative looked at (ClickHouse's
      `TokenIterator::max()`), with the expectations recorded at that token: the message is
      `Expected X` or `Expected one of: X, Y`, after `Maybe you meant: KEYWORD. ` when there is
      a close keyword, as in ClickHouse.
   6. A query that parses but is followed by more than `;` or the end gets `Expected end of query`.
4. A diagnostic covers the token it points at; at the end of the input it is zero-width.
   After an error, checking resumes after the next `;` (ClickHouse stops at the first error;
   an editor wants them all).

`check()` does not build an AST and does not look at names, types or semantics: an unknown
function is fine, a misplaced keyword is not. Very deep nesting is reported as an error instead
of overflowing the JavaScript stack, like ClickHouse's `max_parser_depth` (1000 by default).

## Oracle

`oracle/` measures how close `check()` is to ClickHouse on
`tests/queries/0_stateless/*.sql` of a ClickHouse checkout (about 13,000 files):

1. Extract statements: split each file the way `check()` splits input (step 2 above), keeping the
   file name, line and text. Skip empty statements and files that switch `dialect` to something
   other than `clickhouse`. Statements marked `-- { clientError SYNTAX_ERROR }` are expected to be
   invalid, which is a good check of the extraction.
2. Classify with ClickHouse. In bulk, through one `clickhouse local --implicit_select=0` process
   that runs `formatQueryOrNull(q)` over a JSONEachRow file of statements; NULL means invalid.
   Then each invalid one goes through `clickhouse format` to confirm exit code 62
   (`SYNTAX_ERROR`) and read `failed at position N`, a 1-based UTF-8 byte offset. Other errors
   leave the statement out. Never run more than 4 processes at a time, and never start a server.
3. Cache the verdicts in `oracle/.cache/` (ignored by git), keyed by ClickHouse version and statement.
4. Compare with `check()` on the same statement text and report: verdict agreement; false
   positives (valid SQL we reject, the worst kind for users) and false negatives, each with
   file, line and text; and for statements both reject, how often our first diagnostic starts at
   ClickHouse's position (converted from bytes to UTF-16 offsets).
5. Keep a small committed sample under `oracle/fixtures/` (statements, ClickHouse verdict and
   position, with a note that they come from ClickHouse's Apache-2.0 tests) so that the oracle
   workspace's `npm test` catches regressions without ClickHouse.

## npm scripts

At the root:

| Script | Runs |
| --- | --- |
| `build` | `build` of every workspace that has one: core (`tsc` to `dist/`), vscode (bundle). |
| `test` | Build, type-check `scripts/`, then `test` of every workspace that has one. |
| `oracle` | `oracle` of the oracle workspace: the full corpus comparison. Takes `--clickhouse <binary> --corpus <dir>`. |
| `generate` | Regenerates `packages/core/src/generated/`. |
| `package:vscode` | `package` of the vscode workspace: builds the `.vsix`. |
| `test:vscode` | `test:e2e` of the vscode workspace: the extension tests in a real VS Code. |

Every workspace `test` script must be fast and headless and need no network and no ClickHouse
binary; the oracle and the real-VS Code tests have their own scripts.

The VS Code language id is `clickhouse-sql` and the grammar scope name is `source.clickhouse-sql`.

## Conventions

- Plain, readable TypeScript, ES modules, strict mode. Relative imports end in `.js`.
- Comments are at most two lines, in simple words; the reasoning goes in the commit message.
- Tests use `node:test` and `node:assert/strict`, live in `test/<area>/*.test.ts` and run through `tsx`.
- No stubs or placeholder code in finished work.
