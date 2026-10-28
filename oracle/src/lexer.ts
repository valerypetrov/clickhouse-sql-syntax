// A small lexer that follows the token boundaries of ClickHouse's Lexer.cpp.
// The oracle has its own so that a bug in the library under test cannot change the corpus.

export type LexemeKind =
  | "space"
  | "comment"
  | "word"
  | "string"
  | "quoted"
  | "heredoc"
  | "open"
  | "close"
  | "semicolon"
  | "operator"
  | "error";

export interface Lexeme {
  kind: LexemeKind;
  start: number;
  end: number;
}

// Longest first, so that "<=>" wins over "<=" and "!~*" over "!~".
const OPERATORS = [
  "<=>", "!~*",
  "->", "::", "==", "!=", "<>", "<=", ">=", "||", "|>", "~*", "!~", "@@", "\\G",
  "+", "-", "*", "/", "%", "=", "<", ">", "?", ":", "^", "~", "|", "@", ",", ".", "$", "−",
];

// Code points that skipWhitespacesUTF8() in ClickHouse treats as whitespace.
const UNICODE_SPACES = new Set([0x85, 0xa0, 0x180e, 0x2028, 0x2029, 0x200b, 0x200c, 0x200d, 0x202f, 0x205f, 0x2060, 0x3000, 0xfeff]);

export function isSpace(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13) || (code >= 0x2000 && code <= 0x200a) || UNICODE_SPACES.has(code);
}

export function isWordChar(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

function lineEnd(text: string, from: number): number {
  const nl = text.indexOf("\n", from);
  return nl === -1 ? text.length : nl;
}

// A quoted string where the quote is doubled or escaped with a backslash.
function quoted(text: string, start: number, quote: string, kind: LexemeKind): Lexeme {
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
    } else if (c === quote) {
      if (text[i + 1] === quote) {
        i += 2;
      } else {
        return { kind, start, end: i + 1 };
      }
    } else {
      i++;
    }
  }
  return { kind: "error", start, end: text.length };
}

function nestedComment(text: string, start: number): Lexeme {
  let depth = 1;
  let i = start + 2;
  while (i + 2 <= text.length) {
    if (text[i] === "/" && text[i + 1] === "*") {
      depth++;
      i += 2;
    } else if (text[i] === "*" && text[i + 1] === "/") {
      depth--;
      i += 2;
      if (depth === 0) return { kind: "comment", start, end: i };
    } else {
      i++;
    }
  }
  return { kind: "error", start, end: text.length };
}

function heredoc(text: string, start: number): Lexeme | undefined {
  const tagEnd = text.indexOf("$", start + 1);
  if (tagEnd === -1) return undefined;
  for (let i = start + 1; i < tagEnd; i++) {
    if (!isWordChar(text.charCodeAt(i))) return undefined;
  }
  const tag = text.slice(start, tagEnd + 1);
  const close = text.indexOf(tag, tagEnd + 1);
  if (close === -1) return undefined;
  return { kind: "heredoc", start, end: close + tag.length };
}

function hexOrBinString(text: string, start: number): Lexeme {
  const hex = text[start] === "x" || text[start] === "X";
  let i = start + 2;
  const digit = hex ? /[0-9a-fA-F]/ : /[01]/;
  while (i < text.length && digit.test(text[i]!)) i++;
  if (text[i] !== "'") return { kind: "error", start, end: text.length };
  return { kind: "string", start, end: i + 1 };
}

function unicodeQuoted(text: string, start: number, close: string, kind: LexemeKind): Lexeme {
  const end = text.indexOf(close, start + 1);
  if (end === -1) return { kind: "error", start, end: text.length };
  return { kind, start, end: end + 1 };
}

/** Reads one lexeme at `pos`, which must be before the end of `text`. */
export function readLexeme(text: string, pos: number): Lexeme {
  const c = text[pos]!;
  const code = text.charCodeAt(pos);
  const next = text[pos + 1];

  if (isSpace(code)) {
    let i = pos + 1;
    while (i < text.length && isSpace(text.charCodeAt(i))) i++;
    return { kind: "space", start: pos, end: i };
  }
  switch (c) {
    case "'":
      return quoted(text, pos, "'", "string");
    case '"':
      return quoted(text, pos, '"', "quoted");
    case "`":
      return quoted(text, pos, "`", "quoted");
    case "(":
    case "[":
    case "{":
      return { kind: "open", start: pos, end: pos + 1 };
    case ")":
    case "]":
    case "}":
      return { kind: "close", start: pos, end: pos + 1 };
    case ";":
      return { kind: "semicolon", start: pos, end: pos + 1 };
    case "‘":
      if (pos + 1 < text.length) return unicodeQuoted(text, pos, "’", "string");
      break;
    case "“":
      if (pos + 1 < text.length) return unicodeQuoted(text, pos, "”", "quoted");
      break;
  }
  if ((c === "-" && next === "-") || (c === "/" && next === "/") || (c === "#" && (next === " " || next === "!"))) {
    return { kind: "comment", start: pos, end: lineEnd(text, pos) };
  }
  if (c === "/" && next === "*") return nestedComment(text, pos);
  if (c === "$") {
    const doc = heredoc(text, pos);
    if (doc) return doc;
    if (pos + 1 === text.length || !isWordChar(text.charCodeAt(pos + 1))) {
      return { kind: "operator", start: pos, end: pos + 1 };
    }
  }
  if (next === "'" && pos + 2 < text.length && "xXbB".includes(c)) return hexOrBinString(text, pos);
  if (isWordChar(code) || c === "$") {
    let i = pos + 1;
    while (i < text.length && (isWordChar(text.charCodeAt(i)) || text[i] === "$")) i++;
    return { kind: "word", start: pos, end: i };
  }
  for (const op of OPERATORS) {
    if (text.startsWith(op, pos)) return { kind: "operator", start: pos, end: pos + op.length };
  }
  // Anything else is one unrecognized character; a surrogate pair stays whole.
  const width = code >= 0xd800 && code <= 0xdbff && pos + 1 < text.length ? 2 : 1;
  return { kind: "error", start: pos, end: pos + width };
}

/** Splits all of `text` into lexemes. */
export function lex(text: string): Lexeme[] {
  const result: Lexeme[] = [];
  let pos = 0;
  while (pos < text.length) {
    const lexeme = readLexeme(text, pos);
    result.push(lexeme);
    pos = lexeme.end;
  }
  return result;
}

export function isSignificant(lexeme: Lexeme): boolean {
  return lexeme.kind !== "space" && lexeme.kind !== "comment";
}
