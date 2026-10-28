/**
 * Reading the values of literal tokens the way ClickHouse's ReadHelpers do.
 * Only what the parser needs to accept or reject a query.
 */
import type { Lit } from "./ast.js";

const SIMPLE_ESCAPES: Record<string, string> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "0": "\0",
};

function isControl(c: string): boolean {
  const code = c.charCodeAt(0);
  return code < 32 || code === 127;
}

/**
 * Reads a quoted string with backslash escapes, and doubled quotes in SQL style, like
 * readAnyQuotedString. Returns undefined if it does not read exactly the whole text.
 */
export function unquote(text: string, quote: string, sqlStyle = true): string | undefined {
  if (text[0] !== quote) return undefined;
  let result = "";
  let i = 1;
  while (i < text.length) {
    const c = text[i]!;
    if (c === quote) {
      i++;
      if (sqlStyle && text[i] === quote) {
        result += quote;
        i++;
        continue;
      }
      return i === text.length ? result : undefined;
    }
    if (c === "\\") {
      i++;
      if (i >= text.length) return undefined;
      const after = text[i]!;
      if (after === "x") {
        const hex = text.slice(i + 1, i + 3);
        if (hex.length !== 2) return undefined;
        result += String.fromCharCode(parseInt(hex, 16) || 0);
        i += 3;
      } else if (after === "N") {
        i++;
      } else {
        const decoded = SIMPLE_ESCAPES[after] ?? after;
        if (!"\\'\"`/=".includes(decoded) && !isControl(decoded)) result += "\\";
        result += decoded;
        i++;
      }
      continue;
    }
    result += c;
    i++;
  }
  return undefined;
}

const UNICODE_OPEN_DOUBLE = "\u201C";
const UNICODE_OPEN_SINGLE = "\u2018";

/** The name of a QuotedIdentifier token, or undefined if ClickHouse does not accept it. */
export function quotedIdentifierName(text: string): string | undefined {
  if (text[0] === UNICODE_OPEN_DOUBLE) return text.length > 2 ? text.slice(1, -1) : undefined;
  const name = unquote(text, text[0] === "`" ? "`" : '"');
  return name ? name : undefined;
}

function decodeBits(digits: string, wordSize: number, hex: boolean): string {
  let result = "";
  for (let i = 0; i < digits.length; i += wordSize) {
    const word = digits.slice(i, i + wordSize);
    result += String.fromCharCode(parseInt(word, hex ? 16 : 2) || 0);
  }
  return result;
}

/** The value of a StringLiteral token, or undefined where ParserStringLiteral fails. */
export function stringLiteralValue(text: string): string | undefined {
  const first = text[0];
  if (first === "x" || first === "X") return decodeBits(text.slice(2, -1), 2, true);
  if (first === "b" || first === "B") return decodeBits(text.slice(2, -1), 8, false);
  if (first === UNICODE_OPEN_SINGLE) return text.slice(1, -1);
  return unquote(text, "'");
}

/** The body of a HereDoc token. */
export function heredocValue(text: string): string {
  const size = text.indexOf("$", 1) + 1;
  return text.slice(size, text.length - size);
}

const DECIMAL_FLOAT = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const HEX_FLOAT = /^0[xX](?:([0-9a-fA-F]+)\.?([0-9a-fA-F]*)|\.([0-9a-fA-F]+))(?:[pP]([+-]?\d+))?$/;
const SPECIAL_FLOAT = /^(?:inf(?:inity)?|nan(?:\([0-9A-Za-z_]*\))?)$/i;

/** strtod over the whole text: the value, or undefined if it does not read all of it or overflows. */
export function readFloat(text: string): number | undefined {
  if (SPECIAL_FLOAT.test(text)) return text[0] === "n" || text[0] === "N" ? NaN : Infinity;
  if (DECIMAL_FLOAT.test(text)) {
    const value = Number(text);
    return Number.isFinite(value) ? value : undefined;
  }
  const hex = HEX_FLOAT.exec(text);
  if (hex) {
    const intPart = hex[1] ?? "";
    const fracPart = hex[2] ?? hex[3] ?? "";
    const exponent = Number(hex[4] ?? "0");
    const mantissa = parseInt(intPart + fracPart || "0", 16);
    const value = mantissa * Math.pow(2, exponent - 4 * fracPart.length);
    return Number.isFinite(value) ? value : undefined;
  }
  return undefined;
}

const DIGITS: Record<number, RegExp> = {
  2: /^[01]*$/,
  10: /^\d*$/,
  16: /^[0-9a-fA-F]*$/,
};

const UINT64_MAX = 2n ** 64n - 1n;
const INT64_MIN_ABS = 2n ** 63n;

/** strtoull over the whole text, as parseNumber in ExpressionElementParsers.cpp uses it. */
function readUnsigned(digits: string, base: number, negative: boolean): Lit | undefined {
  let body = digits;
  if (base === 16 && /^0[xX]/.test(body)) body = body.slice(2);
  if (!DIGITS[base]!.test(body)) return undefined;
  const value = body === "" ? 0n : BigInt((base === 16 ? "0x" : base === 2 ? "0b" : "") + body);
  if (value > UINT64_MAX) return undefined;
  if (negative && value > INT64_MIN_ABS) return undefined;
  if (negative && value !== 0n) return { t: "Int64", v: -Number(value) };
  return { t: "UInt64", v: Number(value) };
}

const MAX_LENGTH_OF_NUMBER = 319;

/** The value of a Number token as ParserNumber reads it, or undefined where it fails. */
export function numberValue(text: string, negative: boolean): Lit | undefined {
  const buf = text.replaceAll("_", "");
  if (buf.length > MAX_LENGTH_OF_NUMBER) return undefined;
  if (buf[0] === "0") {
    const rest = buf.slice(1);
    if (rest[0] === "b") return readUnsigned(rest.slice(1), 2, negative);
    if (rest[0] === "x" || rest[0] === "X") {
      const result = readUnsigned(rest.slice(1), 16, negative);
      if (result) return result;
    } else {
      const result = readUnsigned(rest.replace(/^0+/, ""), 10, negative);
      if (result) return result;
    }
  } else {
    const result = readUnsigned(buf, 10, negative);
    if (result) return result;
  }
  return floatLit(buf, negative);
}

/** The float reading of ParserNumber, also used for bare words such as inf and nan. */
export function floatLit(text: string, negative: boolean): Lit | undefined {
  const value = readFloat(text);
  if (value === undefined) return undefined;
  return { t: "Float64", v: negative ? -value : value };
}

/** tryReadIntText over the whole text: plain decimal digits. */
export function isUnsignedIntegerText(text: string): boolean {
  return /^\+?\d+$/.test(text);
}
