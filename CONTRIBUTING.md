# Contributing

You need Node.js 22 or newer.

```sh
npm install
npm run build   # the library into packages/core/dist, the extension into packages/vscode/dist
npm test        # unit, grammar and oracle tests; no network and no ClickHouse needed
```

The extension and the oracle import the library by its name, which resolves to `packages/core/dist`, so run
`npm run build` after a change in `packages/core`. [ARCHITECTURE.md](ARCHITECTURE.md) shows how the parts fit together.

## Tests in VS Code

These download VS Code into `packages/vscode/.vscode-test` and run in a profile of their own. On Linux, run them under `xvfb-run -a`.

- `npm run test:vscode`: the extension tests.
  - `VSCODE_VERSION=<version>` picks the VS Code to test with; the default is the current stable, and CI also tests 1.90.0, the oldest one the extension supports.
  - `VSIX=<file>` installs that package with the `code` command line, tests it instead of the source folder, and uninstalls it.
  - `CLICKHOUSE_BINARY=<clickhouse>` runs the server tests, which skip themselves without it; they start a server
    of their own in a temporary folder, or under `CLICKHOUSE_SERVER_DIR=<dir>`.
- `npm run test:vscode:corpus`: opens ClickHouse's own test files and checks the diagnostics, formatting, semantic
  tokens and completion against the library and against ClickHouse. It needs
  `CLICKHOUSE_CORPUS=<ClickHouse checkout>/tests/queries/0_stateless` and `CLICKHOUSE_BINARY=<clickhouse>`.
- `npm run test:vscode:stress`: edits a 1 MB file of 10,000 statements and times the diagnostics, semantic tokens and completion.

With `CLICKHOUSE_CORPUS` set, `npm test` also times the TextMate grammar on every line of ClickHouse's tests instead of the stored sample.

## Comparing with ClickHouse

```sh
npm run oracle                    # check() against the labelled sample in oracle/fixtures
npm run oracle -- --clickhouse <clickhouse> --corpus <ClickHouse checkout>/tests/queries/0_stateless
npm run oracle:format -- --clickhouse <clickhouse> --corpus <ClickHouse checkout>/tests/queries/0_stateless
```

The second command labels every statement of the tests with that binary and compares `check()` with it. The third
checks that ClickHouse reads each statement that `format()` changed as the same query, and formats every test file
whole, as LF and as CRLF text. `npm test` fails when the sample's rates fall below `oracle/thresholds.json`; raise
them when `check()` gets better. [oracle/README.md](oracle/README.md) describes the sample and how to rebuild it.

## Generated files

The lists that come from ClickHouse are generated; do not edit them by hand.

- `npm run generate -- --src <ClickHouse checkout> --clickhouse <clickhouse>`: the keywords, data types and privileges in `packages/core/src/generated/`.
- `npx tsx scripts/generate-catalog.ts --clickhouse <clickhouse>`: the functions, settings, table engines, formats,
  table functions and combinators that completion offers.
- `npm run generate -w packages/vscode`: the TextMate grammar in `packages/vscode/syntaxes/`. Edit
  `packages/vscode/scripts/grammar.ts` instead of the JSON, and run it after the keyword or data type lists change.

## Packaging and CI

`npm run package:vscode` writes `packages/vscode/clickhouse-sql-<version>.vsix`.

`.github/workflows/ci.yml` runs on every push to `main` and every pull request, on Linux, macOS and Windows: `npm ci`,
`npm run build`, `npm test` and the oracle thresholds with Node.js 22 and 24, then the VS Code tests of the packed
`.vsix` in the current stable VS Code and in 1.90.0.

## Conventions

- Plain, readable TypeScript in strict mode, as ES modules; relative imports end in `.js`.
- Comments are at most two lines, in simple words; the reasoning goes in the commit message.
- Tests use `node:test` and `node:assert/strict`, live in `test/<area>/*.test.ts` and run through `tsx`.
- The `npm test` of every workspace stays fast and headless, with no network and no ClickHouse binary.
