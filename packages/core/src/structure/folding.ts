/**
 * foldingRanges(): the lines an editor can fold. Statements, bracket groups and block comments of
 * several lines, runs of line comments, and -- #region blocks; inline INSERT data is never looked into.
 */
import { split } from "../format/index.js";
import { type FoldingRange, TokenKind as T } from "../types.js";

const CLOSER = new Map([
  [T.OpeningRoundBracket, T.ClosingRoundBracket],
  [T.OpeningSquareBracket, T.ClosingSquareBracket],
  [T.OpeningCurlyBrace, T.ClosingCurlyBrace],
]);
const CLOSERS = new Set(CLOSER.values());

// The markers of VS Code's own SQL support, on a line of their own.
const REGION = /^--\s*#region\b/;
const END_REGION = /^--\s*#endregion\b/;

/** A range to fold before its last line is chosen: its first line and the line of its last character. */
interface Candidate {
  start: number;
  last: number;
  /** A bracket group, whose last line stays in view when it can. */
  bracket: boolean;
  kind?: FoldingRange["kind"];
}

/** Line numbers from 1 of offsets, with lines ending at "\n", "\r\n" or a lone "\r". */
class Lines {
  private readonly starts: number[] = [0];

  constructor(text: string) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) this.starts.push(i + 1);
    }
  }

  get count(): number {
    return this.starts.length;
  }

  at(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
}

export function foldingRanges(sql: string): FoldingRange[] {
  const lines = new Lines(sql);
  // crossed[k] is 1 when a token other than whitespace, or inline data, runs on from line k to line k + 1.
  const crossed = new Uint8Array(lines.count + 2);
  const candidates: Candidate[] = [];
  /** The first line of a piece of the input and the line of its last character. */
  const span = (start: number, end: number): [number, number] => [lines.at(start), lines.at(Math.max(start, end - 1))];
  /** The same for a token or inline data, which no fold may cut. */
  const piece = (start: number, end: number): [number, number] => {
    const [first, last] = span(start, end);
    for (let k = first; k < last; k++) crossed[k] = 1;
    return [first, last];
  };

  const regions: number[] = [];
  let run: [number, number] | undefined;
  const endRun = (): void => {
    if (run && run[1] > run[0]) candidates.push({ start: run[0], last: run[1], bracket: false, kind: "comment" });
    run = undefined;
  };
  // The last line of the last token that is not whitespace, to tell a comment on a line of its own.
  let previous = 0;

  for (const unit of split(sql)) {
    if (unit.statement) {
      const [first, last] = span(unit.statement.start, unit.statement.end);
      if (last > first) candidates.push({ start: first, last, bracket: false });
    }
    let data = unit.data.start >= 0 ? unit.data : undefined;
    const open: { kind: T; line: number }[] = [];
    for (const token of unit.tokens) {
      if (token.kind === T.Whitespace || token.kind === T.EndOfStream) continue;
      if (data && token.start >= data.end) {
        previous = piece(data.start, data.end)[1];
        data = undefined;
      }
      const [first, last] = piece(token.start, token.end);
      if (token.kind === T.Comment) {
        const text = sql.slice(token.start, token.end);
        const ownLine = first > previous;
        if (text.startsWith("/*")) {
          endRun();
          if (last > first) candidates.push({ start: first, last, bracket: false, kind: "comment" });
        } else if (ownLine && REGION.test(text)) {
          endRun();
          regions.push(first);
        } else if (ownLine && END_REGION.test(text)) {
          endRun();
          const start = regions.pop();
          if (start !== undefined) candidates.push({ start, last, bracket: false, kind: "region" });
        } else if (ownLine && run && first === run[1] + 1) {
          run[1] = last;
        } else {
          endRun();
          if (ownLine) run = [first, last];
        }
      } else {
        endRun();
        const closer = CLOSER.get(token.kind);
        if (closer !== undefined) {
          open.push({ kind: closer, line: first });
        } else if (CLOSERS.has(token.kind) && open[open.length - 1]?.kind === token.kind) {
          const start = open.pop()!.line;
          if (first > start) candidates.push({ start, last: first, bracket: true });
        }
      }
      previous = last;
    }
    if (data) previous = piece(data.start, data.end)[1];
  }
  endRun();
  return nest(candidates, crossed);
}

/**
 * Picks the last folded line of each candidate so that no token runs out of the fold, and keeps one
 * range per first line and only ranges that nest, as VS Code needs them.
 */
function nest(candidates: Candidate[], crossed: Uint8Array): FoldingRange[] {
  const ranges: FoldingRange[] = [];
  for (const c of candidates) {
    // A closing bracket stays in view unless a token runs on into its line.
    const options = c.bracket ? [crossed[c.last - 1] ? c.last : c.last - 1] : [c.last, c.last - 1];
    const end = options.find((line) => line > c.start && !crossed[line]);
    if (end === undefined) continue;
    ranges.push(c.kind ? { startLine: c.start, endLine: end, kind: c.kind } : { startLine: c.start, endLine: end });
  }
  ranges.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
  const result: FoldingRange[] = [];
  const enclosing: FoldingRange[] = [];
  for (const range of ranges) {
    if (result[result.length - 1]?.startLine === range.startLine) continue;
    while (enclosing.length && enclosing[enclosing.length - 1]!.endLine < range.startLine) enclosing.pop();
    if (enclosing.length && range.endLine > enclosing[enclosing.length - 1]!.endLine) continue;
    result.push(range);
    enclosing.push(range);
  }
  return result;
}
