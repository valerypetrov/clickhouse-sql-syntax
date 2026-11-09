/**
 * Reading the values of literal tokens the way ClickHouse's ReadHelpers do.
 * Only what the parser needs to accept or reject a query.
 */
import type { Lit } from "./ast.js";
/**
 * Reads a quoted string with backslash escapes, and doubled quotes in SQL style, like
 * readAnyQuotedString. Returns undefined if it does not read exactly the whole text.
 */
export declare function unquote(text: string, quote: string, sqlStyle?: boolean): string | undefined;
/** The name of a QuotedIdentifier token, or undefined if ClickHouse does not accept it. */
export declare function quotedIdentifierName(text: string): string | undefined;
/** The value of a StringLiteral token, or undefined where ParserStringLiteral fails. */
export declare function stringLiteralValue(text: string): string | undefined;
/** The body of a HereDoc token. */
export declare function heredocValue(text: string): string;
/** strtod over the whole text: the value, or undefined if it does not read all of it or overflows. */
export declare function readFloat(text: string): number | undefined;
/** The value of a Number token as ParserNumber reads it, or undefined where it fails. */
export declare function numberValue(text: string, negative: boolean): Lit | undefined;
/** The float reading of ParserNumber, also used for bare words such as inf and nan. */
export declare function floatLit(text: string, negative: boolean): Lit | undefined;
/** tryReadIntText into a UInt64 over the whole text: plain decimal digits, not past UInt64. */
export declare function isUnsignedIntegerText(text: string): boolean;
//# sourceMappingURL=literals.d.ts.map