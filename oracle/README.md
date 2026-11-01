# Oracle

This workspace measures how close `check()` is to the real ClickHouse parser. It runs `check()` on
statements from ClickHouse's own tests, each labelled valid or invalid by a ClickHouse binary, and
reports where the two disagree.

## Run it

```sh
npm run build -w packages/core   # the oracle imports the built library
npm run oracle                   # compares check() with fixtures/corpus.jsonl.gz
```

This needs no ClickHouse. It prints a confusion matrix, the share of errors reported at the same
position as ClickHouse, the most common false positives and false negatives grouped by statement
and by error, and writes everything, with file and line of each case, to `out/report.json`.

To compare with every statement of a ClickHouse checkout instead of the committed sample:

```sh
npm run oracle -w oracle -- --clickhouse /path/to/clickhouse --corpus /path/to/ClickHouse/tests/queries/0_stateless
```

When the binary is another build than the one that labelled `fixtures/`, a statement that the labels there read
as `check()` does, while the binary reads it otherwise, is a version gap: it is listed with both verdicts and left out
of the numbers. `--check-thresholds` fails when a rate falls below `thresholds.json`.

`npm run oracle -w oracle -- --help` lists the other options.

## The corpus

`fixtures/corpus.jsonl.gz` is gzipped JSON lines: a header with the ClickHouse version that labelled
it, then one entry per statement:

```json
{"sql": "SELECT (1", "file": "00001_x.sql", "line": 3, "valid": false, "position": 10, "message": "Unmatched parentheses: ..."}
```

`position` is ClickHouse's "failed at position N", a 1-based UTF-8 byte offset. Entries with
`mutation` are copies of a valid statement with one change (a dropped bracket, two keywords swapped,
a cut, a typo, ...), labelled by ClickHouse like the others.

The statements come from the tests of [ClickHouse](https://github.com/ClickHouse/ClickHouse),
Copyright ClickHouse, Inc., licensed under the Apache License 2.0.

Rebuild it with:

```sh
npm run corpus -w oracle -- --clickhouse /path/to/clickhouse --corpus /path/to/ClickHouse/tests/queries/0_stateless
```

This splits every test file the way `clickhouse-client` does: at `;`, with the inline data of an
`INSERT` kept whole (VALUES data runs to a `;` outside brackets, other data to the first empty
line). It skips files in other dialects (Kusto, PRQL, ...) and the tests tagged `use-xray`, whose
SYSTEM INSTRUMENT only builds with XRay parse as `check()` does, removes duplicates, and labels each
statement:

1. In bulk, with `formatQueryOrNull()` in one `clickhouse local --implicit_select=0` process per
   5,000 statements.
2. Each rejected statement then goes through `clickhouse format`, which must exit with code 62
   (`SYNTAX_ERROR`), for its position and message. A sample of accepted ones is confirmed too.

At most 4 ClickHouse processes run at a time, and the verdicts are cached in `.cache/` per
ClickHouse build, so a rebuild only asks about new statements. The corpus keeps every invalid
statement, then valid ones up to `--limit` (20,000 by default) in a fixed hash order, then adds
`--mutations` mutated copies (5,000 by default).

## Thresholds

`npm test` runs the comparison on the committed corpus and fails when a rate falls below the value
in `thresholds.json`. Raise the values when `check()` gets better, so it cannot slide back.

## Rename

```sh
npm run build -w packages/core
npm run oracle:rename -- --clickhouse /path/to/clickhouse --corpus /path/to/ClickHouse/tests/queries/0_stateless
```

This checks `rename()` against ClickHouse. It takes the SELECT statements of the tests without a `FORMAT`, `INTO OUTFILE`
or expected error, renames each name that `prepareRename()` accepts to a fresh one (every seventh also to one that needs
quotes), and runs the original and the renamed query in a fresh `clickhouse local` with one thread. A statement counts
when it runs alone, without the tables of its test, and gives the same result twice. A mismatch is a renamed query that
fails or gives another result, or edits that are not exactly the words `references()` finds, each one the old name
becoming the new one. `out/rename-report.json` lists the counts, why `prepareRename()` refused names, and every mismatch.
