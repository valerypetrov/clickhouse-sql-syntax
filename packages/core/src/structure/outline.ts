/**
 * outline(): each statement with its kind and a short name, and its CTEs and columns as children.
 * Names come from the leading keywords and the name after them, CTEs and columns from analyze().
 */
import { split } from "../format/index.js";
import { KEYWORDS } from "../generated/keywords.js";
import { checkWithRoles, type ParseCache } from "../parser/index.js";
import { type OutlineKind, type OutlineSymbol, TokenKind as T } from "../types.js";
import { Statement } from "./statement.js";

const KEYWORD_WORDS = new Set(KEYWORDS.flatMap((keyword) => keyword.split(" ")));
const QUERY_WORDS = new Set(["SELECT", "WITH", "FROM"]);
const DEFINING_WORDS = new Set(["CREATE", "ATTACH", "REPLACE"]);
const OBJECTS: Partial<Record<string, OutlineKind>> = { TABLE: "table", VIEW: "view", DICTIONARY: "dictionary", DATABASE: "database", FUNCTION: "function" };
/** Words that start what follows the name of a statement, so its leading keywords end before them. */
const AFTER_HEAD = new Set(["WHERE", "FORMAT", "SETTINGS", "LIKE", "ILIKE", "AS", "ENGINE", "VALUES", "ON", "LIMIT", "IN"]);
/** In a statement that does not parse, a name follows these words, even one spelled as a keyword. */
const NAME_AFTER = new Set(["TABLE", "VIEW", "DICTIONARY", "DATABASE", "FUNCTION", "INTO", "USE", "FROM", "UPDATE", "DESCRIBE", "DESC", "USER", "ROLE", "INDEX"]);
/** Words after which the FROM of a query has come or will not come. */
const AFTER_FROM = new Set(["UNION", "INTERSECT", "WHERE", "PREWHERE", "GROUP", "HAVING", "WINDOW", "QUALIFY", "ORDER", "LIMIT", "OFFSET", "SETTINGS", "FORMAT", "INTO"]);
/** The statements that EXPLAIN may explain. */
const EXPLAINED = new Set(["SELECT", "WITH", "FROM", "INSERT", "CREATE", "ALTER", "DROP", "SHOW", "DESCRIBE", "DESC", "SYSTEM", "OPTIMIZE", "DELETE", "UPDATE"]);
const MAX_NAME = 80;

/** The name of a statement, its kind, and the tokens where the name is written. */
interface Label {
  name: string;
  kind: OutlineKind;
  from: number;
  to: number;
}

export function outline(sql: string, cache?: ParseCache): OutlineSymbol[] {
  const units = split(sql).filter((unit) => unit.statement);
  if (!units.length) return [];
  const { spans } = checkWithRoles(sql, cache);
  const symbols: OutlineSymbol[] = [];
  for (const unit of units) {
    const statement = new Statement(sql, unit, spans);
    // A ";" alone is no statement.
    if (statement.sig.every((token) => token.kind === T.Semicolon)) continue;
    const reader = new Reader(statement);
    const label = reader.label(0);
    symbols.push({
      name: label.name,
      kind: label.kind,
      start: unit.statement!.start,
      end: unit.statement!.end,
      nameStart: statement.sig[label.from]!.start,
      nameEnd: statement.sig[label.to - 1]!.end,
      children: reader.children(label.kind),
    });
  }
  return symbols;
}

class Reader {
  constructor(private readonly st: Statement) {}

  private keyword(i: number): boolean {
    return this.st.isKeyword(i, KEYWORD_WORDS);
  }

  /** The text of tokens `from` up to `to`, shortened. */
  private text(from: number, to: number): string {
    const sig = this.st.sig;
    const text = sig
      .slice(from, to)
      .map((token) => token.text)
      .join("")
      .replace(/\s+/g, " ");
    return text.length > MAX_NAME ? `${text.slice(0, MAX_NAME - 1)}…` : text;
  }

  /** The index after a name at `i`: words, quoted names and {parameters} joined by dots; `i` for none. */
  private nameEnd(i: number): number {
    const { sig, match } = this.st;
    const part = (j: number): number => {
      const token = sig[j];
      if (!token || token.data) return j;
      if (token.kind === T.BareWord || token.kind === T.QuotedIdentifier) return j + 1;
      if (token.kind === T.OpeningCurlyBrace && match[j]! > j) return match[j]! + 1;
      return j;
    };
    let end = part(i);
    if (end === i) return i;
    while (sig[end]?.kind === T.Dot) {
      const next = part(end + 1);
      if (next === end + 1) break;
      end = next;
    }
    return end;
  }

  /** The label of the statement that starts at token `from`. */
  label(from: number): Label {
    const st = this.st;
    let first = from;
    while (st.sig[first]?.kind === T.OpeningRoundBracket) first++;
    if (QUERY_WORDS.has(st.word(first)) && this.keyword(first)) return this.queryLabel(from);
    const words: string[] = [];
    let i = from;
    let last = from;
    let stopped = false;
    while (words.length < 8 && this.keyword(i)) {
      const word = st.word(i);
      // IF [NOT] EXISTS says nothing about the statement.
      const skip = word === "IF" ? (st.word(i + 1) === "EXISTS" ? 2 : st.word(i + 1) === "NOT" && st.word(i + 2) === "EXISTS" ? 3 : 0) : 0;
      if (skip) {
        i += skip;
        continue;
      }
      if (words.length && (AFTER_HEAD.has(word) || (words[0] === "EXPLAIN" && EXPLAINED.has(word)))) {
        stopped = true;
        break;
      }
      words.push(word);
      last = ++i;
      if (st.roles.size === 0 && NAME_AFTER.has(word)) break;
    }
    if (!words.length) return { name: this.text(from, from + 1), kind: "statement", from, to: from + 1 };
    const head = { from, to: last };
    if (words[0] === "EXPLAIN") {
      // The explained statement follows the settings of EXPLAIN, if any.
      for (let k = i; k < st.sig.length && st.depth[k]! >= st.depth[from]!; k++) {
        if (st.depth[k] !== st.depth[from]) continue;
        const query = st.sig[k]!.kind === T.OpeningRoundBracket && QUERY_WORDS.has(st.word(k + 1));
        if (query || (this.keyword(k) && EXPLAINED.has(st.word(k)))) {
          return { name: `${words.join(" ")} ${this.label(k).name}`, kind: "statement", ...head };
        }
      }
    }
    const kind = (DEFINING_WORDS.has(words[0]!) && words.map((word) => OBJECTS[word]).find(Boolean)) || "statement";
    const end = stopped ? i : this.nameEnd(i);
    if (end > i) return { name: `${words.join(" ")} ${this.text(i, end)}`, kind, from: i, to: end };
    return { name: words.join(" "), kind, ...head };
  }

  /** "SELECT … FROM t" for a query, after the first table of its first FROM, or "SELECT …". */
  private queryLabel(from: number): Label {
    const { sig, depth } = this.st;
    let i = from;
    while (sig[i]?.kind === T.OpeningRoundBracket) i++;
    const level = depth[i]!;
    let select = -1;
    let table = "";
    for (let k = i; k < sig.length && depth[k]! >= level; k++) {
      if (depth[k] !== level || !this.keyword(k)) continue;
      const word = this.st.word(k);
      if (word === "SELECT" && select < 0) select = k;
      else if (word === "FROM" && this.st.word(k - 1) !== "DISTINCT" && this.st.word(k - 1) !== "FILL") {
        table = this.tableAt(k + 1);
        break;
      } else if (select >= 0 && AFTER_FROM.has(word)) break;
    }
    const at = select >= 0 ? select : i;
    return { name: table ? `SELECT … FROM ${table}` : "SELECT …", kind: "query", from: at, to: at + 1 };
  }

  /** How the table at `i` reads: its name, f(…) for a table function, (…) for a subquery. */
  private tableAt(i: number): string {
    const sig = this.st.sig;
    if (sig[i]?.kind === T.OpeningRoundBracket) return "(…)";
    const end = this.nameEnd(i);
    if (end === i) return "";
    return sig[end]?.kind === T.OpeningRoundBracket ? `${this.text(i, end)}(…)` : this.text(i, end);
  }

  /** The CTEs of the statement at any depth, and the columns of what CREATE TABLE, VIEW or DICTIONARY makes. */
  children(kind: OutlineKind): OutlineSymbol[] {
    const st = this.st;
    const columns = kind === "table" || kind === "view" || kind === "dictionary";
    if (!columns && !st.sig.some((token, i) => token.kind === T.BareWord && st.word(i) === "WITH")) return [];
    const clauses: [number, number][] = [];
    const found: OutlineSymbol[] = [];
    const ran = st.analyze((region, start, end, name) => {
      if (region === "clause" && name === "WITH") clauses.push([start, end]);
      // The columns are in the brackets after the name, so one bracket deep.
      else if (region === "column" && columns && st.depth[start] === 1 && isName(st.sig[start]!.kind)) found.push(this.symbol(start, start + 1, end, "column"));
    });
    if (!ran) return [];
    for (const [start, end] of clauses) this.ctes(start, end, found);
    return nest(found);
  }

  /** The CTEs among the elements of a WITH clause: name [(aliases)] AS [MATERIALIZED] (query). */
  private ctes(clause: number, end: number, found: OutlineSymbol[]): void {
    const { sig, match } = this.st;
    let element = clause + 1;
    if (this.st.word(element) === "RECURSIVE") element++;
    for (let k = element; k <= end; k++) {
      if (k < end && sig[k]!.kind !== T.Comma) {
        if (match[k]! > k) k = Math.min(match[k]!, end - 1);
        continue;
      }
      let j = element + 1;
      if (sig[j]?.kind === T.OpeningRoundBracket && match[j]! > j) j = match[j]! + 1;
      if (this.st.word(j) === "AS") j++;
      else j = -1;
      if (j > 0 && this.st.word(j) === "MATERIALIZED") j++;
      if (k > element && isName(sig[element]!.kind) && j > 0 && sig[j]?.kind === T.OpeningRoundBracket && match[j] === k - 1) {
        found.push(this.symbol(element, element + 1, k, "cte"));
      }
      element = k + 1;
    }
  }

  /** A child symbol of tokens `from` up to `to`, named by tokens `from` up to `nameTo`. */
  private symbol(from: number, nameTo: number, to: number, kind: OutlineKind): OutlineSymbol {
    const sig = this.st.sig;
    return { name: this.text(from, nameTo), kind, start: sig[from]!.start, end: sig[to - 1]!.end, nameStart: sig[from]!.start, nameEnd: sig[nameTo - 1]!.end, children: [] };
  }
}

function isName(kind: T): boolean {
  return kind === T.BareWord || kind === T.QuotedIdentifier;
}

/** The symbols as a tree: each one goes under the last one that holds it. */
function nest(symbols: OutlineSymbol[]): OutlineSymbol[] {
  symbols.sort((a, b) => a.start - b.start || b.end - a.end);
  const top: OutlineSymbol[] = [];
  const open: OutlineSymbol[] = [];
  let previous: OutlineSymbol | undefined;
  for (const symbol of symbols) {
    if (previous && previous.start === symbol.start && previous.end === symbol.end) continue;
    previous = symbol;
    while (open.length && open[open.length - 1]!.end <= symbol.start) open.pop();
    (open.length ? open[open.length - 1]!.children : top).push(symbol);
    open.push(symbol);
  }
  return top;
}
