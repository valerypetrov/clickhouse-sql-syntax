import { split } from "clickhouse-sql-syntax";

/** The values of the dialect setting other than clickhouse, in ClickHouse 26.11. */
const OTHER_DIALECTS = new Set(["trino", "logsql", "clickhouse_json", "prql", "polyglot", "promql", "kusto"]);

/**
 * The statements that clickhouse-client parses in another dialect, after SET dialect = 'kusto' and the like
 * and up to SET dialect = 'clickhouse'. SET statements are left out, as every dialect reads them as ClickHouse does.
 */
export function otherDialectSpans(text: string): { start: number; end: number }[] {
  if (!text.includes("dialect")) return [];
  const spans: { start: number; end: number }[] = [];
  let other = false;
  for (const unit of split(text)) {
    const statement = unit.statement;
    if (!statement) continue;
    const sql = text.slice(statement.start, statement.end);
    if (/^SET\b/i.test(sql)) {
      // The last dialect = value of the SET; the setting's name and values are case-sensitive.
      const values = [...sql.matchAll(/\bdialect\s*=\s*(?:'(\w+)'|(DEFAULT)\b)/g)];
      const value = values.pop();
      if (value) other = value[1] !== undefined && OTHER_DIALECTS.has(value[1]) ? true : value[1] === "clickhouse" || value[2] !== undefined ? false : other;
      continue;
    }
    if (other) spans.push({ start: statement.start, end: statement.end });
  }
  return spans;
}
