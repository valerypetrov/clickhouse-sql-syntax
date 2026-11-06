// Applies the quick fixes of check(), checkOptions(), test hints and ClickHouse's own hints to erroring statements and
// runs the results in clickhouse local, as `npm run oracle:fixes -- --help` describes.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { check, checkOptions, type Diagnostic, type Fix, messageFixes, nameHints, replaceFixes } from "clickhouse-sql-syntax";

import { CODECS, INDEX_TYPES, STATISTICS_TYPES } from "../../packages/core/src/generated/options.js";
import { FORMATS } from "../../packages/core/src/generated/formats.js";
import { FUNCTIONS } from "../../packages/core/src/generated/functions.js";
import { MERGE_TREE_SETTINGS } from "../../packages/core/src/generated/merge-tree-settings.js";
import { SETTINGS } from "../../packages/core/src/generated/settings.js";
import { type Outcome, probe } from "../../scripts/probe.js";
import { readCorpus } from "./corpus.js";

const USAGE = `Usage: npm run oracle:fixes -w oracle -- --clickhouse <binary> [--report <file>]

Makes erroring statements (typos of the names in the catalogs, wrong values, CREATE TABLE without ENGINE, test hints
with unknown error names, and the invalid statements of fixtures/corpus.jsonl.gz), applies every quick fix offered for
them, and runs each result in clickhouse local. It prints how many fixed statements ClickHouse accepts, by kind of fix.`;

const { values: args } = parseArgs({
  options: {
    clickhouse: { type: "string" },
    report: { type: "string", default: new URL("../out/fixes-report.json", import.meta.url).pathname },
    help: { type: "boolean", default: false },
  },
});
if (args.help || !args.clickhouse) {
  console.log(USAGE);
  process.exit(args.help ? 0 : 2);
}
const clickhouse = args.clickhouse;

function apply(sql: string, fix: Fix): string {
  let text = sql;
  for (const edit of [...fix.edits].sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.newText + text.slice(edit.end);
  return text;
}

/** A typo of a name: a letter dropped from its middle, or two swapped in a short one; deterministic. */
function typo(name: string, i: number): string {
  if (name.length > 5) {
    const at = 1 + (i % (name.length - 2));
    return name.slice(0, at) + name.slice(at + 1);
  }
  return name.length > 2 ? name[0] + name[2] + name[1] + name.slice(3) : `${name}q`;
}

/** One erroring statement with its fixes, and what ClickHouse said about each fixed text. */
interface Case {
  kind: string;
  sql: string;
  setup?: string[];
  /** For the statements of the sample, the word that the fixes replace. */
  word?: string;
  fixes: { text: string; preferred: boolean; outcome?: Outcome }[];
}

const cases: Case[] = [];
const id = () => Math.floor(Math.random() * 1e12);
const quote = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** The cases of the statements that ClickHouse runs before a typo, from the diagnostics of the typo that have fixes. */
function fromTypos(kind: string, pairs: { valid: string; broken: string }[], setup?: string[], diagnose = (sql: string) => checkOptions(sql), chunk = 2000): void {
  const controls = probe(clickhouse, pairs.map((p) => p.valid), { setup, chunk });
  let skipped = 0;
  pairs.forEach((pair, i) => {
    if (!controls[i]!.ok) return void skipped++;
    const fixes = diagnose(pair.broken).flatMap((d: Diagnostic) => d.fixes ?? []);
    cases.push({ kind, sql: pair.broken, setup, fixes: fixes.map((f) => ({ text: apply(pair.broken, f), preferred: !!f.preferred })) });
  });
  console.log(`${kind}: ${pairs.length - skipped} of ${pairs.length} statements run before the typo`);
}

const literal = (value: string | undefined) => quote(value ?? "");

// Settings of queries and of MergeTree, by their default values.
const settings = SETTINGS.filter((s) => !s.obsolete && !s.aliasTo);
fromTypos("query setting", settings.map((s, i) => ({ valid: `SELECT 1 SETTINGS ${s.name} = ${literal(s.default)} FORMAT Null`, broken: `SELECT 1 SETTINGS ${typo(s.name, i)} = ${literal(s.default)} FORMAT Null` })));
fromTypos("MergeTree setting", MERGE_TREE_SETTINGS.filter((s) => !s.obsolete).map((s, i) => {
  const make = (name: string) => `CREATE TABLE t_${id()} (x UInt64) ENGINE = MergeTree ORDER BY x SETTINGS ${name} = ${literal(s.default)}`;
  return { valid: make(s.name), broken: make(typo(s.name, i)) };
}));

// Codecs, index types and statistics.
const codecs = CODECS.filter((c) => !c.refused && !c.encryption && !c.setting);
fromTypos("codec", codecs.flatMap((c, i) => ["UInt64", "Float64", "String", "DateTime"].flatMap((type) => {
  const make = (name: string) => `CREATE TABLE t_${id()} (x ${type} CODEC(${name}${c.rule?.max ? "(1)" : ""})) ENGINE = MergeTree ORDER BY tuple()`;
  return [0, 1].map((n) => ({ valid: make(c.name), broken: make(typo(c.name, i + n)) }));
})), ["SET allow_suspicious_codecs = 1"]);
const indexes = ["minmax", "set(100)", "bloom_filter(0.01)", "ngrambf_v1(3, 256, 2, 0)", "tokenbf_v1(256, 2, 0)", "bloom_filter", "set(0)"];
fromTypos("index type", indexes.flatMap((call, i) => {
  const name = /^\w+/.exec(call)![0];
  const make = (type: string) => `CREATE TABLE t_${id()} (s String, INDEX i s TYPE ${type}${call.slice(name.length)}) ENGINE = MergeTree ORDER BY tuple()`;
  return [0, 1, 2].map((n) => ({ valid: make(name), broken: make(typo(name, i + n)) }));
}));
fromTypos("statistics type", STATISTICS_TYPES.flatMap((t, i) => {
  const make = (name: string) => `CREATE TABLE t_${id()} (x UInt64 STATISTICS(${name})) ENGINE = MergeTree ORDER BY tuple()`;
  return [0, 1].map((n) => ({ valid: make(t.name), broken: make(typo(t.name, i + n)) }));
}), ["SET allow_experimental_statistics = 1"]);

// Output formats and compression methods.
const outputs = FORMATS.filter((f) => f.output);
fromTypos("format", outputs.map((f, i) => ({ valid: `SELECT 1 AS x FORMAT ${f.name}`, broken: `SELECT 1 AS x FORMAT ${typo(f.name, i)}` })), undefined, undefined, 1);
const out = mkdtempSync(join(tmpdir(), "fixes-oracle-"));
fromTypos("compression method", ["gzip", "deflate", "brotli", "zstd", "lz4", "bz2", "snappy", "lzma", "auto", "none"].map((m, i) => {
  const file = join(out, `f_${i}`);
  return { valid: `SELECT 1 INTO OUTFILE '${file}' TRUNCATE COMPRESSION '${m}'`, broken: `SELECT 1 INTO OUTFILE '${file}' TRUNCATE COMPRESSION '${typo(m, i)}'` };
}));

// Values: typos of enum values, and numbers for settings that take strings.
const enums = settings.filter((s) => s.values?.length);
fromTypos("enum value", enums.flatMap((s, i) => s.values!.filter((v) => /^\w{3,}$/.test(v)).slice(0, 3).map((v, n) => ({ valid: `SET ${s.name} = '${v}'`, broken: `SET ${s.name} = '${typo(v, i + n)}'` }))));
fromTypos("quoted value", settings.flatMap((s) => ["1", "0", "-1", "1.5"].map((v) => ({ valid: `SELECT 1`, broken: `SELECT 1 SETTINGS ${s.name} = ${v} FORMAT Null` }))));

// CREATE TABLE without ENGINE after SET default_table_engine = 'None'.
const noEngine = ["SET default_table_engine = 'None'"];
fromTypos("missing ENGINE", [
  "CREATE TABLE t_{} (x UInt64)", "CREATE TABLE t_{} (x UInt64) ORDER BY x", "CREATE TABLE t_{} (x UInt64) PRIMARY KEY x", "CREATE TABLE IF NOT EXISTS t_{} (x UInt64) PARTITION BY x",
  "CREATE OR REPLACE TABLE t_{} (x UInt64) COMMENT 'c'", "CREATE TABLE t_{} (x UInt64) SETTINGS index_granularity = 128", "CREATE TABLE t_{} AS SELECT 1 AS x",
  "CREATE TABLE t_{} ORDER BY x AS SELECT 1 AS x", "CREATE TABLE t_{} EMPTY AS SELECT 1 AS x ORDER BY x", "CREATE TABLE t_{} (x UInt64, INDEX i x TYPE minmax) TTL toDate(x) + 1",
  "CREATE TABLE t_{} (x UInt64) ORDER BY x SAMPLE BY x", "CREATE TABLE t_{} (x UInt64, y UInt64) PRIMARY KEY x ORDER BY (x, y)",
].map((sql) => ({ valid: "SELECT 1", broken: sql.replace("{}", String(id())) })), noEngine, (sql) => checkOptions(`${noEngine[0]};\n${sql}`).map((d) => ({
  ...d, fixes: d.fixes?.map((f) => ({ ...f, edits: f.edits.map((e) => ({ ...e, start: e.start - noEngine[0]!.length - 2, end: e.end - noEngine[0]!.length - 2 })) })),
})));

// Keywords: the invalid statements of the stored sample, whose fixes must parse.
const invalid = readCorpus(new URL("../fixtures/corpus.jsonl.gz", import.meta.url).pathname).entries.filter((e) => !e.valid);
let keywordCases = 0;
for (const entry of invalid) {
  const fixes = check(entry.sql).flatMap((d) => d.fixes ?? []);
  if (!fixes.length) continue;
  keywordCases++;
  cases.push({ kind: "keyword", sql: entry.sql, fixes: fixes.map((f) => ({ text: apply(entry.sql, f), preferred: !!f.preferred })) });
}
console.log(`keyword: ${keywordCases} of ${invalid.length} invalid statements of the sample have a fix`);

// The statements of the sample that parse and that checkOptions() fixes; they run without their tables, so a fix is
// taken when ClickHouse's error no longer names the word it replaced.
for (const e of readCorpus(new URL("../fixtures/corpus.jsonl.gz", import.meta.url).pathname).entries.filter((e) => e.valid)) {
  const fixes = checkOptions(e.sql).flatMap((d) => d.fixes ?? []);
  if (!fixes.length) continue;
  const edit = fixes[0]!.edits[0]!;
  cases.push({ kind: "sample option", sql: e.sql, word: e.sql.slice(edit.start, edit.end), fixes: fixes.map((f) => ({ text: apply(e.sql, f), preferred: !!f.preferred })) });
}

// ---------------------------------------------------------------- Running the fixed statements

const parsing = cases.filter((c) => c.kind === "keyword");
const running = cases.filter((c) => c.kind !== "keyword");
let fresh = 0;
const runAll = (list: Case[], wrap: (text: string) => string, chunk = 500) => {
  const bySetup = new Map<string, Case[]>();
  for (const c of list) bySetup.set(JSON.stringify(c.setup ?? []), [...(bySetup.get(JSON.stringify(c.setup ?? [])) ?? []), c]);
  for (const [setup, group] of bySetup) {
    const fixes = group.flatMap((c) => c.fixes);
    // Each fix of a CREATE makes a table of its own.
    const outcomes = probe(clickhouse, fixes.map((f) => wrap(f.text.replace(/\bt_\d+/, () => `f_${fresh++}`))), { setup: JSON.parse(setup) as string[], chunk });
    fixes.forEach((f, i) => (f.outcome = outcomes[i]));
  }
};
// The parser of ClickHouse, without running anything.
runAll(parsing, (text) => `SELECT throwIf(formatQueryOrNull(${quote(text)}) IS NULL, 'does not parse') FORMAT Null`);
runAll(running.filter((c) => c.kind !== "format"), (text) => text);
// Binary formats can break the markers between the outputs, so each runs alone.
runAll(running.filter((c) => c.kind === "format"), (text) => text, 1);

// Test hints with a typo of an error name, fixed as the extension's hints.ts does, each file run as clickhouse-client reads its hints.
const errorNames = [...readFileSync(new URL("../../packages/vscode/src/generated/errors.ts", import.meta.url), "utf8").matchAll(/^ {2}(\w+): \d+,$/gm)].map((m) => m[1]!);
const names = errorNames.filter((_, i) => i % 10 === 0);
const dir = mkdtempSync(join(tmpdir(), "fixes-hints-"));
for (const [i, name] of names.entries()) {
  const wrong = typo(name, i);
  const text = `SELECT throwIf(1); -- { serverError ${wrong} }\nSELECT 'done';\n`;
  const at = text.indexOf(wrong);
  const fixes = errorNames.includes(wrong) ? [] : replaceFixes(at, at + wrong.length, nameHints(wrong, errorNames));
  const c: Case = { kind: "test hint", sql: text, fixes: fixes.map((f) => ({ text: apply(text, f), preferred: !!f.preferred })) };
  for (const f of c.fixes) {
    writeFileSync(join(dir, "q.sql"), f.text);
    const run = spawnSync(clickhouse, ["local", "--queries-file", join(dir, "q.sql")], { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" });
    const output = `${run.stdout}${run.stderr}`;
    f.outcome = /No error code with name/.test(output) || run.signal ? { ok: false, message: output.trim().slice(0, 300) } : { ok: true };
  }
  cases.push(c);
}
rmSync(dir, { recursive: true, force: true });

// ClickHouse's own hints in its errors: misspelled functions, types, table functions, databases and tables.
const functions = FUNCTIONS.filter((f) => !f.aggregate && /^[a-z]\w{4,}$/i.test(f.name)).filter((_, i) => i % 15 === 0);
const named: { kind: string; sql: string; word: string }[] = [
  ...functions.map((f, i) => ({ kind: "server hint: function", word: typo(f.name, i), sql: `SELECT ${typo(f.name, i)}(1)` })),
  ...["String", "UInt64", "DateTime", "Decimal", "Float32", "LowCardinality"].map((t, i) => ({ kind: "server hint: data type", word: typo(t, i), sql: `SELECT CAST('1' AS ${typo(t, i)})` })),
  ...["numbers", "zeros", "generateRandom", "values"].map((t, i) => ({ kind: "server hint: table function", word: typo(t, i), sql: `SELECT * FROM ${typo(t, i)}(1) LIMIT 1` })),
  { kind: "server hint: database", word: "sytem", sql: "SELECT * FROM sytem.one" },
  { kind: "server hint: table", word: "system.numbrs", sql: "SELECT * FROM system.numbrs LIMIT 1" },
  { kind: "server hint: table", word: "system.setings", sql: "SELECT * FROM system.setings LIMIT 1" },
];
const first = probe(clickhouse, named.map((n) => n.sql));
const hinted: Case[] = [];
named.forEach((n, i) => {
  const at = n.sql.indexOf(n.word);
  const fixes = messageFixes(n.sql, at, at + n.word.length, first[i]!.message ?? "");
  if (fixes.length) hinted.push({ kind: n.kind, sql: n.sql, fixes: fixes.map((f) => ({ text: apply(n.sql, f), preferred: !!f.preferred })) });
});
console.log(`server hints: ${hinted.length} of ${named.length} statements have hints in ClickHouse's error`);
runAll(hinted, (text) => text);
cases.push(...hinted);

// ---------------------------------------------------------------- The numbers

/** Whether ClickHouse took the fix: it ran, or for ClickHouse's hints, its error is no longer about an unknown name. */
const UNKNOWN_NAME = new Set([46, 50, 60, 81]);
const accepted = (c: Case, outcome: Outcome) =>
  outcome.ok || (c.kind.startsWith("server hint") && !UNKNOWN_NAME.has(outcome.code ?? 0)) || (c.word !== undefined && !outcome.message?.includes(c.word));
const kinds = [...new Set(cases.map((c) => c.kind))];
const summary = kinds.map((kind) => {
  const of = cases.filter((c) => c.kind === kind);
  const fixes = of.flatMap((c) => c.fixes.map((f) => ({ c, f })));
  const preferred = fixes.filter(({ f }) => f.preferred);
  return {
    kind,
    statements: of.length,
    withFixes: of.filter((c) => c.fixes.length).length,
    fixes: fixes.length,
    accepted: fixes.filter(({ c, f }) => accepted(c, f.outcome!)).length,
    preferred: preferred.length,
    preferredAccepted: preferred.filter(({ c, f }) => accepted(c, f.outcome!)).length,
    refused: fixes.filter(({ c, f }) => !accepted(c, f.outcome!)).slice(0, 20).map(({ f }) => `${f.text.slice(0, 200)} -- ${f.outcome!.message?.slice(0, 200)}`),
  };
});
for (const s of summary) {
  console.log(`${s.kind}: ${s.accepted} of ${s.fixes} fixes accepted (${s.preferredAccepted} of ${s.preferred} preferred), ${s.withFixes} of ${s.statements} statements with fixes`);
  for (const r of s.refused.slice(0, 8)) console.log(`  refused: ${r}`);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(dirname(args.report!), { recursive: true });
writeFileSync(args.report!, JSON.stringify({ summary, cases }, null, 1));
