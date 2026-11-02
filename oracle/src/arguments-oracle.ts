// Checks what completion offers for the arguments of functions against ClickHouse's tests and a ClickHouse binary,
// as `npm run oracle:arguments -- --help` describes.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  type ArgumentInfo, complete, type CompletionCandidate, DATA_TYPES, type Description, describe, functionArgument,
  isSignificant, type Token, TokenKind, tokenize,
} from "clickhouse-sql-syntax";

import { extractCorpus } from "./extract.js";
import { integerOption } from "./paths.js";

const USAGE = `Usage: npm run oracle:arguments -w oracle -- --corpus <dir> [--clickhouse <binary>] [options]

Counts the documented arguments of functions that completion knows the kind of, checks each argument that
ClickHouse's tests write where a function takes one of those kinds against what completion offers there, runs each
suggestion in a call with clickhouse local, and times completion at the arguments of the functions in the tests.

Options:
  --corpus <dir>        tests/queries/0_stateless of a ClickHouse checkout
  --clickhouse <binary> runs each suggestion in a call of each function that offers it
  --before <dir>        another build of the library, as packages/core/dist, to time completion with too
  --positions <n>       at most this many places to time completion at (default: 20000)
  --report <file>       where to write the JSON report (default: out/arguments-report.json)
  --jobs <n>            parallel ClickHouse processes, 1 to 4 (default: 4)`;

const { values } = parseArgs({
  options: {
    corpus: { type: "string" },
    clickhouse: { type: "string" },
    before: { type: "string" },
    positions: { type: "string", default: "20000" },
    report: { type: "string", default: new URL("../out/arguments-report.json", import.meta.url).pathname },
    jobs: { type: "string", default: "4" },
    help: { type: "boolean", default: false },
  },
});
if (values.help || !values.corpus) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 2);
}
const jobs = Math.min(4, integerOption(values.jobs, "--jobs", 1));

const significant = (sql: string): Token[] => tokenize(sql).filter((t) => isSignificant(t.kind) && t.kind !== TokenKind.EndOfStream);
const text = (sql: string, token: Token): string => sql.slice(token.start, token.end);

/** The value of a string literal in single quotes. */
function unquote(literal: string): string {
  return literal.slice(1, -1).replace(/''/g, "'").replace(/\\(.)/g, "$1");
}

// The functions, as completion offers them where an expression goes.
const FUNCTION_NAMES = complete("SELECT ", 7)
  .filter((c) => c.kind === "function" && !c.detail?.startsWith("alias of"))
  .map((c) => c.label);
const described = new Map(FUNCTION_NAMES.map((name) => [name, describe(name, "function")!]));
const groupsOf = (d: Description): [string, readonly ArgumentInfo[]][] => [
  ["parameters", d.parameters ?? []],
  ["arguments", d.arguments ?? []],
];

// Coverage: the documented arguments that get a kind, and those with types that rank the columns.
const coverage = { functions: 0, arguments: 0, functionsWithKind: 0, argumentsWithKind: 0, argumentsRankedByType: 0, byKind: {} as Record<string, string[]> };
for (const d of described.values()) {
  const all = groupsOf(d).flatMap(([, list]) => list);
  if (!all.length) continue;
  coverage.functions++;
  coverage.arguments += all.length;
  if (all.some((a) => a.kind)) coverage.functionsWithKind++;
  for (const a of all) {
    if (a.kind) {
      coverage.argumentsWithKind++;
      (coverage.byKind[a.kind] ??= []).push(`${d.name}(${a.name})`);
    } else if (a.types?.length && !a.types.some((t) => /^(?:const )?(?:Any|Expression)$/.test(t))) coverage.argumentsRankedByType++;
  }
}

/** The suggestions of a kind among those that complete() gives for an argument. */
function ofKind(candidates: CompletionCandidate[], arg: ArgumentInfo): CompletionCandidate[] {
  switch (arg.kind) {
    case "data type":
    case "JSON data type":
      return candidates.filter((c) => c.kind === "data type" && c.insertText !== undefined);
    case "value":
      return candidates.filter((c) => (c.kind === "value" || c.kind === "keyword") && (c.detail === arg.name || c.detail?.startsWith(`${arg.name}, also `)));
    case "time zone":
      return candidates.filter((c) => c.detail === "time zone");
    case "format":
      return candidates.filter((c) => c.kind === "format");
    case "JSON path":
      return candidates.filter((c) => c.detail === "JSONPath");
    default:
      return [];
  }
}

/** The family that a type name stands for, as Int64 for 'BIGINT' or Array for 'Array(String)'. */
function typeFamily(type: string): string | undefined {
  const words = type.trim().split(/[\s(]/);
  for (let n = Math.min(4, words.length); n > 0; n--) {
    const name = words.slice(0, n).join(" ");
    const found = DATA_TYPES.find((t) => t.name === name || (t.caseInsensitive && t.name.toUpperCase() === name.toUpperCase()));
    if (found) return found.aliasTo || found.name;
  }
  return undefined;
}

/** Whether a value that a test writes is one that the suggestions of its kind name. */
function fits(arg: ArgumentInfo, value: string, suggestions: CompletionCandidate[]): boolean {
  switch (arg.kind) {
    case "data type":
    case "JSON data type": {
      const family = typeFamily(value);
      return family !== undefined && suggestions.some((c) => c.label.split("(")[0] === family);
    }
    case "value":
      return suggestions.some((c) => [c.label, ...(c.detail?.split(", also ")[1]?.split(", ") ?? [])].some((v) => v.toLowerCase() === value.toLowerCase()));
    case "JSON path":
      return value.startsWith("$");
    default:
      return suggestions.some((c) => c.label === value);
  }
}

interface Call {
  name: string;
  d: Description;
  /** Each pair of brackets: whether it holds parameters, and the tokens of each argument. */
  groups: { parameters: boolean; args: Token[][]; open: Token }[];
}

/** The calls of known functions in a statement, not table functions or engines. */
function callsIn(sql: string, tokens: Token[]): Call[] {
  const calls: Call[] = [];
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (tokens[i]!.kind !== TokenKind.BareWord || tokens[i + 1]!.kind !== TokenKind.OpeningRoundBracket) continue;
    const before = tokens[i - 1];
    if (before?.kind === TokenKind.Dot || (before?.kind === TokenKind.BareWord && /^(from|join|function|engine)$/i.test(text(sql, before)))) continue;
    if (before?.kind === TokenKind.Equals && /^engine$/i.test(text(sql, tokens[i - 2] ?? before))) continue;
    const d = describe(text(sql, tokens[i]!), "function");
    if (!d) continue;
    const call: Call = { name: d.name, d, groups: [] };
    let open = i + 1;
    while (tokens[open]?.kind === TokenKind.OpeningRoundBracket && call.groups.length < 2) {
      const args: Token[][] = [[]];
      let depth = 0;
      let j = open;
      for (; j < tokens.length; j++) {
        const kind = tokens[j]!.kind;
        if (kind === TokenKind.OpeningRoundBracket || kind === TokenKind.OpeningSquareBracket || kind === TokenKind.OpeningCurlyBrace) depth++;
        else if (kind === TokenKind.ClosingRoundBracket || kind === TokenKind.ClosingSquareBracket || kind === TokenKind.ClosingCurlyBrace) depth--;
        if (depth === 0) break;
        if (j > open && depth === 1 && kind === TokenKind.Comma) args.push([]);
        else if (j > open) args[args.length - 1]!.push(tokens[j]!);
      }
      call.groups.push({ parameters: false, args: args.length === 1 && !args[0]!.length ? [] : args, open: tokens[open]! });
      open = j + 1;
    }
    if (call.groups.length === 2 && d.parameters?.length) call.groups[0]!.parameters = true;
    else call.groups.length = 1;
    calls.push(call);
  }
  return calls;
}

const extracted = extractCorpus(values.corpus, { maxLength: 100_000 });
console.error(`${extracted.statements.length} statements in ${extracted.files} files`);

// The corpus check: each argument that a test writes where the function takes a kind.
const usage = new Map<string, number>();
interface Mismatch {
  file: string;
  line: number;
  call: string;
  argument: string;
  written: string;
  /** Whether the test expects the statement to fail. */
  expectsError: boolean;
}
const corpus: Record<string, { checked: number; fit: number; notLiteral: number; mismatches: Mismatch[] }> = {};
const suggestionCache = new Map<string, CompletionCandidate[]>();
const timedPlaces: { sql: string; offset: number }[] = [];
// The places where a function takes an argument of a known kind, timed apart.
const kindPlaces: { sql: string; offset: number }[] = [];
for (const statement of extracted.statements) {
  const sql = statement.sql;
  const tokens = significant(sql);
  for (const call of callsIn(sql, tokens)) {
    usage.set(call.name, (usage.get(call.name) ?? 0) + 1);
    for (const group of call.groups) {
      group.args.forEach((arg, index) => {
        const start = arg[0]?.start ?? (index === 0 ? group.open.end : undefined);
        if (start !== undefined) timedPlaces.push({ sql, offset: start });
      });
    }
    if (!groupsOf(call.d).some(([, list]) => list.some((a) => a.kind))) continue;
    for (const group of call.groups) {
      for (const arg of group.args) {
        if (!arg.length) continue;
        // The unit of INTERVAL x unit is the last word of its argument.
        const places = [arg[0]!.start, ...(arg.length >= 3 && /^interval$/i.test(text(sql, arg[0]!)) ? [arg[arg.length - 1]!.start] : [])];
        for (const [p, place] of places.entries()) {
          const at = functionArgument(sql, place);
          if (!at) continue;
          const list = at.parameters ? call.d.parameters ?? [] : call.d.arguments ?? [];
          for (const doc of list.filter((a) => a.kind && at.arguments.includes(a.name))) {
            const result = (corpus[doc.kind!] ??= { checked: 0, fit: 0, notLiteral: 0, mismatches: [] });
            const written = p === 0 ? arg : arg.slice(-1);
            const token = written.length === 1 ? written[0]! : undefined;
            const value = token?.kind === TokenKind.StringLiteral && text(sql, token).startsWith("'") ? unquote(text(sql, token)) : token?.kind === TokenKind.BareWord ? text(sql, token) : undefined;
            if (p === 0) kindPlaces.push({ sql, offset: place });
            const key = `${call.name}|${at.parameters}|${doc.name}`;
            let suggestions = suggestionCache.get(key);
            if (!suggestions) suggestionCache.set(key, (suggestions = ofKind(complete(sql, place), doc)));
            // A word is a value written as a keyword, as day in dateDiff(day, a, b), or else a name.
            if (value === undefined || (token?.kind === TokenKind.BareWord && (doc.kind !== "value" || !fits(doc, value, suggestions)))) {
              result.notLiteral++;
              continue;
            }
            result.checked++;
            if (fits(doc, value, suggestions)) result.fit++;
            else {
              const expectsError = statement.hints.some((hint) => /\b(?:server|client)Error\b/.test(hint));
              result.mismatches.push({ file: statement.file, line: statement.line, call: call.name, argument: doc.name, written: text(sql, written[0]!), expectsError });
            }
          }
        }
      }
    }
  }
}

// The arguments with no kind, of the functions the tests call most.
const unkinded = [...described.values()]
  .flatMap((d) => groupsOf(d).flatMap(([, list]) => list.filter((a) => !a.kind).map((a) => ({ function: d.name, argument: a.name, description: a.description, calls: usage.get(d.name) ?? 0, rankedByType: Boolean(a.types?.length && !a.types.some((t) => /^(?:const )?(?:Any|Expression)$/.test(t))) }))))
  .sort((a, b) => b.calls - a.calls)
  .slice(0, 30);

const MARK = "\u0001";
/** The type at MARK, where a value of it goes, as x in CAST(x, T). */
const TYPE = "\u0002";
/** Another argument of a kind, filled with its first suggestion. */
const OTHER = /\u0003([^\u0004]*)\u0004/;

/** A value of the documented argument at `index` to fill a call with, by its types, for a call that tries a suggestion of `kind`. */
function sample(doc: ArgumentInfo | undefined, kind: string, index: number): string {
  const types = (doc?.types ?? []).map((t) => t.replace(/^const /, ""));
  const description = doc?.description ?? "";
  const any = !types.length || types.some((t) => /^(?:Any|Expression)$/.test(t));
  // Formats name a column by its expression, which some of them take only as a name.
  if (any && kind === "format") return `1 AS c${index}`;
  // A value of the type that is tried, and a time where a time zone applies.
  if (any && (kind === "data type" || kind === "JSON data type")) return `defaultValueOfTypeName(${TYPE})`;
  if (any && kind === "time zone") return "now()";
  if (types.includes("DateTime")) return "now()";
  if (types.some((t) => t.startsWith("DateTime64"))) return "now64()";
  const type = types[0] ?? "";
  if (/JSON/.test(description) && /String/.test(type)) return `'{"a":1}'`;
  if (/^(?:String|FixedString)/.test(type)) {
    if (/joda/i.test(description)) return "'yyyy-MM-dd HH:mm:ss'";
    if (/format string/i.test(description)) return "'%Y-%m-%d %H:%i:%s'";
    return /\b(?:date|time)/i.test(description) ? "'2024-01-02 03:04:05'" : "'a'";
  }
  if (/^U?Int(?:8|16|32|64)$/.test(type)) return `to${type}(1)`;
  if (/^\(U\)Int|^U?Int|^Integer/.test(type)) return "1";
  if (/^B?Float/.test(type)) return "1.5";
  if (/^Decimal/.test(type)) return "toDecimal64(1, 2)";
  if (/^Date32|^Date$/.test(type)) return "today()";
  if (/^Array\(String/.test(type)) return "['a']";
  if (/^Array/.test(type)) return "[1]";
  if (/^Map/.test(type)) return "map('a', 1)";
  if (/^Tuple/.test(type)) return "tuple(1)";
  if (/^UUID/.test(type)) return "toUUID('00000000-0000-0000-0000-000000000000')";
  if (/^JSON/.test(type)) return `'{"a":1}'::JSON`;
  if (/^Dynamic/.test(type)) return "1::Dynamic";
  if (/^Variant/.test(type)) return "1::Variant(UInt8, String)";
  if (/^Interval/.test(type)) return "INTERVAL 1 HOUR";
  if (/^Bool/.test(type)) return "true";
  return "1";
}

/** The calls given for the kinds that the request names, as their minimal calls. */
const CANONICAL = new Map([
  ["dateDiff", `dateDiff(${MARK}, now(), now())`],
  ["JSONExtract", `JSONExtract('{"a":1}', 'a', ${MARK})`],
  ["toTimezone", `toTimezone(now(), ${MARK})`],
  // CapnProto and Protobuf take no column named by a number.
  ["formatRow", `formatRow(${MARK}, 1 AS x)`],
]);

/**
 * A call of the function with the argument `target` at MARK, from a line of its syntax as the documentation writes it:
 * optional parts left out unless they hold the target, `...` dropped, and each other name a value of its type.
 */
function callOf(d: Description, group: "parameters" | "arguments", target: string, kind: string): string | undefined {
  const canonical = CANONICAL.get(d.name);
  // Only for the argument the call is given for: the time zone of dateDiff() is tried in a call built from its syntax.
  if (canonical && group === "arguments" && ((d.name === "dateDiff") === (target === "unit"))) return canonical;
  const calls: string[] = [];
  const holds = (text: string) => new RegExp(`(^|\\W)${target}(\\W|$)`).test(text);
  for (const line of (d.syntax ?? "").split("\n")) {
    const head = new RegExp(`^(?:or\\s+)?${d.name.replace(/\W/g, "\\$&")}\\s*`, "i").exec(line.trim());
    if (!head) continue;
    const rest = line.trim().slice(head[0].length);
    const groups = [...rest.matchAll(/\[?\(((?:[^()]|\([^()]*\))*)\)\]?/g)].map((m) => m[1]!);
    const params = d.parameters?.length && groups.length > 1 ? groups[0] : undefined;
    const args = params === undefined ? groups[0] : groups[1];
    if (args === undefined || (group === "parameters" && params === undefined)) continue;
    const render = (syntax: string, docs: readonly ArgumentInfo[], mark: boolean): string => {
      let s = syntax.replace(/\.\.\.|…/g, "");
      // An optional part with the target keeps what comes before it and the target, as `[, maximum_unit, minimum_unit]`.
      const upTo = (body: string) => {
        const parts = body.split(",");
        return parts.slice(0, parts.findIndex(holds) + 1).join(",");
      };
      for (let inner = /\[([^[\]]*)\]/; inner.test(s); ) s = s.replace(inner, (_, body: string) => (mark && holds(body) ? upTo(body) : ""));
      const pieces = s.split(",").map((piece) => piece.trim()).filter(Boolean).map((piece) => {
        const choices = piece.split("|").map((c) => c.trim());
        return (mark ? choices.find(holds) : undefined) ?? choices[0]!;
      });
      const done = new Set<string>();
      return pieces
        .filter((piece) => !done.has(piece) && done.add(piece))
        .map((piece, index) =>
          piece.replace(/('?)([A-Za-z_]\w*)'?/g, (word, quote: string, name: string) => {
            if (mark && name === target) return MARK;
            if (/^[A-Z][A-Z0-9_]+$/.test(name)) return name;
            // A name of no argument at its place, or else the argument at that place.
            const doc = docs.find((a) => a.name === name || a.name.match(/[A-Za-z_]\w*/g)?.includes(name)) ?? (quote ? undefined : docs[index]);
            if (!doc) return word;
            return doc.kind ? `\u0003${doc.name}\u0004` : sample(doc, kind, index);
          }),
        )
        .join(", ");
    };
    const argsText = render(args, d.arguments ?? [], group === "arguments");
    const call = params === undefined ? `${d.name}(${argsText})` : `${d.name}(${render(params, d.parameters ?? [], group === "parameters")})(${argsText})`;
    if (call.includes(MARK)) calls.push(call);
  }
  return calls.sort((a, b) => a.length - b.length)[0];
}

/** The call with each other argument of a kind given its first suggestion, or undefined when one has none. */
function fillOthers(d: Description, call: string): string | undefined {
  for (let found = OTHER.exec(call); found; found = OTHER.exec(call)) {
    const doc = groupsOf(d).flatMap(([, list]) => list).find((a) => a.name === found![1])!;
    const sql = `SELECT ${call.replace(MARK, "1").replace(TYPE, "'String'")}`;
    const offset = sql.indexOf("\u0003");
    const first = ofKind(complete(sql.replace(OTHER, ""), offset), doc)[0];
    if (!first) return undefined;
    call = call.replace(OTHER, first.insertText ?? first.label);
  }
  return call;
}

interface Probe {
  id: string;
  kind: string;
  call: string;
  suggestion: string;
  query: string;
  ok?: boolean;
  error?: string;
}

const probes: Probe[] = [];
const unbuilt: string[] = [];
if (values.clickhouse) {
  for (const d of described.values()) {
    for (const [group, list] of groupsOf(d)) {
      for (const doc of list.filter((a) => a.kind)) {
        const template = callOf(d, group as "parameters" | "arguments", doc.name.match(/[A-Za-z_]\w*/)?.[0] ?? doc.name, doc.kind!);
        const call = template && fillOthers(d, template);
        if (!call) {
          unbuilt.push(`${d.name}(${doc.name})`);
          continue;
        }
        const sql = `SELECT ${call.replace(TYPE, "'String'")}`;
        const offset = sql.indexOf(MARK);
        const suggestions = ofKind(complete(sql.replace(MARK, ""), offset), doc);
        for (const s of suggestions) {
          // The JSONPath snippet is tried with a key typed where the cursor goes.
          const insert = s.cursor === undefined ? (s.insertText ?? s.label) : `${s.insertText!.slice(0, s.cursor)}a${s.insertText!.slice(s.cursor)}`;
          const filled = call.replace(MARK, insert).replace(TYPE, insert);
          const id = `p${probes.length}`;
          probes.push({ id, kind: doc.kind!, call: `${d.name}(${doc.name})`, suggestion: insert, query: `SELECT '${id}', length(toString(${filled}))` });
        }
      }
    }
  }
}

/** Runs queries in one clickhouse local that goes on after an error, and marks each one with its result. */
function runBatch(batch: Probe[]): Promise<void> {
  return new Promise((done) => {
    const query = batch.map((p) => `${p.query};`).join("\n");
    const child = spawn(values.clickhouse!, ["local", "--ignore-error", "--format", "TSV", "--max_execution_time", "60", "--query", query], { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("close", () => {
      const passed = new Set(Buffer.concat(out).toString("utf8").split("\n").map((line) => line.split("\t")[0]));
      const errors = new Map<string, string>();
      for (const m of Buffer.concat(err).toString("utf8").matchAll(/Received exception:\n([\s\S]*?)\n\(query: SELECT '(p\d+)'/g)) errors.set(m[2]!, m[1]!.trim());
      for (const p of batch) {
        p.ok = passed.has(p.id);
        if (!p.ok) p.error = errors.get(p.id) ?? "no result";
      }
      done();
    });
  });
}

const BATCH = 2000;
const batches: Probe[][] = [];
for (let i = 0; i < probes.length; i += BATCH) batches.push(probes.slice(i, i + BATCH));
let nextBatch = 0;
await Promise.all(
  Array.from({ length: Math.min(jobs, batches.length) }, async () => {
    while (nextBatch < batches.length) await runBatch(batches[nextBatch++]!);
  }),
);

// A type of a value is tried again from a string, as reinterpret() makes an array only of a string.
const fromString = probes.filter((p) => !p.ok && p.query.includes("defaultValueOfTypeName("));
const asString = fromString.map((p) => ({ ...p, query: p.query.replace(/defaultValueOfTypeName\('(?:[^'\\]|\\.)*'\)/g, "'abcd'") }));
for (let i = 0; i < asString.length; i += BATCH) await runBatch(asString.slice(i, i + BATCH));
fromString.forEach((p, i) => {
  if (asString[i]!.ok) Object.assign(p, { ok: true, error: undefined });
});

// A failure with a date or a time is tried again with a DateTime64, which some units need.
const retried = probes.filter((p) => !p.ok && /\b(?:now|today)\(\)/.test(p.query));
const again = retried.map((p) => ({ ...p, query: p.query.replace(/\b(?:now|today)\(\)/g, "now64()") }));
for (let i = 0; i < again.length; i += BATCH) await runBatch(again.slice(i, i + BATCH));
retried.forEach((p, i) => {
  if (again[i]!.ok) p.error = `only with a DateTime64: ${p.error}`;
});

// A call that no suggestion runs in is a call this check could not make, not a wrong suggestion.
const byCall = new Map<string, Probe[]>();
for (const p of probes) byCall.set(p.call, [...(byCall.get(p.call) ?? []), p]);
const clickhouse: Record<string, { suggestions: number; ran: number; failed: number; onlyDateTime64: number; calls: number; callsNotRun: string[]; failures: { call: string; suggestion: string; error: string }[] }> = {};
for (const [call, list] of byCall) {
  const result = (clickhouse[list[0]!.kind] ??= { suggestions: 0, ran: 0, failed: 0, onlyDateTime64: 0, calls: 0, callsNotRun: [], failures: [] });
  if (!list.some((p) => p.ok)) {
    result.callsNotRun.push(`${call}: ${list[0]!.query.replace(/^SELECT '\w+', length\(toString\((.*)\)\)$/, "$1")}: ${list[0]!.error?.split("\n")[0]}`);
    continue;
  }
  result.calls++;
  result.suggestions += list.length;
  for (const p of list) {
    result.ran++;
    if (!p.ok) {
      if (p.error!.startsWith("only with a DateTime64")) result.onlyDateTime64++;
      else result.failed++;
      result.failures.push({ call, suggestion: p.suggestion, error: p.error!.split("\n")[0]! });
    }
  }
}

// Speed: completion at the start of each argument of a function call in the tests, with this build and another.
type CompleteFunction = typeof complete;
const before: CompleteFunction | undefined = values.before
  ? ((await import(pathToFileURL(join(resolve(values.before), "index.js")).href)) as { complete: CompleteFunction }).complete
  : undefined;
const cap = integerOption(values.positions, "--positions", 1);
const timeOne = (run: CompleteFunction, place: { sql: string; offset: number }) => {
  const start = performance.now();
  run(place.sql, place.offset);
  return performance.now() - start;
};
const percentile = (list: number[], p: number) => [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor((p / 100) * list.length))] ?? 0;
/** The p50, p95 and the slowest time of completion at evenly spread places, with this build and the other one. */
function timed(all: { sql: string; offset: number }[]) {
  const stride = Math.max(1, Math.floor(all.length / cap));
  const places = all.filter((_, i) => i % stride === 0).slice(0, cap);
  const times: Record<string, number[]> = { after: [], ...(before ? { before: [] } : {}) };
  for (const place of places.slice(0, 200)) {
    timeOne(complete, place);
    if (before) timeOne(before, place);
  }
  for (const place of places) {
    times.after!.push(timeOne(complete, place));
    if (before) times.before!.push(timeOne(before, place));
  }
  return Object.fromEntries(
    Object.entries(times).map(([build, list]) => [build, { places: list.length, p50: percentile(list, 50), p95: percentile(list, 95), max: Math.max(...list) }]),
  );
}
const speed = { "every argument": timed(timedPlaces), "arguments of a known kind": timed(kindPlaces) };

const report = { coverage, corpus, unkinded, clickhouse, unbuilt, speed };
mkdirSync(dirname(values.report), { recursive: true });
writeFileSync(values.report, JSON.stringify(report, null, 2));

const ms = (n: number) => `${n.toFixed(2)} ms`;
console.log(`Functions with documented arguments: ${coverage.functions}, ${coverage.functionsWithKind} with an argument of a known kind.`);
console.log(`Arguments: ${coverage.arguments}, ${coverage.argumentsWithKind} of a known kind, ${coverage.argumentsRankedByType} more whose types rank the columns.`);
for (const [kind, list] of Object.entries(coverage.byKind)) console.log(`  ${kind}: ${list.length}`);
console.log("\nArguments in the tests, by kind: checked, fit, not a literal");
for (const [kind, r] of Object.entries(corpus)) {
  const failing = r.mismatches.filter((m) => m.expectsError).length;
  console.log(
    `  ${kind}: ${r.checked} checked, ${r.fit} fit (${((100 * r.fit) / Math.max(1, r.checked)).toFixed(1)}%), ` +
      `${r.mismatches.length} do not (${failing} in statements the test expects to fail), ${r.notLiteral} not a literal`,
  );
  for (const m of r.mismatches.filter((m) => !m.expectsError).slice(0, 15)) console.log(`    ${m.file}:${m.line} ${m.call}(${m.argument}): ${m.written}`);
  if (r.mismatches.length - failing > 15) console.log(`    ... ${r.mismatches.length - failing - 15} more in the report`);
}
console.log("\nArguments with no kind, of the functions the tests call most:");
for (const u of unkinded) console.log(`  ${u.calls} ${u.function}(${u.argument})${u.rankedByType ? " [types rank columns]" : ""}: ${u.description}`);
if (values.clickhouse) {
  console.log("\nSuggestions run in a call with clickhouse local, by kind:");
  for (const [kind, r] of Object.entries(clickhouse)) {
    console.log(`  ${kind}: ${r.ran} runs in ${r.calls} calls, ${r.failed} failed, ${r.onlyDateTime64} ran only with a DateTime64; ${r.callsNotRun.length} calls with no suggestion that runs`);
    for (const f of r.failures) console.log(`    ${f.call} ${f.suggestion}: ${f.error}`);
    for (const c of r.callsNotRun) console.log(`    not run: ${c}`);
  }
  if (unbuilt.length) console.log(`  no call built from the syntax for: ${unbuilt.join(", ")}`);
}
console.log("\nCompletion at the start of the arguments of function calls in the tests:");
for (const [where, builds] of Object.entries(speed))
  for (const [build, s] of Object.entries(builds)) console.log(`  ${where}, ${build}: ${s.places} places, p50 ${ms(s.p50)}, p95 ${ms(s.p95)}, max ${ms(s.max)}`);
console.log(`\nReport: ${values.report}`);
