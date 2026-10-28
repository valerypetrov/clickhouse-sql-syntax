import { TokenKind, isSignificant, type Token } from "../types.js";

// A port of Lexer::nextTokenImpl() from ClickHouse's src/Parsers/Lexer.cpp. ClickHouse reads
// UTF-8 bytes; here we read UTF-16 code units, and every rule only looks at ASCII except the ones marked.

const CR = 0x0d;
const LF = 0x0a;

function isNumeric(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

function isHexDigit(c: number): boolean {
  return isNumeric(c) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);
}

function isWordChar(c: number): boolean {
  return isNumeric(c) || (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c === 0x5f;
}

function isWhitespaceASCII(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === LF || c === CR || c === 0x0c || c === 0x0b;
}

/** The Unicode spaces that ClickHouse's skipWhitespacesUTF8() skips. */
function isUnicodeWhitespace(c: number): boolean {
  return (
    c === 0x85 ||
    c === 0xa0 ||
    c === 0x180e ||
    (c >= 0x2000 && c <= 0x200d) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x2060 ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** ClickHouse's isNumberSeparator(): an underscore between two digits, as in 1_000. */
function isNumberSeparator(sql: string, pos: number, startOfBlock: boolean, hex: boolean): boolean {
  if (sql.charCodeAt(pos) !== 0x5f || startOfBlock) return false;
  if (pos + 1 >= sql.length) return false;
  const next = sql.charCodeAt(pos + 1);
  return hex ? isHexDigit(next) : isNumeric(next);
}

/** Number of UTF-8 bytes of the code point at `pos`; a lone surrogate counts as U+FFFD. */
function utf8Length(sql: string, pos: number): number {
  const c = sql.codePointAt(pos)!;
  if (c < 0x80) return 1;
  if (c < 0x800) return 2;
  return c < 0x10000 ? 3 : 4;
}

/** Number of UTF-16 code units of the code point at `pos`. */
function charLength(sql: string, pos: number): number {
  return sql.codePointAt(pos)! > 0xffff ? 2 : 1;
}

/** Whether at least `bytes` UTF-8 bytes follow `pos`, as ClickHouse's `pos + n < end` checks ask. */
function hasBytes(sql: string, pos: number, bytes: number): boolean {
  let count = 0;
  while (pos < sql.length && count < bytes) {
    count += utf8Length(sql, pos);
    pos += charLength(sql, pos);
  }
  return count >= bytes;
}

class Lexer {
  private pos = 0;
  private prevSignificant = TokenKind.Whitespace;

  constructor(private readonly sql: string) {}

  /** Returns the kind of the next token and moves `pos` past it. */
  next(): TokenKind {
    const kind = this.scan();
    if (isSignificant(kind)) this.prevSignificant = kind;
    return kind;
  }

  get offset(): number {
    return this.pos;
  }

  private code(at: number): number {
    return at < this.sql.length ? this.sql.charCodeAt(at) : -1;
  }

  private scan(): TokenKind {
    const sql = this.sql;
    const end = sql.length;
    if (this.pos >= end) return TokenKind.EndOfStream;

    const c = sql.charCodeAt(this.pos);
    switch (c) {
      case 0x20: // space
      case 0x09: // \t
      case LF:
      case CR:
      case 0x0c: // \f
      case 0x0b: // \v
        this.pos++;
        while (this.pos < end && isWhitespaceASCII(sql.charCodeAt(this.pos))) this.pos++;
        return TokenKind.Whitespace;

      case 0x27: // '
        return this.quoted(0x27, TokenKind.StringLiteral, TokenKind.ErrorSingleQuoteIsNotClosed);
      case 0x22: // "
        return this.quoted(0x22, TokenKind.QuotedIdentifier, TokenKind.ErrorDoubleQuoteIsNotClosed);
      case 0x60: // `
        return this.quoted(0x60, TokenKind.QuotedIdentifier, TokenKind.ErrorBackQuoteIsNotClosed);

      case 0x28: // (
        return this.single(TokenKind.OpeningRoundBracket);
      case 0x29: // )
        return this.single(TokenKind.ClosingRoundBracket);
      case 0x5b: // [
        return this.single(TokenKind.OpeningSquareBracket);
      case 0x5d: // ]
        return this.single(TokenKind.ClosingSquareBracket);
      case 0x7b: // {
        return this.single(TokenKind.OpeningCurlyBrace);
      case 0x7d: // }
        return this.single(TokenKind.ClosingCurlyBrace);
      case 0x2c: // ,
        return this.single(TokenKind.Comma);
      case 0x3b: // ;
        return this.single(TokenKind.Semicolon);

      case 0x2e: // .
        return this.dot();

      case 0x2b: // +
        return this.single(TokenKind.Plus);
      case 0x2d: // -, ->, --
        this.pos++;
        if (this.code(this.pos) === 0x3e) return this.single(TokenKind.Arrow);
        if (this.code(this.pos) === 0x2d) {
          this.pos++;
          return this.commentUntilEndOfLine();
        }
        return TokenKind.Minus;
      case 0x2a: // *
        return this.single(TokenKind.Asterisk);
      case 0x2f: // /, //, /*
        this.pos++;
        if (this.code(this.pos) === 0x2f) {
          this.pos++;
          return this.commentUntilEndOfLine();
        }
        if (this.code(this.pos) === 0x2a) {
          this.pos++;
          return this.multilineComment();
        }
        return TokenKind.Slash;
      case 0x23: // # is a comment only before a space or "!"
        this.pos++;
        if (this.code(this.pos) === 0x20 || this.code(this.pos) === 0x21) return this.commentUntilEndOfLine();
        return TokenKind.Error;
      case 0x25: // %
        return this.single(TokenKind.Percent);
      case 0x3d: // =, ==
        this.pos++;
        if (this.code(this.pos) === 0x3d) this.pos++;
        return TokenKind.Equals;
      case 0x21: // !=, !~, !~*
        this.pos++;
        if (this.code(this.pos) === 0x3d) return this.single(TokenKind.NotEquals);
        if (this.code(this.pos) === 0x7e) {
          this.pos++;
          if (this.code(this.pos) === 0x2a) return this.single(TokenKind.NotTildeAsterisk);
          return TokenKind.NotTilde;
        }
        return TokenKind.ErrorSingleExclamationMark;
      case 0x7e: // ~, ~*
        this.pos++;
        if (this.code(this.pos) === 0x2a) return this.single(TokenKind.TildeAsterisk);
        return TokenKind.Tilde;
      case 0x3c: // <, <=, <>, <=>
        this.pos++;
        if (this.code(this.pos) === 0x3d && this.code(this.pos + 1) === 0x3e) {
          this.pos += 2;
          return TokenKind.Spaceship;
        }
        if (this.code(this.pos) === 0x3d) return this.single(TokenKind.LessOrEquals);
        if (this.code(this.pos) === 0x3e) return this.single(TokenKind.NotEquals);
        return TokenKind.Less;
      case 0x3e: // >, >=
        this.pos++;
        if (this.code(this.pos) === 0x3d) return this.single(TokenKind.GreaterOrEquals);
        return TokenKind.Greater;
      case 0x3f: // ?
        return this.single(TokenKind.QuestionMark);
      case 0x5e: // ^
        return this.single(TokenKind.Caret);
      case 0x3a: // :, ::
        this.pos++;
        if (this.code(this.pos) === 0x3a) return this.single(TokenKind.DoubleColon);
        return TokenKind.Colon;
      case 0x7c: // |, ||, |>
        this.pos++;
        if (this.code(this.pos) === 0x7c) return this.single(TokenKind.Concatenation);
        if (this.code(this.pos) === 0x3e) return this.single(TokenKind.PipeOperator);
        return TokenKind.PipeMark;
      case 0x40: // @, @@
        this.pos++;
        if (this.code(this.pos) === 0x40) return this.single(TokenKind.DoubleAt);
        return TokenKind.At;
      case 0x5c: // \G
        this.pos++;
        if (this.code(this.pos) === 0x47) return this.single(TokenKind.VerticalDelimiter);
        return TokenKind.Error;
    }

    if (isNumeric(c)) return this.number();
    if (c === 0x2212) return this.single(TokenKind.Minus); // the minus sign −
    // Unicode quotes ‘...’ and “...”; ClickHouse wants at least 3 bytes after the opening one.
    if ((c === 0x2018 || c === 0x201c) && hasBytes(sql, this.pos + 1, 3)) {
      const close = c === 0x2018 ? "’" : "”";
      const found = sql.indexOf(close, this.pos + 1);
      if (found < 0) {
        this.pos = end;
        return c === 0x2018 ? TokenKind.ErrorSingleQuoteIsNotClosed : TokenKind.ErrorDoubleQuoteIsNotClosed;
      }
      this.pos = found + 1;
      return c === 0x2018 ? TokenKind.StringLiteral : TokenKind.QuotedIdentifier;
    }
    return this.other(c);
  }

  private single(kind: TokenKind): TokenKind {
    this.pos++;
    return kind;
  }

  /** ClickHouse's quotedString(): a backslash escapes the next character, a doubled quote is the quote. */
  private quoted(quote: number, success: TokenKind, error: TokenKind): TokenKind {
    const sql = this.sql;
    const end = sql.length;
    this.pos++;
    while (this.pos < end) {
      const c = sql.charCodeAt(this.pos);
      if (c === quote) {
        this.pos++;
        if (this.code(this.pos) === quote) {
          this.pos++;
          continue;
        }
        return success;
      }
      this.pos += c === 0x5c ? 2 : 1;
    }
    this.pos = end;
    return error;
  }

  private commentUntilEndOfLine(): TokenKind {
    // Only "\n" ends the comment, as in ClickHouse.
    const newline = this.sql.indexOf("\n", this.pos);
    this.pos = newline < 0 ? this.sql.length : newline;
    return TokenKind.Comment;
  }

  /** A /* comment, already past its opening; comments nest as in the SQL standard. */
  private multilineComment(): TokenKind {
    const sql = this.sql;
    let nesting = 1;
    while (this.pos + 2 <= sql.length) {
      const a = sql.charCodeAt(this.pos);
      const b = sql.charCodeAt(this.pos + 1);
      if (a === 0x2f && b === 0x2a) {
        this.pos += 2;
        nesting++;
      } else if (a === 0x2a && b === 0x2f) {
        this.pos += 2;
        if (--nesting === 0) return TokenKind.Comment;
      } else {
        this.pos++;
      }
    }
    this.pos = sql.length;
    return TokenKind.ErrorMultilineCommentIsNotClosed;
  }

  /** Digits and underscore separators, the loop Lexer.cpp repeats for each part of a number. */
  private digits(hex: boolean, startOfBlock: boolean): void {
    const sql = this.sql;
    while (this.pos < sql.length) {
      const c = sql.charCodeAt(this.pos);
      if (!(hex ? isHexDigit(c) : isNumeric(c)) && !isNumberSeparator(sql, this.pos, startOfBlock, hex)) break;
      this.pos++;
      startOfBlock = false;
    }
  }

  /** The exponent of a number, with an optional sign; it is always decimal. */
  private exponent(letters: string): void {
    const end = this.sql.length;
    if (this.pos + 1 < end && letters.includes(this.sql[this.pos]!)) {
      this.pos++;
      if (this.pos + 1 < end && (this.code(this.pos) === 0x2d || this.code(this.pos) === 0x2b)) this.pos++;
      this.digits(false, true);
    }
  }

  private number(): TokenKind {
    const sql = this.sql;
    const end = sql.length;
    const begin = this.pos;

    if (this.prevSignificant === TokenKind.Dot) {
      // After a dot only an integer, so that x.1.1 is x . 1 . 1
      this.pos++;
      this.digits(false, false);
    } else {
      let hex = false;
      let startOfBlock = false;
      const second = this.code(this.pos + 1);
      if (this.pos + 2 < end && sql.charCodeAt(this.pos) === 0x30 && "xXbB".includes(sql[this.pos + 1]!)) {
        const third = sql.charCodeAt(this.pos + 2);
        const valid = second === 0x78 || second === 0x58 ? isHexDigit(third) : third === 0x30 || third === 0x31;
        hex = valid && (second === 0x78 || second === 0x58);
        if (valid) {
          this.pos += 2;
          startOfBlock = true;
        } else {
          this.pos++;
        }
      } else {
        this.pos++;
      }
      this.digits(hex, startOfBlock);
      if (this.code(this.pos) === 0x2e) {
        this.pos++;
        this.digits(hex, true);
      }
      this.exponent(hex ? "pP" : "eE");
    }

    // A number followed by word characters is an identifier like 1st, unless it has a "." or a sign.
    if (this.pos < end && isWordChar(sql.charCodeAt(this.pos))) {
      this.pos++;
      while (this.pos < end && isWordChar(sql.charCodeAt(this.pos))) this.pos++;
      for (let i = begin; i < this.pos; i++) {
        const c = sql.charCodeAt(i);
        if (!isWordChar(c) && c !== 0x24) return TokenKind.ErrorWrongNumber;
      }
      return TokenKind.BareWord;
    }
    return TokenKind.Number;
  }

  /** A "." is a Dot after a name, a number or a bracket, otherwise it starts a number like .5 */
  private dot(): TokenKind {
    const prev = this.prevSignificant;
    if (
      this.pos > 0 &&
      (!isNumeric(this.code(this.pos + 1)) ||
        prev === TokenKind.ClosingRoundBracket ||
        prev === TokenKind.ClosingSquareBracket ||
        prev === TokenKind.BareWord ||
        prev === TokenKind.QuotedIdentifier ||
        prev === TokenKind.Number)
    ) {
      return this.single(TokenKind.Dot);
    }
    this.pos++;
    this.digits(false, true);
    this.exponent("eE");
    return TokenKind.Number;
  }

  /** The default branch of Lexer.cpp: heredocs, $, x'..' and b'..' strings, words and the rest. */
  private other(c: number): TokenKind {
    const sql = this.sql;
    const end = sql.length;

    if (c === 0x24) {
      const heredoc = this.heredoc();
      if (heredoc) return heredoc;
      if (this.pos + 1 === end || !isWordChar(sql.charCodeAt(this.pos + 1))) return this.single(TokenKind.DollarSign);
    }

    if (this.pos + 2 < end && sql.charCodeAt(this.pos + 1) === 0x27 && "xXbB".includes(sql[this.pos]!)) {
      return this.hexOrBinString();
    }

    if (isWordChar(c) || c === 0x24) {
      this.pos++;
      while (this.pos < end && (isWordChar(sql.charCodeAt(this.pos)) || sql.charCodeAt(this.pos) === 0x24)) this.pos++;
      return TokenKind.BareWord;
    }

    // Unicode spaces, as in text pasted from a word processor, and the ASCII spaces after them.
    const start = this.pos;
    while (this.pos < end) {
      const w = sql.charCodeAt(this.pos);
      if (!isWhitespaceASCII(w) && !isUnicodeWhitespace(w)) break;
      this.pos++;
    }
    if (this.pos > start) return TokenKind.Whitespace;

    this.pos += charLength(sql, this.pos);
    return TokenKind.Error;
  }

  /** $tag$ ... $tag$, where the tag is made of word characters and may be empty. */
  private heredoc(): TokenKind | undefined {
    const sql = this.sql;
    const tagEnd = sql.indexOf("$", this.pos + 1);
    if (tagEnd < 0) return undefined;
    for (let i = this.pos + 1; i < tagEnd; i++) {
      if (!isWordChar(sql.charCodeAt(i))) return undefined;
    }
    const tag = sql.slice(this.pos, tagEnd + 1);
    const close = sql.indexOf(tag, tagEnd + 1);
    if (close < 0) return undefined;
    this.pos = close + tag.length;
    return TokenKind.HereDoc;
  }

  /** x'4142' or b'0101'; anything but the right digits before the closing quote is an error up to the end. */
  private hexOrBinString(): TokenKind {
    const sql = this.sql;
    const hex = sql[this.pos] === "x" || sql[this.pos] === "X";
    this.pos += 2;
    while (this.pos < sql.length) {
      const c = sql.charCodeAt(this.pos);
      if (hex ? !isHexDigit(c) : c !== 0x30 && c !== 0x31) break;
      this.pos++;
    }
    if (this.code(this.pos) !== 0x27) {
      this.pos = sql.length;
      return TokenKind.ErrorSingleQuoteIsNotClosed;
    }
    this.pos++;
    return TokenKind.StringLiteral;
  }
}

/** Splits `sql` into tokens the way ClickHouse's Lexer.cpp does. */
export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  const lexer = new Lexer(sql);
  let line = 1;
  let lineStart = 0;
  let scanned = 0;

  for (;;) {
    const start = lexer.offset;
    // Count the line breaks before `start`: "\n", "\r\n" and a lone "\r".
    for (; scanned < start; scanned++) {
      const c = sql.charCodeAt(scanned);
      if (c === LF || (c === CR && sql.charCodeAt(scanned + 1) !== LF)) {
        line++;
        lineStart = scanned + 1;
      }
    }
    const kind = lexer.next();
    tokens.push({ kind, start, end: lexer.offset, line, col: start - lineStart + 1 });
    if (kind === TokenKind.EndOfStream) return tokens;
  }
}
