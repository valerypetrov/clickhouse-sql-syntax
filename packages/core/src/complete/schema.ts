/**
 * The tables a statement names and the columns that CREATE declares, found by looking at its tokens,
 * and the columns of the tables in a schema.
 */
import { DATA_TYPES } from "../generated/data-types.js";
import { type CompletionCandidate, type CompletionSchema, type Token, TokenKind as T } from "../types.js";

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

/** A database, table or column, inserted in back quotes when it is not a plain identifier. */
export function named(candidate: CompletionCandidate): CompletionCandidate {
  const name = candidate.label;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return candidate;
  return { ...candidate, insertText: `\`${name.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\`` };
}

/** Every database of the schema, listed or holding a table. */
export function databases(schema: CompletionSchema): string[] {
  return [...new Set([...(schema.databases ?? []), ...(schema.tables ?? []).map((t) => t.database)])];
}

/** A column that a CREATE statement declares, with its type as written, empty when it is left out. */
export interface DeclaredColumn {
  name: string;
  type: string;
  /** The type the name of the type stands for, such as Int8 for TINYINT. */
  family?: string;
  /** The family of the type in the brackets, as UInt64 in LowCardinality(UInt64). */
  inner?: string;
}

const typesByName = new Map(DATA_TYPES.map((t) => [t.name, t]));
const typesByUpperName = new Map(DATA_TYPES.filter((t) => t.caseInsensitive).map((t) => [t.name.toUpperCase(), t]));

/** The family of a type name of one or more words, such as Int64 for BIGINT SIGNED. */
function family(name: string): string | undefined {
  const type = typesByName.get(name) ?? typesByUpperName.get(name.toUpperCase());
  return type && (type.aliasTo || type.name);
}

/** A column of the schema, whose type the server writes as ClickHouse names it. */
export function schemaColumn(name: string, type: string): DeclaredColumn {
  const match = /^(\w+)(?:\((\w+))?/.exec(type);
  return { name, type, family: match ? family(match[1]!) : undefined, inner: match?.[2] && family(match[2]) };
}

/** How many of the bare words from `i` name a type, the most that do, and its family. */
function typeAt(sql: string, toks: Token[], i: number): [number, string] | undefined {
  const words: string[] = [];
  let found: [number, string] | undefined;
  for (let j = i; j < i + 4 && toks[j]?.kind === T.BareWord; j++) {
    words.push(sql.slice(toks[j]!.start, toks[j]!.end));
    const name = family(words.join(" "));
    if (name) found = [words.length, name];
  }
  return found;
}

/** Words that start a declaration in the column list other than a column, when no type follows them. */
const NOT_COLUMNS = new Set(["index", "projection", "constraint", "primary"]);

/** The index of the bracket that closes the one at `i`, or the end of the tokens. */
function closing(toks: Token[], i: number): number {
  let depth = 0;
  for (let j = i; j < toks.length; j++) {
    const kind = toks[j]!.kind;
    if (kind === T.OpeningRoundBracket || kind === T.OpeningSquareBracket) depth++;
    else if ((kind === T.ClosingRoundBracket || kind === T.ClosingSquareBracket) && --depth === 0) return j;
  }
  return toks.length;
}

function declaredColumn(sql: string, toks: Token[], from: number, to: number): DeclaredColumn | undefined {
  const name = nameOf(sql, toks[from]);
  if (name === undefined) return undefined;
  const type = from + 1 < to ? typeAt(sql, toks, from + 1) : undefined;
  if (!type && toks[from]!.kind === T.BareWord && NOT_COLUMNS.has(name.toLowerCase())) return undefined;
  if (!type) return { name, type: "" };
  let end = from + type[0];
  let inner: string | undefined;
  if (toks[end + 1]?.kind === T.OpeningRoundBracket) {
    inner = typeAt(sql, toks, end + 2)?.[1];
    end = Math.min(closing(toks, end + 1), to - 1);
  }
  return { name, type: sql.slice(toks[from + 1]!.start, toks[end]!.end), family: type[1], inner };
}

/** The columns in the brackets after the name of the table that CREATE makes, and the table of its `AS [db.]table`. */
export function createdTable(sql: string, toks: Token[]): { columns: DeclaredColumn[]; source?: TableRef } {
  const columns: DeclaredColumn[] = [];
  const at = toks.findIndex((token, i) => i < 6 && isWord(sql, token, "table"));
  if (at < 0) return { columns };
  for (let i = at + 1; i < toks.length; i++) {
    const token = toks[i]!;
    if (isWord(sql, token, "engine")) break;
    if (isWord(sql, token, "as")) {
      const first = nameOf(sql, toks[i + 1]);
      const second = toks[i + 2]?.kind === T.Dot ? nameOf(sql, toks[i + 3]) : undefined;
      const next = toks[i + (second === undefined ? 2 : 4)];
      if (first === undefined || next?.kind === T.OpeningRoundBracket || ["select", "with"].includes(first.toLowerCase())) break;
      return { columns, source: second === undefined ? { name: first } : { database: first, name: second } };
    }
    if (token.kind !== T.OpeningRoundBracket) continue;
    const end = closing(toks, i);
    for (let from = i + 1, j = i + 1; j <= end; j++) {
      const kind = toks[j]?.kind;
      if (kind === T.OpeningRoundBracket || kind === T.OpeningSquareBracket) j = closing(toks, j);
      else if (kind === T.Comma || j === end) {
        const column = declaredColumn(sql, toks, from, j);
        if (column) columns.push(column);
        from = j + 1;
      }
    }
    break;
  }
  return { columns };
}

const KEY_CLAUSES = ["order", "primary", "partition"];
const CLAUSES = new Set([...KEY_CLAUSES, "sample", "ttl", "settings", "comment", "as", "empty"]);

/** The names in the ORDER BY, PRIMARY KEY and PARTITION BY clauses after the ENGINE of a statement. */
export function keyNames(sql: string, toks: Token[]): Set<string> {
  const names = new Set<string>();
  let inKey = false;
  for (let i = toks.findIndex((token) => isWord(sql, token, "engine")), depth = 0; i >= 0 && i < toks.length; i++) {
    const token = toks[i]!;
    const word = token.kind === T.BareWord ? sql.slice(token.start, token.end).toLowerCase() : "";
    if (token.kind === T.OpeningRoundBracket) depth++;
    else if (token.kind === T.ClosingRoundBracket) depth--;
    else if (depth === 0 && CLAUSES.has(word)) inKey = KEY_CLAUSES.includes(word);
    else if (inKey && nameOf(sql, token) !== undefined) names.add(nameOf(sql, token)!);
  }
  return names;
}
