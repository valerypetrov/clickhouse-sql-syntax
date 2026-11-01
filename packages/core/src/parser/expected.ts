/**
 * What the parser accepts at a position, for completion: the variants that ClickHouse's
 * Expected collects there, such as "FROM", "identifier" or "data type".
 */
import { type Token, TokenKind as T } from "../types.js";
import { parseQuery } from "./query.js";
import { Budget, OutOfBudget, P, ParseError } from "./state.js";

/** A token kind that no parser accepts. Unlike the end of input, it lets the expression parser try an operand. */
const NOTHING = "Nothing" as T;

/** Enough backtracks for any statement a person types, and a few milliseconds of work. */
const BACKTRACKS = 50_000;
/** What the keywords of one place may take together to be tried: a fifth of that, and 100,000 tokens parsed. */
const PROBE_BACKTRACKS = 10_000;
const PROBE_TOKENS = 100_000;

/**
 * The Expected variants at `offset`, after the significant tokens `before` of one statement.
 * The parser reads them followed by a token it never accepts, so it records all it tries there.
 */
export function expectedAt(sql: string, before: Token[], offset: number): string[] {
  const stop: Token = { kind: NOTHING, start: offset, end: offset, line: 0, col: 0 };
  const toks = [...before, stop, { ...stop, kind: T.EndOfStream }];
  const budget = new Budget();
  budget.backtracks = BACKTRACKS;
  const p = new P(toks, sql, 0, budget);
  try {
    parseQuery(p);
  } catch (error) {
    if (error instanceof OutOfBudget || error instanceof RangeError) return [];
    if (!(error instanceof ParseError)) throw error;
  }
  return p.e.pos === before.length ? p.e.variants : [];
}

/** acceptsKeyword() for the keywords of one place, which share one budget of backtracks and tokens; past it, all pass. */
export function keywordFilter(sql: string, before: Token[], offset: number): (keyword: string) => boolean {
  const budget = new Budget();
  budget.backtracks = PROBE_BACKTRACKS;
  budget.tokens = PROBE_TOKENS;
  // Some parsers look for a bracket after a keyword without saying so in Expected, as after Int32 SIGNED.
  const closers: T[] = [];
  for (const token of before) {
    if (token.kind === T.OpeningRoundBracket) closers.unshift(T.ClosingRoundBracket);
    else if (token.kind === T.OpeningSquareBracket) closers.unshift(T.ClosingSquareBracket);
    else if (token.kind === T.ClosingRoundBracket || token.kind === T.ClosingSquareBracket) closers.shift();
  }
  return (keyword) => acceptsKeyword(sql, before, offset, keyword, closers, budget);
}

/**
 * Whether a keyword of expectedAt() can come next: the parser neither throws at it, as at FETCH
 * without ORDER BY, nor stops before its end, as at SYSTEM END. Expected lists such keywords too.
 */
function acceptsKeyword(sql: string, before: Token[], offset: number, keyword: string, closers: T[], budget: Budget): boolean {
  for (const opening of [[], [T.OpeningRoundBracket, T.ClosingRoundBracket]]) {
    for (let k = 0; k <= closers.length; k++) {
      const verdict = probe(sql, before, offset, keyword, [...opening, ...closers.slice(0, k)], budget);
      if (verdict !== undefined) return verdict;
    }
  }
  return false;
}

const BRACKETS: Partial<Record<T, string>> = {
  [T.OpeningRoundBracket]: "(",
  [T.ClosingRoundBracket]: ")",
  [T.ClosingSquareBracket]: "]",
};

/** Parses the keyword and the brackets `after` it: false if it throws at the keyword, undefined if it stops before their end. */
function probe(sql: string, before: Token[], offset: number, keyword: string, after: T[], budget: Budget): boolean | undefined {
  // Each probe parses the tokens before the keyword again.
  budget.tokens -= before.length;
  if (budget.tokens < 0) return true;
  const toks = [...before];
  let text = sql.slice(0, offset);
  const add = (kind: T, word: string) => {
    toks.push({ kind, start: text.length, end: text.length + word.length, line: 0, col: 0 });
    text += `${word} `;
  };
  for (const word of keyword.split(" ")) add(T.BareWord, word);
  const end = toks.length;
  for (const kind of after) add(kind, BRACKETS[kind]!);
  const stop: Token = { kind: NOTHING, start: text.length, end: text.length, line: 0, col: 0 };
  toks.push(stop, { ...stop, kind: T.EndOfStream });
  const p = new P(toks, text, 0, budget);
  let node = null;
  try {
    node = parseQuery(p);
  } catch (error) {
    if (error instanceof OutOfBudget || error instanceof RangeError) return true;
    if (!(error instanceof ParseError)) throw error;
    if (error.tokenIndex >= before.length && error.tokenIndex < end) return false;
  }
  const past = end + after.length;
  return p.e.pos >= past || (node !== null && p.i >= past) ? true : undefined;
}
