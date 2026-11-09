/** Token kinds of ClickHouse's lexer, named as in src/Parsers/Lexer.h. */
export var TokenKind;
(function (TokenKind) {
    TokenKind["Whitespace"] = "Whitespace";
    TokenKind["Comment"] = "Comment";
    /** A keyword (SELECT) or an identifier (column). */
    TokenKind["BareWord"] = "BareWord";
    /** Never negative, no leading plus: 123, 123.456e12, 0x123p12, 0b101, 1_000. */
    TokenKind["Number"] = "Number";
    /** 'hello', 'it''s', 'it\'s', x'ab', b'01', ‘hello’. */
    TokenKind["StringLiteral"] = "StringLiteral";
    /** "x", `x`, “x”. */
    TokenKind["QuotedIdentifier"] = "QuotedIdentifier";
    TokenKind["OpeningRoundBracket"] = "OpeningRoundBracket";
    TokenKind["ClosingRoundBracket"] = "ClosingRoundBracket";
    TokenKind["OpeningSquareBracket"] = "OpeningSquareBracket";
    TokenKind["ClosingSquareBracket"] = "ClosingSquareBracket";
    TokenKind["OpeningCurlyBrace"] = "OpeningCurlyBrace";
    TokenKind["ClosingCurlyBrace"] = "ClosingCurlyBrace";
    TokenKind["Comma"] = "Comma";
    TokenKind["Semicolon"] = "Semicolon";
    /** \G at the end of a query. */
    TokenKind["VerticalDelimiter"] = "VerticalDelimiter";
    /** a.b, a.1 and (x, y).2; never the start of a number like .1 */
    TokenKind["Dot"] = "Dot";
    /** Multiplication or "SELECT *". */
    TokenKind["Asterisk"] = "Asterisk";
    /** $tag$ ... $tag$ and $$ ... $$. */
    TokenKind["HereDoc"] = "HereDoc";
    TokenKind["DollarSign"] = "DollarSign";
    TokenKind["Plus"] = "Plus";
    TokenKind["Minus"] = "Minus";
    TokenKind["Slash"] = "Slash";
    TokenKind["Percent"] = "Percent";
    /** -> */
    TokenKind["Arrow"] = "Arrow";
    TokenKind["QuestionMark"] = "QuestionMark";
    TokenKind["Colon"] = "Colon";
    TokenKind["Caret"] = "Caret";
    /** :: */
    TokenKind["DoubleColon"] = "DoubleColon";
    /** = and == */
    TokenKind["Equals"] = "Equals";
    /** != and <> */
    TokenKind["NotEquals"] = "NotEquals";
    TokenKind["Less"] = "Less";
    TokenKind["Greater"] = "Greater";
    TokenKind["LessOrEquals"] = "LessOrEquals";
    TokenKind["GreaterOrEquals"] = "GreaterOrEquals";
    /** <=> */
    TokenKind["Spaceship"] = "Spaceship";
    /** | */
    TokenKind["PipeMark"] = "PipeMark";
    /** |> */
    TokenKind["PipeOperator"] = "PipeOperator";
    /** || */
    TokenKind["Concatenation"] = "Concatenation";
    TokenKind["Tilde"] = "Tilde";
    /** ~* */
    TokenKind["TildeAsterisk"] = "TildeAsterisk";
    /** !~ */
    TokenKind["NotTilde"] = "NotTilde";
    /** !~* */
    TokenKind["NotTildeAsterisk"] = "NotTildeAsterisk";
    TokenKind["At"] = "At";
    /** @@ */
    TokenKind["DoubleAt"] = "DoubleAt";
    /** Zero-width token at the end of the input; always the last token. */
    TokenKind["EndOfStream"] = "EndOfStream";
    /** Something unrecognized. */
    TokenKind["Error"] = "Error";
    TokenKind["ErrorMultilineCommentIsNotClosed"] = "ErrorMultilineCommentIsNotClosed";
    TokenKind["ErrorSingleQuoteIsNotClosed"] = "ErrorSingleQuoteIsNotClosed";
    TokenKind["ErrorDoubleQuoteIsNotClosed"] = "ErrorDoubleQuoteIsNotClosed";
    TokenKind["ErrorBackQuoteIsNotClosed"] = "ErrorBackQuoteIsNotClosed";
    TokenKind["ErrorSingleExclamationMark"] = "ErrorSingleExclamationMark";
    TokenKind["ErrorWrongNumber"] = "ErrorWrongNumber";
})(TokenKind || (TokenKind = {}));
/** Messages for error tokens, worded as in ClickHouse's getErrorTokenDescription(). */
export const LEXER_ERROR_MESSAGES = {
    [TokenKind.Error]: "Unrecognized token",
    [TokenKind.ErrorMultilineCommentIsNotClosed]: "Multiline comment is not closed",
    [TokenKind.ErrorSingleQuoteIsNotClosed]: "Single quoted string is not closed",
    [TokenKind.ErrorDoubleQuoteIsNotClosed]: "Double quoted string is not closed",
    [TokenKind.ErrorBackQuoteIsNotClosed]: "Back quoted string is not closed",
    [TokenKind.ErrorSingleExclamationMark]: "Exclamation mark can only occur in !=, !~ and !~* operators",
    [TokenKind.ErrorWrongNumber]: "Wrong number",
};
/** True for every token except whitespace and comments. */
export function isSignificant(kind) {
    return kind !== TokenKind.Whitespace && kind !== TokenKind.Comment;
}
/** True for the Error* kinds. */
export function isErrorKind(kind) {
    return kind in LEXER_ERROR_MESSAGES;
}
//# sourceMappingURL=types.js.map