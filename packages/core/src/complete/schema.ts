/**
 * The tables a statement names, found by looking at its tokens, and their columns in a schema.
 */
import { type CompletionSchema, type Token, TokenKind as T } from "../types.js";

export type SchemaTable = NonNullable<CompletionSchema["tables"]>[number];

/** A table of the statement, as `[database.]name [AS alias]`. */
export interface TableRef {
  database?: string;
  name: string;
  alias?: string;
}

const TABLE_WORDS = new Set(["from", "join", "into", "table", "update"]);
/** Words after a table name that are not its alias: those of ClickHouse's ParserAlias, then VALUES, SET, ... */
const NOT_ALIASES = new Set([
  "all", "anti", "any", "array", "asof", "between", "cross", "paste", "final", "format", "from", "full",
  "global", "group", "having", "ilike", "inner", "into", "join", "left", "like", "limit", "natural", "not",
  "offset", "on", "only", "order", "parallel", "prewhere", "right", "sample", "semi", "settings", "similar",
  "stream", "union", "using", "where", "window", "qualify", "with", "intersect", "except", "else",
  "values", "select", "set", "add", "drop", "modify", "delete", "update", "engine",
]);

/** The name a bare word or a quoted identifier stands for. */
export function nameOf(sql: string, token: Token | undefined): string | undefined {
  if (token?.kind === T.BareWord) return sql.slice(token.start, token.end);
  if (token?.kind !== T.QuotedIdentifier) return undefined;
  const text = sql.slice(token.start + 1, token.end - 1);
  return text.replace(/\\(.)/g, "$1").replace(/``|""/g, (pair) => pair[0]!);
}

/** Is the token the bare word `word`, given in lower case? */
export function isWord(sql: string, token: Token | undefined, word: string): boolean {
  return token?.kind === T.BareWord && sql.slice(token.start, token.end).toLowerCase() === word;
}

/** The tables named after FROM, JOIN, INTO, TABLE and UPDATE, and in lists like FROM a, b. */
export function tableRefs(sql: string, toks: Token[]): TableRef[] {
  const refs: TableRef[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (toks[i]!.kind !== T.BareWord || !TABLE_WORDS.has(sql.slice(toks[i]!.start, toks[i]!.end).toLowerCase())) continue;
    let j = i + 1;
    for (;;) {
      const first = nameOf(sql, toks[j]);
      if (first === undefined) break;
      const second = toks[j + 1]?.kind === T.Dot ? nameOf(sql, toks[j + 2]) : undefined;
      const ref: TableRef = second === undefined ? { name: first } : { database: first, name: second };
      j += second === undefined ? 1 : 3;
      const explicit = isWord(sql, toks[j], "as");
      if (explicit) j++;
      const alias = nameOf(sql, toks[j]);
      if (alias !== undefined && (explicit || toks[j]!.kind === T.QuotedIdentifier || !NOT_ALIASES.has(alias.toLowerCase()))) {
        ref.alias = alias;
        j++;
      }
      refs.push(ref);
      if (toks[j]?.kind !== T.Comma) break;
      j++;
    }
  }
  return refs;
}

/** The tables of the schema that a reference may mean: in its database, or in any when it names none. */
export function resolve(schema: CompletionSchema, ref: TableRef): SchemaTable[] {
  return (schema.tables ?? []).filter((t) => t.name === ref.name && (ref.database === undefined || t.database === ref.database));
}

/** Every database of the schema, listed or holding a table. */
export function databases(schema: CompletionSchema): string[] {
  return [...new Set([...(schema.databases ?? []), ...(schema.tables ?? []).map((t) => t.database)])];
}
