/**
 * Splits the input into units: a statement with the comments that belong to it, or a paragraph
 * of comments alone. Statements end where check() ends them, inline INSERT data included.
 */
import { tokenize } from "../lexer/index.js";
import { TokenKind as T, isSignificant, type Token } from "../types.js";

export interface Unit {
  /** Offsets of the whole unit: leading comments, the statement, comments after it. */
  start: number;
  end: number;
  /** The statement as check() sees it; null for comments alone. */
  statement: { start: number; end: number } | null;
  /** Inline INSERT data, printed as written; start is -1 without data. */
  data: { start: number; end: number; blankLine: boolean };
  /** The tokens of the unit, whitespace and comments included, without the ones inside the data. */
  tokens: Token[];
}

/** The number of line breaks in a piece of whitespace. */
export function lineBreaks(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n" || (c === "\r" && text[i + 1] !== "\n")) count++;
  }
  return count;
}

export function split(sql: string): Unit[] {
  return new Splitter(sql).run();
}

interface Gap {
  comment: Token;
  /** Line breaks between the comment and what comes before it. */
  breaks: number;
}

interface StatementEnd {
  /** Index of the first token after the statement. */
  next: number;
  /** Offset just after the statement. */
  end: number;
  data: Unit["data"];
}

class Splitter {
  private tokens: Token[];
  private readonly units: Unit[] = [];

  constructor(private readonly sql: string) {
    this.tokens = tokenize(sql);
  }

  run(): Unit[] {
    let i = 0;
    let previous: Unit | undefined;
    for (;;) {
      // The comments between the previous statement and the next one.
      const gap: Gap[] = [];
      let breaks = previous?.data.blankLine ? 2 : 0;
      while (!isSignificant(this.tokens[i]!.kind)) {
        const token = this.tokens[i++]!;
        if (token.kind === T.Whitespace) breaks += lineBreaks(this.sql.slice(token.start, token.end));
        else {
          gap.push({ comment: token, breaks });
          breaks = 0;
        }
      }
      const first = this.tokens[i]!;
      const atEnd = first.kind === T.EndOfStream;
      // A stray ";" right after a statement stays with it.
      if (first.kind === T.Semicolon && previous?.statement && gap.length === 0 && !previous.data.blankLine) {
        previous.tokens.push(...this.tokens.slice(this.indexAt(previous.end), i + 1));
        previous.end = first.end;
        previous.statement.end = first.end;
        i++;
        continue;
      }
      let g = 0;
      // Comments on the line where the previous statement ends belong to it.
      if (previous && !previous.data.blankLine) {
        while (g < gap.length && gap[g]!.breaks === 0) this.extend(previous, gap[g++]!.comment);
        // At the end, the comments right below the last statement belong to it too.
        if (atEnd && previous.statement) {
          while (g < gap.length && gap[g]!.breaks < 2) this.extend(previous, gap[g++]!.comment);
        }
      }
      // The rest falls into paragraphs at blank lines; the last one leads into the next statement.
      const paragraphs: Gap[][] = [];
      for (; g < gap.length; g++) {
        if (paragraphs.length === 0 || gap[g]!.breaks >= 2) paragraphs.push([]);
        paragraphs[paragraphs.length - 1]!.push(gap[g]!);
      }
      const leading = !atEnd && paragraphs.length > 0 && breaks < 2 ? paragraphs.pop()! : [];
      for (const paragraph of paragraphs) this.units.push(this.commentUnit(paragraph));
      if (atEnd) break;

      const start = leading.length > 0 ? leading[0]!.comment.start : first.start;
      const stop = this.statementEnd(i);
      const tokens = this.tokens.slice(this.indexAt(start), stop.data.start >= 0 ? this.indexAt(stop.data.start) : stop.next);
      const unit: Unit = {
        start,
        end: stop.data.start >= 0 && stop.data.end === stop.end ? stop.data.end : stop.end,
        statement: { start: first.start, end: stop.end },
        data: stop.data,
        tokens,
      };
      // Tokens after the data: the ";" that ends VALUES.
      if (stop.data.start >= 0 && stop.data.end < stop.end) {
        unit.tokens.push(...this.tokens.slice(this.indexAt(stop.data.end), stop.next));
      }
      this.units.push(unit);
      previous = unit;
      i = stop.next;
    }
    return this.units;
  }

  /** Adds a comment that follows the unit to it. */
  private extend(unit: Unit, comment: Token): void {
    unit.tokens.push(...this.tokens.slice(this.indexAt(unit.end), this.indexAt(comment.end)));
    unit.end = comment.end;
  }

  private commentUnit(paragraph: Gap[]): Unit {
    const start = paragraph[0]!.comment.start;
    const end = paragraph[paragraph.length - 1]!.comment.end;
    return {
      start,
      end,
      statement: null,
      data: { start: -1, end: -1, blankLine: false },
      tokens: this.tokens.slice(this.indexAt(start), this.indexAt(end)),
    };
  }

  /** The index of the first token that starts at or after `offset`. */
  private indexAt(offset: number): number {
    let lo = 0;
    let hi = this.tokens.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.tokens[mid]!.start >= offset) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  /** Makes the tokens from `offset` on the ones lexed from there, as check() does after inline data. */
  private realign(offset: number): number {
    const index = this.indexAt(offset);
    const crossing = index > 0 ? this.tokens[index - 1] : undefined;
    const first = this.tokens[index];
    const aligned =
      (!crossing || crossing.end <= offset || crossing.kind === T.Whitespace) && this.sql[first?.start ?? 0] !== ".";
    if (!aligned) {
      const kept = this.tokens.slice(0, index).filter((token) => token.end <= offset);
      const rest = tokenize(this.sql.slice(offset)).map((token) => ({ ...token, start: token.start + offset, end: token.end + offset }));
      this.tokens = [...kept, ...rest];
    }
    return this.indexAt(offset);
  }

  private significantAfter(i: number): number {
    // Past the end there is only the end of the stream.
    i = Math.min(i, this.tokens.length - 1);
    while (!isSignificant(this.tokens[i]!.kind)) i++;
    return i;
  }

  private upper(i: number): string {
    const token = this.tokens[i]!;
    return token.kind === T.BareWord ? this.sql.slice(token.start, token.end).toUpperCase() : "";
  }

  /** Where the statement that starts at token `i` ends. */
  private statementEnd(i: number): StatementEnd {
    const noData = { start: -1, end: -1, blankLine: false };
    let depth = 0;
    let insert = false;
    let mode: "none" | "select" | "done" = "none";
    let readsInput = false;
    let last = i;
    for (let j = i; ; j = this.significantAfter(j + 1)) {
      const token = this.tokens[j]!;
      // Comments after the last statement are read as the gap after it.
      if (token.kind === T.EndOfStream) return { next: last + 1, end: this.tokens[last]!.end, data: noData };
      if (token.kind === T.Semicolon) return { next: j + 1, end: token.end, data: noData };
      last = j;
      if (token.kind === T.OpeningRoundBracket || token.kind === T.OpeningSquareBracket) depth++;
      if (token.kind === T.ClosingRoundBracket || token.kind === T.ClosingSquareBracket) depth--;
      const word = this.upper(j);
      if (!insert) {
        if (word === "INSERT" && depth === 0 && this.upper(this.significantAfter(j + 1)) === "INTO") {
          insert = true;
          j = this.skipTarget(this.significantAfter(j + 1));
          // A statement that ends in its target, as `INSERT INTO db.` does, ends at its last token.
          while (!isSignificant(this.tokens[j]!.kind) || this.tokens[j]!.kind === T.EndOfStream) j--;
          last = j;
        }
        continue;
      }
      // An INSERT ... SELECT has inline data only when it reads it with input().
      if (mode === "select" && word === "INPUT" && this.tokens[this.significantAfter(j + 1)]!.kind === T.OpeningRoundBracket) {
        readsInput = true;
      }
      if (depth !== 0 || mode === "done") continue;
      if (word === "INFILE") {
        mode = "done";
      } else if (mode === "none" && (word === "SELECT" || word === "WITH" || word === "FROM")) {
        mode = "select";
      } else if (mode === "none" && word === "VALUES") {
        return this.valuesEnd(j, token.end);
      } else if (word === "FORMAT" && (mode === "none" || readsInput)) {
        const name = this.significantAfter(j + 1);
        const kind = this.tokens[name]!.kind;
        if (kind !== T.BareWord && kind !== T.QuotedIdentifier) continue;
        const nameToken = this.tokens[name]!;
        const text = this.sql.slice(nameToken.start, nameToken.end);
        if ((kind === T.QuotedIdentifier ? text.slice(1, -1) : text) === "Values") return this.valuesEnd(name, nameToken.end);
        // ClickHouse rejects a ";" right after the format name, and the statement ends there.
        if (this.sql[nameToken.end] === ";") {
          const semicolon = this.indexAt(nameToken.end);
          return { next: semicolon + 1, end: nameToken.end + 1, data: noData };
        }
        return this.formatDataEnd(nameToken.end);
      }
    }
  }

  /** Skips the target of INSERT INTO: [TABLE] name, or [TABLE] FUNCTION f(...). Returns its last token. */
  private skipTarget(into: number): number {
    let j = this.significantAfter(into + 1);
    const next = (k: number) => this.significantAfter(k + 1);
    if (this.upper(j) === "TABLE" && this.tokens[next(j)]!.kind !== T.Semicolon) j = next(j);
    if (this.upper(j) === "FUNCTION" && this.tokens[next(j)]!.kind === T.BareWord && this.tokens[next(next(j))]!.kind === T.OpeningRoundBracket) {
      return j;
    }
    // name, db.name or a {parameter}
    for (;;) {
      if (this.tokens[j]!.kind === T.OpeningCurlyBrace) {
        let depth = 0;
        for (; this.tokens[j]!.kind !== T.EndOfStream; j = next(j)) {
          if (this.tokens[j]!.kind === T.OpeningCurlyBrace) depth++;
          if (this.tokens[j]!.kind === T.ClosingCurlyBrace && --depth === 0) break;
        }
      }
      if (this.tokens[next(j)]!.kind !== T.Dot) return j;
      j = next(next(j));
    }
  }

  /** VALUES data: from after the keyword to the first ";" outside brackets. */
  private valuesEnd(keyword: number, dataStart: number): StatementEnd {
    let depth = 0;
    let lastEnd = dataStart;
    for (let j = keyword + 1; ; j++) {
      const token = this.tokens[j]!;
      const kind = token.kind;
      if (kind === T.EndOfStream) {
        return { next: j, end: lastEnd, data: { start: dataStart, end: lastEnd, blankLine: false } };
      }
      if (kind === T.OpeningRoundBracket || kind === T.OpeningSquareBracket || kind === T.OpeningCurlyBrace) depth++;
      else if (kind === T.ClosingRoundBracket || kind === T.ClosingSquareBracket || kind === T.ClosingCurlyBrace) depth--;
      else if (kind === T.Semicolon && depth <= 0) {
        // `INSERT INTO t VALUES;` has no data.
        const data = lastEnd > dataStart ? { start: dataStart, end: lastEnd, blankLine: false } : { start: -1, end: -1, blankLine: false };
        return { next: j + 1, end: token.end, data };
      }
      if (kind !== T.Whitespace) lastEnd = token.end;
    }
  }

  /** Data after FORMAT name: to the first empty line, as in clickhouse-client. */
  private formatDataEnd(nameEnd: number): StatementEnd {
    const blank = this.sql.indexOf("\n\n", nameEnd);
    if (blank === -1) {
      // Data that runs to the end of the input keeps all of it, spaces and line breaks included.
      const end = this.sql.length;
      const next = this.realign(this.sql.length);
      return { next, end, data: { start: nameEnd, end, blankLine: false } };
    }
    const next = this.realign(blank + 2);
    return { next, end: blank, data: { start: nameEnd, end: blank, blankLine: true } };
  }
}
