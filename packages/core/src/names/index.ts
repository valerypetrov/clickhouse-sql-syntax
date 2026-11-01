/**
 * Go to definition, references and rename for the aliases, CTEs, table aliases, lambda parameters and query
 * parameters of a statement, with nothing for a name that ClickHouse could read in another way.
 */
import { tokenize } from "../lexer/index.js";
import { type ParseCache, type ParsedStatement, parsedStatements, quotedName } from "../parser/index.js";
import { isSignificant, type NameLocation, type NameOptions, type PrepareRenameResult, type RenameResult, type TextEdit, type Token, TokenKind as T } from "../types.js";
import { needsQuotes, quote, written } from "./quote.js";
import { type Def, isDef, type Resolution, resolveStatement } from "./resolve.js";
import { buildStatement, type Statement } from "./tree.js";

/** Settings that change how ClickHouse resolves names, other than prefer_column_name_to_alias. */
const SCOPING_SETTINGS = new Set([
  "enable_global_with_statement", "enable_scopes_for_with_statement", "analyzer_compatibility_join_using_top_level_identifier",
  "enable_named_columns_in_function_tuple", "analyzer_compatibility_allow_cte_redefinition", "allow_experimental_analyzer",
  "enable_analyzer", "analyzer_compatibility_prefer_alias_over_subcolumn", "analyzer_compatibility_multiple_joins_qualify_column_names",
  "enable_materialized_cte", "compatibility", "semi_join_include_columns_from_both_sides", "anti_join_include_columns_from_both_sides",
  // These name tables and columns in strings.
  "additional_table_filters", "additional_result_filter",
  // Turned off, ORDER BY ALL reads a column named all.
  "enable_order_by_all",
  // These shape the result of a query by expressions in strings.
  "select", "order", "sort", "filter",
]);

/** One statement's names, and why there are none when there are none. */
interface Analysis {
  statement?: Statement;
  resolution?: Resolution;
  error?: string;
  /** The uses of each definition, once asked for. */
  uses?: Map<Def, NameLocation[]>;
}

/** The last analyses, by the statement's place and text and the settings before it. */
const analyses = new Map<string, Analysis>();
const KEPT_ANALYSES = 16;

/** The statements of the text last asked about, for the calls that follow on the same text. */
let last: { sql: string; cache?: ParseCache; statements: ParsedStatement[] } | undefined;

/** The analysis of the statement at `offset`. */
function analyze(sql: string, offset: number, cache?: ParseCache): Analysis {
  if (last?.sql !== sql || last.cache !== cache) last = { sql, cache, statements: parsedStatements(sql, cache) };
  const statements = last.statements;
  let lo = 0;
  let hi = statements.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (statements[mid]!.begin <= offset) lo = mid;
    else hi = mid - 1;
  }
  const parsed = statements[lo];
  if (!parsed || offset < parsed.begin || offset > parsed.end) return { error: "There is no statement without syntax errors here." };
  // SET before the statement changes the settings it runs with.
  const before: string[] = [];
  for (const earlier of statements.slice(0, lo)) {
    if (sql.slice(earlier.begin, earlier.begin + 3).toUpperCase() !== "SET") continue;
    for (const span of earlier.spans) if (span.role === "setting") before.push(sql.slice(span.start, span.end).toLowerCase());
  }
  const text = sql.slice(parsed.begin, parsed.end);
  const key = `${parsed.begin}\u0000${before.join(",")}\u0000${text}`;
  const known = analyses.get(key);
  if (known) {
    analyses.delete(key);
    analyses.set(key, known);
    return known;
  }
  const analysis = analyzeStatement(sql, parsed, before);
  analyses.set(key, analysis);
  if (analyses.size > KEPT_ANALYSES) analyses.delete(analyses.keys().next().value!);
  return analysis;
}

function analyzeStatement(sql: string, parsed: ParsedStatement, before: string[]): Analysis {
  // The statement lexes alone as it does in the whole text, since it begins and ends between tokens.
  const tokens = tokenize(sql.slice(parsed.begin, parsed.end))
    .filter((token) => isSignificant(token.kind))
    .map((token) => ({ ...token, start: token.start + parsed.begin, end: token.end + parsed.begin }));
  const statement = buildStatement(sql, tokens, parsed);
  if (statement.unsupported) return { statement, error: `Names are not followed in this statement, which has ${statement.unsupported}.` };
  const settings = new Set([...statement.settings, ...before]);
  const scoping = [...settings].find((name) => SCOPING_SETTINGS.has(name));
  if (scoping) return { statement, error: `The query sets ${scoping}, which changes how ClickHouse reads names.` };
  const resolution = resolveStatement(statement, { preferColumnsMaybe: settings.has("prefer_column_name_to_alias"), settings });
  return { statement, resolution };
}

/** The word token at `offset`, or the one that ends there. */
function wordAt(statement: Statement, offset: number): Token | undefined {
  const tokens = statement.tokens;
  let lo = 0;
  let hi = tokens.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid]!.end <= offset) lo = mid + 1;
    else hi = mid;
  }
  const isWord = (token?: Token) => token?.kind === T.BareWord || token?.kind === T.QuotedIdentifier;
  const inside = tokens[lo];
  if (isWord(inside) && inside!.start <= offset) return inside;
  const before = tokens[lo - 1];
  return isWord(before) && before!.end === offset ? before : undefined;
}

/** The definition that the word at `offset` names, or why there is none. */
function defAt(analysis: Analysis, offset: number): { def?: Def; token?: Token; error?: string } {
  const { statement, resolution } = analysis;
  if (!statement || !resolution) return { error: analysis.error };
  const token = wordAt(statement, offset);
  if (!token) return { error: "Place the cursor on a name: an alias, a CTE, a table alias, a lambda parameter or a query parameter." };
  const site = resolution.sites.get(token.start);
  if (site) return { def: site, token };
  const entry = resolution.words.get(token.start);
  const name = sqlName(statement.sql, token);
  if (!entry) return { token, error: `\`${name}\` is not a name that this query defines.` };
  const targets = [...entry.targets];
  if (targets.length === 1 && isDef(targets[0]!)) return { def: targets[0], token };
  if (targets.some(isDef)) return { token, error: `\`${name}\` may stand for more than one thing here, so it is left alone.` };
  return { token, error: `\`${name}\` is not defined in this query: it is a table, a column of a table, a function or something else that ClickHouse knows.` };
}

function sqlName(sql: string, token: Token): string {
  const text = sql.slice(token.start, token.end);
  return token.kind === T.QuotedIdentifier ? (quotedName(text) ?? text) : text;
}

/** Every place that names the definition: where it is defined, then where it is used. */
function occurrences(analysis: Analysis, def: Def): NameLocation[] {
  const resolution = analysis.resolution!;
  if (!analysis.uses) {
    // Every definite use of every definition, found once per analysis.
    analysis.uses = new Map();
    for (const { word, targets } of resolution.words.values()) {
      if (targets.size !== 1 || resolution.sites.has(word.start)) continue;
      const [target] = targets;
      if (!isDef(target!)) continue;
      const list = analysis.uses.get(target);
      if (list) list.push({ start: word.start, end: word.end, definition: false });
      else analysis.uses.set(target, [{ start: word.start, end: word.end, definition: false }]);
    }
  }
  const result: NameLocation[] = def.sites.map((site) => ({ start: site.start, end: site.end, definition: true }));
  result.push(...(analysis.uses.get(def) ?? []));
  return result.sort((a, b) => a.start - b.start);
}

/** Where the name at `offset` is defined; empty when it is not defined in the statement or is ambiguous. */
export function definition(sql: string, offset: number, options: NameOptions = {}): NameLocation[] {
  const { def } = defAt(analyze(sql, offset, options.cache), offset);
  if (!def) return [];
  const site = def.sites[0]!;
  return [{ start: site.start, end: site.end, definition: true }];
}

/** Every place in the statement that names the same definition as the name at `offset`, definitions included. */
export function references(sql: string, offset: number, options: NameOptions = {}): NameLocation[] {
  const analysis = analyze(sql, offset, options.cache);
  const { def } = defAt(analysis, offset);
  if (!def || !analysis.resolution) return [];
  return occurrences(analysis, def);
}

/** The name at `offset` and its range, when it can be renamed, or why not. */
export function prepareRename(sql: string, offset: number, options: NameOptions = {}): PrepareRenameResult {
  const analysis = analyze(sql, offset, options.cache);
  const { def, token, error } = defAt(analysis, offset);
  if (!def || !token) return { error: error ?? "This cannot be renamed." };
  if (def.reason) return { error: `${def.reason}, so renaming it could change the query.` };
  return { start: token.start, end: token.end, name: def.name };
}

/** The edits that rename the name at `offset` to `newName`, quoted where needed, or why it cannot be renamed. */
export function rename(sql: string, offset: number, newName: string, options: NameOptions = {}): RenameResult {
  const analysis = analyze(sql, offset, options.cache);
  const { def, error } = defAt(analysis, offset);
  if (!def || !analysis.resolution || !analysis.statement) return { error: error ?? "This cannot be renamed." };
  if (def.reason) return { error: `${def.reason}, so renaming it could change the query.` };
  const name = newNameOf(newName);
  if (name === undefined) return { error: `\`${newName}\` is not a name.` };
  if (def.kind === "query parameter" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { error: `A query parameter name is a plain word, not \`${name}\`.` };
  if (name === def.name) return { edits: [] };
  const places = occurrences(analysis, def);
  // A plain name first; quotes when the plain name reads differently.
  const attempts = def.kind === "query parameter" || needsQuotes(name) ? [false] : [false, true];
  let failure = "";
  for (const forceQuotes of attempts) {
    const edits = places.map((place) => {
      const mark = quoteOf(sql, place.start);
      const text = forceQuotes ? quote(name, mark ?? "`") : def.kind === "query parameter" ? name : written(name, mark);
      return { start: place.start, end: place.end, newText: text };
    });
    failure = verify(sql, offset, analysis, def, edits, name, options.cache);
    if (!failure) return { edits };
  }
  return { error: failure };
}

/** The name the user typed: as is, or the name inside quotes. */
function newNameOf(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed[0] === "`" || trimmed[0] === '"') {
    const tokens = tokenize(trimmed).filter((token) => isSignificant(token.kind));
    if (tokens.length === 2 && tokens[0]!.kind === T.QuotedIdentifier) return quotedName(trimmed);
  }
  return trimmed;
}

/** The quote character a word is written with, if any. */
function quoteOf(sql: string, start: number): "`" | '"' | undefined {
  const c = sql[start];
  if (c === "`") return "`";
  if (c === '"' || c === "“") return '"';
  return undefined;
}

/**
 * Why the renamed statement would mean something else, or "" when it parses again and every word in it
 * resolves as before, the renamed ones to the renamed definition.
 */
function verify(sql: string, offset: number, before: Analysis, def: Def, edits: TextEdit[], name: string, cache?: ParseCache): string {
  const text = applyEdits(sql, edits);
  const moved = (position: number): number => {
    let delta = 0;
    for (const edit of edits) if (edit.end <= position) delta += edit.newText.length - (edit.end - edit.start);
    return position + delta;
  };
  const after = analyze(text, moved(offset), cache);
  const changed = `Renaming \`${def.name}\` to \`${name}\` would change what the query means`;
  if (!after.resolution || !after.statement) return `${changed}: ${after.error ?? "it no longer parses"}`;
  if (after.statement.begin !== moved(before.statement!.begin)) return `${changed}: it no longer parses`;
  const old = before.resolution!;
  const now = after.resolution;
  // Definitions correspond by where they are written.
  const defOf = (target: unknown, shift: (position: number) => number): string => {
    if (!isDef(target as Def)) return (target as { kind: string }).kind;
    const site = (target as Def).sites[0]!;
    return `def@${shift(site.start)}`;
  };
  const renamed = new Set(edits.map((edit) => moved(edit.start)));
  const signature = (resolution: Resolution, shift: (position: number) => number) => {
    const words = new Map<number, string>();
    for (const [start, entry] of resolution.words) {
      words.set(shift(start), [...entry.targets].map((target) => defOf(target, shift)).sort().join("|"));
    }
    return words;
  };
  const oldWords = signature(old, moved);
  const newWords = signature(now, (position) => position);
  if (oldWords.size !== newWords.size) return `${changed}.`;
  for (const [start, targets] of oldWords) {
    const current = newWords.get(start);
    if (current === targets) continue;
    if (!renamed.has(start) && current?.includes(`def@${moved(def.sites[0]!.start)}`)) return `${changed}: \`${name}\` is already used in this query.`;
    return `${changed}.`;
  }
  const renamedDef = now.sites.get(moved(def.sites[0]!.start));
  if (!renamedDef || renamedDef.name !== name) return `${changed}.`;
  if (now.defs.length !== old.defs.length) return `${changed}.`;
  return "";
}

function applyEdits(sql: string, edits: TextEdit[]): string {
  let result = "";
  let at = 0;
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    result += sql.slice(at, edit.start) + edit.newText;
    at = edit.end;
  }
  return result + sql.slice(at);
}
