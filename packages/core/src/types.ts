/**
 * Shared contracts of the library. Every other module builds on these types,
 * so change them only together with all their users.
 */

/** Token kinds of ClickHouse's lexer, named as in src/Parsers/Lexer.h. */
export enum TokenKind {
  Whitespace = "Whitespace",
  Comment = "Comment",

  /** A keyword (SELECT) or an identifier (column). */
  BareWord = "BareWord",

  /** Never negative, no leading plus: 123, 123.456e12, 0x123p12, 0b101, 1_000. */
  Number = "Number",
  /** 'hello', 'it''s', 'it\'s', x'ab', b'01', ‘hello’. */
  StringLiteral = "StringLiteral",
  /** "x", `x`, “x”. */
  QuotedIdentifier = "QuotedIdentifier",

  OpeningRoundBracket = "OpeningRoundBracket",
  ClosingRoundBracket = "ClosingRoundBracket",
  OpeningSquareBracket = "OpeningSquareBracket",
  ClosingSquareBracket = "ClosingSquareBracket",
  OpeningCurlyBrace = "OpeningCurlyBrace",
  ClosingCurlyBrace = "ClosingCurlyBrace",

  Comma = "Comma",
  Semicolon = "Semicolon",
  /** \G at the end of a query. */
  VerticalDelimiter = "VerticalDelimiter",
  /** a.b, a.1 and (x, y).2; never the start of a number like .1 */
  Dot = "Dot",
  /** Multiplication or "SELECT *". */
  Asterisk = "Asterisk",
  /** $tag$ ... $tag$ and $$ ... $$. */
  HereDoc = "HereDoc",
  DollarSign = "DollarSign",

  Plus = "Plus",
  Minus = "Minus",
  Slash = "Slash",
  Percent = "Percent",
  /** -> */
  Arrow = "Arrow",
  QuestionMark = "QuestionMark",
  Colon = "Colon",
  Caret = "Caret",
  /** :: */
  DoubleColon = "DoubleColon",
  /** = and == */
  Equals = "Equals",
  /** != and <> */
  NotEquals = "NotEquals",
  Less = "Less",
  Greater = "Greater",
  LessOrEquals = "LessOrEquals",
  GreaterOrEquals = "GreaterOrEquals",
  /** <=> */
  Spaceship = "Spaceship",
  /** | */
  PipeMark = "PipeMark",
  /** |> */
  PipeOperator = "PipeOperator",
  /** || */
  Concatenation = "Concatenation",
  Tilde = "Tilde",
  /** ~* */
  TildeAsterisk = "TildeAsterisk",
  /** !~ */
  NotTilde = "NotTilde",
  /** !~* */
  NotTildeAsterisk = "NotTildeAsterisk",
  At = "At",
  /** @@ */
  DoubleAt = "DoubleAt",

  /** Zero-width token at the end of the input; always the last token. */
  EndOfStream = "EndOfStream",

  /** Something unrecognized. */
  Error = "Error",
  ErrorMultilineCommentIsNotClosed = "ErrorMultilineCommentIsNotClosed",
  ErrorSingleQuoteIsNotClosed = "ErrorSingleQuoteIsNotClosed",
  ErrorDoubleQuoteIsNotClosed = "ErrorDoubleQuoteIsNotClosed",
  ErrorBackQuoteIsNotClosed = "ErrorBackQuoteIsNotClosed",
  ErrorSingleExclamationMark = "ErrorSingleExclamationMark",
  ErrorWrongNumber = "ErrorWrongNumber",
}

/** Messages for error tokens, worded as in ClickHouse's getErrorTokenDescription(). */
export const LEXER_ERROR_MESSAGES: Readonly<Partial<Record<TokenKind, string>>> = {
  [TokenKind.Error]: "Unrecognized token",
  [TokenKind.ErrorMultilineCommentIsNotClosed]: "Multiline comment is not closed",
  [TokenKind.ErrorSingleQuoteIsNotClosed]: "Single quoted string is not closed",
  [TokenKind.ErrorDoubleQuoteIsNotClosed]: "Double quoted string is not closed",
  [TokenKind.ErrorBackQuoteIsNotClosed]: "Back quoted string is not closed",
  [TokenKind.ErrorSingleExclamationMark]: "Exclamation mark can only occur in !=, !~ and !~* operators",
  [TokenKind.ErrorWrongNumber]: "Wrong number",
};

/** True for every token except whitespace and comments. */
export function isSignificant(kind: TokenKind): boolean {
  return kind !== TokenKind.Whitespace && kind !== TokenKind.Comment;
}

/** True for the Error* kinds. */
export function isErrorKind(kind: TokenKind): boolean {
  return kind in LEXER_ERROR_MESSAGES;
}

/**
 * Offsets count UTF-16 code units of the JavaScript string, like String.prototype.slice.
 * Lines and columns start at 1; a line ends at "\n", "\r\n" or a lone "\r".
 */
export interface Token {
  kind: TokenKind;
  /** Offset of the first character. */
  start: number;
  /** Offset just past the last character. */
  end: number;
  /** Line of `start`. */
  line: number;
  /** Column of `start`. */
  col: number;
}

export type Severity = "error" | "warning";

/** A problem found by check(). Offsets, line and column follow the same rules as Token. */
export interface Diagnostic {
  message: string;
  start: number;
  /** Equal to `start` for a problem at the end of the input. */
  end: number;
  line: number;
  col: number;
  severity: Severity;
}

/**
 * TextMate scope names used by highlight() and by the VS Code grammar, so that
 * any TextMate theme colours them. Every significant token falls in exactly one span.
 */
export type Scope =
  /** -- comment, // comment, # comment, #!shebang */
  | "comment.line.sql"
  /** Nested multiline comment. */
  | "comment.block.sql"
  /** A word from the ClickHouse keyword list used as a keyword. */
  | "keyword.other.sql"
  /** Symbolic operators: + - * / % = != < <= <=> || -> :: ? : ^ ~ |> @ ... */
  | "keyword.operator.sql"
  /** NULL, TRUE, FALSE. */
  | "constant.language.sql"
  | "constant.numeric.sql"
  /** 'string', x'hex', b'bits', ‘string’. */
  | "string.quoted.single.sql"
  /** $tag$ ... $tag$ */
  | "string.unquoted.heredoc.sql"
  /** Identifiers, bare or quoted. */
  | "variable.other.sql"
  /** A whole query parameter such as {name:Type}. */
  | "variable.parameter.sql"
  /** The name before the "(" of a function call. */
  | "entity.name.function.sql"
  /** Data type names such as UInt64 or Nullable. */
  | "storage.type.sql"
  /** Brackets, commas, dots and semicolons. */
  | "punctuation.sql"
  /** Error tokens. */
  | "invalid.illegal.sql";

/** One coloured piece of the input. Spans are sorted and never overlap. */
export interface HighlightSpan {
  start: number;
  end: number;
  scope: Scope;
}

/** The public API, implemented in lexer/, highlight/ and parser/. */
export interface ClickHouseSqlSyntax {
  /** Every token of the input in order, whitespace and comments included, ending with EndOfStream. */
  tokenize(sql: string): Token[];
  /** Coloured spans for the input; whitespace is not covered. */
  highlight(sql: string): HighlightSpan[];
  /** Syntax errors of every ';'-separated statement; an empty array when the input is valid. */
  check(sql: string): Diagnostic[];
  /** The input with ClickHouse-style layout and keyword case; meaning, names and comments are kept. */
  format(sql: string, options?: FormatOptions): string;
}

/** How format() writes keywords: in upper case, in lower case, or as they are. */
export type KeywordCase = "upper" | "lower" | "preserve";

/** Options of format(). */
export interface FormatOptions {
  /** "upper" by default. */
  keywordCase?: KeywordCase;
  /** Spaces per level of indentation, 4 by default. */
  indentSize?: number;
}
