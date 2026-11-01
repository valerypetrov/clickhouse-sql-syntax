/**
 * Names as ClickHouse writes them: plain when the parser reads them back as the same name,
 * in quotes otherwise, as writeProbablyBackQuotedString in src/IO/WriteHelpers.cpp does.
 */

/** Valid identifiers that ClickHouse still quotes, because a parser reads them as literals or keywords. */
const ALWAYS_QUOTED = new Set([
  "inf", "infinity", "nan", "true", "false", "distinct", "all", "some", "table", "select", "cube", "rollup",
  "recursive", "from", "top", "values",
]);

/** Whether ClickHouse writes this name in quotes. */
export function needsQuotes(name: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return true;
  const lower = name.toLowerCase();
  return lower === "null" || ALWAYS_QUOTED.has(lower);
}

const ESCAPES: Record<string, string> = { "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t", "\0": "\\0", "\\": "\\\\" };

/** The name in back quotes or double quotes, escaped as writeAnyQuotedString does. */
export function quote(name: string, mark: "`" | '"' = "`"): string {
  let result = mark;
  for (const c of name) result += ESCAPES[c] ?? (c === mark ? `\\${c}` : c);
  return result + mark;
}

/** The name as it should be written in place of a word that was written with `original` quotes, if any. */
export function written(name: string, original?: string): string {
  if (original === "`" || original === '"') return quote(name, original);
  return needsQuotes(name) ? quote(name) : name;
}
