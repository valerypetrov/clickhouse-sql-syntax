/**
 * The arguments of table engines: the lists of parameters that the syntax of each engine in the catalog
 * allows, what each parameter takes by its name, and which ones the argument at the cursor may be.
 */
import { FORMATS } from "../generated/formats.js";
import { TABLE_ENGINES, type TableEngineInfo } from "../generated/table-engines.js";
import { stringLiteralValue } from "../parser/index.js";
import { type Token, TokenKind as T } from "../types.js";
import { isWord, nameOf } from "./schema.js";
import { type ArgumentList, closingBracket, type Parameter, parameterAt, readArguments } from "./syntax.js";

/** A parameter as the syntax of an engine names it, such as `'zoo_path'`, `ver` or `NOSIGN`. */
export type EngineParameter = Parameter;

/** What the brackets of an engine hold, read from its syntax. */
export interface EngineSignature {
  /** The call as the syntax writes it, such as `File(format[, path | fd])`. */
  label: string;
  /** Each parameter once, in the order of the label. */
  parameters: EngineParameter[];
  lists: ArgumentList[];
}

/** Reads `ENGINE = Name(...)` of the engine's syntax, or `ENGINE = Name` for none; undefined for any other form. */
export function readSignature(info: TableEngineInfo): EngineSignature | undefined {
  const syntax = info.syntax ?? "";
  const head = `ENGINE = ${info.name}`;
  if (!syntax.startsWith(head)) return undefined;
  if (syntax[head.length] !== "(") {
    if (/\w/.test(syntax[head.length] ?? "")) return undefined;
    return { label: info.name, parameters: [], lists: [{ parameters: [], repeats: false }] };
  }
  const close = closingBracket(syntax, head.length);
  // ClickHouse reads the next value as an optional format or keyword left out, so no optional one follows.
  const read = close < 0 ? undefined : readArguments(syntax.slice(head.length + 1, close), isTyped);
  return read && { label: syntax.slice("ENGINE = ".length, close + 1), ...read };
}

const signatures = new Map<TableEngineInfo, EngineSignature | null>();

export function engineSignature(info: TableEngineInfo): EngineSignature | undefined {
  let signature = signatures.get(info);
  if (signature === undefined) signatures.set(info, (signature = readSignature(info) ?? null));
  return signature ?? undefined;
}

const enginesByName = new Map(TABLE_ENGINES.map((e) => [e.name, e]));
const enginesByLowerName = new Map(TABLE_ENGINES.map((e) => [e.name.toLowerCase(), e]));

export function findEngine(name: string): TableEngineInfo | undefined {
  return enginesByName.get(name) ?? enginesByLowerName.get(name.toLowerCase());
}

/** What a parameter takes, by the name the syntax gives it. */
export type ParameterKind =
  | "zoo path" | "replica" | "sign" | "version" | "is_deleted" | "columns" | "sharding key" | "key" | "format"
  | "compression" | "cluster" | "database" | "table" | "strictness" | "join kind" | "keyword";

const KINDS = new Map<string, ParameterKind>([
  ["zoo_path", "zoo path"], ["replica_name", "replica"], ["sign", "sign"], ["ver", "version"], ["version", "version"],
  ["is_deleted", "is_deleted"], ["columns", "columns"], ["sharding_key", "sharding key"], ["format", "format"],
  ["compression", "compression"], ["compression_method", "compression"], ["cluster", "cluster"],
  ["join_strictness", "strictness"], ["join_type", "join kind"],
]);
/** Names of the server's databases and tables only when not in quotes: 'database' of MySQL is a remote one. */
const BARE_KINDS = new Map<string, ParameterKind>([
  ["database", "database"], ["db", "database"], ["db_name", "database"], ["target_db", "database"],
  ["table", "table"], ["target_table", "table"],
]);

export function kindOf(param: EngineParameter): ParameterKind | undefined {
  if (param.keyword) return "keyword";
  if (param.named) return undefined;
  const name = param.name.toLowerCase();
  return KINDS.get(name) ?? (param.quoted ? undefined : BARE_KINDS.get(name)) ?? (/^k\d+$/.test(name) ? "key" : undefined);
}

const DESCRIPTIONS: Record<ParameterKind, string> = {
  "zoo path": "The path of the table in ClickHouse Keeper.",
  replica: "The name of the replica in ClickHouse Keeper.",
  sign: "A column of type Int8: 1 for a row, -1 for one that cancels it.",
  version: "A column of the version of a row, of type UInt*, Date, DateTime or DateTime64.",
  is_deleted: "A column of type UInt8: 1 for a deleted row, 0 for a row.",
  columns: "The columns whose values are merged, as a name or a tuple of names, none of the sorting key.",
  "sharding key": "An expression of an integer type that picks the shard, such as rand().",
  key: "A column of the key of the JOIN.",
  format: "The format of the data.",
  compression: "How the data is compressed.",
  cluster: "A cluster of the server, from remote_servers.",
  database: "A database.",
  table: "A table.",
  strictness: "ANY, ALL, SEMI or ANTI.",
  "join kind": "LEFT, INNER, RIGHT or FULL.",
  keyword: "This word as it is.",
};

export function parameterDescription(param: EngineParameter): string {
  const kind = kindOf(param);
  return kind ? DESCRIPTIONS[kind] : "";
}

/** The methods of ClickHouse's chooseCompressionMethod(), and the other names it takes for them. */
export const COMPRESSION = ["auto", "none", "gzip", "deflate", "br", "xz", "zstd", "lz4", "bz2", "snappy"];
const COMPRESSION_NAMES = new Set([...COMPRESSION, "gz", "brotli", "lzma", "zst"]);
const FORMAT_NAMES = new Set(["auto", ...FORMATS.map((f) => f.name.toLowerCase())]);
export const STRICTNESS = ["ANY", "ALL", "SEMI", "ANTI"];
/** The join kinds that the Join engine takes after each strictness. */
export const JOIN_KINDS: Record<string, string[]> = {
  ANY: ["LEFT", "INNER", "RIGHT"],
  ALL: ["LEFT", "INNER", "RIGHT", "FULL"],
  SEMI: ["LEFT", "RIGHT"],
  ANTI: ["LEFT", "RIGHT"],
};

/** The kinds of parameters that take only some words: a format, a keyword, ... */
const TYPED = new Set<ParameterKind | undefined>(["keyword", "format", "compression", "strictness", "join kind"]);

function isTyped(param: EngineParameter): boolean {
  return TYPED.has(kindOf(param));
}

/** Whether the parameter takes the value, or undefined for one that takes any. */
function takes(param: EngineParameter, value: string): boolean | undefined {
  switch (kindOf(param)) {
    case "keyword":
      return value.toUpperCase() === param.name;
    case "format":
      return FORMAT_NAMES.has(value.toLowerCase());
    case "compression":
      return COMPRESSION_NAMES.has(value.toLowerCase());
    case "strictness":
      return STRICTNESS.includes(value.toUpperCase());
    case "join kind":
      return JOIN_KINDS.ALL!.includes(value.toUpperCase());
    default:
      return undefined;
  }
}

/** An argument as written: its value when it is one string or word, and its name when it is `name = value`. */
export interface Written {
  value?: string;
  named?: string;
}

function written(sql: string, tokens: Token[]): Written {
  const [first, second] = tokens;
  if (first?.kind === T.BareWord && second?.kind === T.Equals) return { named: sql.slice(first.start, first.end) };
  if (tokens.length !== 1) return {};
  if (first!.kind === T.StringLiteral) return { value: stringLiteralValue(sql.slice(first!.start, first!.end)) };
  return { value: nameOf(sql, first) };
}

function accepts(param: EngineParameter, arg: Written): boolean {
  if (param.named || arg.named !== undefined) return param.named && arg.named !== undefined;
  return arg.value === undefined ? !isTyped(param) : takes(param, arg.value) !== false;
}

/** The engine call whose brackets the cursor is in, at the top level of them. */
export interface EngineCall {
  info: TableEngineInfo;
  /** The arguments before the one at the cursor. */
  args: Written[];
  /** The tokens of the argument at the cursor that are before it. */
  current: Token[];
  /** The lists that agree with the arguments before, each with a parameter at the cursor. */
  lists: ArgumentList[];
  /** The parameters that the argument at the cursor may be, in the order of the label. */
  parameters: EngineParameter[];
}

const OPENING = new Set([T.OpeningRoundBracket, T.OpeningSquareBracket, T.OpeningCurlyBrace]);
const CLOSING = new Set([T.ClosingRoundBracket, T.ClosingSquareBracket, T.ClosingCurlyBrace]);

/** Whether the statement makes a database, whose engines are not table engines. */
function createsDatabase(sql: string, statement: Token[]): boolean {
  let i = 0;
  while (["create", "attach", "or", "replace"].some((word) => isWord(sql, statement[i], word))) i++;
  return isWord(sql, statement[i], "database");
}

/** The engine call at the end of `before`, the tokens of the statement before the cursor. */
export function engineCall(sql: string, statement: Token[], before: Token[]): EngineCall | undefined {
  let open = before.length - 1;
  for (let depth = 0; open >= 0; open--) {
    const kind = before[open]!.kind;
    if (CLOSING.has(kind)) depth++;
    else if (OPENING.has(kind)) {
      if (depth === 0) break;
      depth--;
    }
  }
  const name = before[open - 1];
  if (before[open]?.kind !== T.OpeningRoundBracket || name?.kind !== T.BareWord) return undefined;
  if (!isWord(sql, before[open - 2]?.kind === T.Equals ? before[open - 3] : before[open - 2], "engine")) return undefined;
  const info = findEngine(sql.slice(name.start, name.end));
  if (!info || createsDatabase(sql, statement)) return undefined;

  const args: Written[] = [];
  let current: Token[] = [];
  for (let i = open + 1, depth = 0; i < before.length; i++) {
    const token = before[i]!;
    if (token.kind === T.Comma && depth === 0) {
      args.push(written(sql, current));
      current = [];
      continue;
    }
    if (OPENING.has(token.kind)) depth++;
    else if (CLOSING.has(token.kind)) depth--;
    current.push(token);
  }

  const signature = engineSignature(info);
  let lists = (signature?.lists ?? []).filter(
    (list) => parameterAt(list, args.length) && args.every((arg, j) => accepts(parameterAt(list, j)!, arg)),
  );
  // A value that a format or keyword takes is read as it, as ClickHouse reads a format name as the format.
  args.forEach((_, j) => {
    const typed = lists.filter((list) => isTyped(parameterAt(list, j)!));
    if (typed.length) lists = typed;
  });
  const at = new Set(lists.map((list) => parameterAt(list, args.length)!.name));
  const parameters = (signature?.parameters ?? []).filter((p) => at.has(p.name));
  return { info, args, current, lists, parameters };
}
