# format()

```ts
import { format } from "clickhouse-sql-syntax";

format("select a, count() from t where x > 1 group by a");
// SELECT
//     a,
//     count()
// FROM t
// WHERE x > 1
// GROUP BY a

format(sql, { keywordCase: "lower", indentSize: 2 });
```

`format(sql, options?)` lays out ClickHouse SQL the way `clickhouse format` does and returns the new text.

| Option | Values | Default |
| --- | --- | --- |
| `keywordCase` | `"upper"`, `"lower"`, `"preserve"` | `"upper"` |
| `indentSize` | spaces per level | `4` |

## What it changes

- Each clause of a query starts a line: `WITH`, `SELECT`, `FROM`, every `JOIN`, `ARRAY JOIN`, `PREWHERE`,
  `WHERE`, `GROUP BY`, `HAVING`, `WINDOW`, `QUALIFY`, `ORDER BY`, `LIMIT`, `SETTINGS`, `FORMAT`, and
  `UNION`, `EXCEPT` and `INTERSECT` between queries.
- The items of `WITH`, `SELECT`, `GROUP BY` and `ORDER BY` go one per line when there are several.
- Subqueries and CTE bodies are indented one level, inside brackets that close on their own line.
- `CREATE TABLE` puts each column, index, projection and constraint on a line, and `ENGINE`,
  `PARTITION BY`, `PRIMARY KEY`, `ORDER BY`, `SAMPLE BY`, `TTL`, `SETTINGS` and `COMMENT` on lines of their own.
  `ALTER TABLE` puts each command on a line when there are several. Other statements stay on one line.
- Inside expressions: one space around binary operators and after commas, none inside brackets.
- Statements are separated by their `;` and one empty line.
- Keywords take the case of `keywordCase`. Only words from the keyword list, where they are used as
  keywords, are re-cased.

## What it never changes

- Names, quoted or not, function and data type names, strings, heredocs, numbers and query parameters.
  A column called `key` or `date` keeps its case.
- Comments. Each stays where it was: at the end of its line, or on a line of its own.
- The inline data of `INSERT ... VALUES` and `INSERT ... FORMAT`.
- A statement that `check()` reports an error for: it is returned exactly as written, and the
  statements around it are still formatted.
- The line endings: a file whose first line break is CRLF gets CRLF.

The result is idempotent: `format(format(x)) === format(x)`. Empty or blank input is returned as it is.

## How it is checked

`npm run oracle:format -- --clickhouse <clickhouse binary>` formats every valid statement of the
labelled corpus with each `keywordCase` and checks that ClickHouse's `formatQuerySingleLine` reads
the same query, that every re-cased word is a keyword for ClickHouse's `highlightQuery`, and that the
output is idempotent, still valid for `check()` and has the same tokens and comments. With
`--corpus <ClickHouse checkout>/tests/queries/0_stateless` it does the same for all the tests,
and also formats each test file as a whole, as LF and as CRLF text.

## VS Code

The extension registers "Format Document" and "Format Selection" for ClickHouse SQL files.
"Format Selection" formats the whole statements that the selection touches. Indentation follows the
editor's tab size and "Insert Spaces" setting, and `clickhouseSql.format.keywordCase` (`upper`,
`lower` or `preserve`) sets the case of keywords.
