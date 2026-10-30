/**
 * complete(): suggestions at a cursor. Keywords are those the parser expects there, and the
 * other names depend on what it expects: an expression, a table, a data type, a format, ...
 */
import { COMBINATORS } from "../generated/combinators.js";
import { DATA_TYPES } from "../generated/data-types.js";
import { FORMATS } from "../generated/formats.js";
import { FUNCTIONS } from "../generated/functions.js";
import { SETTINGS } from "../generated/settings.js";
import { TABLE_ENGINES } from "../generated/table-engines.js";
import { TABLE_FUNCTIONS } from "../generated/table-functions.js";
import { split, type Unit } from "../format/index.js";
import { expectedAt } from "../parser/index.js";
import {
  type CompleteOptions,
  type CompletionCandidate,
  type CompletionSchema,
  isErrorKind,
  isSignificant,
  type Token,
  TokenKind as T,
} from "../types.js";
import {
  AGGREGATES,
  combinatorDocumentation,
  engineDocumentation,
  formatDetail,
  formatDocumentation,
  functionDocumentation,
  settingDocumentation,
  tableFunctionDocumentation,
} from "./catalog.js";
import { databases, isWord, nameOf, resolve, type SchemaTable, tableRefs } from "./schema.js";

/** Expected variants that are keywords, such as FROM or ORDER BY, rather than descriptions. */
const KEYWORD_VARIANT = /^[A-Z][A-Z0-9_]*( [A-Z][A-Z0-9_]*)*$/;

/** Expected where a table goes after FROM or JOIN; the list of joins expects its own variant after a table too. */
const TABLE_VARIANT = "table or subquery or table function";

/** Words after which a table name follows. */
const TABLE_NAME_WORDS = new Set(["table", "into", "update", "describe", "desc", "exists", "truncate"]);
const DATABASE_WORDS = new Set(["database", "use"]);

/** The word being typed: where it starts and its part before the cursor. */
interface Word {
  start: number;
  prefix: string;
}

/** The last token that starts before the offset, or undefined at the start. */
function tokenBefore(tokens: Token[], offset: number): Token | undefined {
  if (!tokens.length) return undefined;
  let lo = 0;
  let hi = tokens.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tokens[mid]!.start < offset) lo = mid;
    else hi = mid - 1;
  }
  const token = tokens[lo]!;
  return token.start < offset ? token : undefined;
}

/** The last unit that starts before the offset, the one whose tokens the cursor is among. */
function unitBefore(units: Unit[], offset: number): Unit | undefined {
  let found: Unit | undefined;
  for (const unit of units) {
    if (unit.start >= offset) break;
    found = unit;
  }
  return found;
}

/** Whether a statement has ended before the offset, at its ";" or at the empty line after its data. */
function endedBefore(unit: Unit, offset: number): boolean {
  const statement = unit.statement!;
  if (offset < statement.end) return false;
  return unit.data.blankLine || unit.tokens.some((token) => token.kind === T.Semicolon && token.end === statement.end);
}

/** The statement that a word starting at `start` goes on, or undefined when it starts one. */
function statementAt(units: Unit[], start: number): Unit | undefined {
  let i = units.length - 1;
  while (i >= 0 && !(units[i]!.statement && units[i]!.statement!.start <= start)) i--;
  if (i >= 0 && !endedBefore(units[i]!, start)) return units[i];
  for (i++; i < units.length; i++) if (units[i]!.statement) return units[i];
  return undefined;
}

/** The word at the cursor, or undefined in a comment, a string, a quoted name or a number. */
function wordAt(sql: string, tokens: Token[], offset: number): Word | undefined {
  const token = tokenBefore(tokens, offset);
  const none = { start: offset, prefix: "" };
  if (!token) return none;
  switch (token.kind) {
    case T.BareWord:
      return { start: token.start, prefix: sql.slice(token.start, offset) };
    case T.Number:
      return undefined;
    case T.Comment:
      // A line comment goes on to the end of its line.
      return token.end > offset || !sql.startsWith("/*", token.start) ? undefined : none;
    case T.StringLiteral:
    case T.QuotedIdentifier:
    case T.HereDoc:
      return token.end > offset ? undefined : none;
    default:
      return isErrorKind(token.kind) ? undefined : none;
  }
}

/** Candidates that start with the prefix, each label once, sorted by tier and then by label. */
class Candidates {
  private readonly items = new Map<string, { tier: number; candidate: CompletionCandidate }>();
  private readonly lowerPrefix: string;

  constructor(readonly prefix: string) {
    this.lowerPrefix = prefix.toLowerCase();
  }

  matches(label: string): boolean {
    return label.toLowerCase().startsWith(this.lowerPrefix);
  }

  add(tier: number, candidate: CompletionCandidate): void {
    if (this.matches(candidate.label) && !this.items.has(candidate.label)) this.items.set(candidate.label, { tier, candidate });
  }

  sorted(): CompletionCandidate[] {
    return [...this.items.values()]
      .sort((a, b) => a.tier - b.tier || compare(a.candidate.label, b.candidate.label))
      .map((item) => item.candidate);
  }
}

function compare(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
}

const isLower = (text: string) => /[a-z]/.test(text) && !/[A-Z]/.test(text);
const isUpper = (text: string) => /[A-Z]/.test(text) && !/[a-z]/.test(text);

/** A case-insensitive name in capitals after a prefix in capitals, as ClickHouse spells it otherwise. */
function nameCase(name: string, caseInsensitive: boolean | undefined, prefix: string): string {
  return caseInsensitive && isUpper(prefix) ? name.toUpperCase() : name;
}

/** A database, table or column, inserted in back quotes when it is not a plain identifier. */
function named(candidate: CompletionCandidate): CompletionCandidate {
  const name = candidate.label;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return candidate;
  return { ...candidate, insertText: `\`${name.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\`` };
}

/**
 * Whether the tokens end inside a list of settings: after SETTINGS, or after the SET of a
 * SET query, followed by `name = value` pairs and a comma.
 */
function inSettingsList(sql: string, before: Token[]): boolean {
  let i = before.length - 1;
  for (;;) {
    if (isWord(sql, before[i], "settings")) return true;
    if (isWord(sql, before[i], "set")) return i === 0;
    if (before[i]?.kind !== T.Comma) return false;
    // Back over the value, which may hold brackets, to its "=", then over the name.
    let depth = 0;
    for (i--; i >= 0 && (depth > 0 || before[i]!.kind !== T.Equals); i--) {
      const kind = before[i]!.kind;
      if (kind === T.ClosingRoundBracket || kind === T.ClosingSquareBracket || kind === T.ClosingCurlyBrace) depth++;
      if (kind === T.OpeningRoundBracket || kind === T.OpeningSquareBracket || kind === T.OpeningCurlyBrace) depth--;
      if (depth < 0) return false;
    }
    i -= 2;
  }
}

/** The names before a dot at the end of the tokens, as `db` and `t` in `db.t.`. */
function qualifier(sql: string, before: Token[]): string[] {
  const names: string[] = [];
  for (let i = before.length - 1; before[i]?.kind === T.Dot; i -= 2) {
    const name = nameOf(sql, before[i - 1]);
    if (name === undefined) break;
    names.unshift(name);
  }
  return names;
}

/** The aggregate functions with combinators that the prefix starts, like sumIf and sumIfOrNull for "sumI". */
function addCombinators(out: Candidates, tier: number): void {
  const prefix = out.prefix;
  for (const aggregate of AGGREGATES) {
    const name = aggregate.name;
    if (prefix.length < name.length) continue;
    const head = prefix.slice(0, name.length);
    if (aggregate.caseInsensitive ? head.toLowerCase() !== name.toLowerCase() : head !== name) continue;
    // Whole combinators already typed, then the start of the next one.
    let applied = head;
    let rest = prefix.slice(name.length);
    for (let next = COMBINATORS.find((c) => rest.startsWith(c.name)); next; next = COMBINATORS.find((c) => rest.startsWith(c.name))) {
      applied += next.name;
      rest = rest.slice(next.name.length);
    }
    for (const combinator of COMBINATORS) {
      if (!combinator.name.toLowerCase().startsWith(rest.toLowerCase())) continue;
      out.add(tier, {
        label: applied + combinator.name,
        kind: "combinator",
        detail: `${name} with ${combinator.name}`,
        documentation: combinatorDocumentation(combinator),
      });
    }
  }
}

function addColumns(out: Candidates, tier: number, tables: SchemaTable[]): void {
  for (const table of tables)
    for (const column of table.columns) {
      const documentation = `Column of \`${table.database}.${table.name}\``;
      out.add(tier, named({ label: column.name, kind: "column", detail: column.type, documentation }));
    }
}

function addTables(out: Candidates, tier: number, tables: SchemaTable[]): void {
  for (const table of tables) out.add(tier, named({ label: table.name, kind: "table", detail: table.database }));
}

function addDatabases(out: Candidates, tier: number, schema: CompletionSchema): void {
  for (const database of databases(schema)) out.add(tier, named({ label: database, kind: "database" }));
}

/** Suggestions at `offset` of `sql`, best first, for the word that ends there. */
export function complete(sql: string, offset: number, options: CompleteOptions = {}): CompletionCandidate[] {
  const at = Math.max(0, Math.min(offset, sql.length));
  // Statements end where check() ends them, inline INSERT data included.
  const units = split(sql);
  const around = unitBefore(units, at);
  const word = wordAt(sql, around && at <= around.end ? around.tokens : [], at);
  if (!word) return [];

  const unit = statementAt(units, word.start);
  if (unit && unit.data.start >= 0 && at > unit.data.start && !endedBefore(unit, word.start)) return [];
  const statement = (unit?.tokens ?? []).filter(
    (token) => isSignificant(token.kind) && token.kind !== T.Semicolon && token.kind !== T.EndOfStream,
  );
  const before = statement.filter((token) => token.start < word.start);

  const variants = expectedAt(sql, before, word.start);
  const has = (variant: string) => variants.includes(variant);
  const schema = options.schema ?? {};
  const prefix = word.prefix;
  const out = new Candidates(prefix);
  // Keywords that the prefix starts come first; with no prefix, the names of the schema do.
  const keywordTier = prefix ? 0 : 1;
  const schemaTier = prefix ? 1 : 0;
  const nameTier = 2;

  const refs = tableRefs(sql, statement);
  const names = qualifier(sql, before);
  if (names.length) {
    // After `x.`: the columns of the table or alias x, and the tables of the database x.
    const last = names[names.length - 1]!;
    const aliased = refs.filter((ref) => ref.alias === last || (ref.name === last && names.length === 1));
    const tables = aliased.length
      ? aliased.flatMap((ref) => resolve(schema, ref))
      : resolve(schema, names.length > 1 ? { database: names[names.length - 2]!, name: last } : { name: last });
    addColumns(out, schemaTier, tables);
    if (names.length === 1) addTables(out, schemaTier, (schema.tables ?? []).filter((t) => t.database === last));
    return out.sorted();
  }

  for (const variant of variants)
    if (KEYWORD_VARIANT.test(variant))
      out.add(keywordTier, { label: isLower(prefix) ? variant.toLowerCase() : variant, kind: "keyword" });

  const previous = before[before.length - 1];
  const previousWord = previous?.kind === T.BareWord ? sql.slice(previous.start, previous.end).toLowerCase() : "";
  const identifier = has("identifier");

  // The parser of an expression operand tries CAST first, so "CAST operator" means an expression is expected.
  if (has("CAST operator")) {
    addColumns(out, schemaTier, refs.flatMap((ref) => resolve(schema, ref)));
    for (const info of FUNCTIONS) {
      if (!out.matches(info.name)) continue;
      out.add(nameTier, {
        label: nameCase(info.name, info.caseInsensitive, prefix),
        kind: "function",
        detail: info.aliasTo ? `alias of ${info.aliasTo}` : info.category,
        documentation: functionDocumentation(info),
      });
    }
    if (prefix) addCombinators(out, nameTier + 1);
  } else if (has(TABLE_VARIANT)) {
    addTables(out, schemaTier, schema.tables ?? []);
    addDatabases(out, schemaTier, schema);
    for (const info of TABLE_FUNCTIONS)
      out.add(nameTier, { label: info.name, kind: "table function", documentation: tableFunctionDocumentation(info) });
  } else if (has("insert element")) {
    addColumns(out, schemaTier, refs.flatMap((ref) => resolve(schema, ref)));
  } else if (identifier && TABLE_NAME_WORDS.has(previousWord)) {
    addTables(out, schemaTier, schema.tables ?? []);
    addDatabases(out, schemaTier, schema);
  } else if (identifier && DATABASE_WORDS.has(previousWord)) {
    addDatabases(out, schemaTier, schema);
  }

  if (has("data type")) {
    for (const type of DATA_TYPES)
      out.add(nameTier, {
        label: nameCase(type.name, type.caseInsensitive, prefix),
        kind: "data type",
        detail: type.aliasTo ? `alias of ${type.aliasTo}` : undefined,
      });
  }

  const afterEngine = previousWord === "engine" || (previous?.kind === T.Equals && isWord(sql, before[before.length - 2], "engine"));
  if (has("identifier with optional parameters") && afterEngine) {
    for (const info of TABLE_ENGINES)
      out.add(nameTier, { label: info.name, kind: "table engine", documentation: engineDocumentation(info) });
  }

  if (identifier && previousWord === "format") {
    const input = isWord(sql, before[0], "insert");
    for (const info of FORMATS)
      if (input ? info.input : info.output)
        out.add(nameTier, { label: info.name, kind: "format", detail: formatDetail(info), documentation: formatDocumentation(info) });
  }

  if (identifier && inSettingsList(sql, before)) {
    for (const info of SETTINGS)
      if (out.matches(info.name))
        out.add(nameTier, { label: info.name, kind: "setting", detail: info.type, documentation: settingDocumentation(info) });
  }

  return out.sorted();
}
