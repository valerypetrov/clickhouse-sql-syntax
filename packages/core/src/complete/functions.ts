/**
 * The arguments of functions: the lists of arguments that the syntax of each function in the catalog allows,
 * what each documented argument takes by what its documentation says, and which ones the argument at the cursor is.
 */
import { DATA_TYPES } from "../generated/data-types.js";
import { FORMATS } from "../generated/formats.js";
import type { Argument, FunctionInfo } from "../generated/functions.js";
import { TIME_ZONES } from "../generated/time-zones.js";
import { stringLiteralValue } from "../parser/index.js";
import { type CompletionCandidate, type Token, TokenKind as T } from "../types.js";
import { findFunction, formatDetail, formatDocumentation } from "./catalog.js";
import { argumentKind } from "./kinds.js";
import { type DeclaredColumn, isWord, named, nameOf } from "./schema.js";
import { type ArgumentList, closingBracket, type Parameter, parameterAt, readArguments } from "./syntax.js";

/** How to write the types whose names need arguments; the others are written as their name. */
const TYPE_EXAMPLES: Record<string, string> = {
  AggregateFunction: "AggregateFunction(sum, UInt64)",
  Array: "Array(String)",
  Decimal32: "Decimal32(2)",
  Decimal64: "Decimal64(2)",
  Decimal128: "Decimal128(2)",
  Decimal256: "Decimal256(2)",
  Enum: "Enum('a' = 0, 'b' = 1)",
  Enum8: "Enum8('a' = 0, 'b' = 1)",
  Enum16: "Enum16('a' = 0, 'b' = 1)",
  FixedString: "FixedString(16)",
  LowCardinality: "LowCardinality(String)",
  Map: "Map(String, String)",
  Nested: "Nested(a String)",
  Nullable: "Nullable(String)",
  QBit: "QBit(Float32, 8)",
  SimpleAggregateFunction: "SimpleAggregateFunction(sum, UInt64)",
  Tuple: "Tuple(String, UInt64)",
  Variant: "Variant(String, UInt64)",
};

/** The types to offer where a type name goes: each type as ClickHouse names it, not its aliases like BIGINT. */
export function typeNames(skip?: RegExp): string[] {
  return DATA_TYPES.filter((t) => !t.aliasTo && t.name !== "Nothing" && !skip?.test(t.name)).map((t) => TYPE_EXAMPLES[t.name] ?? t.name);
}

// The rules of ClickHouse 26.11 for the types that some functions take, as it answers for each type.
/** The types that JSONExtract() and the other functions that parse JSON cannot return. */
const NOT_JSON = /^(?:AggregateFunction|BFloat16|Interval\w+|Nothing|QBit)$/;
/** The types that cannot be inside Nullable, as the OrNull and OrDefault functions return them. */
const NOT_NULLABLE = /^(?:AggregateFunction|Array|LowCardinality|Map|Nested|LineString|MultiLineString|MultiPoint|MultiPolygon|Polygon|Ring)$/;
/** The types that reinterpret() takes: strings, the types stored as numbers, and from a string an array of them. */
const REINTERPRETED = /^(?:U?Int\d+|B?Float\d+|Decimal\d*|Bool|Date|DateTime(?:32|64)?|UUID|String|FixedString)$/;

/** The types in the brackets of a type such as Variant(String, UInt64). */
function memberTypes(type: string): string[] {
  const open = type.indexOf("(");
  const members: string[] = [];
  for (let i = open + 1, depth = 0, start = i; open >= 0 && i < type.length; i++) {
    if (type[i] === "(") depth++;
    else if (type[i] === ")" && depth-- === 0) members.push(type.slice(start, i).trim());
    else if (type[i] === "," && depth === 0) {
      members.push(type.slice(start, i).trim());
      start = i + 1;
    }
    if (depth < 0) break;
  }
  return members.filter(Boolean);
}

/** The type names that the argument of a call takes, of the "data type" or "JSON data type" kind. */
function takenTypes(call: FunctionCall, json: boolean, columns: FunctionContext["columns"]): string[] {
  if (json) return typeNames(NOT_JSON);
  if (/Or(?:Null|Default)$/.test(call.target.name)) return typeNames(NOT_NULLABLE);
  if (call.target.name === "reinterpret") return [...typeNames().filter((type) => REINTERPRETED.test(type.split("(")[0]!)), "Array(UInt8)"];
  // A type of a Variant argument is one of those it holds, which its column tells.
  const variant = (call.inParameters ? call.target.parameters : call.target.arguments)?.findIndex((a) => a.types?.includes("Variant")) ?? -1;
  if (variant < 0) return typeNames();
  const column = columns.find((c) => c.column.name === call.names[variant] && c.column.family === "Variant");
  return column ? memberTypes(column.column.type) : [];
}

/** A string literal of the text. */
export function literal(text: string): string {
  return `'${text.replace(/[\\']/g, "\\$&")}'`;
}

/** The documented argument that a parameter of the syntax names: by its name, or by one of the names in it. */
function documented(list: readonly Argument[] | undefined, name: string): Argument | undefined {
  return list?.find((a) => a.name === name) ?? list?.find((a) => a.name.match(/[A-Za-z_]\w*/g)?.includes(name));
}

/** The lists of arguments in each pair of brackets of a function. */
interface FunctionSignature {
  /** The lists of the parameters of a parametric aggregate function, as `level` in quantile(level)(x). */
  parameters: ArgumentList[];
  arguments: ArgumentList[];
  /** Whether the lists come from the syntax, not from the documented arguments in their order. */
  read: boolean;
}

const signatures = new Map<FunctionInfo, FunctionSignature>();

/** The documented arguments in their order, for a function whose syntax is not read. */
function documentedList(list: readonly Argument[] | undefined): ArgumentList[] {
  return [{ parameters: (list ?? []).map((a) => ({ name: a.name, quoted: false, keyword: false, named: false })), repeats: false }];
}

/**
 * Reads each line of the syntax that calls the function, such as `quantile(level)(expr)` or `or CAST(x AS T)`;
 * a function whose syntax gives no list has its documented arguments in their order.
 */
export function functionSignature(info: FunctionInfo): FunctionSignature {
  let signature = signatures.get(info);
  if (signature) return signature;
  signature = { parameters: [], arguments: [], read: false };
  for (const line of (info.syntax ?? "").split("\n")) {
    const head = new RegExp(`^(?:or\\s+)?${info.name.replace(/\W/g, "\\$&")}\\s*`, "i").exec(line.trim());
    if (!head) continue;
    const text = line.trim();
    const groups: (ArgumentList[] | undefined)[] = [];
    for (let at = head[0].length; groups.length < 2 && at < text.length; ) {
      // A group of parameters in square brackets is optional, as in quantileBFloat16[(level)](expr).
      const optional = text[at] === "[" && text[at + 1] === "(";
      const open = at + (optional ? 1 : 0);
      if (text[open] !== "(") break;
      const close = closingBracket(text, open);
      if (close < 0) break;
      groups.push(readArguments(text.slice(open + 1, close))?.lists);
      at = close + 1 + (optional && text[close + 1] === "]" ? 1 : 0);
    }
    const [first, second] = groups;
    if (groups.length === 2 && first && second) {
      signature.parameters.push(...first);
      signature.arguments.push(...second);
    } else if (groups.length === 1 && first) signature.arguments.push(...first);
  }
  signature.read = signature.arguments.length > 0;
  if (!signature.arguments.length) signature.arguments = documentedList(info.arguments);
  if (!signature.parameters.length && info.parameters?.length) signature.parameters = documentedList(info.parameters);
  signatures.set(info, signature);
  return signature;
}

/** Whether a list has room for `count` arguments; the brackets may still lack some that it needs. */
function holds(list: ArgumentList, count: number): boolean {
  return list.repeats || count <= list.parameters.length;
}

/** The function call whose brackets the cursor is in, at the top level of them. */
export interface FunctionCall {
  info: FunctionInfo;
  /** The function the name stands for, the target of an alias. */
  target: FunctionInfo;
  /** Whether the brackets hold the parameters of a parametric aggregate function, the first of two pairs. */
  inParameters: boolean;
  /** The index of the argument at the cursor, and how many arguments the brackets hold. */
  index: number;
  count: number;
  /** The tokens of the argument at the cursor that are before it. */
  current: Token[];
  /** The name that each argument before the cursor is, when it is one. */
  names: (string | undefined)[];
  /** The documented arguments that the argument at the cursor may be, each with the word of the syntax it is. */
  arguments: { arg: Argument; word: Parameter; afterKeyword: boolean }[];
}

const OPENING = new Set([T.OpeningRoundBracket, T.OpeningSquareBracket, T.OpeningCurlyBrace]);
const CLOSING = new Set([T.ClosingRoundBracket, T.ClosingSquareBracket, T.ClosingCurlyBrace]);

/** Words after which a name with brackets is a table function, not a function. */
const TABLE_FUNCTION_WORDS = ["from", "join", "function"];

/** The index of the bracket that closes the one at `open` among the tokens, or the end of them. */
function closingToken(tokens: Token[], open: number): number {
  for (let i = open, depth = 0; i < tokens.length; i++) {
    if (OPENING.has(tokens[i]!.kind)) depth++;
    else if (CLOSING.has(tokens[i]!.kind) && --depth === 0) return i;
  }
  return tokens.length;
}

/** The word of a parameter written as several words that the argument at the cursor is, as `unit` after INTERVAL 1. */
function compoundWord(sql: string, param: Parameter, current: Token[]): { word: Parameter; afterKeyword: boolean } {
  const words = param.words;
  if (!words) return { word: param, afterKeyword: false };
  // After the last keyword written, the words that follow it take one token each, the last one the rest.
  let from = 0;
  let after = -1;
  words.forEach((word, i) => {
    if (!word.keyword) return;
    const at = current.findIndex((token, j) => j >= after && isWord(sql, token, word.name.toLowerCase()));
    if (at >= 0) [from, after] = [i + 1, at + 1];
  });
  const names = words.slice(from).filter((word) => !word.keyword);
  const word = names[Math.min(after < 0 ? 0 : current.length - after, names.length - 1)] ?? words[0]!;
  return { word, afterKeyword: from > 0 && word === names[names.length - 1] };
}

/** The function call at the end of `before`, the tokens of the statement before the cursor, in `statement`. */
export function functionCall(sql: string, statement: Token[], before: Token[]): FunctionCall | undefined {
  let open = before.length - 1;
  for (let depth = 0; open >= 0; open--) {
    const kind = before[open]!.kind;
    if (CLOSING.has(kind)) depth++;
    else if (OPENING.has(kind)) {
      if (depth === 0) break;
      depth--;
    }
  }
  if (before[open]?.kind !== T.OpeningRoundBracket) return undefined;
  // In name(parameters)(arguments), the second brackets follow the first ones.
  let nameAt = open - 1;
  const second = before[nameAt]?.kind === T.ClosingRoundBracket;
  if (second) {
    for (let depth = 0; nameAt >= 0; nameAt--) {
      const kind = before[nameAt]!.kind;
      if (kind === T.ClosingRoundBracket) depth++;
      else if (kind === T.OpeningRoundBracket && --depth === 0) break;
    }
    nameAt--;
  }
  const name = before[nameAt];
  if (name?.kind !== T.BareWord || before[nameAt - 1]?.kind === T.Dot) return undefined;
  if (TABLE_FUNCTION_WORDS.some((word) => isWord(sql, before[nameAt - 1], word))) return undefined;
  const info = findFunction(sql.slice(name.start, name.end));
  if (!info) return undefined;
  const target = info.aliasTo ? (findFunction(info.aliasTo) ?? info) : info;

  let index = 0;
  let current: Token[] = [];
  // The value of each argument before the cursor that is one string, and the name of each one that is a name.
  const written: (string | undefined)[] = [];
  const names: (string | undefined)[] = [];
  for (let i = open + 1, depth = 0; i < before.length; i++) {
    const token = before[i]!;
    if (token.kind === T.Comma && depth === 0) {
      written.push(current.length === 1 && current[0]!.kind === T.StringLiteral ? stringLiteralValue(sql.slice(current[0]!.start, current[0]!.end)) : undefined);
      names.push(current.length === 1 ? nameOf(sql, current[0]) : undefined);
      index++;
      current = [];
      continue;
    }
    if (OPENING.has(token.kind)) depth++;
    else if (CLOSING.has(token.kind)) depth--;
    current.push(token);
  }
  const close = closingToken(statement, open);
  let count = index + 1;
  for (let i = before.length, depth = 0; i < close; i++) {
    const kind = statement[i]!.kind;
    if (OPENING.has(kind)) depth++;
    else if (CLOSING.has(kind)) depth--;
    else if (kind === T.Comma && depth === 0) count++;
  }
  const inParameters = !second && statement[close + 1]?.kind === T.OpeningRoundBracket && Boolean(target.parameters?.length);

  const signature = functionSignature(target);
  const docs = inParameters ? target.parameters : target.arguments;
  // A string in quotes that names no documented argument is a value the form takes, as 'chinese' in tokens(value, 'chinese').
  const fixed = (param: Parameter) => param.quoted && !documented(docs, param.name);
  const found: FunctionCall["arguments"] = [];
  for (const list of inParameters ? signature.parameters : signature.arguments) {
    const param = holds(list, count) ? parameterAt(list, index, count) : undefined;
    if (!param) continue;
    const differs = written.some((value, j) => {
      const before = parameterAt(list, j, count);
      return value !== undefined && before !== undefined && fixed(before) && before.name !== value;
    });
    if (differs) continue;
    const { word, afterKeyword } = compoundWord(sql, param, current);
    // Such a value stands for the documented argument at its place.
    const arg = fixed(word) ? docs?.[index] : documented(docs, word.name);
    if (arg && !found.some((f) => f.arg === arg)) found.push({ arg, word, afterKeyword });
  }
  // In the order of the documentation.
  found.sort((a, b) => docs!.indexOf(a.arg) - docs!.indexOf(b.arg));
  return { info, target, inParameters, index, count, current, names, arguments: found };
}

/** The families of types that ClickHouse converts into one another where a documented type of the group is taken. */
const TYPE_GROUPS = [/^U?Int\d*$|^Integer$/, /^B?Float\d*$/, /^Decimal\d*$/, /^(?:Fixed)?String$/, /^Date(?:32)?$/, /^DateTime(?:32|64)?$/, /^Time(?:64)?$/, /^Enum(?:8|16)?$/, /^Interval\w*$/];

/** The family of a documented type, as Int for (U)Int* and Array for Array(T), or undefined for one of any type. */
function documentedFamily(type: string): string | undefined {
  const name = /^(?:const\s+)?(?:\(U\))?([A-Za-z]\w*)/.exec(type)?.[1];
  return name === "Any" || name === "Expression" || name === "T" || name === "Nullable" ? undefined : name;
}

/** Whether a column of the family fits one of the documented types, or undefined when they say any type does. */
export function fitsTypes(types: readonly string[], family: string | undefined): boolean | undefined {
  const families = types.map(documentedFamily);
  if (!families.length || families.includes(undefined)) return undefined;
  if (!family) return false;
  return families.some((f) => f === family || TYPE_GROUPS.some((group) => group.test(f!) && group.test(family)));
}

/** A suggestion and its tier: the lower, the earlier. */
export interface Ranked {
  tier: number;
  candidate: CompletionCandidate;
}

export interface FunctionContext {
  call: FunctionCall;
  /** The columns the statement may use: of the table it makes, and of the tables it reads in the schema. */
  columns: { column: DeclaredColumn; documentation?: string }[];
  /** The tier of the columns that fit no documented type. */
  columnTier: number;
  /** Whether keywords are written in lower case, after a prefix in lower case. */
  lower: boolean;
}

const VALUES = -2;
const FITTING = -1;

/** Values that the documentation lists and ClickHouse 26.11 refuses there, as it answers for each of them. */
const REFUSED = new Map([
  // No LIKE patterns with these, splitByRegexp needs its regular expression, and SHAKE has no HMAC.
  ["tokensForLikePattern", ["array", "splitByString"]],
  ["hasAllTokens", ["splitByRegexp"]],
  ["hasAnyTokens", ["splitByRegexp"]],
  ["HMAC", ["shake128", "shake256"]],
]);

/** The suggestions for the argument at the cursor of a function, by what each documented argument there takes. */
export function functionCandidates(context: FunctionContext): Ranked[] {
  const { call, columns, columnTier, lower } = context;
  const out: Ranked[] = [];
  const add = (tier: number, candidate: CompletionCandidate) => out.push({ tier, candidate });
  for (const { arg, afterKeyword } of call.arguments) {
    const kind = argumentKind(call.target, arg);
    // Values come where the argument starts, or as keywords after the keyword before them, as DAY in INTERVAL 1 DAY.
    if (call.current.length && !(afterKeyword && kind === "value")) continue;
    const detail = arg.name;
    switch (kind) {
      case "value":
        for (const [value, ...spellings] of arg.values!) {
          if (REFUSED.get(call.target.name)?.includes(value)) continue;
          const note = spellings.length ? `${detail}, also ${spellings.join(", ")}` : detail;
          if (afterKeyword) add(VALUES, { label: lower ? value.toLowerCase() : value.toUpperCase(), kind: "keyword", detail: note });
          else add(VALUES, { label: value, kind: "value", detail: note, insertText: literal(value) });
        }
        break;
      case "data type":
      case "JSON data type":
        for (const type of takenTypes(call, kind === "JSON data type", columns))
          add(VALUES, { label: type, kind: "data type", detail, insertText: literal(type) });
        break;
      case "time zone":
        for (const { name } of TIME_ZONES) add(VALUES, { label: name, kind: "value", detail: "time zone", insertText: literal(name) });
        break;
      case "format": {
        const input = /\binput format\b/i.test(arg.description);
        // A function that is not an aggregate formats one row at a time.
        for (const info of FORMATS)
          if ((input ? info.input : info.output) && (input || call.target.aggregate || info.rows))
            add(VALUES, { label: info.name, kind: "format", detail: formatDetail(info), documentation: formatDocumentation(info), insertText: literal(info.name) });
        break;
      }
      case "JSON path":
        add(VALUES, { label: "'$.'", kind: "value", detail: "JSONPath", insertText: "'$.'", cursor: 3 });
        break;
    }
  }
  // The columns whose type fits the argument first, and then the others.
  if (!call.current.length && call.arguments.length) {
    for (const { column, documentation } of columns) {
      const fits = call.arguments.some(({ arg }) => fitsTypes(arg.types ?? [], column.family === "LowCardinality" || column.family === "Nullable" ? column.inner : column.family));
      const candidate = named({ label: column.name, kind: "column", detail: column.type || undefined });
      add(fits ? FITTING : columnTier, documentation ? { ...candidate, documentation } : candidate);
    }
  }
  return out;
}
