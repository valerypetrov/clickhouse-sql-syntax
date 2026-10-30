/**
 * format(): lays out every valid statement the way `clickhouse format` does, changing only
 * whitespace and the case of keywords. Invalid statements are returned as they are.
 */
import { tokenize } from "../lexer/index.js";
import { check, checkWithRoles, type Role } from "../parser/index.js";
import { type FormatOptions, type KeywordCase, TokenKind as T } from "../types.js";
import { analyze, type Tok } from "./analyze.js";
import { type Note, type Piece, print } from "./print.js";
import { lineBreaks, split, type Unit } from "./split.js";
import { KEYWORD_WORDS } from "./words.js";

const DEFAULT_INDENT = 4;

export function format(sql: string, options: FormatOptions = {}): string {
  if (sql.trim() === "") return sql;
  const keywordCase = options.keywordCase === "lower" || options.keywordCase === "preserve" ? options.keywordCase : "upper";
  const size = options.indentSize ?? DEFAULT_INDENT;
  const unit = " ".repeat(Number.isFinite(size) && size > 0 ? Math.floor(size) : size === 0 ? 0 : DEFAULT_INDENT);
  const firstBreak = /\r\n|\n|\r/.exec(sql)?.[0];
  const eol = firstBreak === "\r\n" ? "\r\n" : "\n";

  const units = split(sql);
  let out = "";
  units.forEach((u, k) => {
    // Inline data that ended at an empty line needs that "\n\n" to end there again.
    if (k > 0) out += units[k - 1]!.data.blankLine ? "\n\n" : eol + eol;
    out += formatUnit(sql, u, keywordCase, unit, eol);
  });
  if (/[\r\n]$/.test(sql)) out += eol;
  return out;
}

/** Roles of words that are names or literals, never keywords. */
const NAME_ROLES = new Set<Role | undefined>(["identifier", "setting", "parameter", "number"]);

function formatUnit(sql: string, unit: Unit, keywordCase: KeywordCase, indent: string, eol: string): string {
  let original = sql.slice(unit.start, unit.end);
  // A line comment at the end keeps its "\r", which the eol written after the unit would double.
  if (eol === "\r\n") original = original.replace(/\r$/, "");
  // The role of each word as the parser reads it, by its offset in sql.
  const roles = new Map<number, Role>();
  if (unit.statement) {
    const { diagnostics, spans } = checkWithRoles(sql.slice(unit.statement.start, unit.statement.end));
    if (diagnostics.length > 0) return original;
    for (const span of spans) roles.set(unit.statement.start + span.start, span.role);
  }
  const piece = toPiece(sql, unit, eol, roles);
  const text = print(piece, analyze(piece.sig), keywordCase, indent, eol);
  // A last safety net: the same tokens and comments, only keywords re-cased, and still valid.
  const keywordAt = (offset: number): boolean => roles.get(unit.start + offset) === "keyword";
  if (!sameTokens(original, text, keywordAt) || (unit.statement && check(text).length > 0)) return original;
  return text;
}

/** The significant tokens of a unit with the comments around them. */
function toPiece(sql: string, unit: Unit, eol: string, roles: Map<number, Role>): Piece {
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
      const note: Note = { text: line && eol === "\r\n" ? text.replace(/\r$/, "") : text, ownLine: breaks > 0, newlineAfter: false, line };
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
