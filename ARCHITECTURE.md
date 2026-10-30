# Architecture

The library reads SQL as ClickHouse's parser does, and the extension is built on it. The reference is the real
parser of the ClickHouse version named at the top of `packages/core/src/generated/*.ts`.

## Layout

- `packages/core`: the library, `clickhouse-sql-syntax`, with no runtime dependencies.
- `packages/vscode`: the extension, `clickhouse-sql`.
- `oracle`: compares the library with a ClickHouse binary on ClickHouse's own tests. Not published.
- `scripts`: the generators of `packages/core/src/generated/`.

In `packages/core/src`, a module uses another only through its `index.ts`, never its inner files:

- `lexer/`: `tokenize()`.
- `parser/`: `check()`, `roles()`, and the Expected set at a position, which completion uses.
- `highlight/`: `highlight()`.
- `format/`: `format()`.
- `complete/`: `complete()` and `describe()`.
- `generated/`: lists from ClickHouse: keywords, data types, privileges, and the functions, settings, table engines,
  formats, table functions and combinators that completion offers.

`types.ts` holds the public types. `index.ts` exports them and the functions by name, and the six main functions as one default object.
Offsets are UTF-16 code units of the JavaScript string; lines and columns start at 1, and a line ends at `\n`,
`\r\n` or a lone `\r`, as in VS Code.

## tokenize()

A port of `Lexer::nextToken()` from `src/Parsers/Lexer.cpp`. `TokenKind` names the kinds as `TokenType` does there.

- The tokens cover the input with no gaps: whitespace and comments are tokens too, and the last token is a
  zero-width `EndOfStream`. Lexing never throws; bad input becomes `Error*` tokens.
- The previous significant token decides between `Dot` and a number like `.5`, and makes `x.1.1` lex as
  `x . 1 . 1`, as in ClickHouse.
- Only ASCII letters, digits, `_` and `$` make words. Other non-ASCII characters are `Error` tokens, except the
  minus sign U+2212, the quotes ‘ ’ “ ” and Unicode whitespace, which the lexer of ClickHouse also accepts.

## check()

`check()` follows `tryParseQuery()` and `splitMultipartQuery()` in `src/Parsers/parseQuery.cpp`.

1. Tokenize once and drop whitespace and comments.
2. Split into statements as `clickhouse-client` does: at a `;` or at the end of the input, skipping empty ones.
   The inline data of an `INSERT` is skipped: after `VALUES` (or `FORMAT Values`) it runs to the first `;` outside
   brackets, after any other format to the first empty line.
3. Check each statement as `tryParseQuery()` does, in the same order:
   1. Unless the statement starts with `INSERT INTO`, its first error token is reported at once.
   2. Parse one query with the alternatives of `ParserQuery` and `ParserQueryWithOutput`, in the same order, with
      the settings of `clickhouse format`: no implicit `SELECT`, the `clickhouse` dialect.
   3. An error token where the parse stopped is a lexical error, and unmatched brackets give ClickHouse's
      "Unmatched parentheses" error.
   4. A failed parse is reported at the furthest token any alternative looked at (ClickHouse's
      `TokenIterator::max()`), as `Expected X` or `Expected one of: X, Y` from the expectations recorded there, after
      `Maybe you meant: KEYWORD. ` when a keyword is close.
   5. A query that parses but is followed by more than `;` gets `Expected end of query`.
4. A diagnostic covers the token it points at, or is zero-width at the end of the input. After an error, checking
   goes on after the next `;`, where ClickHouse would stop.

There is no AST of names, types or meaning: an unknown function is fine, a misplaced keyword is not. As in
ClickHouse, nesting deeper than 1000 levels and more than 1,000,000 backtracks in one statement are errors. All the
statements of one call share 2,000,000 backtracks; where they run out, a warning says the rest was not checked.

`checkWithRoles()` takes a `ParseCache` of statements checked before, by their text from where they begin to their
first `;`. It keeps a statement only when nothing after that `;` decided its result, so no inline data, and a hit
costs the backtracks of the parse it stands for, so the result is the same as without the cache.

## roles() and highlight()

While a statement parses, the parser marks what it read each word as: a keyword, identifier, function, type,
engine, setting, parameter or number. Moving back drops the marks past its position, so only the successful parse
counts. `roles()` returns these marks for every statement without errors.

`highlight()` turns them into TextMate scope names, such as `keyword.other.sql` or `variable.other.sql`
(the full list is `Scope` in `types.ts`). In statements that do not parse it decides by the tokens around each word:
a name before `(` is a function, a word from `KEYWORDS` is a keyword, and so on.

## format()

1. `split.ts` cuts the input into units: a statement with its comments, or a paragraph of comments. Statements end
   where `check()` ends them, inline data included.
2. A unit whose statement `check()` rejects is returned as written.
3. `analyze.ts` finds the clauses, lists and brackets of each statement, and `print.ts` lays them out as
   `clickhouse format` does. A word changes case only where `roles()` reads it as a keyword, and a word that
   `roles()` reads as a name or a setting is never taken for a keyword.
4. As a last check, a unit is returned as written unless the result has the same tokens and comments, changes the
   case of keywords only, and still passes `check()`.
5. The line break of the output is the first one in whitespace that `format()` writes again. Strings, comments,
   literals kept as written, rejected statements and inline data decide it only when there is no such break.
   A lone CR becomes LF when a line comment is followed by more text, since only "\n" ends a line comment.

## complete()

`complete()` takes the statement around the cursor and parses its tokens before the cursor, followed by a token
that no parser accepts, so the parser records everything it tries there (`expectedAt()`). The keywords among those
expectations are offered when the parser takes them there, which it does not for all of them, as for FETCH without
ORDER BY or SYSTEM END (`acceptsKeyword()`); the other ones (an expression, a table, a data type, a format, a
setting, ...) pick names from the generated lists and from the schema passed in. The parse stops after 50,000
backtracks, so a very long statement gets no suggestions.

## The VS Code extension

In `packages/vscode/src`:

- `extension.ts`: diagnostics from `check()`, 300 ms after the last change. A `ParseCache` per document keeps the
  statements parsed, so that the diagnostics, the semantic tokens and hover parse a statement once, until it changes.
- `semantic.ts`: semantic tokens from `roles()`, which colour over the TextMate grammar.
- `format.ts`: Format Document and Format Selection through `format()`, with the editor's indentation. Format Selection
  matches the units of `split()` in the text and in its formatted copy, and replaces only the ones the selection touches.
- `complete.ts`, `hover.ts`, `signature.ts`: completion, hover and signature help through `complete()` and `describe()`;
  hover takes the role of the word from the parser where completion does not tell what it is.
- `server/`: the server check. `statements.ts` finds the SELECTs the server can explain: SELECT and WITH statements,
  and the SELECT of `CREATE ... AS SELECT` and `INSERT ... SELECT`. `index.ts` sends each one as `EXPLAIN QUERY TREE`
  with `readonly=1`, 500 ms after a change, keeps the answers by query text, and puts an error on the name it
  mentions. `schema.ts` reads `system.databases`, `system.tables` and `system.columns` for completion.

The TextMate grammar in `syntaxes/` is generated by `scripts/grammar.ts` from the library's keyword and type lists.
It uses the scope names of `highlight()`, so the grammar tests compare the two on the same input.

## Oracle

`oracle/` splits every test file of a ClickHouse checkout into statements as `check()` does, labels each one valid
or invalid with a ClickHouse binary (`formatQueryOrNull()` in bulk, then `clickhouse format` for the position and
message of each error), and compares `check()` and `format()` with those labels. A labelled sample is committed in
`oracle/fixtures/`, so `npm test` compares with it without ClickHouse. See [oracle/README.md](oracle/README.md).
