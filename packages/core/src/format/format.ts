/**
 * format(): lays out every valid statement the way `clickhouse format` does, changing only
 * whitespace and the case of keywords. Invalid statements are returned as they are.
 */
import { tokenize } from "../lexer/index.js";
import { check, checkWithRoles, type Role } from "../parser/index.js";
import { type FormatOptions, type KeywordCase, TokenKind as T, type Token } from "../types.js";
import { analyze, type Shape, type Tok } from "./analyze.js";
import { type Note, type Piece, print } from "./print.js";
import { lineBreaks, split, type Unit } from "./split.js";
import { KEYWORD_WORDS } from "./words.js";

const DEFAULT_INDENT = 4;

export function format(sql: string, options: FormatOptions = {}): string {
  if (sql.trim() === "") return sql;
  const keywordCase = options.keywordCase === "lower" || options.keywordCase === "preserve" ? options.keywordCase : "upper";
  const size = options.indentSize ?? DEFAULT_INDENT;
  const unit = " ".repeat(Number.isFinite(size) && size > 0 ? Math.floor(size) : size === 0 ? 0 : DEFAULT_INDENT);

  const units = split(sql);
  const parts = units.map((u) => prepare(sql, u));
  const eol = lineEnd(sql, units, parts);
  // A byte order mark is whitespace to the lexer, but it stays at the start.
  let out = sql.startsWith("\uFEFF") ? "\uFEFF" : "";
  units.forEach((u, k) => {
    // Inline data that ended at an empty line needs that "\n\n" to end there again.
    if (k > 0) out += units[k - 1]!.data.blankLine ? "\n\n" : eol + eol;
    out += formatUnit(sql, u, parts[k]!, keywordCase, unit, eol);
  });
  // A line break after the last unit, or the "\r" that ends its last line comment, ends the output too.
  const last = units[units.length - 1]!;
  const gap = sql.slice(last.end);
  const lastToken = last.tokens[last.tokens.length - 1];
  if (/[\r\n]$/.test(gap) || (lastToken?.kind === T.Comment && lastToken.end === sql.length && sql.endsWith("\r"))) out += eol;
  return out;
}

/** Roles of words that are names or literals, never keywords. */
const NAME_ROLES = new Set<Role | undefined>(["identifier", "setting", "parameter", "number"]);

/** A unit read and laid out, to be printed with the line break of the output. */
interface Part {
  /** The role of each word as the parser reads it, by its offset in sql. */
  roles: Map<number, Role>;
  piece: Piece;
  shape: Shape;
}

/** Reads a unit; null for a statement that check() rejects. */
function prepare(sql: string, unit: Unit): Part | null {
  const roles = new Map<number, Role>();
  if (unit.statement) {
    const { diagnostics, spans } = checkWithRoles(sql.slice(unit.statement.start, unit.statement.end));
    if (diagnostics.length > 0) return null;
    for (const span of spans) roles.set(unit.statement.start + span.start, span.role);
  }
  const piece = toPiece(sql, unit, roles);
  return { roles, piece, shape: analyze(piece.sig) };
}

function formatUnit(sql: string, unit: Unit, part: Part | null, keywordCase: KeywordCase, indent: string, eol: string): string {
  let original = sql.slice(unit.start, unit.end);
  // A line comment at the end keeps its "\r", which the eol written after the unit would double.
  const last = unit.tokens[unit.tokens.length - 1];
  if (eol !== "\n" && last?.kind === T.Comment && last.end === unit.end) original = original.replace(/\r$/, "");
  if (!part) return original;
  const text = print(part.piece, part.shape, keywordCase, indent, eol);
  // A last safety net: the same tokens and comments, only keywords re-cased, and still valid.
  const keywordAt = (offset: number): boolean => part.roles.get(unit.start + offset) === "keyword";
  if (!sameTokens(original, text, keywordAt) || (unit.statement && check(text).length > 0)) return original;
  return text;
}

/** The line break of the output; "\r" alone only when no line comment needs a "\n" to end before more text. */
function lineEnd(sql: string, units: Unit[], parts: (Part | null)[]): string {
  const eol = firstLineBreak(sql, units, parts);
  const lineComment = (t: Token): boolean => t.kind === T.Comment && !sql.startsWith("/*", t.start) && t.end < sql.length;
  return eol === "\r" && units.some((u) => u.tokens.some(lineComment)) ? "\n" : eol;
}

/**
 * The first line break in whitespace that format() writes again, else in whitespace that it keeps, else in
 * inline data, else "\n". The "\r" that ends a line comment starts the break after it.
 */
function firstLineBreak(sql: string, units: Unit[], parts: (Part | null)[]): string {
  let kept: string | undefined;
  let data: string | undefined;
  const breakAfter = (previous: Token | undefined, from: number, to: number): string | undefined => {
    if (previous?.kind === T.Comment && sql[previous.end - 1] === "\r") return sql[from] === "\n" ? "\r\n" : "\r";
    return /\r\n|\n|\r/.exec(sql.slice(from, to))?.[0];
  };
  for (let k = 0; k < units.length; k++) {
    const u = units[k]!;
    const part = parts[k];
    // Literals printed as written keep their whitespace, and so does a statement that check() rejects.
    const verbatim: [number, number][] = [];
    part?.shape.verbatim.forEach((close, i) => {
      if (close >= 0) verbatim.push([part.piece.sig[i]!.end, part.piece.sig[close]!.end]);
    });
    let v = 0;
    let previous: Token | undefined;
    for (const token of u.tokens) {
      if (token.kind === T.Whitespace) {
        const found = breakAfter(previous, token.start, token.end);
        while (v < verbatim.length && verbatim[v]![1] <= token.start) v++;
        const isKept = !part || (v < verbatim.length && verbatim[v]![0] <= token.start);
        if (found && !isKept) return found;
        if (found) kept ??= found;
      }
      previous = token;
    }
    if (u.data.start >= 0) data ??= /\r\n|\n|\r/.exec(sql.slice(u.data.start, u.data.end))?.[0];
    // The gap after data that ended at an empty line is always "\n\n".
    if (u.data.blankLine) continue;
    const gap = breakAfter(u.tokens[u.tokens.length - 1], u.end, units[k + 1]?.start ?? sql.length);
    if (gap) return gap;
  }
  return kept ?? data ?? "\n";
}

/** The significant tokens of a unit with the comments around them. */
function toPiece(sql: string, unit: Unit, roles: Map<number, Role>): Piece {
  const sig: Tok[] = [];
  const notes: Note[][] = [[]];
  const gaps: number[] = [];
  let breaks = 1;
  let separated = false;
  let last: Note | undefined;
  const pushData = (end: number): void => {
    if (unit.data.start !== end) return;
    sig.push({ kind: T.StringLiteral, text: sql.slice(unit.data.start, unit.data.end), up: "", start: unit.data.start, end: unit.data.end, data: true });
    gaps.push(0);
    notes.push([]);
  };
  for (const token of unit.tokens) {
    const text = sql.slice(token.start, token.end);
    if (token.kind === T.Whitespace) {
      const count = lineBreaks(text);
      breaks += count;
      if (count > 0 && last) last.newlineAfter = true;
      separated = true;
    } else if (token.kind === T.Comment) {
      const line = !text.startsWith("/*");
      // print() writes the line break after a line comment, so its "\r" goes.
      const note: Note = { text: line ? text.replace(/\r$/, "") : text, ownLine: breaks > 0, newlineAfter: false, line };
      notes[notes.length - 1]!.push(note);
      last = note;
      breaks = 0;
      separated = true;
    } else if (token.kind !== T.EndOfStream) {
      const role = roles.get(token.start);
      const up = token.kind === T.BareWord && !NAME_ROLES.has(role) ? text.toUpperCase() : "";
      sig.push({ kind: token.kind, text, up, keyword: role === "keyword", start: token.start, end: token.end });
      gaps.push(separated ? 1 : 0);
      notes.push([]);
      breaks = 0;
      separated = false;
      last = undefined;
      pushData(token.end);
    }
  }
  return { sig, notes, gap: Uint8Array.from(gaps), sql };
}

/** Whether two texts have the same tokens, apart from whitespace and the case of the keywords that keywordAt() finds in a. */
export function sameTokens(a: string, b: string, keywordAt: (start: number) => boolean): boolean {
  const x = tokenize(a).filter((t) => t.kind !== T.Whitespace);
  const y = tokenize(b).filter((t) => t.kind !== T.Whitespace);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    const s = x[i]!;
    const t = y[i]!;
    if (s.kind !== t.kind) return false;
    let p = a.slice(s.start, s.end);
    let q = b.slice(t.start, t.end);
    if (s.kind === T.Comment) {
      p = p.replace(/\r$/, "");
      q = q.replace(/\r$/, "");
    }
    if (p === q) continue;
    if (s.kind !== T.BareWord || p.toUpperCase() !== q.toUpperCase() || !KEYWORD_WORDS.has(p.toUpperCase()) || !keywordAt(s.start)) return false;
  }
  return true;
}
