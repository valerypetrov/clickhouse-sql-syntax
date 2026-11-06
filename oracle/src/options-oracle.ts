// Compares checkOptions() and the option suggestions of complete() with a ClickHouse binary,
// as `npm run oracle:options -- --help` describes.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { checkOptions, complete, type Diagnostic, split } from "clickhouse-sql-syntax";

import { type Outcome, probe } from "../../scripts/probe.js";
import { needsXRay, usesOtherDialect } from "./extract.js";

const USAGE = `Usage: npm run oracle:options -w oracle -- --clickhouse <binary> [--corpus <dir>] [options]

Runs checkOptions() on every test file of the corpus and runs each statement it flags in clickhouse local, to count
the ones ClickHouse runs without an error; checks every setting, codec and index type with a generated set of values
against ClickHouse; runs every option that completion offers in a statement; and times both.

Options:
  --clickhouse <binary> the ClickHouse to compare with
  --corpus <dir>        tests/queries/0_stateless of a ClickHouse checkout
  --only <parts>        a comma-separated subset of corpus, values, codecs, completion, timing
  --report <file>       where to write the JSON report (default: out/options-report.json)`;

const { values: args } = parseArgs({
  options: {
    clickhouse: { type: "string" },
    corpus: { type: "string" },
    only: { type: "string" },
    report: { type: "string", default: new URL("../out/options-report.json", import.meta.url).pathname },
    help: { type: "boolean", default: false },
  },
});
if (args.help || !args.clickhouse) {
  console.log(USAGE);
  process.exit(args.help ? 0 : 2);
}
const clickhouse = args.clickhouse;
const parts = new Set((args.only ?? "corpus,values,codecs,completion,timing").split(","));
const report: Record<string, unknown> = {};

const isError = (d: Diagnostic) => d.severity === "error";
const id = () => Math.floor(Math.random() * 1e12);
/** Whether ClickHouse refused the value itself, rather than the query for another reason. */
const aboutValue = (o: Outcome) =>
  !o.ok && /while setting|Unknown setting|out of range of bool|has to be greater than 0|Invalid time zone|Unexpected value|Cannot parse bool/.test(o.message ?? "");

// ---------------------------------------------------------------- The corpus: what checkOptions() flags

function corpus(): void {
  if (!args.corpus) return;
  const files = readdirSync(args.corpus).filter((f) => f.endsWith(".sql")).sort();
  const flagged: { file: string; sql: string; diagnostics: string[]; severity: string; expected: boolean }[] = [];
  let statements = 0;
  const started = performance.now();
  for (const file of files) {
    const source = readFileSync(join(args.corpus, file), "utf8");
    if (usesOtherDialect(source) || needsXRay(source)) continue;
    const units = split(source).filter((u) => u.statement);
    statements += units.length;
    const diagnostics = checkOptions(source);
    for (const unit of units) {
      const own = diagnostics.filter((d) => d.start >= unit.statement!.start && d.start < unit.statement!.end);
      if (!own.length) continue;
      const lineEnd = source.indexOf("\n", unit.statement!.end);
      const after = source.slice(unit.statement!.end, lineEnd < 0 ? undefined : lineEnd);
      const sql = source.slice(unit.statement!.start, unit.statement!.end).replace(/;\s*$/, "");
      // A hint inside the statement counts too, as clickhouse-client reads it there.
      const expected = /\b(serverError|clientError)\b/.test(after) || /--\s*\{\s*(serverError|clientError)\b/.test(sql);
      flagged.push({ file, sql, diagnostics: own.map((d) => `${d.severity}: ${d.message}`), severity: own.some(isError) ? "error" : "warning", expected });
    }
  }
  const checkMs = performance.now() - started;
  // Each flagged statement that its test does not expect to fail runs alone, in a database of its own.
  const unexpected = flagged.filter((f) => !f.expected);
  const outcomes = probe(clickhouse, unexpected.map((f) => f.sql), { setup: ["SET allow_experimental_analyzer = 1"], chunk: 200 });
  const rows = unexpected.map((f, i) => ({ ...f, clickhouse: outcomes[i]! }));
  const falsePositives = rows.filter((r) => r.clickhouse.ok);
  const summary = {
    statements,
    flagged: flagged.length,
    expectedByTheTest: flagged.length - unexpected.length,
    unexpected: unexpected.length,
    clickhouseFails: rows.filter((r) => !r.clickhouse.ok).length,
    falsePositives: falsePositives.length,
    falsePositiveErrors: falsePositives.filter((r) => r.severity === "error").length,
    falsePositiveWarnings: falsePositives.filter((r) => r.severity === "warning").length,
    checkMs: Math.round(checkMs),
  };
  console.log("corpus:", summary);
  for (const r of falsePositives.slice(0, 30)) console.log(`  ran fine: ${r.file}: ${r.sql.slice(0, 120).replace(/\s+/g, " ")}\n    ${r.diagnostics.join(" | ").slice(0, 200)}`);
  report.corpus = { summary, falsePositives, failing: rows.filter((r) => !r.clickhouse.ok).map((r) => ({ file: r.file, sql: r.sql, ours: r.diagnostics, clickhouse: r.clickhouse.message })) };
}

// ---------------------------------------------------------------- Generated values of settings

const VALUES = ["0", "1", "2", "-1", "1.5", "18446744073709551616", "'abc'", "''", "'10'", "'10K'", "'10G'", "'1.5'", "'true'", "'FALSE'", "'auto'", "NULL", "true", "{'a':'b'}", "'a'", "'UTC'", "'Europe/Nowhere'"];

interface Matrix {
  agree: number;
  /** checkOptions() reports an error and ClickHouse takes the value. */
  falseErrors: string[];
  /** ClickHouse refuses the value and checkOptions() says nothing. */
  missed: string[];
  /** ClickHouse refused the statement for another reason; left out. */
  other: number;
}

function compare(statements: string[], verdict: (o: Outcome) => boolean | undefined, setup?: string[]): Matrix {
  const outcomes = probe(clickhouse, statements, { setup });
  const matrix: Matrix = { agree: 0, falseErrors: [], missed: [], other: 0 };
  statements.forEach((sql, i) => {
    const theirs = verdict(outcomes[i]!);
    if (theirs === undefined) {
      matrix.other++;
      return;
    }
    const ours = checkOptions(sql).some(isError);
    if (ours === theirs) matrix.agree++;
    else if (ours) matrix.falseErrors.push(`${sql} -- ClickHouse: ok`);
    else matrix.missed.push(`${sql} -- ClickHouse: ${outcomes[i]!.message}`);
  });
  return matrix;
}

function summarize(name: string, m: Matrix): void {
  console.log(`${name}: ${m.agree} agree, ${m.falseErrors.length} false errors, ${m.missed.length} missed, ${m.other} refused for other reasons`);
  for (const e of m.falseErrors.slice(0, 10)) console.log(`  false error: ${e.slice(0, 220)}`);
  for (const e of m.missed.slice(0, 5)) console.log(`  missed: ${e.slice(0, 220)}`);
  report[name] = m;
}

function values(): void {
  const settings = complete("SELECT 1 SETTINGS ", 18).filter((c) => c.kind === "setting").map((c) => c.label);
  const enumValues = (name: string) => complete(`SELECT 1 SETTINGS ${name} = `, `SELECT 1 SETTINGS ${name} = `.length).filter((c) => c.kind === "value").map((c) => c.insertText ?? c.label).slice(0, 2);
  const query = settings.flatMap((name) => [...VALUES, ...enumValues(name), "'zz_value'"].map((v) => `SELECT 1 SETTINGS ${name} = ${v} FORMAT Null`));
  const verdict = (o: Outcome) => (o.ok ? false : aboutValue(o) ? true : undefined);
  summarize("query settings", compare(query, verdict));
  const mergeTree = complete("CREATE TABLE t (x UInt64) ENGINE = MergeTree ORDER BY x SETTINGS ", 66).filter((c) => c.kind === "setting" && c.detail !== undefined && !/^setting\b/.test(c.detail));
  const mt = mergeTree.flatMap((c) => VALUES.map((v) => `CREATE TABLE p_${id()} (x UInt64) ENGINE = MergeTree ORDER BY x SETTINGS ${c.label} = ${v}`));
  summarize("MergeTree settings", compare(mt, verdict));
  const engines: [string, string][] = [
    ["Memory", "Memory"], ["Kafka", "Kafka('localhost:1', 't', 'g', 'CSV')"], ["Distributed", "Distributed(test_shard_localhost, system, one)"],
    ["Set", "Set"], ["EmbeddedRocksDB", "EmbeddedRocksDB PRIMARY KEY x"], ["FileLog", "FileLog('/nonexistent', 'CSV')"], ["S3Queue", "S3Queue('http://localhost:1/b/*', CSV)"],
  ];
  const own = engines.flatMap(([engine, call]) => {
    const prefix = `CREATE TABLE t (x UInt64) ENGINE = ${call} SETTINGS `;
    return complete(prefix, prefix.length).filter((c) => c.kind === "setting" && c.detail?.startsWith(engine)).flatMap((c) =>
      ["0", "1", "-1", "'abc'", "''", "NULL", "'zz_value'"].map((v) => `CREATE TABLE p_${id()} (x UInt64) ENGINE = ${call} SETTINGS ${c.label} = ${v}`));
  });
  summarize("engine settings", compare(own, verdict));
  const names = ["zz_unknown", "max_threads", "index_granularity", "compress", "kafka_num_consumers", "disk", "background_insert_batch"];
  const unknown = engines.concat([["MergeTree", "MergeTree ORDER BY x"], ["Log", "Log"], ["Null", "Null"], ["Join", "Join(ANY, LEFT, x)"]]).flatMap(([, call]) =>
    names.map((n) => `CREATE TABLE p_${id()} (x UInt64) ENGINE = ${call} SETTINGS ${n} = 1`));
  summarize("engine setting names", compare(unknown, (o) => (o.ok ? false : /Unknown setting|doesn't support SETTINGS/.test(o.message ?? "") ? true : undefined)));
  const explain = ["AST", "SYNTAX", "QUERY TREE", "PLAN", "PIPELINE", "ESTIMATE"].flatMap((kind) => {
    const prefix = `EXPLAIN ${kind} `;
    const offered = complete(prefix, prefix.length).filter((c) => c.kind === "setting").map((c) => c.label);
    return [...offered, "zz_unknown"].flatMap((n) => ["0", "1", "2", "'a'", "-1"].map((v) => `EXPLAIN ${kind} ${n} = ${v} SELECT 1`));
  });
  summarize("EXPLAIN settings", compare(explain, (o) => (o.ok ? false : /setting|Invalid value|Invalid type/.test(o.message ?? "") ? true : undefined)));
}

// ---------------------------------------------------------------- Codecs, index types and statistics

function codecs(): void {
  const codecNames = complete("CREATE TABLE t (x UInt64 CODEC(", 31).filter((c) => c.kind === "codec").map((c) => c.label);
  const params = ["", "(0)", "(1)", "(2)", "(3)", "(4)", "(5)", "(6)", "(8)", "(9)", "(12)", "(13)", "(15)", "(19)", "(22)", "(23)", "(28)", "(29)", "(-1)", "(1.5)", "('byte')", "('bit')", "('zz')", "(AUTO)", "(zz)", "(1, 1)", "(3, 10)", "(3, 9)", "(3, 31)", "(3, 32)", "(12, 4)", "(12, 5)", "(1, 2, 3)"];
  const types = ["UInt64", "Float64", "String", "LowCardinality(String)", "Nullable(Float32)", "Array(UInt128)", "Map(String, UInt64)", "Tuple(a Int32, b DateTime)"];
  const codec = codecNames.flatMap((name) => types.flatMap((type) => params.map((p) => `CREATE TABLE p_${id()} (x ${type} CODEC(${name}${p}, LZ4)) ENGINE = Memory`)));
  const setup = ["SET allow_suspicious_codecs = 1", ...["enable_pco_codec", "enable_alp_codec", "enable_sz3_codec", "enable_zxc_codec", "enable_gdeflate_codec", "enable_quantized_codec"].map((s) => `SET ${s} = 1`)];
  const codecVerdict = (o: Outcome) => (o.ok ? false : /codec|Codec|Bad get|parameter/.test(o.message ?? "") ? true : undefined);
  summarize("codecs", compare([...codec, `CREATE TABLE p_${id()} (x UInt64 CODEC(Zzz)) ENGINE = Memory`], codecVerdict, setup));
  const indexes = complete("CREATE TABLE t (x String, INDEX i x TYPE ", 41).filter((c) => c.kind === "index type").map((c) => c.label);
  const indexParams = ["", "(0)", "(1)", "(0.5)", "(2)", "(100)", "(-1)", "(3, 256, 2, 0)", "(3, 256, 2)", "(256, 2, 0)", "(0, 2, 0)", "(3, 100, 256, 2, 0)", "('a')"];
  const textParams = ["(tokenizer = splitByNonAlpha)", "(tokenizer = zz)", "(tokenizer = ngrams(3))", "(tokenizer = 'array', posting_list_block_size = 0)", "(tokenizer = array, zz = 1)",
    "(tokenizer = array, tokenizer = array)", "(tokenizer = array, dictionary_block_size = 'a')", "(tokenizer = array, support_phrase_search = 2)", "(preprocessor = lower(x))"];
  const vectorParams = ["('hnsw', 'L2Distance', 3)", "('hnsw', 'L2Distance', 0)", "('hnsw', 'cosineDistance', 3, 'bf16', 16, 100)", "('hnsw', 'L2Distance', 3, 'bf16', 1, 100)",
    "('hnsw', 'L2Distance', 3, 'bf16')", "('zz', 'L2Distance', 3)", "('hnsw', 'zz', 3)", "('hnsw', 'L2Distance', 3, 'zz', 16, 100)", "('hnsw', 'L2Distance', -1)"];
  const index = [
    ...[...indexes, "zz_type"].flatMap((name) => indexParams.map((p) => `CREATE TABLE p_${id()} (x String, INDEX i x TYPE ${name}${p} GRANULARITY 1) ENGINE = MergeTree ORDER BY tuple()`)),
    ...textParams.map((p) => `CREATE TABLE p_${id()} (x String, INDEX i x TYPE text${p} GRANULARITY 1) ENGINE = MergeTree ORDER BY tuple()`),
    ...[...indexParams, ...vectorParams].map((p) => `CREATE TABLE p_${id()} (x Array(Float32), INDEX i x TYPE vector_similarity${p} GRANULARITY 1) ENGINE = MergeTree ORDER BY tuple()`),
  ];
  summarize("index types", compare(index, (o) => (o.ok ? false : /index|Index|argument|parameter/.test(o.message ?? "") && !/does not support|cannot be used|data type/.test(o.message ?? "") ? true : undefined)));
  const statistics = [...complete("CREATE TABLE t (x UInt64 STATISTICS(", 36).filter((c) => c.kind === "statistics type").map((c) => c.label), "zz", "TDigest"];
  summarize("statistics types", compare(statistics.map((s) => `CREATE TABLE p_${id()} (x UInt64 STATISTICS(${s})) ENGINE = MergeTree ORDER BY x`), (o) => (o.ok ? false : /Unknown statistics/.test(o.message ?? "") ? true : undefined)));
  // The levels of INTO OUTFILE, into a file of a folder of its own.
  const folder = mkdtempSync(join(tmpdir(), "options-oracle-"));
  const levels = ["none", "gzip", "zstd", "lz4", "br", "xz", "bz2", "snappy", "deflate", "gz"].flatMap((m) => ["0", "1", "9", "10", "12", "13", "22", "23", "-1", "1.5", "0x05"].map((l) =>
    `SELECT 1 INTO OUTFILE '${join(folder, "f")}' TRUNCATE COMPRESSION '${m}' LEVEL ${l}`));
  summarize("compression levels", compare(levels, (o) => (o.ok ? false : /compression level/.test(o.message ?? "") ? true : undefined)));
  rmSync(folder, { recursive: true, force: true });
  const formats = ["JSON", "json", "TSV", "Zzz", "Null", "CSVWithNames", "pretty"];
  summarize("formats", compare(formats.map((f) => `SELECT 1 FORMAT ${f}`), (o) => (o.ok ? false : /Unknown format/.test(o.message ?? "") ? true : undefined)));
}

// ---------------------------------------------------------------- Completion: every option offered runs

function completion(): void {
  const cases: { at: string; build: (label: string, insert: string) => string; kind: string }[] = [
    { at: "SELECT 1 SETTINGS ", kind: "setting", build: (l) => `SELECT 1 SETTINGS ${l} = DEFAULT FORMAT Null` },
    { at: "CREATE TABLE t (x UInt64) ENGINE = MergeTree ORDER BY x SETTINGS ", kind: "setting", build: (l) => `CREATE TABLE p_${id()} (x UInt64) ENGINE = MergeTree ORDER BY x SETTINGS ${l} = DEFAULT` },
    { at: "SET join_algorithm = ", kind: "value", build: (_, i) => `SELECT 1 SETTINGS join_algorithm = ${i} FORMAT Null` },
    { at: "SET load_balancing = ", kind: "value", build: (_, i) => `SELECT 1 SETTINGS load_balancing = ${i} FORMAT Null` },
    { at: "SET use_uncompressed_cache = ", kind: "value", build: (_, i) => `SELECT 1 SETTINGS use_uncompressed_cache = ${i} FORMAT Null` },
    { at: "CREATE TABLE t (x UInt64) ENGINE = MergeTree ORDER BY x SETTINGS deduplicate_merge_projection_mode = ", kind: "value", build: (_, i) => `CREATE TABLE p_${id()} (x UInt64) ENGINE = MergeTree ORDER BY x SETTINGS deduplicate_merge_projection_mode = ${i}` },
    { at: "CREATE TABLE t (x UInt64 CODEC(", kind: "codec", build: (l) => `CREATE TABLE p_${id()} (x ${/^(FPC|Gorilla|ALP|SZ3|PCO)$/.test(l) ? "Float64" : "UInt64"} CODEC(${l}, LZ4)) ENGINE = Memory` },
    { at: "CREATE TABLE t (x UInt64 CODEC(T64(", kind: "value", build: (_, i) => `CREATE TABLE p_${id()} (x UInt64 CODEC(T64(${i}), LZ4)) ENGINE = Memory` },
    { at: "CREATE TABLE t (x String, INDEX i x TYPE ", kind: "index type", build: (_, i) => `CREATE TABLE p_${id()} (x String, INDEX i x TYPE ${i} GRANULARITY 1) ENGINE = MergeTree ORDER BY tuple()` },
    { at: "CREATE TABLE t (x UInt64 STATISTICS(", kind: "statistics type", build: (l) => `CREATE TABLE p_${id()} (x UInt64 STATISTICS(${l})) ENGINE = MergeTree ORDER BY x` },
    { at: "CREATE DATABASE d ENGINE = ", kind: "database engine", build: (l) => `CREATE DATABASE p_${id()} ENGINE = ${l}` },
    { at: "SELECT 1 FORMAT ", kind: "format", build: (l) => `SELECT 1 FORMAT ${l}` },
    { at: "SELECT 1 INTO OUTFILE 'f' COMPRESSION ", kind: "value", build: (_, i) => `SELECT 1 INTO OUTFILE '/dev/null' APPEND COMPRESSION ${i}` },
    { at: "EXPLAIN PLAN ", kind: "setting", build: (l) => `EXPLAIN PLAN ${l} = 1 SELECT 1` },
    { at: "EXPLAIN QUERY TREE ", kind: "setting", build: (l) => `EXPLAIN QUERY TREE ${l} = 1 SELECT 1` },
    { at: "CREATE TABLE t (x UInt64) ENGINE = Kafka('localhost:1', 't', 'g', 'CSV') SETTINGS ", kind: "setting", build: (l) => `CREATE TABLE p_${id()} (x UInt64) ENGINE = Kafka('localhost:1', 't', 'g', 'CSV') SETTINGS ${l} = DEFAULT` },
  ];
  const statements: { sql: string; kind: string; label: string }[] = [];
  for (const c of cases)
    for (const candidate of complete(c.at, c.at.length).filter((x) => x.kind === c.kind))
      statements.push({ sql: c.build(candidate.label, candidate.insertText ?? candidate.label), kind: c.kind, label: candidate.label });
  // What a suggestion is meant to avoid: an unknown name or value; another error, as a missing server, is not about it.
  const setup = ["SET allow_suspicious_codecs = 1", ...["enable_pco_codec", "enable_alp_codec", "enable_sz3_codec", "enable_zxc_codec", "enable_gdeflate_codec", "enable_quantized_codec"].map((s) => `SET ${s} = 1`)];
  const outcomes = probe(clickhouse, statements.map((s) => s.sql), { setup });
  const refused = statements.map((s, i) => ({ ...s, outcome: outcomes[i]! })).filter((s) =>
    !s.outcome.ok && /Unknown (setting|codec|Index type|statistics|format|compression|database engine)|Unexpected value|Wrong modification|Syntax error/i.test(s.outcome.message ?? ""));
  const summary = { offered: statements.length, ran: outcomes.filter((o) => o.ok).length, refusedAsUnknown: refused.length };
  console.log("completion:", summary);
  for (const r of refused.slice(0, 20)) console.log(`  refused: ${r.sql.slice(0, 120)} -- ${r.outcome.message?.slice(0, 160)}`);
  report.completion = { summary, refused };
}

// ---------------------------------------------------------------- Timing

function timing(): void {
  const docs = [
    "SELECT * FROM t WHERE x = 1 SETTINGS max_threads = 8, join_algorithm = 'hash', use_uncompressed_cache = 1;\n",
    "CREATE TABLE t (x UInt64 CODEC(Delta(8), ZSTD(3)), s String, INDEX i s TYPE bloom_filter(0.01) GRANULARITY 4) ENGINE = MergeTree ORDER BY x SETTINGS index_granularity = 8192;\n",
  ];
  const sql = docs.join("").repeat(500);
  const time = (f: () => void, n: number) => {
    const t = performance.now();
    for (let i = 0; i < n; i++) f();
    return (performance.now() - t) / n;
  };
  const result = {
    checkOptions1000StatementsMs: time(() => checkOptions(sql), 3),
    completeSettingsMs: time(() => complete("SELECT 1 SETTINGS max_", 22), 50),
    completeMergeTreeSettingsMs: time(() => complete("CREATE TABLE t (x UInt64) ENGINE = MergeTree ORDER BY x SETTINGS index_", 72), 50),
    completeValueMs: time(() => complete("SET join_algorithm = ", 21), 50),
    completeCodecMs: time(() => complete("CREATE TABLE t (x UInt64 CODEC(", 31), 50),
  };
  console.log("timing:", result);
  report.timing = result;
}

if (parts.has("corpus")) corpus();
if (parts.has("values")) values();
if (parts.has("codecs")) codecs();
if (parts.has("completion")) completion();
if (parts.has("timing")) timing();
mkdirSync(dirname(args.report!), { recursive: true });
writeFileSync(args.report!, JSON.stringify(report, null, 1));
