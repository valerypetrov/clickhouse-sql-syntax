/**
 * The value of a setting as ClickHouse converts it to the setting's type: a port of the conversions of
 * src/Core/SettingsFields.cpp and SettingsFieldsConversionHelpers.cpp, for the literals a query can write.
 */
import { TIME_ZONES } from "../generated/time-zones.js";
import type { SettingInfo } from "../generated/settings.js";
import { stringLiteralValue } from "../parser/index.js";
import { type Token, TokenKind as T } from "../types.js";

/** A literal as ClickHouse's Field holds it. */
export type Value =
  | { t: "UInt64" | "Int64" | "Float64"; v: number; big?: bigint; text: string }
  | { t: "String"; v: string; text: string }
  | { t: "Bool"; v: boolean; text: string }
  | { t: "Null"; text: string }
  | { t: "Map" | "Array" | "Tuple"; text: string };

const UINT64_MAX = 2n ** 64n - 1n;
const INT64_MIN = -(2n ** 63n);

/** The literal that the tokens of a value write, or undefined for anything else, such as DEFAULT or a function. */
export function readValue(sql: string, tokens: readonly Token[]): Value | undefined {
  const text = tokens.length ? sql.slice(tokens[0]!.start, tokens[tokens.length - 1]!.end) : "";
  const first = tokens[0];
  if (!first) return undefined;
  const negative = first.kind === T.Minus;
  const rest = negative ? tokens.slice(1) : tokens;
  if (rest.length === 1 && rest[0]!.kind === T.Number) return number(sql.slice(rest[0]!.start, rest[0]!.end), negative, text);
  if (negative) return undefined;
  if (tokens.length === 1 && first.kind === T.StringLiteral) {
    const value = stringLiteralValue(sql.slice(first.start, first.end));
    return value === undefined ? undefined : { t: "String", v: value, text };
  }
  if (tokens.length === 1 && first.kind === T.BareWord) {
    const word = text.toLowerCase();
    if (word === "null") return { t: "Null", text: "NULL" };
    if (word === "true" || word === "false") return { t: "Bool", v: word === "true", text: word };
    return undefined;
  }
  const last = tokens[tokens.length - 1]!.kind;
  if (first.kind === T.OpeningCurlyBrace && last === T.ClosingCurlyBrace) return { t: "Map", text };
  if (first.kind === T.OpeningSquareBracket && last === T.ClosingSquareBracket) return { t: "Array", text };
  return undefined;
}

/** A number as ClickHouse's parser reads it: an integer that fits 64 bits, or a Float64. */
function number(raw: string, negative: boolean, text: string): Value | undefined {
  const digits = raw.replace(/_/g, "");
  let big: bigint | undefined;
  if (/^\d+$/.test(digits)) big = BigInt(digits);
  else if (/^0x[0-9a-f]+$/i.test(digits)) big = BigInt(digits);
  else if (/^0b[01]+$/i.test(digits)) big = BigInt(digits);
  if (big !== undefined) {
    if (!negative && big <= UINT64_MAX) return { t: "UInt64", v: Number(big), big, text };
    if (negative && -big >= INT64_MIN) return { t: "Int64", v: -Number(big), big: -big, text };
    return { t: "Float64", v: (negative ? -1 : 1) * Number(big), text };
  }
  const v = Number(digits);
  if (Number.isNaN(v)) return undefined;
  return { t: "Float64", v: negative ? -v : v, text };
}

/** How a setting of each integer type is named in ClickHouse's messages, and its range. */
const INTEGERS: Record<string, { cpp: string; min: bigint; max: bigint }> = {
  UInt64: { cpp: "unsigned long long", min: 0n, max: UINT64_MAX },
  UInt32: { cpp: "unsigned int", min: 0n, max: 2n ** 32n - 1n },
  Int64: { cpp: "long", min: INT64_MIN, max: 2n ** 63n - 1n },
  Int32: { cpp: "int", min: -(2n ** 31n), max: 2n ** 31n - 1n },
};

/** The integer type behind a setting type, and whether a string is read with a size suffix, as 10G. */
function integerOf(type: string): { base: string; suffix: boolean; nonZero?: boolean; auto?: boolean; maxThreads?: boolean } | undefined {
  switch (type) {
    case "UInt64":
    case "UInt32":
    case "Int64":
    case "Int32":
      return { base: type, suffix: true };
    case "NonZeroUInt64":
      return { base: "UInt64", suffix: true, nonZero: true };
    case "UInt64Auto":
      return { base: "UInt64", suffix: true, auto: true };
    case "Milliseconds":
      return { base: "UInt64", suffix: true };
    case "MaxThreads":
      return { base: "UInt64", suffix: false, maxThreads: true };
    default:
      return undefined;
  }
}

/** A number in a string as parseWithSizeSuffix() reads it: digits, then optional k, M, G, T, P, E with an optional i. */
const INTEGER_STRING = /^[+-]?\d+([kKMGTPE]i?)?$/;
const PLAIN_INTEGER_STRING = /^[+-]?\d+$/;
const FLOAT_STRING = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?([kKMGTPE]i?)?$|^[+-]?(inf|nan)$/i;

const fieldName = (value: Value) => (value.t === "Map" || value.t === "Array" || value.t === "Tuple" ? value.t : value.t);

/** ClickHouse's message for a value that a setting does not take, or undefined when it takes it or the check is not known. */
export function valueError(setting: SettingInfo, value: Value): string | undefined {
  const problem = valueProblem(setting, value);
  return problem && `${problem}: while setting '${setting.name}' to value ${value.text}.`;
}

function valueProblem(setting: SettingInfo, value: Value): string | undefined {
  const type = setting.type;
  if (setting.values?.length) return enumProblem(setting, value);
  const integer = integerOf(type);
  if (integer) return integerProblem(integer, value);
  switch (type) {
    case "Bool":
      return boolProblem(value);
    case "BoolAuto":
      return value.t === "String" && value.v.toLowerCase() === "auto" ? undefined : boolProblem(value);
    case "Float":
    case "Double":
    case "Seconds":
    case "FloatAuto":
    case "DoubleAuto":
      if (value.t === "String") {
        if (type.endsWith("Auto") && value.v.toLowerCase() === "auto") return undefined;
        return FLOAT_STRING.test(value.v) || value.v === "" ? undefined : `Cannot read floating point value here: ${value.v}`;
      }
      return value.t === "Null" ? `Invalid value NULL of the setting, which needs ${type === "Float" ? "float" : "double"}` : undefined;
    case "String":
      return value.t === "String" ? undefined : badGet(value, "String");
    case "Char":
      if (value.t !== "String") return badGet(value, "String");
      // An empty string is taken too, as no character.
      return [...value.v].length <= 1 ? undefined : "A setting's value string has to be an exactly one character long";
    case "Map":
      if (value.t === "Map") return undefined;
      if (value.t !== "String") return badGet(value, "Map");
      return value.v === "" || value.v.trimStart().startsWith("{") ? undefined : `Cannot parse input: expected '{' before: '${value.v}'`;
    case "Timezone":
      if (value.t !== "String") return badGet(value, "String");
      // Fixed offsets such as Fixed/UTC+03:00:00 and +03:00 are time zones too.
      if (value.v === "" || TIME_ZONE_NAMES.has(value.v.toLowerCase()) || /^(Fixed\/|[+-]\d|UTC[+-]|GMT[+-])/i.test(value.v)) return undefined;
      return `Invalid time zone: ${value.v}`;
    default:
      return undefined;
  }
}

const TIME_ZONE_NAMES = new Set(TIME_ZONES.map((z) => z.name.toLowerCase()));

function badGet(value: Value, requested: string): string | undefined {
  // An array or a map of the parser is never one ClickHouse converts to these.
  if (value.t === "Array" || value.t === "Tuple") return undefined;
  return `Bad get: has ${fieldName(value)}, requested ${requested}`;
}

function enumProblem(setting: SettingInfo, value: Value): string | undefined {
  if (value.t !== "String") return badGet(value, "String");
  const values = setting.values!;
  const parts = setting.multi ? value.v.split(/[\s,]+/).filter((part) => part !== "") : [value.v];
  const wrong = parts.find((part) => !values.includes(part));
  if (wrong === undefined) return undefined;
  return `Unexpected value of ${setting.type}: '${wrong}'. Must be one of [${values.map((v) => `'${v}'`).join(", ")}]`;
}

function boolProblem(value: Value): string | undefined {
  switch (value.t) {
    case "Bool":
      return undefined;
    case "UInt64":
    case "Int64":
      return value.big === 0n || value.big === 1n ? undefined : `Field value ${value.text} is out of range of bool type`;
    case "Float64":
      return value.v >= 0 && value.v <= 1 ? undefined : "Cannot convert out of range floating point value to integer type";
    case "String": {
      const v = value.v.toLowerCase();
      return v === "0" || v === "1" || v === "true" || v === "false" ? undefined : `Cannot parse bool from string '${value.v}'`;
    }
    case "Null":
      return "Invalid value NULL of the setting, which needs bool";
    default:
      return undefined;
  }
}

function integerProblem(integer: NonNullable<ReturnType<typeof integerOf>>, value: Value): string | undefined {
  const range = INTEGERS[integer.base]!;
  let result: bigint | undefined;
  switch (value.t) {
    case "Bool":
      result = value.v ? 1n : 0n;
      break;
    case "UInt64":
    case "Int64":
      if (value.big! < range.min || value.big! > range.max) return `Field value ${value.text} is out of range of ${range.cpp} type`;
      result = value.big!;
      break;
    case "Float64":
      if (!Number.isFinite(value.v)) return undefined;
      if (value.v >= Number(range.max + 1n) || value.v < Number(range.min)) return "Cannot convert out of range floating point value to integer type";
      result = BigInt(Math.trunc(value.v));
      break;
    case "String": {
      if (integer.maxThreads && /^'?auto/.test(value.v)) return undefined;
      if (integer.auto && value.v.toLowerCase() === "auto") return undefined;
      if (value.v === "") return "Attempt to read after eof";
      if (!(integer.suffix ? INTEGER_STRING : PLAIN_INTEGER_STRING).test(value.v)) {
        const at = /^[+-]?\d*/.exec(value.v)![0].length;
        return /^[+-]?\d/.test(value.v) || at === 0 ? `Cannot parse input: expected 'eof' before: '${value.v.slice(at)}'` : undefined;
      }
      if (/^\+?\d+$/.test(value.v)) result = BigInt(value.v);
      break;
    }
    case "Null":
      return `Invalid value NULL of the setting, which needs ${range.cpp}`;
    default:
      return undefined;
  }
  if (integer.nonZero && result === 0n) return "A setting's value has to be greater than 0";
  return undefined;
}
