/**
 * checkOptions(): what ClickHouse refuses in the options of statements that its parser takes: settings, codecs,
 * index and statistics types, formats and compression methods. It looks only at statements without syntax errors.
 */
import { FORMATS } from "../generated/formats.js";
import { CODECS, type CallRule, INDEX_TYPES, type ParameterRule, STATISTICS_MESSAGE, STATISTICS_TYPES, UNKNOWN_INDEX_TYPE } from "../generated/options.js";
import { tokenize } from "../lexer/index.js";
import { Lines, type ParseCache, parsedStatements, quotedName, type Role, stringLiteralValue } from "../parser/index.js";
import { type Diagnostic, type Fix, isSignificant, type Severity, type Token, TokenKind as T } from "../types.js";
import { explainSettings, querySetting, type SettingsContext, settingsScope } from "./catalog.js";
import { ENGINE_REQUIRED, missingEngine, setsNoEngine } from "./engine.js";
import { nameHints, replaceFixes, valueFixes } from "./fixes.js";
import { readValue, valueError } from "./values.js";
import { COMPRESSION_METHODS, EXPLAIN_KINDS } from "./words.js";

/** The words and tokens of one statement that parses. */
interface Statement {
  sql: string;
  tokens: Token[];
  /** The role of each word, by its offset. */
  roles: Map<number, Role>;
  out: Diagnostic[];
  lines: Lines;
}

const word = (s: Statement, token: Token | undefined) => (token?.kind === T.BareWord ? s.sql.slice(token.start, token.end).toLowerCase() : undefined);
const textOf = (s: Statement, token: Token) => s.sql.slice(token.start, token.end);
const nameOf = (s: Statement, token: Token): string | undefined =>
  token.kind === T.BareWord ? textOf(s, token) : token.kind === T.QuotedIdentifier ? quotedName(textOf(s, token)) : undefined;
const isKeyword = (s: Statement, token: Token | undefined, keyword: string) => word(s, token) === keyword && s.roles.get(token!.start) === "keyword";

function report(s: Statement, from: Token, to: Token, message: string, severity: Severity = "error", fixes?: Fix[]): void {
  const { line, col } = s.lines.at(from.start);
  s.out.push({ message, start: from.start, end: to.end, line, col, severity, ...(fixes?.length && { fixes }) });
}

/** Fixes that write one of `names` in place of the tokens from `from` to `to`; with `closest`, only the closest ones. */
function nameFixes(from: Token, to: Token, name: string, names: Iterable<string>, closest = false): Fix[] {
  const hints = nameHints(name, names);
  return replaceFixes(from.start, to.end, closest ? hints.filter((h) => h.distance === hints[0]!.distance) : hints);
}

/** Errors of options in the statements of `sql` that parse, with the same cache as checkWithRoles(). */
export function checkOptions(sql: string, cache?: ParseCache): Diagnostic[] {
  const out: Diagnostic[] = [];
  const statements = parsedStatements(sql, cache);
  if (!statements.length) return out;
  const all = tokenize(sql).filter((t) => isSignificant(t.kind) && t.kind !== T.EndOfStream);
  const lines = new Lines(sql);
  let at = 0;
  let noEngine = false;
  for (const parsed of statements) {
    while (at < all.length && all[at]!.start < parsed.begin) at++;
    let end = at;
    while (end < all.length && all[end]!.start < parsed.end) end++;
    const tokens = all.slice(at, end).filter((t) => t.kind !== T.Semicolon);
    const s: Statement = { sql, tokens, roles: new Map(parsed.spans.map((span) => [span.start, span.role])), out, lines };
    // ATTACH restores what was made before, and ClickHouse does not check its definitions again.
    if (word(s, tokens[0]) === "attach") {
      at = end;
      continue;
    }
    noEngine = setsNoEngine(sql, tokens) ?? noEngine;
    const missing = noEngine ? missingEngine(sql, tokens, (t) => s.roles.get(t.start) === "keyword") : undefined;
    if (missing) report(s, missing.name, missing.name, ENGINE_REQUIRED, "error", [missing.fix]);
    for (const mark of parsed.names)
      if (mark.kind === "settings") checkSettingsList(s, parsed.begin + mark.start, parsed.begin + mark.end, mark.flag as SettingsContext, mark.name && sql.slice(parsed.begin + mark.name[0], parsed.begin + mark.name[1]));
    checkCalls(s);
    at = end;
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The pieces of a list between its top-level commas. */
function splitList(tokens: Token[]): Token[][] {
  const pieces: Token[][] = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (token.kind === T.OpeningRoundBracket || token.kind === T.OpeningSquareBracket || token.kind === T.OpeningCurlyBrace) depth++;
    if (token.kind === T.ClosingRoundBracket || token.kind === T.ClosingSquareBracket || token.kind === T.ClosingCurlyBrace) depth--;
    if (token.kind === T.Comma && depth === 0) pieces.push([]);
    else pieces[pieces.length - 1]!.push(token);
  }
  return pieces.filter((p) => p.length);
}

const PROFILE_WORDS = new Set(["min", "max", "const", "readonly", "writable", "changeable_in_readonly"]);

/** The context of a storage: a table engine, or a database engine in CREATE DATABASE. */
function isDatabaseStatement(s: Statement): boolean {
  for (const token of s.tokens.slice(0, 5)) {
    const w = word(s, token);
    if (w === "database") return true;
    if (w === "table" || w === "view" || w === "dictionary" || w === "function") return false;
  }
  return false;
}

/** The kind of the EXPLAIN whose settings start at `start`, as PLAN or QUERY TREE, from the words after its EXPLAIN. */
function explainKind(s: Statement, start: number): string {
  let at = s.tokens.findIndex((t) => t.start >= start);
  if (at < 0) at = s.tokens.length;
  let explain = at - 1;
  while (explain >= 0 && word(s, s.tokens[explain]) !== "explain") explain--;
  const words = s.tokens.slice(explain + 1, at).map((t) => word(s, t)?.toUpperCase() ?? "");
  for (const kind of EXPLAIN_KINDS) {
    const parts = kind.split(" ");
    if (parts.every((part, i) => words[i] === part)) return kind;
  }
  return "PLAN";
}

function checkSettingsList(s: Statement, start: number, end: number, context: SettingsContext, engine: string | undefined): void {
  const tokens = s.tokens.filter((t) => t.start >= start && t.end <= end);
  if (!tokens.length) return;
  let scopeContext = context;
  if (context === "storage" && isDatabaseStatement(s)) scopeContext = "database";
  if (context === "backup" && word(s, s.tokens[0]) === "restore") scopeContext = "restore";
  const kind = context === "explain" ? explainKind(s, start) : undefined;
  const scope = settingsScope(scopeContext, engine, kind);
  // An engine without SETTINGS still takes the settings of queries there.
  const unsupported = scope.unsupported && (scopeContext === "storage" || scopeContext === "database") ? scope.unsupported : undefined;
  for (const piece of splitList(tokens)) {
    // The name may have dots; quoted parts are unquoted.
    let i = 0;
    const parts: string[] = [];
    for (; i < piece.length; i += 2) {
      const part = nameOf(s, piece[i]!);
      if (part === undefined) return;
      parts.push(part);
      if (piece[i + 1]?.kind !== T.Dot) break;
    }
    const nameEnd = piece[Math.min(i, piece.length - 1)]!;
    const name = parts.join(".");
    let valueTokens: Token[] | undefined;
    if (piece[i + 1]?.kind === T.Equals) {
      valueTokens = piece.slice(i + 2);
      if (context === "profile") {
        const stop = valueTokens.findIndex((t) => PROFILE_WORDS.has(word(s, t) ?? ""));
        if (stop >= 0) valueTokens = valueTokens.slice(0, stop);
      }
    }
    const isDefault = valueTokens?.length === 1 && word(s, valueTokens[0]) === "default";
    const isParameter = /^\{.*\}$/.test(valueTokens?.map((t) => textOf(s, t)).join("") ?? "");
    // SET profile = 'p' applies a profile, which no list of settings has.
    if (name.startsWith("param_") || isDefault || (name === "profile" && settingsScopeIsQuery(scopeContext))) continue;
    // Settings with the prefix that servers allow for custom settings by default.
    if (name.startsWith("custom_") && settingsScopeIsQuery(scopeContext)) continue;
    // The queue engines read their settings with an s3queue_ prefix too.
    const queue = (engine && /Queue$/.test(engine)) || scopeContext === "alter" || scopeContext === "reset";
    if (unsupported) {
      if (!querySetting(name)) {
        report(s, piece[0]!, nameEnd, unsupported);
        return;
      }
      continue;
    }
    const setting = scope.find(name) ?? (queue && name.startsWith("s3queue_") ? scope.find(name.slice(8)) : undefined);
    if (!setting) {
      if (scope.unknown && (context !== "explain" || explainSettings(kind!))) {
        // Only the closest settings that take the value written, as the checks of values are not complete.
        const value = valueTokens && !isParameter && context !== "explain" ? readValue(s.sql, valueTokens) : undefined;
        const names = scope.offered.filter((o) => !value || !valueError(o.info, value)).map((o) => o.info.name);
        report(s, piece[0]!, nameEnd, scope.unknown.replace("{}", name), "error", nameFixes(piece[0]!, nameEnd, name, names, true));
      }
      continue;
    }
    if (!valueTokens || isParameter) continue;
    if (context === "explain") {
      checkExplainValue(s, kind!, name, setting.type === "Bool", valueTokens);
      continue;
    }
    const value = readValue(s.sql, valueTokens);
    const problem = value && valueError(setting, value);
    if (problem) report(s, valueTokens[0]!, valueTokens[valueTokens.length - 1]!, problem, "error", valueFixes(s.sql, valueTokens, setting, value!));
    if (context === "profile") checkConstraints(s, piece, setting);
  }
}

const settingsScopeIsQuery = (context: SettingsContext) => context === "query" || context === "set" || context === "profile";

/** The MIN and MAX of a settings profile element take the type of the setting too. */
function checkConstraints(s: Statement, piece: Token[], setting: NonNullable<ReturnType<typeof querySetting>>): void {
  for (let i = 0; i < piece.length; i++) {
    const w = word(s, piece[i]);
    if (w !== "min" && w !== "max") continue;
    let j = i + 1;
    if (piece[j]?.kind === T.Equals) j++;
    const take = piece[j]?.kind === T.Minus ? 2 : 1;
    const valueTokens = piece.slice(j, j + take);
    const value = readValue(s.sql, valueTokens);
    const problem = value && valueError(setting, value);
    if (problem) report(s, valueTokens[0]!, valueTokens[valueTokens.length - 1]!, problem);
  }
}

/** EXPLAIN takes integers only, and 0 or 1 for its boolean settings. */
function checkExplainValue(s: Statement, kind: string, name: string, bool: boolean, valueTokens: Token[]): void {
  const explain = explainSettings(kind);
  const value = readValue(s.sql, valueTokens);
  if (!explain || !value) return;
  const first = valueTokens[0]!;
  const last = valueTokens[valueTokens.length - 1]!;
  // EXPLAIN takes UInt64 values only.
  if (value.t === "String" || value.t === "Float64" || value.t === "Int64") {
    if (explain.string) report(s, first, last, explain.string.replace("{}", name).replace("{type}", value.t));
  } else if (bool && value.t === "UInt64" && value.big !== 0n && value.big !== 1n) {
    if (explain.bool) report(s, first, last, explain.bool.replace("{}", name).replace("{value}", value.text));
  }
}

// ---------------------------------------------------------------- Codecs, index types, statistics, formats, compression

const codecsByName = new Map(CODECS.map((c) => [c.name.toLowerCase(), c]));
const indexTypesByName = new Map(INDEX_TYPES.map((t) => [t.name.toLowerCase(), t]));
const statisticsNames = new Set(STATISTICS_TYPES.map((t) => t.name.toLowerCase()));
const formatNames = new Set(FORMATS.map((f) => f.name.toLowerCase()));

/** The index of the bracket that closes the one at `open`. */
function matching(tokens: Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i]!.kind === T.OpeningRoundBracket) depth++;
    else if (tokens[i]!.kind === T.ClosingRoundBracket && --depth === 0) return i;
  }
  return tokens.length;
}

/** The calls of a bracket list from `open`: each name with the tokens of its arguments, and where the list ends. */
function bracketCalls(tokens: Token[], open: number): { calls: { name: Token; args?: Token[][]; close?: Token }[]; end: number } {
  const calls: { name: Token; args?: Token[][]; close?: Token }[] = [];
  let i = open + 1;
  while (i < tokens.length && tokens[i]!.kind !== T.ClosingRoundBracket) {
    const name = tokens[i]!;
    i++;
    let args: Token[][] | undefined;
    let close: Token | undefined;
    if (tokens[i]?.kind === T.OpeningRoundBracket) {
      const shut = matching(tokens, i);
      args = splitList(tokens.slice(i + 1, shut));
      close = tokens[shut];
      i = shut + 1;
    }
    calls.push({ name, args, close });
    // Past anything else up to the next comma at this level, as a second list of parameters.
    let depth = 0;
    while (i < tokens.length) {
      const t = tokens[i]!;
      if (t.kind === T.OpeningRoundBracket) depth++;
      else if (t.kind === T.ClosingRoundBracket) {
        if (depth === 0) break;
        depth--;
      } else if (t.kind === T.Comma && depth === 0) {
        i++;
        break;
      }
      i++;
    }
  }
  return { calls, end: i };
}

function checkCalls(s: Statement): void {
  const tokens = s.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== T.BareWord || s.roles.get(token.start) !== "keyword") continue;
    switch (word(s, token)) {
      case "codec":
        if (tokens[i + 1]?.kind === T.OpeningRoundBracket) checkCodecs(s, i + 1);
        break;
      case "statistics":
        if (tokens[i + 1]?.kind === T.OpeningRoundBracket) for (const call of bracketCalls(tokens, i + 1).calls) checkStatistics(s, call.name);
        break;
      case "type":
        checkType(s, i);
        break;
      case "format": {
        const next = tokens[i + 1];
        const name = next && nameOf(s, next);
        if (name !== undefined && s.roles.get(next!.start) !== "keyword" && !formatNames.has(name.toLowerCase()) && /^\w+$/.test(name)) {
          const input = word(s, tokens[0]) === "insert";
          report(s, next!, next!, `Unknown format ${name}.`, "error", nameFixes(next!, next!, name, FORMATS.filter((f) => (input ? f.input : f.output)).map((f) => f.name)));
        }
        break;
      }
      case "compression": {
        const next = tokens[i + 1];
        const method = next?.kind === T.StringLiteral ? stringLiteralValue(textOf(s, next)) : undefined;
        if (method !== undefined && !COMPRESSION_METHODS.has(method.toLowerCase()))
          report(s, next!, next!, `Unknown compression method '${method}'. Only 'auto', 'none', 'gzip', 'deflate', 'br', 'xz', 'zstd', 'lz4', 'bz2', 'snappy' are supported as compression methods.`, "warning",
            replaceFixes(next!.start, next!.end, nameHints(method, [...COMPRESSION_METHODS].filter(Boolean)), (m) => `'${m}'`));
        break;
      }
    }
  }
}

function checkStatistics(s: Statement, name: Token): void {
  const text = nameOf(s, name);
  if (text !== undefined && !statisticsNames.has(text.toLowerCase()))
    report(s, name, name, STATISTICS_MESSAGE.replace("{}", text), "error", nameFixes(name, name, text, STATISTICS_TYPES.map((t) => t.name)));
}

/** TYPE after INDEX name expr, or after STATISTICS columns. */
function checkType(s: Statement, at: number): void {
  const tokens = s.tokens;
  let depth = 0;
  let owner: string | undefined;
  for (let j = at - 1; j >= 0; j--) {
    const t = tokens[j]!;
    if (t.kind === T.ClosingRoundBracket) depth++;
    else if (t.kind === T.OpeningRoundBracket) {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && t.kind === T.BareWord && s.roles.get(t.start) === "keyword") {
      const w = word(s, t);
      if (w === "index" || w === "statistics") {
        owner = w;
        break;
      }
    }
  }
  if (owner === "statistics") {
    for (let j = at + 1; j < tokens.length && tokens[j]!.kind === T.BareWord && s.roles.get(tokens[j]!.start) !== "keyword"; j += 2) {
      checkStatistics(s, tokens[j]!);
      if (tokens[j + 1]?.kind !== T.Comma) break;
    }
    return;
  }
  if (owner !== "index") return;
  // PROJECTION p INDEX x TYPE t has projection index types, which are not skipping indexes.
  const index = tokens.slice(0, at).map((t, j) => [t, j] as const).reverse().find(([t]) => isKeyword(s, t, "index"))?.[1];
  if (index !== undefined && isKeyword(s, tokens[index - 2], "projection")) return;
  const name = tokens[at + 1];
  const text = name && nameOf(s, name);
  if (!name || text === undefined) return;
  const info = indexTypesByName.get(text.toLowerCase());
  if (!info) {
    const count = tokens[at + 2]?.kind === T.OpeningRoundBracket ? splitList(tokens.slice(at + 3, matching(tokens, at + 2))).length : 0;
    report(s, name, name, UNKNOWN_INDEX_TYPE.replace("{}", text), "error", nameFixes(name, name, text, INDEX_TYPES.filter((t) => !t.refused && takes(t.rule, count)).map((t) => t.name)));
    return;
  }
  if (info.refused) report(s, name, name, info.refused);
  let next = at + 2;
  if (tokens[next]?.kind === T.OpeningRoundBracket) {
    const close = matching(tokens, next);
    const args = splitList(tokens.slice(next + 1, close));
    // Index types whose syntax has optional parameters past the ones asked about are only checked at the probed count.
    const syntaxCount = (/\((.*)\)/.exec(info.syntax ?? "")?.[1] ?? "").split(",").filter((p) => p.trim()).length;
    if (info.rule) checkRule(s, name, tokens[close] ?? name, args, info.rule, syntaxCount > info.rule.max, true);
    next = close + 1;
  } else if (info.rule && info.rule.min > 0 && info.rule.tooFew) {
    report(s, name, name, info.rule.tooFew);
  }
  for (let j = next; j < tokens.length && j < next + 3; j++)
    if (isKeyword(s, tokens[j], "granularity")) {
      const n = tokens[j + 1];
      if (n?.kind === T.Number && /^0+$/.test(textOf(s, n))) report(s, n, n, "Index GRANULARITY must be a positive integer.");
      break;
    }
}

function checkCodecs(s: Statement, open: number): void {
  const { calls } = bracketCalls(s.tokens, open);
  const known: { name: string; info: (typeof CODECS)[number]; text: string }[] = [];
  for (const call of calls) {
    const text = nameOf(s, call.name);
    if (text === undefined) return;
    // CODEC(Default) stands for the default codec of the server.
    if (text.toLowerCase() === "default") return;
    const info = codecsByName.get(text.toLowerCase());
    if (!info) {
      const names = CODECS.filter((c) => !c.refused && !c.setting && !c.encryption && takes(c.rule, call.args?.length ?? 0)).map((c) => c.name);
      report(s, call.name, call.name, `Unknown codec family: ${text}.`, "error", nameFixes(call.name, call.name, text, names));
      return;
    }
    if (info.refused) {
      report(s, call.name, call.name, info.refused);
      return;
    }
    if (info.rule && call.args) checkRule(s, call.name, call.close ?? call.name, call.args, info.rule, false, false);
    else if (info.rule && !call.args && info.rule.min > 0 && info.rule.tooFew) report(s, call.name, call.name, info.rule.tooFew);
    known.push({ name: info.name, info, text: s.sql.slice(call.name.start, (call.close ?? call.name).end) });
  }
  codecWarnings(s, known, calls[0]!.name, calls[calls.length - 1]!.close ?? calls[calls.length - 1]!.name);
}

/** Whether a codec or index type takes `count` parameters. */
const takes = (rule: CallRule | undefined, count: number) => rule !== undefined && count >= rule.min && count <= rule.max;

const SUSPICIOUS_NOTE = "(Note: you can enable setting 'allow_suspicious_codecs' to skip this check).";

/** What ClickHouse refuses unless allow_suspicious_codecs or a codec's own setting is on: a warning, since a profile may turn them on. */
function codecWarnings(s: Statement, codecs: { name: string; info: (typeof CODECS)[number]; text: string }[], from: Token, to: Token): void {
  for (const c of codecs)
    if (c.info.setting && !s.sql.includes(c.info.setting))
      report(s, from, to, c.info.tier === "Beta"
        ? `Codec ${c.name} is in beta and not yet recommended for production use. You can enable it with the '${c.info.setting}' setting.`
        : `Codec ${c.name} is experimental and not meant to be used in production. You can enable it with the '${c.info.setting}' setting.`, "warning");
  if (s.sql.includes("allow_suspicious_codecs")) return;
  const list = codecs.map((c) => c.text).join(", ");
  const plain = codecs.filter((c) => !c.info.encryption);
  if (plain.some((c) => c.name === "NONE") && plain.length > 1)
    report(s, from, to, `It does not make sense to have codec NONE along with other compression codecs: ${list}. ${SUSPICIOUS_NOTE}`, "warning");
  else if (plain.findIndex((c) => c.info.generic) >= 0 && plain.findIndex((c) => c.info.generic) < plain.length - 1)
    report(s, from, to, `The combination of compression codecs ${list} is meaningless, because it does not make sense to apply any transformations after generic compression algorithm. ${SUSPICIOUS_NOTE}`, "warning");
  // Codecs of a tier other than Production, as Quantized, are left to ClickHouse.
  else if (plain.length && !plain.some((c) => c.info.compression || c.name === "NONE" || c.info.tier))
    report(s, from, to, `Compression codec ${list} does not compress anything. You may want to add generic compression algorithm after other transformations, like: ${list}, LZ4. ${SUSPICIOUS_NOTE}`, "warning");
}

/** A literal argument as a probe of the generator would write it, or undefined for an expression. */
function argument(s: Statement, tokens: Token[]): { kind: "int" | "float" | "string" | "word"; value: number | string; text: string } | undefined {
  const negative = tokens[0]?.kind === T.Minus;
  const rest = negative ? tokens.slice(1) : tokens;
  if (rest.length !== 1) return undefined;
  const t = rest[0]!;
  const text = textOf(s, t);
  if (t.kind === T.Number) {
    const integer = /^\d+$/.test(text);
    const v = Number(text) * (negative ? -1 : 1);
    if (Number.isNaN(v)) return undefined;
    return { kind: integer ? "int" : "float", value: v, text: (negative ? "-" : "") + text };
  }
  if (negative) return undefined;
  if (t.kind === T.StringLiteral) {
    const v = stringLiteralValue(text);
    return v === undefined ? undefined : { kind: "string", value: v, text: v };
  }
  if (t.kind === T.BareWord) return { kind: "word", value: text, text };
  return undefined;
}

/** The verdict of the probes around a number: that of the nearest ones below and above when they agree. */
function numberVerdict(probes: readonly (readonly [number, boolean])[], v: number): boolean | undefined {
  const exact = probes.find(([p]) => p === v);
  if (exact) return exact[1];
  const below = [...probes].reverse().find(([p]) => p < v);
  const above = probes.find(([p]) => p > v);
  if (below && above && below[1] === above[1]) return below[1];
  if (!above && below && probes.length > 1 && below[1] === probes[probes.length - 2]![1]) return below[1];
  return undefined;
}

function checkRule(s: Statement, nameToken: Token, close: Token, args: Token[][], rule: CallRule, countsOnly: boolean, fullCallsOnly: boolean): void {
  if (args.length > rule.max && !countsOnly) {
    if (rule.tooMany) report(s, nameToken, close, rule.tooMany.replace("{}", String(args.length)));
    return;
  }
  if (args.length < rule.min) {
    if (rule.tooFew) report(s, nameToken, close, rule.tooFew);
    return;
  }
  // An index type was asked about one parameter of a call with all of them, so only such a call is checked.
  if (countsOnly || (fullCallsOnly && args.length !== rule.parameters.length)) return;
  args.forEach((tokens, i) => {
    const param: ParameterRule | undefined = rule.parameters[i];
    const value = param && argument(s, tokens);
    if (!value || !param) return;
    let ok: boolean | undefined;
    if (value.kind === "int") ok = numberVerdict(param.ints, value.value as number);
    else if (value.kind === "float") ok = numberVerdict(param.floats, value.value as number);
    else if (value.kind === "string") ok = param.strings?.includes(String(value.value).toLowerCase()) || (param.stringsRefused ? false : undefined);
    else ok = param.words?.includes(String(value.value).toLowerCase()) || (param.wordsRefused ? false : undefined);
    if (ok !== false) return;
    const key = value.kind === "int" && (value.value as number) < 0 && param.messages.negative ? "negative" : value.kind;
    const message = param.messages[key] ?? param.messages.int;
    if (message) report(s, tokens[0]!, tokens[tokens.length - 1]!, message.replace("{}", value.text));
  });
}
