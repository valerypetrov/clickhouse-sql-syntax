/**
 * The arguments of table engines: the lists of parameters that the syntax of each engine in the catalog
 * allows, what each parameter takes by its name, and which ones the argument at the cursor may be.
 */
import { FORMATS } from "../generated/formats.js";
import { TABLE_ENGINES, type TableEngineInfo } from "../generated/table-engines.js";
import { stringLiteralValue } from "../parser/index.js";
import { type Token, TokenKind as T } from "../types.js";
import { isWord, nameOf } from "./schema.js";

/** A parameter as the syntax of an engine names it, such as `'zoo_path'`, `ver` or `NOSIGN`. */
export interface EngineParameter {
  /** The name without its quotes. */
  name: string;
  /** Written in quotes, so the argument is a string. */
  quoted: boolean;
  /** A word in capitals, such as NOSIGN, that the argument is. */
  keyword: boolean;
  /** `key = value`: an argument given by name. */
  named: boolean;
}

/** One list of arguments that an engine takes; with `repeats`, its last parameter may follow any number of times. */
interface ArgumentList {
  parameters: EngineParameter[];
  repeats: boolean;
}

/** What the brackets of an engine hold, read from its syntax. */
export interface EngineSignature {
  /** The call as the syntax writes it, such as `File(format[, path | fd])`. */
  label: string;
  /** Each parameter once, in the order of the label. */
  parameters: EngineParameter[];
  lists: ArgumentList[];
}

/** A piece of the syntax: a parameter, `a | b` at the top level, or `[...]` with alternatives split by `|`. */
type Item =
  | { type: "param"; param: EngineParameter; repeats: boolean }
  | { type: "choice"; items: Item[] }
  | { type: "optional"; lists: Item[][] };

type SyntaxToken = { punct: string; name?: undefined; quoted?: undefined } | { punct?: undefined; name: string; quoted: boolean };

/** More lists than any engine has; a syntax that gives more is not read. */
const MAX_LISTS = 1000;

/** The tokens of the syntax inside the brackets, or undefined at a character it does not use. */
function syntaxTokens(text: string): SyntaxToken[] | undefined {
  const pattern = /\s*(?:(\.\.\.|[[\]|,=])|'([^']*)'|([A-Za-z_]\w*))/y;
  const tokens: SyntaxToken[] = [];
  while (pattern.lastIndex < text.length) {
    if (/^\s*$/.test(text.slice(pattern.lastIndex))) break;
    const match = pattern.exec(text);
    if (!match) return undefined;
    if (match[1]) tokens.push({ punct: match[1] });
    else tokens.push({ name: match[2] ?? match[3]!, quoted: match[2] !== undefined });
  }
  return tokens;
}

/** The items up to `]`, or to the end at the top level, as alternatives split by `|` inside brackets. */
function parseItems(tokens: SyntaxToken[], pos: { i: number }, inBrackets: boolean): Item[][] | undefined {
  const lists: Item[][] = [[]];
  for (;;) {
    const list = lists[lists.length - 1]!;
    const token = tokens[pos.i];
    if (!token) return inBrackets ? undefined : lists;
    if (token.punct === "]") {
      pos.i++;
      return inBrackets ? lists : undefined;
    }
    if (token.punct === "," || token.punct === "|" || token.punct === "...") {
      pos.i++;
      if (token.punct === "|" && inBrackets) lists.push([]);
      else if (token.punct === "|") {
        // At the top level, `a | b` is one argument that is either.
        const left = list.pop();
        const right = parseAtom(tokens, pos);
        if (!left || !right) return undefined;
        list.push({ type: "choice", items: [...(left.type === "choice" ? left.items : [left]), right] });
      } else if (token.punct === "...") {
        const last = list[list.length - 1];
        if (last?.type !== "param") return undefined;
        last.repeats = true;
      }
      continue;
    }
    const atom = parseAtom(tokens, pos);
    if (!atom) return undefined;
    list.push(atom);
  }
}

function parseAtom(tokens: SyntaxToken[], pos: { i: number }): Item | undefined {
  const token = tokens[pos.i++];
  if (token?.punct === "[") {
    const lists = parseItems(tokens, pos, true);
    return lists && { type: "optional", lists };
  }
  if (token?.name === undefined) return undefined;
  const param = { name: token.name, quoted: token.quoted, keyword: !token.quoted && /^[A-Z][A-Z0-9_]+$/.test(token.name), named: false };
  if (tokens[pos.i]?.punct === "=") {
    if (tokens[pos.i + 1]?.name === undefined) return undefined;
    pos.i += 2;
    param.named = true;
  }
  return { type: "param", param, repeats: false };
}

/** Every list of parameters that the items allow. */
function expand(items: readonly Item[]): ArgumentList[] {
  let lists: (ArgumentList & { closed: boolean })[] = [{ parameters: [], repeats: false, closed: false }];
  for (const item of items) {
    const next: typeof lists = [];
    for (const list of lists) {
      const add = (tails: ArgumentList[]) => {
        for (const tail of tails) next.push({ parameters: [...list.parameters, ...tail.parameters], repeats: tail.repeats, closed: list.closed });
      };
      if (list.repeats) next.push(list);
      else if (item.type === "param") add([{ parameters: [item.param], repeats: item.repeats }]);
      else if (item.type === "choice") add(item.items.flatMap((choice) => expand([choice])));
      else {
        // ClickHouse reads the next value as an optional format or keyword left out, so no optional one follows.
        const typed = item.lists.every((l) => l[0]?.type === "param" && isTyped(l[0].param));
        next.push({ ...list, closed: list.closed || typed });
        if (!list.closed) add(item.lists.flatMap((l) => expand(l)));
      }
    }
    if (next.length > MAX_LISTS) return [];
    lists = next;
  }
  return lists.map(({ parameters, repeats }) => ({ parameters, repeats }));
}

function parametersOf(items: readonly Item[], into: EngineParameter[]): EngineParameter[] {
  for (const item of items) {
    if (item.type === "param") {
      if (!into.some((p) => p.name === item.param.name)) into.push(item.param);
    } else if (item.type === "choice") parametersOf(item.items, into);
    else for (const list of item.lists) parametersOf(list, into);
  }
  return into;
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
  let depth = 0;
  let close = -1;
  for (let i = head.length; i < syntax.length && close < 0; i++) {
    if (syntax[i] === "(") depth++;
    else if (syntax[i] === ")" && --depth === 0) close = i;
  }
  const tokens = close < 0 ? undefined : syntaxTokens(syntax.slice(head.length + 1, close));
  const items = tokens && parseItems(tokens, { i: 0 }, false)?.[0];
  if (!items) return undefined;
  const lists = expand(items);
  if (!lists.length) return undefined;
  return { label: syntax.slice("ENGINE = ".length, close + 1), parameters: parametersOf(items, []), lists };
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

export function parameterAt(list: ArgumentList, index: number): EngineParameter | undefined {
  const { parameters } = list;
  return index < parameters.length ? parameters[index] : list.repeats ? parameters[parameters.length - 1] : undefined;
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
