/**
 * A shallow parser for one valid statement. It finds the words used as keywords and marks where
 * lines break; anything it does not recognise keeps its case and stays on the current line.
 */
import { TokenKind as T } from "../types.js";
import {
  AFTER_NAME,
  ALTER_COMMANDS,
  COLUMN_WORDS,
  CREATE_CLAUSES,
  DICTIONARY_CALLS,
  ENDING_WORDS,
  EXPLAIN_KINDS,
  INTERVAL_UNITS,
  JOIN_WORDS,
  KEYWORD_WORDS,
  KEYWORDS_BEFORE_EQUALS,
  NAME_WORDS,
  OBJECT_WORDS,
  PAREN_AFTER,
  RESTRICTED_ALIASES,
  SET_OPERATIONS,
  STATEMENT_WORDS,
  SYSTEM_COMMANDS,
  TAIL_PAREN_KEYWORDS,
  TYPE_WORDS,
  UNIT_FUNCTIONS,
  phrasesOf,
} from "./words.js";

/** A significant token of the statement. `up` is the upper-case text of a bare word that is not a name, otherwise "". */
export interface Tok {
  kind: T;
  text: string;
  up: string;
  /** The parser reads the word as a keyword. */
  keyword?: boolean;
  start: number;
  end: number;
  /** Inline INSERT data with the whitespace before it, printed as written. */
  data?: boolean;
}

/** No space after this token: a unary minus, @@. */
export const GLUE_AFTER = 1;
/** No space before this token: the "(" of a call, the "[" of a subscript. */
export const GLUE_BEFORE = 2;
/** The ":" of a map literal. */
export const MAP_COLON = 4;

/** A "(" that opens an indented block on its line, or one on a line of its own. */
export const BLOCK_INLINE = 1;
export const BLOCK_OWN_LINE = 2;

/** What the analysis found out about each significant token. */
export interface Shape {
  /** 1 for a word used as a keyword. */
  keyword: Uint8Array;
  /** A new line before the token, at this indent from the enclosing block; -1 for none. */
  brk: Int8Array;
  /** BLOCK_* for a "(" whose contents go on their own lines. */
  block: Uint8Array;
  /** GLUE_* and MAP_COLON flags. */
  glue: Uint8Array;
  /** For the "{" of a query parameter, the index of its "}"; the whole parameter is printed as written. */
  verbatim: Int32Array;
  /** For every bracket, the index of the matching one; -1 if unmatched. */
  match: Int32Array;
}

/** How an expression is read. */
interface Ctx {
  /** Stop at the clauses of a SELECT query. */
  query?: boolean;
  /** An alias without AS may follow an operand. */
  alias?: boolean;
  /** ORDER BY element modifiers: ASC, DESC, NULLS FIRST, COLLATE, WITH FILL. */
  order?: boolean;
  /** Stop at these words after an operand. */
  stop?: ReadonlySet<string>;
  /** Stop at any keyword after an operand, as in the tail of a DDL statement. */
  stopAtKeyword?: boolean;
  /** Function arguments: FROM and FOR may follow an operand. */
  args?: boolean;
  /** The keyword a trailing comma may come before: FROM after a SELECT list, SELECT after WITH. */
  trailing?: "FROM" | "SELECT";
}

const OPENERS = new Set([T.OpeningRoundBracket, T.OpeningSquareBracket, T.OpeningCurlyBrace]);
const CLOSERS = new Set([T.ClosingRoundBracket, T.ClosingSquareBracket, T.ClosingCurlyBrace]);

/** Tokens that end an expression. */
const ENDERS = new Set([...CLOSERS, T.Comma, T.Semicolon, T.EndOfStream, T.VerticalDelimiter]);

/** Binary operators: an operand follows. */
const BINARY = new Set([
  T.Plus,
  T.Minus,
  T.Asterisk,
  T.Slash,
  T.Percent,
  T.Arrow,
  T.QuestionMark,
  T.Colon,
  T.Caret,
  T.Equals,
  T.NotEquals,
  T.Less,
  T.Greater,
  T.LessOrEquals,
  T.GreaterOrEquals,
  T.Spaceship,
  T.PipeMark,
  T.PipeOperator,
  T.Concatenation,
  T.Tilde,
  T.TildeAsterisk,
  T.NotTilde,
  T.NotTildeAsterisk,
  T.At,
  T.DoubleAt,
]);

const COMPARISONS = new Set([T.Equals, T.NotEquals, T.Less, T.Greater, T.LessOrEquals, T.GreaterOrEquals, T.Spaceship]);

/** What a part of a statement that analyze() read as one piece is. */
export type RegionKind = "clause" | "column";

/** Takes the parts that analyze() reads: tokens from `start` up to `end`, and a clause's keyword as `name`. */
export type RegionRecorder = (kind: RegionKind, start: number, end: number, name?: string) => void;

export function analyze(sig: Tok[], record?: RegionRecorder): Shape {
  return new Analyzer(sig, record).run();
}

class Analyzer {
  private readonly n: number;
  private readonly shape: Shape;

  constructor(
    private readonly sig: Tok[],
    private readonly record?: RegionRecorder,
  ) {
    this.n = sig.length;
    this.shape = {
      keyword: new Uint8Array(this.n),
      brk: new Int8Array(this.n).fill(-1),
      block: new Uint8Array(this.n),
      glue: new Uint8Array(this.n),
      verbatim: new Int32Array(this.n).fill(-1),
      match: new Int32Array(this.n).fill(-1),
    };
    const stack: number[] = [];
    for (let i = 0; i < this.n; i++) {
      const kind = sig[i]!.kind;
      if (OPENERS.has(kind)) stack.push(i);
      else if (CLOSERS.has(kind) && stack.length) {
        const open = stack.pop()!;
        this.shape.match[open] = i;
        this.shape.match[i] = open;
      }
    }
  }

  run(): Shape {
    let i = 0;
    while (i < this.n) {
      const next = this.statement(i, this.end(i));
      i = next > i ? next : i + 1;
    }
    // ClickHouse reads the type of a query parameter from its text, so every one stays as written.
    for (let j = 0; j < this.n; j++) if (this.parameterAt(j)) this.shape.verbatim[j] = this.shape.match[j]!;
    return this.shape;
  }

  /** Whether "{" at `i` opens a query parameter {name:Type}. */
  private parameterAt(i: number): boolean {
    return this.is(i, T.OpeningCurlyBrace) && this.shape.match[i]! >= 0 && (this.is(i + 1, T.BareWord) || this.is(i + 1, T.QuotedIdentifier)) && this.is(i + 2, T.Colon);
  }

  // ---- Token helpers ----

  private kind(i: number): T | undefined {
    return this.sig[i]?.kind;
  }

  /** The upper-case text of a bare word, or "". */
  private word(i: number): string {
    return this.sig[i]?.up ?? "";
  }

  private is(i: number, kind: T): boolean {
    return this.sig[i]?.kind === kind;
  }

  /** Whether word `i` is a part of a dotted name such as db.table. */
  private dotted(i: number): boolean {
    return this.is(i - 1, T.Dot) || this.is(i + 1, T.Dot);
  }

  /** The end of the statement: its ";" or the end of the tokens. */
  private end(i: number): number {
    while (i < this.n && !this.is(i, T.Semicolon)) i++;
    return i;
  }

  /** Passes the part from `start` up to `end` to the recorder, if any, and returns `end`. */
  private note(kind: RegionKind, start: number, end: number, name?: string): number {
    if (this.record && end > start) this.record(kind, start, end, name);
    return end;
  }

  /** The index after the bracket group that starts at `i`. */
  private after(i: number): number {
    const close = this.shape.match[i]!;
    return close >= 0 ? close + 1 : this.n;
  }

  /** Marks `count` words from `i` as keywords and returns the index after them. */
  private kw(i: number, count = 1): number {
    for (let j = i; j < i + count; j++) {
      if (this.sig[j]?.keyword && KEYWORD_WORDS.has(this.word(j))) this.shape.keyword[j] = 1;
    }
    return i + count;
  }

  /** The number of words of the longest keyword phrase at `i`, or 0. */
  private phrase(i: number): number {
    const first = this.word(i);
    if (!first || this.dotted(i)) return 0;
    for (const words of phrasesOf(first)) {
      if (this.phraseMatches(i, words)) return words.length;
    }
    return 0;
  }

  private phraseMatches(i: number, words: readonly string[]): boolean {
    for (let k = 0; k < words.length; k++) {
      const j = i + k;
      if (this.word(j) !== words[k] || this.dotted(j)) return false;
      // DEFAULT database() is no DEFAULT DATABASE, and TO Disk(...) no TO DISK.
      if (this.is(j + 1, T.OpeningRoundBracket) && (k < words.length - 1 || (k > 0 && !PAREN_AFTER.has(words[k]!)))) return false;
    }
    return true;
  }

  /** Whether the words from `i` are exactly `words`, none of them a dotted name. */
  private words(i: number, ...words: string[]): boolean {
    return words.every((w, k) => this.word(i + k) === w && !this.dotted(i + k));
  }

  /** Whether the token at `i` can start an operand. */
  private startsOperand(i: number): boolean {
    const kind = this.kind(i);
    if (kind === undefined || ENDERS.has(kind)) return false;
    if (kind === T.BareWord) return !RESTRICTED_ALIASES.has(this.word(i)) || this.word(i) === "NOT";
    return !BINARY.has(kind) || kind === T.Minus || kind === T.Plus || kind === T.Asterisk || kind === T.QuestionMark;
  }

  // ---- Statements ----

  private statement(i: number, end: number): number {
    const first = this.word(i);
    if (this.is(i, T.OpeningRoundBracket) || first === "SELECT" || first === "WITH" || first === "FROM") {
      return this.query(i, end);
    }
    switch (first) {
      case "EXPLAIN":
        return this.explain(i, end);
      case "INSERT":
        return this.insert(i, end);
      case "CREATE":
      case "ATTACH":
      case "REPLACE":
        return this.create(i, end);
      case "ALTER":
        return this.alter(i, end);
      case "GRANT":
      case "REVOKE":
        return this.grant(i, end);
      default:
        return this.generic(i, end);
    }
  }

  /** Whether EXPLAIN at `i` starts a statement rather than naming the column of EXPLAIN output. */
  private explainAt(i: number): boolean {
    if (this.word(i) !== "EXPLAIN" || this.dotted(i)) return false;
    const next = this.word(i + 1);
    if (EXPLAIN_KINDS.has(next) || STATEMENT_WORDS.has(next)) return true;
    if (this.is(i + 1, T.BareWord) && this.is(i + 2, T.Equals)) return true;
    return this.is(i + 1, T.OpeningRoundBracket) && this.startsQuery(i + 1);
  }

  /** EXPLAIN [kind] [setting = value, ...] statement */
  private explain(i: number, end: number): number {
    i = this.kw(i);
    const kind = this.phrase(i);
    if (kind > 0 && EXPLAIN_KINDS.has(this.word(i))) {
      i = this.kw(i, kind);
    }
    // Settings of EXPLAIN: name = value, ...
    while (this.is(i, T.BareWord) && this.is(i + 1, T.Equals)) {
      i = this.expr(i + 2, end, {});
      if (this.is(i, T.Comma)) i++;
    }
    if (i < end) this.shape.brk[i] = 0;
    return this.statement(i, end);
  }

  /** INSERT INTO [TABLE] name | FUNCTION f(...) [(columns)] [SETTINGS ...] VALUES | FORMAT name | SELECT ... */
  private insert(i: number, end: number): number {
    i = this.kw(i, this.phrase(i) || 1);
    if (this.word(i) === "TABLE") i = this.kw(i);
    if (this.word(i) === "FUNCTION" && this.is(i + 2, T.OpeningRoundBracket)) {
      i = this.kw(i);
      i = this.call(i);
      if (this.words(i, "PARTITION", "BY")) i = this.expr(this.kw(i, 2), end, { stop: new Set(["SETTINGS", "VALUES", "FORMAT", "SELECT", "WITH"]) });
    } else {
      i = this.name(i);
    }
    while (i < end) {
      const w = this.word(i);
      if (this.is(i, T.OpeningRoundBracket)) {
        if (this.startsQuery(i)) {
          this.shape.brk[i] = 0;
          return this.query(i, end);
        }
        i = this.group(i, "paren");
      } else if (w === "SELECT" || w === "WITH") {
        this.shape.brk[i] = 0;
        return this.query(i, end);
      } else if (w === "SETTINGS") {
        i = this.settings(this.kw(i), end);
      } else if (w === "VALUES") {
        // Script splitters read FORMAT Values by its exact spelling, so INSERT INTO table FORMAT Values keeps it.
        i = this.sig[i - 1]!.text.toUpperCase() === "FORMAT" && this.sig[i]!.text === "Values" ? i + 1 : this.kw(i);
        return this.sig[i]?.data ? i + 1 : i;
      } else if (w === "FORMAT") {
        i = this.name(this.kw(i));
        return this.sig[i]?.data ? i + 1 : i;
      } else if (w === "FROM" && this.word(i + 1) === "INFILE") {
        i = this.kw(i, 2);
      } else if (w === "COMPRESSION" || w === "RETURNING") {
        i = this.kw(i);
      } else {
        i++;
      }
    }
    return i;
  }

  // ---- Queries ----

  /** Whether the group opened at `i` holds a query. */
  private startsQuery(i: number, args = false): boolean {
    const first = this.word(i + 1);
    if (first === "SELECT" || first === "WITH" || this.explainAt(i + 1)) return true;
    // FROM t SELECT ..., but not (from IN (1, 2)) with a column named from.
    if (first === "FROM" && !args) return this.findWord(i + 2, this.shape.match[i]!, "SELECT") > 0 && this.nameAt(i + 2);
    if (this.is(i + 1, T.OpeningRoundBracket) && this.startsQuery(i + 1)) {
      const next = this.after(i + 1);
      const close = this.shape.match[i];
      return next === close || SET_OPERATIONS.has(this.word(next));
    }
    return false;
  }

  /** The clause keyword at `i` in a query: its name and number of words. */
  private clauseAt(i: number, start: boolean): [string, number] | null {
    const w = this.word(i);
    if (!w || this.dotted(i)) return null;
    switch (w) {
      case "SELECT":
      case "FROM":
      case "PREWHERE":
      case "WHERE":
      case "HAVING":
      case "QUALIFY":
      case "WINDOW":
      case "LIMIT":
      case "OFFSET":
      case "SETTINGS":
      case "FORMAT":
      case "INTERPOLATE":
        return [w, 1];
      case "WITH":
        if (start) return ["WITH", 1];
        if (["TOTALS", "ROLLUP", "CUBE"].includes(this.word(i + 1))) return ["MODIFIER", 2];
        return null;
      case "GROUP":
      case "ORDER":
        return this.word(i + 1) === "BY" ? [`${w} BY`, 2] : null;
      case "INTO":
        return this.word(i + 1) === "OUTFILE" ? ["INTO OUTFILE", 2] : null;
      case "PARALLEL":
        return this.word(i + 1) === "WITH" ? ["PARALLEL WITH", 2] : null;
      case "UNION":
      case "EXCEPT":
      case "INTERSECT": {
        const next = this.word(i + 1);
        if (next === "ALL" || next === "DISTINCT") return ["SET", 2];
        if (w === "EXCEPT" && !this.setOperand(i + 1)) return null;
        return ["SET", 1];
      }
    }
    if (JOIN_WORDS.has(w)) {
      let j = i;
      while (j < i + 6 && JOIN_WORDS.has(this.word(j)) && !this.dotted(j)) j++;
      if (this.word(j) === "JOIN" && !this.dotted(j)) return ["JOIN", j - i + 1];
    }
    if (w === "JOIN") return ["JOIN", 1];
    return null;
  }

  /** Whether a query starts at `i`: SELECT, WITH or a bracketed query. */
  private setOperand(i: number): boolean {
    const w = this.word(i);
    return w === "SELECT" || w === "WITH" || (this.is(i, T.OpeningRoundBracket) && this.startsQuery(i));
  }

  /** A query from `i` to `end`: clauses, each on its own line. */
  private query(i: number, end: number): number {
    // `start` is true where a query begins; `first` only for the very first token.
    let start = true;
    let first = true;
    while (i < end) {
      if (!first) this.shape.brk[i] = 0;
      first = false;
      if (this.is(i, T.OpeningRoundBracket)) {
        start = false;
        i = this.group(i, "paren");
        continue;
      }
      if (this.explainAt(i)) return this.explain(i, end);
      const clause = this.clauseAt(i, start);
      if (!clause) {
        // Not a clause: read it as an expression and go on.
        this.shape.brk[i] = -1;
        const next = this.expr(i, end, { query: true, alias: true });
        i = next > i ? next : i + 1;
        start = false;
        continue;
      }
      const [name, count] = clause;
      start = name === "SET" || name === "PARALLEL WITH";
      i = this.clause(name, count, i, end);
    }
    return i;
  }

  private clause(name: string, count: number, i: number, end: number): number {
    return this.note("clause", i, this.clauseBody(name, count, i, end), name);
  }

  private clauseBody(name: string, count: number, i: number, end: number): number {
    let j = this.kw(i, count);
    const q: Ctx = { query: true };
    switch (name) {
      case "WITH":
        if (this.word(j) === "RECURSIVE") j = this.kw(j);
        return this.list(j, end, { query: true, alias: true, trailing: "SELECT" }, true);
      case "SELECT": {
        if (this.word(j) === "DISTINCT") {
          j = this.kw(j);
          if (this.word(j) === "ON" && this.is(j + 1, T.OpeningRoundBracket)) j = this.group(this.kw(j), "paren");
        } else if (this.word(j) === "ALL" && this.startsOperand(j + 1)) {
          j = this.kw(j);
        }
        if (this.word(j) === "TOP" && !this.dotted(j) && (this.is(j + 1, T.Number) || this.is(j + 1, T.OpeningRoundBracket))) {
          j = this.kw(j);
          j = this.is(j, T.OpeningRoundBracket) ? this.group(j, "paren") : j + 1;
          if (this.words(j, "WITH", "TIES")) j = this.kw(j, 2);
        }
        return this.list(j, end, { query: true, alias: true, trailing: "FROM" }, true);
      }
      case "FROM":
        return this.tables(j, end);
      case "JOIN": {
        j = this.table(j, end);
        if (this.word(j) === "ON" && !this.dotted(j)) return this.expr(this.kw(j), end, q);
        if (this.word(j) === "USING" && !this.dotted(j)) {
          j = this.kw(j);
          if (this.is(j, T.OpeningRoundBracket)) return this.group(j, "paren");
          return this.list(j, end, q);
        }
        return j;
      }
      case "PREWHERE":
      case "WHERE":
      case "HAVING":
      case "QUALIFY":
        return this.expr(j, end, q);
      case "GROUP BY": {
        if (this.allAt(j)) return this.kw(j);
        return this.list(j, end, { query: true }, true);
      }
      case "MODIFIER":
        return j;
      case "WINDOW":
        // name AS (window), ...
        for (;;) {
          j = this.name(j);
          if (this.word(j) === "AS" && this.is(j + 1, T.OpeningRoundBracket)) j = this.group(this.kw(j), "window");
          if (!this.is(j, T.Comma)) return j;
          j++;
        }
      case "ORDER BY": {
        if (!this.allAt(j)) return this.list(j, end, { query: true, order: true }, true);
        j = this.kw(j);
        for (;;) {
          if (["ASC", "DESC", "ASCENDING", "DESCENDING"].includes(this.word(j))) j = this.kw(j);
          else if (this.word(j) === "NULLS" && ["FIRST", "LAST"].includes(this.word(j + 1))) j = this.kw(j, 2);
          else if (this.word(j) === "COLLATE" && this.is(j + 1, T.StringLiteral)) j = this.kw(j) + 1;
          else return j;
        }
      }
      case "INTERPOLATE":
        return this.is(j, T.OpeningRoundBracket) ? this.group(j, "paren") : j;
      case "LIMIT": {
        j = this.expr(j, end, q);
        if (this.is(j, T.Comma)) j = this.expr(j + 1, end, q);
        if (this.word(j) === "OFFSET") j = this.expr(this.kw(j), end, q);
        // LIMIT n AFTER condition UNTIL condition
        if (this.word(j) === "AFTER" && !this.dotted(j)) j = this.expr(this.kw(j), end, { query: true, stop: new Set(["UNTIL"]) });
        if (this.word(j) === "UNTIL" && !this.dotted(j)) j = this.expr(this.kw(j), end, q);
        if (this.word(j) === "BY" && !this.dotted(j)) j = this.list(this.kw(j), end, q);
        if (this.words(j, "WITH", "TIES")) j = this.kw(j, 2);
        return j;
      }
      case "OFFSET": {
        j = this.expr(j, end, { query: true, stop: new Set(["ROW", "ROWS"]) });
        if (this.word(j) === "ROW" || this.word(j) === "ROWS") j = this.kw(j);
        if (this.word(j) === "FETCH" && (this.word(j + 1) === "FIRST" || this.word(j + 1) === "NEXT")) {
          j = this.expr(this.kw(j, 2), end, { query: true, stop: new Set(["ROW", "ROWS"]) });
          if (this.word(j) === "ROW" || this.word(j) === "ROWS") j = this.kw(j);
          if (this.word(j) === "ONLY") j = this.kw(j);
          else if (this.words(j, "WITH", "TIES")) j = this.kw(j, 2);
        }
        return j;
      }
      case "SETTINGS":
        return this.settings(j, end);
      case "FORMAT":
        return this.name(j);
      case "INTO OUTFILE": {
        if (this.is(j, T.StringLiteral)) j++;
        for (;;) {
          if (this.words(j, "AND", "STDOUT")) j = this.kw(j, 2);
          else if (this.word(j) === "APPEND" || this.word(j) === "TRUNCATE") j = this.kw(j);
          else if (this.word(j) === "COMPRESSION" && this.is(j + 1, T.StringLiteral)) j = this.kw(j) + 1;
          else if (this.word(j) === "LEVEL" && this.is(j + 1, T.Number)) j = this.kw(j) + 1;
          else return j;
        }
      }
      default:
        return j;
    }
  }

  /** Whether ALL at `i` is GROUP BY ALL or ORDER BY ALL rather than a column called all. */
  private allAt(i: number): boolean {
    if (this.word(i) !== "ALL" || this.dotted(i)) return false;
    const k = this.kind(i + 1);
    if (k === T.Comma || k === T.OpeningRoundBracket || k === T.OpeningSquareBracket || k === T.DoubleColon) return false;
    return !(k !== undefined && BINARY.has(k)) && this.operator(i + 1) === 0;
  }

  /** The tables of FROM, separated by commas. */
  private tables(i: number, end: number): number {
    for (;;) {
      i = this.table(i, end);
      if (!this.is(i, T.Comma)) return i;
      i++;
    }
  }

  /** One table: a name, a table function or a subquery, with FINAL, SAMPLE and an alias. */
  private table(i: number, end: number): number {
    if (this.is(i, T.OpeningRoundBracket)) i = this.group(i, "paren");
    else if ((this.is(i, T.BareWord) || this.is(i, T.QuotedIdentifier)) && this.is(i + 1, T.OpeningRoundBracket)) i = this.call(i);
    else i = this.name(i);
    for (;;) {
      const w = this.word(i);
      if (this.dotted(i)) return i;
      if (w === "FINAL") {
        i = this.kw(i);
      } else if (w === "SAMPLE") {
        i = this.expr(this.kw(i), end, { query: true });
        if (this.word(i) === "OFFSET") i = this.expr(this.kw(i), end, { query: true });
      } else if (w === "AS") {
        i = this.name(this.kw(i));
      } else if (this.is(i, T.QuotedIdentifier) || (this.is(i, T.BareWord) && !RESTRICTED_ALIASES.has(w) && (w !== "SELECT" || this.word(i + 1) === "ON" || this.word(i + 1) === "USING"))) {
        // An alias without AS.
        i++;
      } else {
        return i;
      }
    }
  }

  /** SETTINGS name = value, ... */
  private settings(i: number, end: number): number {
    return this.list(i, end, { query: true });
  }

  /** A name: word, quoted identifier or query parameter, with dotted parts. */
  private name(i: number): number {
    if (this.is(i, T.OpeningCurlyBrace)) i = this.brace(i);
    else if (this.is(i, T.BareWord) || this.is(i, T.QuotedIdentifier) || this.is(i, T.StringLiteral)) i++;
    else return i;
    while (this.is(i, T.Dot)) {
      if (this.is(i + 1, T.OpeningCurlyBrace)) i = this.brace(i + 1);
      else i += 2;
    }
    return i;
  }

  /** Names separated by commas, as in DROP TABLE a, b. */
  private names(i: number): number {
    i = this.name(i);
    while (this.is(i, T.Comma) && this.nameAt(i + 1) && !ALTER_COMMANDS.has(this.word(i + 1))) i = this.name(i + 1);
    return i;
  }

  /** A call: name(arguments), with more bracket groups as in quantile(0.5)(x). */
  private call(i: number): number {
    i++;
    while (this.is(i, T.OpeningRoundBracket)) {
      this.shape.glue[i] |= GLUE_BEFORE;
      i = this.group(i, "args");
    }
    return i;
  }

  // ---- Lists and expressions ----

  /** Comma-separated expressions; with `split`, each on its own line when there are several. */
  private list(i: number, end: number, c: Ctx, split = false): number {
    const items: number[] = [];
    for (;;) {
      const next = this.expr(i, end, c);
      if (next > i) items.push(i);
      i = next;
      if (!this.is(i, T.Comma) || i >= end) break;
      i++;
      if (c.trailing && this.trailingComma(i, c.trailing)) break;
    }
    if (split && items.length > 1) for (const item of items) this.shape.brk[item] = 1;
    return i;
  }

  /** Whether the comma before `i` ends the list, as in SELECT a, b, FROM t; the rule of ExpressionLayer::parse. */
  private trailingComma(i: number, before: string): boolean {
    if (this.word(i) !== before || this.dotted(i)) return false;
    if (before === "SELECT") return true;
    const next = i + 1;
    const k = this.kind(next);
    if (k === T.Comma || k === T.OpeningSquareBracket || k === T.DoubleColon || (k !== undefined && BINARY.has(k))) return false;
    return this.word(next) !== "FROM" && this.word(next) !== "AS" && this.operator(next) === 0;
  }

  /** One expression from `i`; returns the index of the token that ends it. */
  private expr(i: number, end: number, c: Ctx): number {
    let operand = true;
    let cases = 0;
    let between = 0;
    let fill = false;
    // INTERVAL is waiting for its operand (1) or for its unit (2).
    let interval = 0;
    let like = false;
    let afterCall = false;
    let afterStar = false;
    while (i < end) {
      const t = this.sig[i]!;
      const k = t.kind;
      if (ENDERS.has(k)) break;
      if (operand) {
        const before = i;
        const wasInterval = interval === 1;
        let prefix = false;
        afterCall = false;
        afterStar = false;
        if (k === T.OpeningRoundBracket) {
          i = this.group(i, "paren");
        } else if (k === T.OpeningSquareBracket) {
          i = this.group(i, "paren");
        } else if (k === T.OpeningCurlyBrace) {
          i = this.brace(i);
        } else if (k === T.Minus || k === T.Plus) {
          this.shape.glue[i] |= GLUE_AFTER;
          i++;
          prefix = true;
        } else if (k === T.Asterisk) {
          i++;
          afterStar = true;
        } else if (k === T.BareWord) {
          const w = t.up;
          if (this.is(i + 1, T.Dot)) {
            i = this.dottedName(i);
            afterStar = this.is(i - 1, T.Asterisk);
          } else if (this.is(i + 1, T.OpeningRoundBracket)) {
            if (w === "NOT") {
              i = this.kw(i);
              prefix = true;
            } else if ((w === "ANY" || w === "ALL" || w === "SOME") && COMPARISONS.has(this.kind(i - 1)!) && this.startsQuery(i + 1)) {
              // x = ANY (SELECT ...)
              i = this.kw(i);
              prefix = true;
            } else if (w === "COLUMNS") {
              // The COLUMNS matcher is a keyword, not a function.
              i = this.call(this.kw(i) - 1);
              afterStar = true;
            } else {
              i = this.call(i);
              afterCall = true;
            }
          } else if (this.words(i, "GROUPING", "SETS") && this.is(i + 2, T.OpeningRoundBracket)) {
            i = this.kw(i, 2);
            prefix = true;
          } else if (w === "NOT") {
            i = this.kw(i);
            prefix = true;
          } else if (w === "CASE" && this.caseAt(i, end)) {
            i = this.kw(i);
            if (this.word(i) === "WHEN") i = this.kw(i);
            cases++;
            prefix = true;
          } else if (w === "INTERVAL" && this.intervalAt(i)) {
            i = this.kw(i);
            interval = 1;
            prefix = true;
          } else if ((w === "DATE" || w === "TIMESTAMP") && this.is(i + 1, T.StringLiteral)) {
            i = this.kw(i) + 1;
          } else if (w === "NULL" || w === "TRUE" || w === "FALSE") {
            i = this.kw(i);
          } else if (w === "DEFAULT" && this.is(i - 1, T.Equals) && (i + 1 >= end || ENDERS.has(this.kind(i + 1)!))) {
            // SET x = DEFAULT
            i = this.kw(i);
          } else if ((w === "DISTINCT" || w === "ALL") && this.is(i - 1, T.OpeningRoundBracket) && this.startsOperand(i + 1)) {
            i = this.kw(i);
            prefix = true;
          } else {
            i++;
          }
        } else if (k === T.QuotedIdentifier && this.is(i + 1, T.OpeningRoundBracket)) {
          i = this.call(i);
          afterCall = true;
        } else if (k === T.QuotedIdentifier && this.is(i + 1, T.Dot)) {
          i = this.dottedName(i);
        } else {
          i++;
          prefix = BINARY.has(k);
        }
        if (prefix) continue;
        operand = false;
        if (wasInterval && i > before) interval = 2;
        continue;
      }

      // After an operand.
      if (k === T.Dot) {
        i = this.member(i);
        continue;
      }
      if (k === T.DoubleColon) {
        this.castSource(i);
        i = this.type(i + 1, end);
        continue;
      }
      if (k === T.OpeningSquareBracket) {
        this.shape.glue[i] |= GLUE_BEFORE;
        i = this.group(i, "paren");
        continue;
      }
      if (k === T.OpeningRoundBracket) {
        // More arguments of a parametric call, or the arguments of a lambda.
        if (afterCall) this.shape.glue[i] |= GLUE_BEFORE;
        i = this.group(i, "args");
        continue;
      }
      if (BINARY.has(k)) {
        i++;
        operand = true;
        interval = 0;
        continue;
      }
      if (k !== T.BareWord) {
        // A quoted alias, a string after COLLATE or ESCAPE.
        i++;
        continue;
      }

      const w = t.up;
      const unit = interval === 2;
      interval = 0;
      if (this.dotted(i)) {
        i = this.dottedName(i);
        continue;
      }
      if (cases > 0 && (w === "WHEN" || w === "THEN" || w === "ELSE")) {
        i = this.kw(i);
        operand = true;
        continue;
      }
      if (cases > 0 && w === "END") {
        i = this.kw(i);
        cases--;
        continue;
      }
      if (between > 0 && w === "AND") {
        i = this.kw(i);
        between--;
        operand = true;
        continue;
      }
      if (unit && INTERVAL_UNITS.has(w)) {
        i = this.kw(i);
        continue;
      }
      if (c.order) {
        if (["ASC", "DESC", "ASCENDING", "DESCENDING"].includes(w)) {
          i = this.kw(i);
          continue;
        }
        if (w === "NULLS" && (this.word(i + 1) === "FIRST" || this.word(i + 1) === "LAST")) {
          i = this.kw(i, 2);
          continue;
        }
        if (w === "COLLATE" && this.is(i + 1, T.StringLiteral)) {
          i = this.kw(i) + 1;
          continue;
        }
        if (this.words(i, "WITH", "FILL")) {
          i = this.kw(i, 2);
          fill = true;
          continue;
        }
        if (fill && ["FROM", "TO", "STEP", "STALENESS"].includes(w)) {
          i = this.kw(i);
          operand = true;
          continue;
        }
      }
      if (like && w === "ESCAPE" && this.is(i + 1, T.StringLiteral)) {
        i = this.kw(i) + 1;
        like = false;
        continue;
      }
      like = false;
      if (afterCall) {
        afterCall = false;
        if (w === "OVER" && (this.is(i + 1, T.OpeningRoundBracket) || this.is(i + 1, T.BareWord) || this.is(i + 1, T.QuotedIdentifier))) {
          i = this.kw(i);
          i = this.is(i, T.OpeningRoundBracket) ? this.group(i, "window") : i + 1;
          continue;
        }
        if (w === "FILTER" && this.is(i + 1, T.OpeningRoundBracket)) {
          i = this.group(this.kw(i), "filter");
          continue;
        }
        if ((w === "RESPECT" || w === "IGNORE") && this.word(i + 1) === "NULLS") {
          i = this.kw(i, 2);
          afterCall = true;
          continue;
        }
      }
      if (afterStar && (w === "EXCEPT" || w === "REPLACE" || w === "APPLY") && !this.setOperand(i + 1)) {
        i = this.kw(i);
        if (this.is(i, T.OpeningRoundBracket)) i = this.group(i, w === "APPLY" ? "args" : "paren");
        else if (this.startsOperand(i)) i = this.is(i + 1, T.Dot) ? this.dottedName(i) : i + 1;
        continue;
      }
      afterStar = false;
      if (c.query && this.clauseAt(i, false)) break;
      if (c.stop?.has(w)) break;
      if (c.args && (w === "FROM" || w === "FOR")) {
        i = this.kw(i);
        operand = true;
        continue;
      }
      if (w === "AS" && c.stopAtKeyword) break;
      const n = this.operator(i);
      if (n > 0) {
        i = this.kw(i, n);
        const last = this.word(i - 1);
        if (last === "BETWEEN") between++;
        if (last === "LIKE" || last === "ILIKE") like = true;
        if (last === "AS") {
          // An alias, a data type in CAST(x AS T), or a subquery in WITH name AS [MATERIALIZED] (...).
          if (this.word(i) === "MATERIALIZED" && this.is(i + 1, T.OpeningRoundBracket) && this.startsQuery(i + 1)) i = this.kw(i);
          if (this.is(i, T.OpeningRoundBracket)) i = this.group(i, "paren");
          else i = this.type(i, end);
          continue;
        }
        // IS NULL and friends end with their operand.
        if (!["NULL", "TRUE", "FALSE", "UNKNOWN"].includes(last) || this.word(i - 2) === "DISTINCT") operand = true;
        if (last === "FROM" && this.word(i - 2) === "DISTINCT") operand = true;
        continue;
      }
      if (RESTRICTED_ALIASES.has(w) || c.stopAtKeyword) break;
      if (!c.alias) break;
      // An alias without AS.
      i++;
    }
    return i;
  }

  /** The keyword operator at `i` after an operand, as a number of words, or 0. */
  private operator(i: number): number {
    const w = this.word(i);
    switch (w) {
      case "AND":
      case "OR":
      case "IN":
      case "LIKE":
      case "ILIKE":
      case "REGEXP":
      case "BETWEEN":
        return 1;
      case "AS":
        return 1;
      case "DIV":
      case "MOD":
        return this.startsOperand(i + 1) ? 1 : 0;
      case "NOT": {
        const next = this.word(i + 1);
        if (["IN", "LIKE", "ILIKE", "BETWEEN", "REGEXP"].includes(next)) return 2;
        if (this.words(i + 1, "SIMILAR", "TO")) return 3;
        return 0;
      }
      case "GLOBAL":
        if (this.word(i + 1) === "IN") return 2;
        if (this.words(i + 1, "NOT", "IN")) return 3;
        return 0;
      case "IS": {
        const n = this.phrase(i);
        return n > 1 ? n : 0;
      }
      case "SIMILAR":
        return this.word(i + 1) === "TO" ? 2 : 0;
      case "AT":
        return this.words(i + 1, "TIME", "ZONE") ? 3 : 0;
      default:
        return 0;
    }
  }

  /** Whether CASE at `i` starts a CASE expression rather than naming a column. */
  private caseAt(i: number, end: number): boolean {
    return (this.startsOperand(i + 1) || this.word(i + 1) === "WHEN") && this.findWord(i + 1, end, "END") > 0;
  }

  /** [1, 2]::Array(UInt8) and -1::Int8 are printed as written: ClickHouse casts the source text of the literal. */
  private castSource(colon: number): void {
    const last = colon - 1;
    const open = this.shape.match[last]!;
    if (this.is(last, T.ClosingSquareBracket) || this.is(last, T.ClosingRoundBracket)) {
      if (open >= 0 && this.literalGroup(open, last)) this.shape.verbatim[open] = last;
    } else if (this.is(last, T.Number) && (this.is(last - 1, T.Minus) || this.is(last - 1, T.Plus)) && this.shape.glue[last - 1]! & GLUE_AFTER) {
      this.shape.verbatim[last - 1] = last;
    }
  }

  /** CAST([1,2] AS T) and CAST([1,2], 'T'): ClickHouse reads the literal from how it is written, so it stays as it is. */
  private castArgument(i: number, close: number): void {
    let j = i;
    if (this.is(j, T.Minus) || this.is(j, T.Plus)) j++;
    const end = OPENERS.has(this.kind(j)!) ? this.after(j) : j + 1;
    const typed = this.word(end) === "AS" || (this.is(end, T.Comma) && this.is(end + 1, T.StringLiteral));
    if (!typed || end > close) return;
    if (this.is(j, T.OpeningSquareBracket) || this.is(j, T.OpeningRoundBracket)) {
      if (j === i && this.literalGroup(j, end - 1)) this.shape.verbatim[j] = end - 1;
    } else if (j > i && this.is(j, T.Number)) {
      this.shape.verbatim[i] = j;
    }
  }

  /** Whether a bracket group holds nothing but literals, brackets and commas. */
  private literalGroup(open: number, close: number): boolean {
    for (let j = open + 1; j < close; j++) {
      const k = this.kind(j)!;
      if (k === T.BareWord ? !["NULL", "TRUE", "FALSE"].includes(this.word(j)) : !LITERAL_PARTS.has(k)) return false;
    }
    return true;
  }

  /** Whether INTERVAL at `i` starts an interval: INTERVAL 1 DAY, INTERVAL '1 day', INTERVAL x HOUR. */
  private intervalAt(i: number): boolean {
    let j = i + 1;
    const kind = this.kind(j);
    if (kind === T.Number || kind === T.StringLiteral) return true;
    // A unit must follow anything else: a column may be called interval, as in d - interval - 1.
    if ((kind === T.Minus || kind === T.Plus) && this.is(j + 1, T.Number)) j += 2;
    else if (kind === T.OpeningRoundBracket) j = this.after(j);
    else if (kind === T.OpeningCurlyBrace) j = this.after(j);
    else if (kind === T.BareWord || kind === T.QuotedIdentifier) {
      j++;
      while (this.is(j, T.Dot)) j += 2;
      if (this.is(j, T.OpeningRoundBracket)) j = this.after(j);
    } else return false;
    return INTERVAL_UNITS.has(this.word(j));
  }

  /** a.b.c, t.*, t.1 and the like from a word at `i`. */
  private dottedName(i: number): number {
    i++;
    while (this.is(i, T.Dot)) i = this.member(i);
    if (this.is(i, T.OpeningRoundBracket)) i = this.call(i - 1);
    return i;
  }

  /** The "." at `i` and the member after it. */
  private member(i: number): number {
    i++;
    if (this.is(i, T.OpeningCurlyBrace)) return this.brace(i);
    if (this.is(i, T.Caret) || this.is(i, T.Colon)) i++;
    if (i < this.n && !ENDERS.has(this.kind(i)!)) i++;
    return i;
  }

  /** A data type from `i`: words and bracket groups, never keywords. */
  private type(i: number, end: number): number {
    if (this.is(i, T.OpeningCurlyBrace)) return this.brace(i);
    if (!this.is(i, T.BareWord) && !this.is(i, T.QuotedIdentifier)) return i;
    i++;
    if (this.is(i, T.OpeningRoundBracket)) i = this.typeArgs(i);
    // Multi-word types such as DOUBLE PRECISION.
    while (i < end && this.is(i, T.BareWord) && !RESTRICTED_ALIASES.has(this.word(i)) && TYPE_WORDS.has(this.word(i))) i++;
    return i;
  }

  /** The arguments of a data type, such as JSON(SKIP REGEXP 'x'): none of their words is a keyword. */
  private typeArgs(open: number): number {
    const close = this.shape.match[open]!;
    if (close < 0) return this.n;
    for (let j = open; j < close; j++) {
      if (this.is(j, T.OpeningRoundBracket) && (this.is(j - 1, T.BareWord) || this.is(j - 1, T.QuotedIdentifier))) this.shape.glue[j] |= GLUE_BEFORE;
    }
    return close + 1;
  }

  // ---- Bracket groups ----

  /** A bracket group from its opener; returns the index after it. */
  private group(i: number, hint: "paren" | "args" | "window" | "filter" | "columns"): number {
    const close = this.shape.match[i]!;
    if (close < 0) return this.n;
    const first = i + 1;
    if (this.kind(i) === T.OpeningRoundBracket && this.startsQuery(i, hint === "args")) {
      this.shape.block[i] = BLOCK_INLINE;
      this.query(first, close);
      return close + 1;
    }
    switch (hint) {
      case "args": {
        let j = first;
        const name = this.word(i - 1);
        if ((this.word(j) === "DISTINCT" || this.word(j) === "ALL") && this.startsOperand(j + 1)) j = this.kw(j);
        else if (name === "EXTRACT" && INTERVAL_UNITS.has(this.word(j)) && this.word(j + 1) === "FROM") j = this.kw(j, 2);
        else if (name === "TRIM" && ["BOTH", "LEADING", "TRAILING"].includes(this.word(j)) && this.startsOperand(j + 1)) j = this.kw(j);
        else if (name === "CAST") this.castArgument(j, close);
        else if (UNIT_FUNCTIONS.has(name) && INTERVAL_UNITS.has(this.word(j)) && this.is(j + 1, T.Comma)) j = this.kw(j);
        this.list(j, close, { alias: true, args: true });
        break;
      }
      case "window":
        this.window(first, close);
        break;
      case "filter":
        if (this.word(first) === "WHERE") this.expr(this.kw(first), close, {});
        else this.list(first, close, {});
        break;
      case "columns":
        this.columns(first, close);
        break;
      default:
        this.list(first, close, { alias: true });
    }
    return close + 1;
  }

  /** "{": a query parameter {name:Type} printed as written, or a map literal. */
  private brace(i: number): number {
    const close = this.shape.match[i]!;
    if (close < 0) return this.n;
    if (this.parameterAt(i)) return close + 1;
    let j = i + 1;
    while (j < close) {
      j = this.expr(j, close, {});
      if (this.is(j, T.Colon)) {
        this.shape.glue[j] |= MAP_COLON;
        j = this.expr(j + 1, close, {});
      }
      if (this.is(j, T.Comma)) j++;
      else break;
    }
    return close + 1;
  }

  /** A window: [name] [PARTITION BY ...] [ORDER BY ...] [ROWS|RANGE|GROUPS frame]. */
  private window(i: number, close: number): number {
    const frame = new Set(["ROWS", "RANGE", "GROUPS"]);
    if ((this.is(i, T.BareWord) || this.is(i, T.QuotedIdentifier)) && !this.words(i, "PARTITION", "BY") && !this.words(i, "ORDER", "BY") && !frame.has(this.word(i))) {
      i++;
    }
    while (i < close) {
      if (this.words(i, "PARTITION", "BY")) {
        i = this.list(this.kw(i, 2), close, { stop: new Set(["ORDER", ...frame]) });
      } else if (this.words(i, "ORDER", "BY")) {
        i = this.list(this.kw(i, 2), close, { order: true, stop: frame });
      } else if (frame.has(this.word(i))) {
        i = this.kw(i);
        const bounded = this.word(i) === "BETWEEN";
        if (bounded) i = this.kw(i);
        i = this.bound(i, close);
        if (bounded && this.word(i) === "AND") i = this.bound(this.kw(i), close);
      } else {
        const next = this.expr(i, close, {});
        i = next > i ? next : i + 1;
      }
    }
    return close + 1;
  }

  /** A window frame bound: UNBOUNDED PRECEDING, CURRENT ROW, expr FOLLOWING. */
  private bound(i: number, close: number): number {
    if (this.words(i, "CURRENT", "ROW")) return this.kw(i, 2);
    if (this.word(i) === "UNBOUNDED") i = this.kw(i);
    else i = this.expr(i, close, { stop: new Set(["PRECEDING", "FOLLOWING"]) });
    if (this.word(i) === "PRECEDING" || this.word(i) === "FOLLOWING") i = this.kw(i);
    return i;
  }

  // ---- CREATE ----

  private create(i: number, end: number): number {
    const head = i;
    i = this.kw(i);
    // OR REPLACE, TEMPORARY, MATERIALIZED and the like before the object word.
    let object = "";
    for (let guard = 0; guard < 6 && i < end; guard++) {
      const w = this.word(i);
      if (this.dotted(i)) break;
      if (w === "OR" && this.word(i + 1) === "REPLACE") i = this.kw(i, 2);
      else if (["TEMPORARY", "MATERIALIZED", "LIVE", "WINDOW", "REFRESHABLE"].includes(w) && this.isObjectWord(i + 1)) i = this.kw(i);
      else if (this.isObjectWord(i)) {
        object = w;
        i = this.kw(i);
        break;
      } else break;
    }
    if (object === "" && this.word(i) === "INDEX" && !this.dotted(i)) return this.createIndex(this.kw(i), end);
    if (!["TABLE", "VIEW", "DICTIONARY", "DATABASE", "FUNCTION"].includes(object)) {
      return this.generic(head, end);
    }
    if (this.words(i, "IF", "NOT", "EXISTS")) i = this.kw(i, 3);
    if (object === "FUNCTION") {
      i = this.name(i);
      if (this.words(i, "ON", "CLUSTER")) i = this.name(this.kw(i, 2));
      if (this.word(i) === "AS") return this.expr(this.kw(i), end, {});
      return this.tail(i, end);
    }
    i = this.name(i);
    let columnsSeen = false;
    while (i < end) {
      const w = this.dotted(i) ? "" : this.word(i);
      if (this.is(i, T.OpeningRoundBracket) && !columnsSeen) {
        columnsSeen = true;
        this.shape.brk[i] = 0;
        this.shape.block[i] = BLOCK_OWN_LINE;
        i = this.group(i, "columns");
        continue;
      }
      if (w === "UUID" && this.is(i + 1, T.StringLiteral)) {
        i = this.kw(i) + 1;
      } else if (w === "ON" && this.word(i + 1) === "CLUSTER") {
        i = this.name(this.kw(i, 2));
      } else if (w === "TO" && object === "VIEW") {
        i = this.kw(i);
        if (this.words(i, "INNER", "UUID")) i = this.kw(i, 2) + 1;
        else i = this.name(i);
      } else if (w === "AS" && (this.setOperand(i + 1) || this.word(i + 1) === "FROM")) {
        this.shape.brk[i] = 0;
        return this.query(this.kw(i), end);
      } else if (w === "EMPTY" && this.word(i + 1) === "AS") {
        this.shape.brk[i] = 0;
        i = this.kw(i);
        if (this.setOperand(i + 1)) return this.query(this.kw(i), end);
      } else if (w === "CLONE" && this.word(i + 1) === "AS") {
        this.shape.brk[i] = 0;
        i = this.name(this.kw(i, 2));
      } else if (w === "AS") {
        i = this.kw(i);
        i = (this.is(i, T.BareWord) || this.is(i, T.QuotedIdentifier)) && this.is(i + 1, T.OpeningRoundBracket) ? this.call(i) : this.name(i);
      } else if (w === "ENGINE") {
        this.shape.brk[i] = 0;
        i = this.kw(i);
        if (this.is(i, T.Equals)) i++;
        i = this.is(i + 1, T.OpeningRoundBracket) ? this.call(i) : this.name(i);
      } else if (this.words(i, "PARTITION", "BY") || this.words(i, "PRIMARY", "KEY") || this.words(i, "ORDER", "BY") || this.words(i, "SAMPLE", "BY")) {
        this.shape.brk[i] = 0;
        i = this.list(this.kw(i, 2), end, { stop: CREATE_CLAUSES, stopAtKeyword: true });
      } else if (w === "TTL") {
        this.shape.brk[i] = 0;
        i = this.ttl(this.kw(i), end);
      } else if (object === "DICTIONARY" && DICTIONARY_CALLS.has(w) && this.is(i + 1, T.OpeningRoundBracket)) {
        this.shape.brk[i] = 0;
        i = this.kw(i);
        this.shape.glue[i] |= GLUE_BEFORE;
        i = this.typeArgs(i);
      } else if (w === "SETTINGS") {
        this.shape.brk[i] = 0;
        i = this.list(this.kw(i), end, { stopAtKeyword: true });
      } else if (w === "COMMENT") {
        this.shape.brk[i] = 0;
        i = this.kw(i);
        if (this.is(i, T.Equals)) i++;
        if (this.is(i, T.StringLiteral)) i++;
      } else if (w === "POPULATE") {
        i = this.kw(i);
      } else if (w === "REFRESH") {
        this.shape.brk[i] = 0;
        i = this.refresh(this.kw(i), end);
      } else if (w === "DEFINER" && this.is(i + 1, T.Equals)) {
        this.shape.brk[i] = 0;
        i = this.name(this.kw(i) + 1);
      } else if (this.words(i, "SQL", "SECURITY")) {
        if (!this.isAfterDefiner(i)) this.shape.brk[i] = 0;
        i = this.kw(i, 2);
        if (["DEFINER", "INVOKER", "NONE"].includes(this.word(i))) i = this.kw(i);
      } else {
        const next = this.tail(i, end, true);
        i = next > i ? next : i + 1;
      }
    }
    return i;
  }

  /** CREATE INDEX [IF NOT EXISTS] name ON table (columns) [TYPE type] [GRANULARITY n], after INDEX. */
  private createIndex(i: number, end: number): number {
    if (this.words(i, "IF", "NOT", "EXISTS")) i = this.kw(i, 3);
    i = this.name(i);
    if (this.word(i) !== "ON") return this.tail(i, end);
    i = this.name(this.kw(i));
    if (this.is(i, T.OpeningRoundBracket)) {
      const close = this.shape.match[i]!;
      this.list(i + 1, close, { order: true });
      i = close + 1;
    }
    if (this.word(i) === "TYPE") {
      i = this.kw(i);
      i = this.is(i + 1, T.OpeningRoundBracket) ? this.call(i) : this.name(i);
    }
    if (this.word(i) === "GRANULARITY") i = this.kw(i) + 1;
    return this.tail(i, end);
  }

  private isAfterDefiner(i: number): boolean {
    // DEFINER = name SQL SECURITY ...: keep it on the DEFINER line.
    let j = i - 1;
    while (j > 0 && (this.is(j, T.Dot) || this.is(j - 1, T.Dot))) j--;
    return this.is(j - 1, T.Equals) && this.word(j - 2) === "DEFINER";
  }

  private isObjectWord(i: number): boolean {
    return ["TABLE", "VIEW", "DICTIONARY", "DATABASE", "FUNCTION"].includes(this.word(i)) && !this.dotted(i);
  }

  /** REFRESH EVERY|AFTER interval [OFFSET interval] [RANDOMIZE FOR interval] [DEPENDS ON ...] [APPEND] */
  private refresh(i: number, end: number): number {
    const stop = new Set(["OFFSET", "RANDOMIZE", "DEPENDS", "SETTINGS", "APPEND", "TO", "EMPTY", "AS", "ENGINE", "DEFINER", "SQL", "POPULATE"]);
    if (this.word(i) === "EVERY" || this.word(i) === "AFTER") i = this.expr(this.kw(i), end, { stop });
    for (;;) {
      if (this.word(i) === "OFFSET") i = this.expr(this.kw(i), end, { stop });
      else if (this.words(i, "RANDOMIZE", "FOR")) i = this.expr(this.kw(i, 2), end, { stop });
      else if (this.words(i, "DEPENDS", "ON")) i = this.list(this.kw(i, 2), end, { stop });
      else if (this.word(i) === "APPEND") i = this.kw(i);
      else return i;
    }
  }

  /** TTL expr [DELETE | TO DISK 'x' | TO VOLUME 'x' | RECOMPRESS CODEC(...)] [WHERE ...], ... */
  private ttl(i: number, end: number): number {
    const stop = new Set(["DELETE", "TO", "RECOMPRESS", "WHERE", "GROUP", "SET", ...CREATE_CLAUSES]);
    for (;;) {
      i = this.expr(i, end, { stop, stopAtKeyword: true });
      for (;;) {
        const w = this.word(i);
        if (w === "DELETE") i = this.kw(i);
        else if ((this.words(i, "TO", "DISK") || this.words(i, "TO", "VOLUME")) && this.is(i + 2, T.StringLiteral)) i = this.kw(i, 2) + 1;
        else if (w === "RECOMPRESS" && this.word(i + 1) === "CODEC" && this.is(i + 2, T.OpeningRoundBracket)) {
          i = this.kw(i, 2);
          this.shape.glue[i] |= GLUE_BEFORE;
          i = this.typeArgs(i);
        } else if (w === "WHERE") i = this.expr(this.kw(i), end, { stop, stopAtKeyword: true });
        else if (this.words(i, "GROUP", "BY")) i = this.list(this.kw(i, 2), end, { stop, stopAtKeyword: true });
        else if (w === "SET") i = this.list(this.kw(i), end, { stop, stopAtKeyword: true });
        else break;
      }
      if (!this.is(i, T.Comma)) return i;
      i++;
    }
  }

  /** The column list of CREATE TABLE: one element per line. */
  private columns(i: number, close: number): void {
    let first = true;
    while (i < close) {
      if (!first) this.shape.brk[i] = 0;
      first = false;
      i = this.element(i, close);
      if (this.is(i, T.Comma)) i++;
      else if (i < close) i = this.skip(i, close);
    }
  }

  /** Skips to the next comma at this level. */
  private skip(i: number, close: number): number {
    while (i < close && !this.is(i, T.Comma)) {
      if (OPENERS.has(this.kind(i)!)) i = this.after(i);
      else i++;
    }
    if (this.is(i, T.Comma)) i++;
    return i;
  }

  /** The index of the next comma at this level, or `close`. */
  private elementEnd(i: number, close: number): number {
    while (i < close && !this.is(i, T.Comma)) i = OPENERS.has(this.kind(i)!) ? this.after(i) : i + 1;
    return Math.min(i, close);
  }

  /** One element of a column list: a column, INDEX, PROJECTION, CONSTRAINT or PRIMARY KEY. */
  private element(i: number, close: number): number {
    const end = this.elementEnd(i, close);
    const w = this.word(i);
    const nameNext = this.is(i + 1, T.BareWord) || this.is(i + 1, T.QuotedIdentifier);
    if (w === "INDEX" && nameNext && this.findWord(i + 2, end, "TYPE") > 0) {
      return this.index(this.kw(i), end);
    }
    if (w === "PROJECTION" && nameNext && (this.is(i + 2, T.OpeningRoundBracket) || this.word(i + 2) === "INDEX")) {
      i = this.name(this.kw(i));
      if (this.is(i, T.OpeningRoundBracket)) return this.group(i, "paren");
      return this.index(i, end);
    }
    if (w === "CONSTRAINT" && nameNext && (this.word(i + 2) === "CHECK" || this.word(i + 2) === "ASSUME")) {
      return this.expr(this.kw(this.name(this.kw(i))), end, {});
    }
    if (this.words(i, "PRIMARY", "KEY") && !this.is(i + 2, T.Comma) && i + 2 < end) {
      return this.list(this.kw(i, 2), end, {});
    }
    if ((w === "STATISTICS" || w === "FOREIGN" || w === "UNIQUE") && !nameNext) {
      return end;
    }
    const next = this.columnDef(i, end);
    this.note("column", i, end);
    return next;
  }

  /** The first index of `word` between `i` and `end` at this level, or -1. */
  private findWord(i: number, end: number, word: string): number {
    while (i < end) {
      if (this.word(i) === word && !this.dotted(i)) return i;
      i = OPENERS.has(this.kind(i)!) ? this.after(i) : i + 1;
    }
    return -1;
  }

  /** [INDEX] name expr TYPE type [GRANULARITY n], from the name. */
  private index(i: number, end: number): number {
    if (this.word(i) === "INDEX") i = this.kw(i);
    i = this.name(i);
    i = this.expr(i, end, { stop: new Set(["TYPE"]) });
    if (this.word(i) === "TYPE") {
      i = this.kw(i);
      i = this.is(i + 1, T.OpeningRoundBracket) ? this.call(i) : this.name(i);
    }
    if (this.word(i) === "GRANULARITY") i = this.kw(i) + 1;
    return i;
  }

  /** name [Type] [NULL | NOT NULL] [DEFAULT expr] [COMMENT 'x'] [CODEC(...)] [TTL expr] ... */
  private columnDef(i: number, end: number): number {
    i = this.name(i);
    // The data type, up to the first column keyword.
    while (i < end && !(this.is(i, T.BareWord) && COLUMN_WORDS.has(this.word(i)) && !this.dotted(i))) {
      if (this.is(i, T.OpeningRoundBracket)) i = this.typeArgs(i);
      else if (OPENERS.has(this.kind(i)!)) i = this.after(i);
      else i++;
    }
    const stop = COLUMN_WORDS;
    while (i < end) {
      const w = this.word(i);
      if (w === "NULL") i = this.kw(i);
      else if (this.words(i, "NOT", "NULL")) i = this.kw(i, 2);
      else if (["DEFAULT", "MATERIALIZED", "EPHEMERAL", "ALIAS"].includes(w)) i = this.expr(this.kw(i), end, { stop });
      else if (w === "COMMENT" && this.is(i + 1, T.StringLiteral)) i = this.kw(i) + 1;
      else if ((w === "CODEC" || w === "STATISTICS") && this.is(i + 1, T.OpeningRoundBracket)) {
        i = this.kw(i);
        this.shape.glue[i] |= GLUE_BEFORE;
        i = this.typeArgs(i);
      } else if (w === "SETTINGS" && this.is(i + 1, T.OpeningRoundBracket)) {
        i = this.group(this.kw(i), "paren");
      } else if (w === "TTL") i = this.expr(this.kw(i), end, { stop });
      else if (this.words(i, "PRIMARY", "KEY")) i = this.kw(i, 2);
      else if (w === "AUTO_INCREMENT") i = this.kw(i);
      else if (w === "FIRST") i = this.kw(i);
      else if (w === "AFTER") i = this.name(this.kw(i));
      else return i;
    }
    return i;
  }

  // ---- ALTER ----

  private alter(i: number, end: number): number {
    const head = i;
    if (!this.words(i + 1, "TABLE") && !this.words(i + 1, "TEMPORARY", "TABLE")) return this.generic(head, end);
    i = this.kw(i, this.words(i + 1, "TABLE") ? 2 : 3);
    if (this.words(i, "IF", "EXISTS")) i = this.kw(i, 2);
    i = this.name(i);
    if (this.words(i, "ON", "CLUSTER")) i = this.name(this.kw(i, 2));
    // ALTER TABLE t ... FORMAT Null SETTINGS x = 1: these end the commands.
    let last = end;
    for (let j = i; j < end; j = OPENERS.has(this.kind(j)!) ? this.after(j) : j + 1) {
      if (this.dotted(j)) continue;
      if ((this.word(j) === "FORMAT" && this.nameAt(j + 1)) || (this.word(j) === "SETTINGS" && !this.is(j + 1, T.OpeningRoundBracket))) {
        last = j;
        break;
      }
    }
    const commands: number[] = [];
    while (i < last) {
      commands.push(i);
      const next = this.command(i, last);
      i = next > i ? next : i + 1;
      if (this.is(i, T.Comma)) i++;
    }
    if (commands.length > 1) for (const c of commands) this.shape.brk[c] = 1;
    while (i < end) {
      if (this.word(i) === "FORMAT") i = this.name(this.kw(i));
      else if (this.word(i) === "SETTINGS") i = this.list(this.kw(i), end, { stopAtKeyword: true });
      else i++;
    }
    return i;
  }

  /** One ALTER TABLE command, up to the comma before the next one. */
  private command(i: number, end: number): number {
    // A command ends at a comma followed by a command keyword.
    let stopAt = i;
    while (stopAt < end) {
      if (this.is(stopAt, T.Comma) && ALTER_COMMANDS.has(this.word(stopAt + 1)) && !this.dotted(stopAt + 1)) break;
      stopAt = OPENERS.has(this.kind(stopAt)!) ? this.after(stopAt) : stopAt + 1;
    }
    const n = this.phrase(i);
    if (n === 0) return this.tail(i, stopAt);
    const words = this.sig.slice(i, i + n).map((t) => t.up);
    i = this.kw(i, n);
    const last = words[n - 1]!;
    if (this.words(i, "IF", "NOT", "EXISTS")) i = this.kw(i, 3);
    else if (this.words(i, "IF", "EXISTS")) i = this.kw(i, 2);
    if ((words[0] === "ADD" || words[0] === "MODIFY") && last === "COLUMN") {
      return this.columnDef(i, stopAt);
    }
    if (words[0] === "ADD" && last === "INDEX") return this.index(i, stopAt);
    if (words[0] === "ADD" && last === "PROJECTION") {
      i = this.name(i);
      if (this.is(i, T.OpeningRoundBracket)) i = this.group(i, "paren");
      return this.tail(i, stopAt);
    }
    if (words[0] === "ADD" && last === "CONSTRAINT") {
      i = this.name(i);
      if (this.word(i) === "CHECK" || this.word(i) === "ASSUME") return this.expr(this.kw(i), stopAt, {});
      return i;
    }
    if (words[0] === "UPDATE") {
      i = this.list(i, stopAt, { stop: new Set(["WHERE", "IN"]) });
      return this.tail(i, stopAt);
    }
    if (words[0] === "MODIFY" && last === "QUERY" && this.setOperand(i)) {
      this.shape.brk[i] = 0;
      return this.query(i, stopAt);
    }
    if (words[0] === "MODIFY" && last === "TTL") return this.ttl(i, stopAt);
    if (words[0] === "MODIFY" && (last === "BY" || last === "SETTING")) return this.list(i, stopAt, { stopAtKeyword: true });
    if (words[0] === "RESET" && last === "SETTING") {
      for (;;) {
        i = this.name(i);
        if (!this.is(i, T.Comma) || ALTER_COMMANDS.has(this.word(i + 1))) return i;
        i++;
      }
    }
    if (last === "COLUMN" || last === "INDEX" || last === "PROJECTION" || last === "CONSTRAINT") i = this.name(i);
    else if (last === "STATISTICS") i = this.names(i);
    return this.tail(i, stopAt);
  }

  // ---- Other statements ----

  /** GRANT|REVOKE privileges ON target TO|FROM users, or GRANT roles TO users. */
  private grant(i: number, end: number): number {
    i = this.kw(i);
    if (this.words(i, "ON", "CLUSTER")) i = this.name(this.kw(i, 2));
    if (this.words(i, "GRANT", "OPTION", "FOR") || this.words(i, "ADMIN", "OPTION", "FOR")) i = this.kw(i, 3);
    const on = this.findWord(i, end, "ON");
    if (on < 0) return this.tail(this.names(i), end);
    // Privileges, such as SELECT(a, b), ALTER UPDATE, SHOW TABLES.
    while (i < on) {
      if (this.is(i, T.OpeningRoundBracket)) {
        this.shape.glue[i] |= GLUE_BEFORE;
        i = this.after(i);
      } else if (this.is(i, T.BareWord) && !this.dotted(i)) {
        i = this.kw(i, this.phrase(i) || 1);
      } else i++;
    }
    return this.tail(i, end);
  }

  /** Any other statement: its leading keywords, then names and keywords as they come. */
  private generic(i: number, end: number): number {
    const n = this.phrase(i);
    i = n > 0 ? this.kw(i, n) : i + 1;
    return this.tail(i, end, false, this.word(i - 1));
  }

  /**
   * The rest of a statement: names after object words, expressions after WHERE and "=",
   * keywords elsewhere when they are in the keyword list.
   */
  private tail(i: number, end: number, create = false, previous = ""): number {
    let expectName = NAME_WORDS.has(previous);
    while (i < end) {
      const t = this.sig[i]!;
      const k = t.kind;
      if (create && t.kind === T.BareWord && CREATE_CLAUSES.has(t.up) && !this.dotted(i) && i > 0) return i;
      if (k === T.OpeningRoundBracket) {
        i = this.group(i, "paren");
        expectName = false;
        continue;
      }
      if (k === T.OpeningSquareBracket || k === T.OpeningCurlyBrace) {
        i = k === T.OpeningCurlyBrace ? this.brace(i) : this.group(i, "paren");
        expectName = false;
        continue;
      }
      if (k !== T.BareWord) {
        if (COMPARISONS.has(k) || k === T.Arrow) {
          // A value: setting = value, column = expression, x -> x + 1.
          i = this.expr(i + 1, end, { stopAtKeyword: true });
        } else if (k === T.QuotedIdentifier || k === T.StringLiteral) {
          i = expectName ? this.names(i) : this.name(i);
        } else {
          i++;
        }
        expectName = false;
        continue;
      }
      const w = t.up;
      if (this.dotted(i) || (this.is(i + 1, T.OpeningRoundBracket) && !TAIL_PAREN_KEYWORDS.has(w))) {
        i = this.is(i + 1, T.OpeningRoundBracket) ? this.call(i) : this.dottedName(i);
        expectName = false;
        continue;
      }
      // Row policies: AS PERMISSIVE, FOR SELECT, TO ALL [EXCEPT ...].
      const before = this.word(i - 1);
      if ((before === "AS" && (w === "PERMISSIVE" || w === "RESTRICTIVE")) || (before === "FOR" && w === "SELECT") || ((before === "TO" || before === "EXCEPT") && w === "ALL" && !this.nameFollows(i + 1))) {
        i = this.kw(i);
        expectName = false;
        continue;
      }
      if (COMPARISONS.has(this.kind(i + 1)!) && !KEYWORDS_BEFORE_EQUALS.has(w)) {
        // name = value
        i = this.expr(i + 2, end, { stopAtKeyword: true });
        expectName = false;
        continue;
      }
      if (w === "SELECT" && !expectName) {
        this.shape.brk[i] = 0;
        return this.query(i, end);
      }
      if (this.words(i, "IF", "NOT", "EXISTS") || this.words(i, "IF", "EXISTS")) {
        i = this.kw(i, this.word(i + 1) === "NOT" ? 3 : 2);
        expectName = true;
        continue;
      }
      // Where a name goes, a word is the name unless it takes a name itself: SHOW TABLES IN db.
      if (expectName && !((OBJECT_WORDS.has(w) || NAME_WORDS.has(w)) && this.nameFollows(i + 1))) {
        i = this.names(i);
        expectName = false;
        continue;
      }
      if (previous === "SYSTEM" && this.word(i - 1) === "SYSTEM") {
        const command = SYSTEM_COMMANDS.find((words) => this.words(i, ...words));
        // At least one word, so that a statement that does not parse, as SYSTEM FROM 'x', ends.
        i = command ? this.kw(i, command.length) : Math.max(this.systemWords(i, end), i + 1);
        expectName = true;
        continue;
      }
      const n = this.phrase(i);
      if (n === 0) {
        i++;
        expectName = NAME_WORDS.has(w);
        continue;
      }
      i = this.kw(i, n);
      const last = this.word(i - 1);
      if (last === "WHERE" || last === "PREWHERE" || last === "HAVING" || last === "USING") {
        i = this.expr(i, end, { stopAtKeyword: true, query: true });
      } else if (last === "SETTINGS" && !create) {
        i = this.accessSettings(i, end);
      } else if (last === "PARTITION" && this.word(i) === "ALL" && !this.startsOperand(i + 1)) {
        i = this.kw(i);
      } else if (last === "PARTITION" && this.word(i) === "ID" && this.is(i + 1, T.StringLiteral)) {
        i = this.kw(i) + 1;
      } else if (last === "BY" || last === "SET" || last === "PARTITION" || last === "LIMIT" || last === "SETTINGS") {
        i = this.list(i, end, { stopAtKeyword: true });
      } else if (last === "FORMAT") {
        i = this.name(i);
      } else if ((last === "AS" || last === "FROM") && this.setOperand(i)) {
        this.shape.brk[i] = 0;
        return this.query(i, end);
      }
      expectName = NAME_WORDS.has(last);
    }
    return i;
  }

  /** SETTINGS of a user, role or profile: name = value [MIN x] [MAX y] [READONLY], PROFILE name, INHERIT name. */
  private accessSettings(i: number, end: number): number {
    const stop = new Set(["MIN", "MAX", "CONST", "READONLY", "WRITABLE", "CHANGEABLE_IN_READONLY"]);
    for (;;) {
      if ((this.word(i) === "PROFILE" || this.word(i) === "INHERIT") && this.nameAt(i + 1) && !this.dotted(i)) {
        i = this.name(this.kw(i));
      } else {
        i = this.expr(i, end, { stop, stopAtKeyword: true });
        for (;;) {
          if ((this.word(i) === "MIN" || this.word(i) === "MAX") && !this.dotted(i)) i = this.expr(this.kw(i), end, { stop, stopAtKeyword: true });
          else if (stop.has(this.word(i)) && !this.dotted(i)) i = this.kw(i);
          else break;
        }
      }
      if (!this.is(i, T.Comma)) return i;
      i++;
    }
  }

  /** The words of a SYSTEM command we do not know, kept as written: up to the last one before a name. */
  private systemWords(i: number, end: number): number {
    while (i < end && this.is(i, T.BareWord) && !this.dotted(i) && !this.words(i, "ON", "CLUSTER") && this.is(i + 1, T.BareWord)) i++;
    return i;
  }

  /** Whether a name, not a keyword that follows names, starts at `i`. */
  private nameFollows(i: number): boolean {
    if (this.is(i, T.QuotedIdentifier) || this.is(i, T.OpeningCurlyBrace) || this.is(i, T.StringLiteral)) return true;
    if (!this.is(i, T.BareWord)) return false;
    // A last word is the name unless it can end a statement: DROP TABLE t SYNC.
    if (i + 1 >= this.n || this.is(i + 1, T.Semicolon)) return !ENDING_WORDS.has(this.word(i));
    return !AFTER_NAME.has(this.word(i));
  }

  /** Whether a name starts at `i`. */
  private nameAt(i: number): boolean {
    return this.is(i, T.BareWord) || this.is(i, T.QuotedIdentifier) || this.is(i, T.OpeningCurlyBrace);
  }
}

/** What a literal before :: may be made of. */
const LITERAL_PARTS = new Set([
  T.Number,
  T.StringLiteral,
  T.Comma,
  T.Minus,
  T.Plus,
  T.OpeningRoundBracket,
  T.ClosingRoundBracket,
  T.OpeningSquareBracket,
  T.ClosingSquareBracket,
]);
