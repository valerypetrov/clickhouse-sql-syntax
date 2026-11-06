/**
 * The tables, views, dictionaries, functions and databases that CREATE statements make, the names of tables and
 * databases in statements, and which objects a name may mean, with the current database that USE sets.
 */
import { split } from "../format/index.js";
import { tokenize } from "../lexer/index.js";
import { parsedStatements, quotedName } from "../parser/index.js";
import { isSignificant, type NameOptions, type ObjectKind, type ObjectReference, type SqlObject, type Token, TokenKind as T } from "../types.js";

const KINDS: Partial<Record<string, ObjectKind>> = { TABLE: "table", VIEW: "view", DICTIONARY: "dictionary", FUNCTION: "function", DATABASE: "database" };
const TABLES = new Set<ObjectKind>(["table", "view", "materialized view", "dictionary"]);

/** A part of a name: a word, a quoted name or a {parameter}, and the token after it. */
interface Part {
  text: string;
  param: boolean;
  start: number;
  end: number;
  next: number;
}

function part(sql: string, sig: Token[], i: number): Part | undefined {
  const token = sig[i];
  if (!token) return undefined;
  const text = sql.slice(token.start, token.end);
  if (token.kind === T.BareWord) return { text, param: false, start: token.start, end: token.end, next: i + 1 };
  if (token.kind === T.QuotedIdentifier) {
    const name = quotedName(text);
    return name === undefined ? undefined : { text: name, param: false, start: token.start, end: token.end, next: i + 1 };
  }
  if (token.kind !== T.OpeningCurlyBrace) return undefined;
  // {name:Type} is five tokens.
  const close = sig[i + 4];
  if (close?.kind !== T.ClosingCurlyBrace) return undefined;
  return { text: sql.slice(token.start, close.end), param: true, start: token.start, end: close.end, next: i + 5 };
}

/** [database.]name at token `i`. */
function qualifiedName(sql: string, sig: Token[], i: number): { database?: Part; name: Part } | undefined {
  const first = part(sql, sig, i);
  if (!first) return undefined;
  if (sig[first.next]?.kind !== T.Dot) return { name: first };
  const second = part(sql, sig, first.next + 1);
  return second ? { database: first, name: second } : undefined;
}

function word(sql: string, sig: Token[], i: number): string {
  const token = sig[i];
  return token?.kind === T.BareWord ? sql.slice(token.start, token.end).toUpperCase() : "";
}

/** The database of `USE [DATABASE] name`. */
function useTarget(sql: string, sig: Token[]): Part | undefined {
  if (word(sql, sig, 0) !== "USE") return undefined;
  const named = word(sql, sig, 1) === "DATABASE" ? part(sql, sig, 2) : undefined;
  return named ?? part(sql, sig, 1);
}

export function objects(sql: string): SqlObject[] {
  const found: SqlObject[] = [];
  let current: string | undefined;
  for (const unit of split(sql)) {
    if (!unit.statement) continue;
    const sig = unit.tokens.filter((token) => isSignificant(token.kind));
    const use = useTarget(sql, sig);
    if (use) current = use.text;
    const w = (i: number) => word(sql, sig, i);
    let i = w(0) === "REPLACE" ? 1 : w(0) !== "CREATE" ? -1 : w(1) === "OR" && w(2) === "REPLACE" ? 3 : 1;
    if (i < 0) continue;
    const temporary = w(i) === "TEMPORARY";
    if (temporary) i++;
    let kind: ObjectKind | undefined;
    if (w(i + 1) === "VIEW" && (w(i) === "MATERIALIZED" || w(i) === "LIVE" || w(i) === "WINDOW")) {
      kind = w(i) === "MATERIALIZED" ? "materialized view" : "view";
      i += 2;
    } else {
      kind = KINDS[w(i++)];
    }
    if (!kind) continue;
    if (w(i) === "IF" && w(i + 1) === "NOT" && w(i + 2) === "EXISTS") i += 3;
    const name = qualifiedName(sql, sig, i);
    if (!name || name.name.param || (name.database && !TABLES.has(kind))) continue;
    const database = temporary || !TABLES.has(kind) ? undefined : (name.database?.text ?? current);
    found.push({
      kind, name: name.name.text, database, temporary, start: unit.statement.start, end: unit.statement.end,
      nameStart: (name.database ?? name.name).start, nameEnd: name.name.end,
    });
  }
  return found;
}

export function objectReferences(sql: string, options: NameOptions = {}): ObjectReference[] {
  const found: ObjectReference[] = [];
  let current: string | undefined;
  for (const statement of parsedStatements(sql, options.cache)) {
    const sigOf = (start: number, end: number) =>
      tokenize(sql.slice(start, end))
        .filter((token) => isSignificant(token.kind) && token.kind !== T.EndOfStream)
        .map((token) => ({ ...token, start: token.start + start, end: token.end + start }));
    if (/^use\b/i.test(sql.slice(statement.begin, statement.begin + 4))) {
      const use = useTarget(sql, sigOf(statement.begin, statement.end));
      if (use) {
        current = use.text;
        if (!use.param) found.push({ kind: "database", name: use.text, qualified: false, start: use.start, end: use.end });
      }
      continue;
    }
    // A CTE takes the place of a table of the same name.
    const ctes = new Set<string>();
    for (const mark of statement.names) {
      if (mark.kind !== "with" || !mark.name || (mark.flag !== "cte" && mark.flag !== "materialized")) continue;
      const cte = part(sql, sigOf(statement.begin + mark.name[0], statement.begin + mark.name[1]), 0);
      if (cte) ctes.add(cte.text);
    }
    for (const mark of statement.names) {
      if (mark.kind !== "object") continue;
      const sig = sigOf(statement.begin + mark.start, statement.begin + mark.end);
      const name = qualifiedName(sql, sig, 0);
      if (!name || name.name.param || name.name.next !== sig.length) continue;
      if (!name.database && ctes.has(name.name.text)) continue;
      const database = name.database?.text ?? current;
      if (name.database && !name.database.param) found.push({ kind: "database", name: name.database.text, qualified: false, start: name.database.start, end: name.database.end });
      found.push({ kind: "table", name: name.name.text, database, qualified: !!name.database, start: (name.database ?? name.name).start, end: name.name.end });
    }
  }
  return found.sort((a, b) => a.start - b.start || a.end - b.end);
}

const isParam = (database: string | undefined) => database?.startsWith("{") ?? false;

export function objectDefinitions<F>(reference: ObjectReference, file: F, files: ReadonlyMap<F, readonly SqlObject[]>): { file: F; object: SqlObject }[] {
  const found: { file: F; object: SqlObject }[] = [];
  for (const [path, list] of files) {
    for (const object of list) {
      if (object.name !== reference.name) continue;
      if (reference.kind === "database" ? object.kind === "database" : TABLES.has(object.kind)) found.push({ file: path, object });
    }
  }
  // In its own file, the last CREATE before the name is the one that it names.
  const lastBefore = (list: typeof found) => list.filter((c) => c.file === file && c.object.nameStart <= reference.start).at(-1);
  const narrow = (list: typeof found) => {
    const before = lastBefore(list);
    return before ? [before] : list;
  };
  if (reference.kind === "database") return narrow(found);
  // A temporary table lives in its session, and a name without a database means it before any table.
  const temporary = reference.qualified ? undefined : lastBefore(found.filter((c) => c.object.temporary));
  if (temporary) return [temporary];
  const tables = found.filter((c) => !c.object.temporary);
  const database = reference.database;
  const certain = tables.filter((c) => c.object.database === database && (database === undefined ? c.file === file : !isParam(database)));
  if (certain.length) return narrow(certain);
  return tables.filter((c) => database === undefined || c.object.database === undefined || isParam(database) || isParam(c.object.database) || c.object.database === database);
}
