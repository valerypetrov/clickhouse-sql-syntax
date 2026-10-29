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
