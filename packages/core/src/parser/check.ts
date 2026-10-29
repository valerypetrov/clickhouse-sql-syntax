/**
 * check(): splits the input into statements and checks each one the way
 * tryParseQuery() in src/Parsers/parseQuery.cpp does.
 */
import { tokenize } from "../lexer/index.js";
import {
  type Diagnostic,
  isErrorKind,
  isSignificant,
  LEXER_ERROR_MESSAGES,
  type Token,
  TokenKind as T,
} from "../types.js";
import type { Ast } from "./ast.js";
import { parseQuery } from "./query.js";
import { Expected, kwQuiet, MAX_PARSER_DEPTH, P, ParseError } from "./state.js";

const SHOW_CHARS = 160;

/** Line and column of every offset, with lines ending at \n, \r\n or a lone \r. */
class Lines {
  private readonly starts: number[] = [0];

  constructor(readonly text: string) {
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === "\n" || (c === "\r" && text[i + 1] !== "\n")) this.starts.push(i + 1);
    }
  }

  at(offset: number): { line: number; col: number } {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - this.starts[lo]! + 1 };
  }
}

function utf8Length(text: string): number {
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) length += 1;
    else if (code < 0x800) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      // A surrogate pair is one 4-byte character.
      length += 4;
      i++;
    } else length += 3;
  }
  return length;
}

function levenshtein(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  let previous = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const current = [i];
    for (let j = 1; j <= y.length; j++)
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[y.length]!;
}

/** getKeywordTypoHint: the expected keyword that the word is most likely a typo of. */
function keywordTypoHint(word: string, variants: string[]): string {
  if (word.length < 3 || /[0-9]/.test(word)) return "";
  const maxDistance = word.length < 6 ? 1 : 2;
  let best = maxDistance + 1;
  let hint = "";
  for (const variant of variants) {
    if (variant.length + maxDistance < word.length || word.length + maxDistance < variant.length) continue;
    if (!/^[A-Z_]+$/.test(variant)) continue;
    const distance = levenshtein(word, variant);
    if (distance > 0 && distance < best) {
      best = distance;
      hint = variant;
    }
  }
  return hint;
}

/** The "Expected ..." part of a syntax error. */
function expectedMessage(token: Token, sql: string, expected: Expected): string {
  const variants = expected.variants;
  if (!variants.length) return "Syntax error";
  let message = "";
  if (token.kind === T.BareWord) {
    const hint = keywordTypoHint(sql.slice(token.start, token.end), variants);
    if (hint) message = `Maybe you meant: ${hint}. `;
  }
  message += variants.length === 1 ? `Expected ${variants[0]}` : `Expected one of: ${variants.join(", ")}`;
  return message;
}

/** One statement being checked: where it starts and the tokens from there on. */
interface Statement {
  /** Offset where ClickHouse's query begins: after the previous one, its whitespace and ';'. */
  begin: number;
  toks: Token[];
  start: number;
}

class Checker {
  readonly diagnostics: Diagnostic[] = [];
  private readonly lines: Lines;

  constructor(private readonly sql: string) {
    this.lines = new Lines(sql);
  }

  private report(start: number, end: number, message: string): void {
    const { line, col } = this.lines.at(start);
    this.diagnostics.push({ message, start, end, line, col, severity: "error" });
  }

  private reportToken(token: Token, message: string): void {
    this.report(token.start, token.kind === T.EndOfStream ? token.start : token.end, message);
  }

  /** Byte position from the query begin, with line and column if the statement has several lines. */
  private bracketPosition(token: Token, begin: number, statementEnd: number): string {
    const text = this.sql.slice(token.start, token.end);
    let result = `'${text}' at position ${utf8Length(this.sql.slice(begin, token.start)) + 1}`;
    const newline = this.sql.indexOf("\n", begin);
    if (newline !== -1 && newline + 1 < statementEnd) {
      const lineStart = this.sql.lastIndexOf("\n", token.start - 1) + 1;
      const line = this.sql.slice(begin, token.start).split("\n").length;
      result += ` (line ${line}, col ${utf8Length(this.sql.slice(Math.max(lineStart, begin), token.start)) + 1})`;
    }
    return result;
  }

  /** checkUnmatchedParentheses over the tokens from the statement start. */
  private unmatchedParentheses(toks: Token[], start: number): Token[] {
    const stack: Token[] = [];
    for (let i = start; i < toks.length; i++) {
      const token = toks[i]!;
      if (token.kind === T.EndOfStream || isErrorKind(token.kind)) break;
      if (token.kind === T.OpeningRoundBracket || token.kind === T.OpeningSquareBracket) {
        stack.push(token);
      } else if (token.kind === T.ClosingRoundBracket || token.kind === T.ClosingSquareBracket) {
        const top = stack[stack.length - 1];
        const matches =
          top &&
          ((top.kind === T.OpeningRoundBracket && token.kind === T.ClosingRoundBracket) ||
            (top.kind === T.OpeningSquareBracket && token.kind === T.ClosingSquareBracket));
        if (matches) {
          stack.pop();
        } else {
          stack.push(token);
          return stack;
        }
      }
    }
    return stack;
  }

  private unmatchedMessage(parens: Token[], last: Token, begin: number, statementEnd: number): { token: Token; message: string } {
    const closingUnmatched =
      parens[parens.length - 1]!.kind === T.ClosingRoundBracket || parens[parens.length - 1]!.kind === T.ClosingSquareBracket;
    const fallback = closingUnmatched ? parens[parens.length - 1]! : parens[0]!;
    const atParser = closingUnmatched ? last.start < fallback.start : last.start > fallback.start;
    const token = atParser ? last : fallback;
    const position = (bracket: Token) => this.bracketPosition(bracket, begin, statementEnd);
    let message = "Unmatched parentheses: ";
    if (closingUnmatched && parens.length >= 2) {
      message += `${position(parens[parens.length - 1]!)} does not match ${position(parens[parens.length - 2]!)}.`;
    } else if (closingUnmatched) {
      message += `${position(parens[parens.length - 1]!)} has no matching opening bracket.`;
    } else {
      message += parens.map(position).join(", ");
      message += parens.length === 1 ? " is never closed." : " are never closed.";
    }
    return { token, message };
  }

  /** The index of the first ';' or end token at or after `i`. */
  private statementEndIndex(toks: Token[], i: number): number {
    while (toks[i]!.kind !== T.Semicolon && toks[i]!.kind !== T.EndOfStream) i++;
    return i;
  }

  /** Checks one statement and returns the offset where the next one may start. */
  checkStatement(statement: Statement): number {
    const { toks, start, begin } = statement;
    const sql = this.sql;
    const endIndex = this.statementEndIndex(toks, start);
    const afterStatement = toks[endIndex]!.end;

    const startsWithInsert = (() => {
      const probe = new P(toks, sql, start);
      return kwQuiet(probe, "INSERT INTO");
    })();
    if (!startsWithInsert) {
      for (let i = start; i < endIndex; i++) {
        const token = toks[i]!;
        if (isErrorKind(token.kind)) {
          this.reportToken(token, LEXER_ERROR_MESSAGES[token.kind]!);
          return this.statementEndAfterError(toks, i);
        }
      }
    }

    const p = new P(toks, sql, start);
    let node: Ast | null;
    try {
      node = parseQuery(p);
    } catch (error) {
      if (error instanceof ParseError) {
        this.reportToken(toks[Math.min(error.tokenIndex, endIndex)]!, error.message);
        return afterStatement;
      }
      if (error instanceof RangeError) {
        this.reportToken(toks[start]!, `Maximum parse depth (${MAX_PARSER_DEPTH}) exceeded. Consider rising max_parser_depth parameter.`);
        return afterStatement;
      }
      throw error;
    }
    const lastIndex = p.maxIndex;
    const last = toks[lastIndex]!;

    const data = node ? insertData(node) : undefined;
    if (data !== undefined) return this.insertDataEnd(node!, data, toks);

    if (isErrorKind(last.kind)) {
      this.reportToken(last, LEXER_ERROR_MESSAGES[last.kind]!);
      return this.statementEndAfterError(toks, lastIndex);
    }

    const statementEnd = Math.max(afterStatement, last.end);
    const parens = this.unmatchedParentheses(toks, start).filter((token) => token.start >= begin && token.start < statementEnd);
    if (parens.length) {
      const { token, message } = this.unmatchedMessage(parens, last, begin, statementEnd);
      this.reportToken(token, message);
      return afterStatement;
    }

    if (!node) {
      this.reportToken(this.clamp(toks, lastIndex, endIndex), expectedMessage(last, sql, p.e));
      return afterStatement;
    }
    const stop = toks[Math.min(p.i, toks.length - 1)]!;
    if (stop.kind !== T.EndOfStream && stop.kind !== T.Semicolon) {
      p.e.add(lastIndex, "end of query");
      this.reportToken(this.clamp(toks, lastIndex, endIndex), expectedMessage(last, sql, p.e));
      return afterStatement;
    }
    // A query may run past a ';', like COPY to an unsupported target; the next one starts after it.
    if (p.i > endIndex) return stop.kind === T.Semicolon ? stop.end : stop.start;
    return afterStatement;
  }

  /** An error past the end of the statement is shown at its ';'. */
  private clamp(toks: Token[], index: number, endIndex: number): Token {
    return toks[Math.min(index, endIndex)]!;
  }

  /** After a lexical error, the statement ends at the next ';' after the bad token. */
  private statementEndAfterError(toks: Token[], index: number): number {
    return toks[this.statementEndIndex(toks, index)]!.end;
  }

  /**
   * Where the inline data of an INSERT ends, as in clickhouse-client: VALUES data (and FORMAT Values)
   * at a ';' outside brackets, other formats at the first empty line.
   */
  private insertDataEnd(node: Ast, data: number, toks: Token[]): number {
    const insert = node.kind === "InsertQuery" ? node : node.get("query")!;
    if (insert.has("values") || insert.name === "Values") {
      let i = toks.findIndex((token) => token.start >= data);
      let depth = 0;
      for (; i < toks.length; i++) {
        const kind = toks[i]!.kind;
        if (kind === T.EndOfStream) return toks[i]!.start;
        if (kind === T.OpeningRoundBracket || kind === T.OpeningSquareBracket || kind === T.OpeningCurlyBrace) depth++;
        else if (kind === T.ClosingRoundBracket || kind === T.ClosingSquareBracket || kind === T.ClosingCurlyBrace) depth--;
        else if (kind === T.Semicolon && depth <= 0) return toks[i]!.end;
      }
      return this.sql.length;
    }
    const blank = this.sql.indexOf("\n\n", data);
    return blank === -1 ? this.sql.length : blank + 2;
  }
}

/** The inline data offset of an INSERT, or of the INSERT that EXPLAIN explains. */
function insertData(node: Ast): number | undefined {
  if (node.kind === "InsertQuery") return node.data;
  if (node.kind === "ExplainQuery") {
    const query = node.get("query");
    if (query?.kind === "InsertQuery") return query.data;
  }
  return undefined;
}

/** The tokens of the input; after inline data the rest may have to be lexed again. */
class TokenStream {
  all: Token[];
  significant: Token[];

  constructor(private readonly sql: string) {
    this.all = tokenize(sql);
    this.significant = this.all.filter((token) => isSignificant(token.kind));
  }

  /** Makes sure that lexing from `offset` gives the tokens that follow it, and returns the first one. */
  firstFrom(offset: number): number {
    const index = this.search(this.all, offset);
    const crossing = index > 0 ? this.all[index - 1]! : undefined;
    const first = this.all[index];
    const aligned =
      (!crossing || crossing.end <= offset || crossing.kind === T.Whitespace) && this.sql[first?.start ?? 0] !== ".";
    if (!aligned) {
      const kept = this.all.filter((token) => token.end <= offset);
      const rest = tokenize(this.sql.slice(offset)).map((token) => ({
        ...token,
        start: token.start + offset,
        end: token.end + offset,
      }));
      this.all = [...kept, ...rest];
      this.significant = this.all.filter((token) => isSignificant(token.kind));
    }
    return this.search(this.significant, offset);
  }

  /** The index of the first token that starts at or after `offset`. */
  private search(tokens: Token[], offset: number): number {
    let lo = 0;
    let hi = tokens.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tokens[mid]!.start >= offset) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }
}

/** Returns the syntax errors of every statement in `sql`. */
export function check(sql: string): Diagnostic[] {
  const checker = new Checker(sql);
  const stream = new TokenStream(sql);
  let offset = 0;
  while (offset < sql.length) {
    // Skip whitespace and ';' like clickhouse-client.
    let begin = offset;
    while (begin < sql.length && (/\s/.test(sql[begin]!) || sql[begin] === ";")) begin++;
    if (begin >= sql.length) break;
    const start = stream.firstFrom(begin);
    const first = stream.significant[start]!;
    if (first.kind === T.EndOfStream) break;
    // An empty statement after a comment.
    if (first.kind === T.Semicolon) {
      offset = first.end;
      continue;
    }
    const next = checker.checkStatement({ begin, toks: stream.significant, start });
    if (next <= offset) break;
    offset = next;
  }
  return checker.diagnostics;
}
