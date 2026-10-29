/** Prints a statement from its tokens, comments and the shape that analyze() found. */
import { type KeywordCase, TokenKind as T } from "../types.js";
import { GLUE_AFTER, GLUE_BEFORE, MAP_COLON, type Shape, type Tok } from "./analyze.js";

/** A comment and where it stood in the source. */
export interface Note {
  text: string;
  /** Nothing but whitespace before it on its line. */
  ownLine: boolean;
  /** A line break follows it. */
  newlineAfter: boolean;
  /** A -- # or // comment, which runs to the end of the line. */
  line: boolean;
}

export interface Piece {
  sig: Tok[];
  /** notes[i] are the comments before sig[i]; notes[sig.length] are the ones after the last token. */
  notes: Note[][];
  /** Whether anything (whitespace or a comment) separated sig[i] from sig[i - 1] in the source. */
  gap: Uint8Array;
  /** The source, for query parameters printed as written. */
  sql: string;
}

/** Collects lines with their indent. */
class Writer {
  private readonly lines: string[] = [];
  private text = "";
  indent = 0;
  /** A line comment ended the current line. */
  mustBreak = false;

  constructor(
    private readonly unit: string,
    private readonly eol: string,
  ) {}

  get empty(): boolean {
    return this.text === "";
  }

  endsWith(s: string): boolean {
    return this.text.endsWith(s);
  }

  newline(indent: number): void {
    if (this.text !== "") this.lines.push(this.unit.repeat(this.indent) + this.text);
    this.text = "";
    this.indent = indent;
    this.mustBreak = false;
  }

  write(s: string, space: boolean): void {
    if (this.text !== "" && space) this.text += " ";
    this.text += s;
  }

  done(): string {
    this.newline(0);
    return this.lines.join(this.eol);
  }
}

const OPENING = new Set([T.OpeningRoundBracket, T.OpeningSquareBracket]);
const CLOSING = new Set([T.ClosingRoundBracket, T.ClosingSquareBracket, T.ClosingCurlyBrace]);
const NO_SPACE_BEFORE = new Set([T.Comma, T.Semicolon, T.VerticalDelimiter, T.Dot, T.DoubleColon, ...CLOSING]);
/** Tokens that stay right after a comment, such as a comma. */
const AFTER_COMMENT_GLUED = new Set([T.Comma, T.Semicolon, T.ClosingRoundBracket, T.ClosingSquareBracket]);
const NO_SPACE_AFTER = new Set([T.Dot, T.DoubleColon, T.OpeningCurlyBrace, ...OPENING]);

/** Characters that could join two tokens into one if nothing separated them. */
function isWordChar(c: string): boolean {
  return /[A-Za-z0-9_$]/.test(c) || c > "\x7f";
}
const OPERATOR_CHARS = "+-*/%<>=!|:?~@^&.#";

/** Whether printing `a` right before `b` could lex differently from the two tokens. */
function wouldJoin(a: string, b: string): boolean {
  const x = a[a.length - 1]!;
  const y = b[0]!;
  if (isWordChar(x) && (isWordChar(y) || y === "'" || y === '"' || y === "`")) return true;
  if (OPERATOR_CHARS.includes(x) && OPERATOR_CHARS.includes(y)) return true;
  return /[0-9]/.test(x) ? y === "." : x === "." && /[0-9]/.test(y);
}

export function print(piece: Piece, shape: Shape, keywordCase: KeywordCase, unit: string, eol: string): string {
  const { sig, notes, gap } = piece;
  const w = new Writer(unit, eol);
  const blocks: { outer: number; base: number; cont: number }[] = [];
  let base = 0;
  let cont = 1;
  let pending = -1;
  const textOf = (i: number): string => {
    const t = sig[i]!;
    if (!shape.keyword[i] || keywordCase === "preserve") return t.text;
    return keywordCase === "upper" ? t.text.toUpperCase() : t.text.toLowerCase();
  };

  /** Prints comments before a token; returns true when the token may stay on the comment's line. */
  const comments = (list: Note[], indent: number): boolean => {
    let inline = false;
    for (const note of list) {
      if (!note.ownLine && !w.empty) {
        w.write(note.text, note.line || (!w.endsWith("(") && !w.endsWith("[")));
      } else {
        w.newline(indent);
        w.write(note.text, false);
      }
      w.mustBreak = note.line || (note.ownLine && note.newlineAfter);
      inline = note.ownLine && !note.line && !note.newlineAfter;
    }
    return inline;
  };

  for (let i = 0; i < sig.length; i++) {
    const t = sig[i]!;
    const open = shape.match[i]!;
    let target = -1;
    let noteIndent: number;
    if (CLOSING.has(t.kind) && open >= 0 && shape.block[open]) {
      const block = blocks.pop()!;
      noteIndent = block.outer + 1;
      target = block.outer;
      base = block.base;
      cont = block.cont;
    } else {
      if (shape.brk[i]! >= 0) target = base + shape.brk[i]!;
      else if (pending >= 0) target = pending;
      if (i === 0) target = 0;
      noteIndent = target >= 0 ? target : cont;
    }
    pending = -1;
    const stayInline = comments(notes[i]!, noteIndent);
    let space = true;
    if (w.mustBreak) {
      w.newline(target >= 0 ? target : t.kind === T.Semicolon ? 0 : cont);
      if (target >= 0) cont = target + 1;
    } else if (target >= 0 && !(stayInline && notes[i]!.length > 0)) {
      w.newline(target);
      cont = target + 1;
    } else if (notes[i]!.length === 0 && i > 0) {
      space = spaceBetween(sig, shape, gap, i);
    } else if (notes[i]!.length > 0) {
      space = !AFTER_COMMENT_GLUED.has(t.kind);
    }
    if (t.data) {
      // Inline INSERT data, with the whitespace before it, exactly as written.
      w.write(t.text, false);
      continue;
    }
    w.write(textOf(i), space);
    if (shape.verbatim[i]! >= 0) {
      const close = shape.verbatim[i]!;
      w.write(piece.sql.slice(t.end, sig[close]!.end), false);
      i = close;
      continue;
    }
    if (shape.block[i]) {
      blocks.push({ outer: w.indent, base, cont });
      base = w.indent + 1;
      pending = base;
      cont = base + 1;
    }
  }
  comments(notes[sig.length]!, 0);
  return w.done();
}

/** Whether a space goes between sig[i - 1] and sig[i] on one line. */
function spaceBetween(sig: Tok[], shape: Shape, gap: Uint8Array, i: number): boolean {
  const a = sig[i - 1]!;
  const b = sig[i]!;
  let space = true;
  if (shape.glue[i - 1]! & GLUE_AFTER || shape.glue[i]! & GLUE_BEFORE) space = false;
  else if (NO_SPACE_BEFORE.has(b.kind) || NO_SPACE_AFTER.has(a.kind)) space = false;
  else if (b.kind === T.Colon && shape.glue[i]! & MAP_COLON) space = false;
  else if (a.kind === T.At || a.kind === T.DoubleAt || a.kind === T.DollarSign) space = false;
  // Keep a space that the source had when dropping it could join the two tokens.
  if (!space && gap[i] && wouldJoin(a.text, b.text)) space = true;
  return space;
}

