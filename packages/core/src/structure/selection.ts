/**
 * selectionRanges(): for each offset, the pieces of the input around it from the token outward, for an
 * editor's Expand Selection: the parts that the formatter's analyze() reads, such as names, calls,
 * bracket groups and what they hold, expressions, list items, clauses and queries, then the statement.
 */
import { split, type Unit } from "../format/index.js";
import { checkWithRoles, type ParseCache, type RoleSpan } from "../parser/index.js";
import { type TextRange, type Token, TokenKind as T } from "../types.js";
import { Statement } from "./statement.js";

/** Tokens that a cursor right after a word does not belong to: brackets, commas, dots and operators. */
const WORDS = new Set([T.BareWord, T.QuotedIdentifier, T.Number, T.StringLiteral, T.HereDoc, T.Comment]);

/** Where an offset is: the token it is in, if any, and the ranges found around it so far. */
interface Anchor {
  offset: number;
  token?: TextRange;
  around: TextRange[];
}

export function selectionRanges(sql: string, offsets: readonly number[], cache?: ParseCache): TextRange[][] {
  const units = split(sql);
  const byUnit = new Map<Unit, Anchor[]>();
  const anchors = offsets.map((offset): Anchor => {
    const at = Math.max(0, Math.min(offset, sql.length));
    const unit = unitAt(units, at);
    const anchor: Anchor = { offset: at, token: unit && tokenAt(sql, unit, at), around: [] };
    if (unit) {
      const list = byUnit.get(unit);
      if (list) list.push(anchor);
      else byUnit.set(unit, [anchor]);
    }
    return anchor;
  });
  let spans: RoleSpan[] | undefined;
  for (const [unit, inUnit] of byUnit) {
    if (!unit.statement) {
      // A paragraph of comments.
      for (const anchor of inUnit) anchor.around.push({ start: unit.start, end: unit.end });
      continue;
    }
    spans ??= checkWithRoles(sql, cache).spans;
    collect(new Statement(sql, unit, spans), unit, inUnit);
  }
  return anchors.map(chain);
}

/** The unit that holds `at`, the later one where one ends and the next begins. */
function unitAt(units: Unit[], at: number): Unit | undefined {
  let lo = 0;
  let hi = units.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (units[mid]!.start <= at) lo = mid;
    else hi = mid - 1;
  }
  const unit = units[lo];
  return unit && unit.start <= at && at <= unit.end ? unit : undefined;
}

/** The token or inline data at `at`: the one it is in, or a word it is right after. */
function tokenAt(sql: string, unit: Unit, at: number): TextRange | undefined {
  const { data } = unit;
  if (data.start >= 0) {
    // Without the whitespace after VALUES or the name of the format.
    const start = data.end - sql.slice(data.start, data.end).trimStart().length;
    if (start <= at && at <= data.end) return { start, end: data.end };
  }
  const tokens = unit.tokens;
  let lo = 0;
  let hi = tokens.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tokens[mid]!.start <= at) lo = mid;
    else hi = mid - 1;
  }
  const solid = (token: Token | undefined): token is Token => !!token && token.kind !== T.Whitespace && token.end > token.start;
  const inside = tokens[lo]!.start <= at && at < tokens[lo]!.end ? tokens[lo] : undefined;
  const before = inside ? tokens[lo - 1] : tokens[lo];
  const left = solid(before) && before.end === at ? before : undefined;
  const pick = solid(inside) && !(left && WORDS.has(left.kind) && !WORDS.has(inside.kind)) ? inside : left;
  return pick && { start: pick.start, end: pick.end };
}

/** Adds to each anchor of a statement the pieces of the statement around it. */
function collect(st: Statement, unit: Unit, anchors: Anchor[]): void {
  // Anchors in order, so that the ones a piece holds are a run of them.
  const sorted = [...anchors].sort((a, b) => from(a) - from(b));
  const add = (start: number, end: number): void => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (from(sorted[mid]!) < start) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < sorted.length && to(sorted[i]!) <= end; i++) sorted[i]!.around.push({ start, end });
  };
  const { sig, match } = st;
  const tokens = (a: number, b: number): void => add(sig[a]!.start, sig[b - 1]!.end);
  st.analyze((_, a, b) => tokens(a, b));
  // Every bracket group and what it holds, also where analyze() reads none or nests too deep to run.
  for (let i = 0; i < sig.length; i++) {
    if (match[i]! <= i) continue;
    tokens(i, match[i]! + 1);
    if (match[i]! > i + 1) tokens(i + 1, match[i]!);
  }
  let last = sig.length;
  while (last > 1 && sig[last - 1]!.kind === T.Semicolon) last--;
  tokens(0, last);
  add(unit.statement!.start, unit.statement!.end);
  // The statement with the comments that belong to it.
  add(unit.start, unit.end);
}

const from = (anchor: Anchor): number => anchor.token?.start ?? anchor.offset;
const to = (anchor: Anchor): number => anchor.token?.end ?? anchor.offset;

/** The token and the pieces around it, each one holding the one before it. */
function chain(anchor: Anchor): TextRange[] {
  const ranges = anchor.token ? [anchor.token] : [];
  const around = anchor.around.sort((a, b) => a.end - a.start - (b.end - b.start));
  for (const range of around) {
    const inner = ranges[ranges.length - 1];
    if (inner && !(range.start <= inner.start && inner.end <= range.end && range.end - range.start > inner.end - inner.start)) continue;
    ranges.push(range);
  }
  return ranges;
}
