// Checks format() on the valid statements of a labelled corpus: the same query for ClickHouse,
// idempotent, still valid for check(), the same tokens and comments. Run it with `npm run oracle:format -- --help`.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { type KeywordCase, KEYWORDS, TokenKind, check, format, tokenize } from "clickhouse-sql-syntax";

import { classify } from "./clickhouse.js";
import { type Entry, readCorpus } from "./corpus.js";
import { extractCorpus, usesOtherDialect } from "./extract.js";
import { CACHE_DIR, CORPUS_FILE, SOURCE_NOTE, integerOption } from "./paths.js";
import { splitStatements } from "./split.js";

const REPORT = fileURLToPath(new URL("../out/format-report.json", import.meta.url));
const SAMPLE = fileURLToPath(new URL("../../packages/core/test/format/fixtures/corpus-sample.json", import.meta.url));

const USAGE = `Usage: npm run oracle:format [-- options]

Formats every valid statement of ${CORPUS_FILE}, with each keywordCase, and checks that the result is idempotent,
still valid for check(), and has the same tokens and comments. With --clickhouse it also checks
that ClickHouse reads the same query (formatQuerySingleLine) and that every re-cased word is a
keyword for ClickHouse (highlightQuery). With --corpus it also formats every test file as a whole,
comments and inline data included, as LF and as CRLF text.

Options:
  --file <file>         a labelled corpus to use instead (default: the one above)
  --clickhouse <binary> a ClickHouse binary for the checks above
  --corpus <dir>        tests/queries/0_stateless of a ClickHouse checkout, labelled with --clickhouse
  --report <file>       where to write the JSON report (default: ${REPORT})
  --examples <n>        examples to print per kind of failure (default: 5)
  --keyword-case <case> only this keywordCase: upper, lower or preserve (default: all three)
  --jobs <n>            parallel ClickHouse processes, 1 to 4 (default: 4)
  --update-sample       rewrite ${SAMPLE} from statements that pass every check`;

const { values } = parseArgs({
  options: {
    file: { type: "string", default: CORPUS_FILE },
    clickhouse: { type: "string" },
    corpus: { type: "string" },
    report: { type: "string", default: REPORT },
    examples: { type: "string", default: "5" },
    "keyword-case": { type: "string" },
    jobs: { type: "string", default: "4" },
    "update-sample": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help || (values.corpus && !values.clickhouse) || (values["update-sample"] && !values.clickhouse)) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 2);
}
const jobs = Math.min(4, integerOption(values.jobs, "--jobs", 1));

interface Case {
  keywordCase: KeywordCase;
  file: string;
  line: number;
  sql: string;
  formatted: string;
  detail?: string;
}

const FAILURES = {
  meaning: "ClickHouse reads a different query",
  unsafeKeyword: "re-cased a word that ClickHouse takes for a name, a function or a literal",
  idempotence: "format(format(x)) differs from format(x)",
  validity: "check() rejects the formatted statement",
  tokens: "the tokens changed",
  comments: "a comment was lost or changed",
  thrown: "format() threw",
} as const;
type Failure = keyof typeof FAILURES;

const KEYWORD_WORDS = new Set(KEYWORDS.flatMap((k) => k.split(" ")));

/** The comments of a file: those inside its statements and those between them. */
function fileComments(text: string, statements: { text: string; start: number }[]): string[] {
  const comments: string[] = [];
  let from = 0;
  for (const s of statements) {
    comments.push(...tokensOf(text.slice(from, s.start)).comments, ...tokensOf(s.text).comments);
    from = s.start + s.text.length;
  }
  comments.push(...tokensOf(text.slice(from)).comments);
  return comments.sort();
}

/** Significant tokens and comments of a text, words of the keyword list in upper case. */
function tokensOf(sql: string): { tokens: string[]; comments: string[] } {
  const tokens: string[] = [];
  const comments: string[] = [];
  for (const token of tokenize(sql)) {
    const text = sql.slice(token.start, token.end);
    if (token.kind === TokenKind.Whitespace) continue;
    if (token.kind === TokenKind.Comment) comments.push(text.replace(/\r$/, ""));
    else if (token.kind === TokenKind.BareWord && KEYWORD_WORDS.has(text.toUpperCase())) tokens.push(`${token.kind} ${text.toUpperCase()}`);
    else tokens.push(`${token.kind} ${text}`);
  }
  return { tokens, comments: comments.sort() };
}

function same(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function run(command: string, args: string[], input: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

interface Verdict {
  /** formatQuerySingleLine of the original and of the formatted text agree. */
  same: boolean;
  original: string | null;
  formatted: string | null;
  /** highlightQuery of the original: byte ranges and their kind. */
  highlights: { begin: number; end: number; type: string }[];
}

/** Asks ClickHouse about pairs of texts, a chunk per process; a chunk that fails is split. */
async function askClickHouse(clickhouse: string, pairs: { a: string; b: string }[]): Promise<(Verdict | null)[]> {
  const result: (Verdict | null)[] = new Array(pairs.length).fill(null);
  const query =
    "SELECT id, isNotDistinctFrom(x, y) AS same, x, y, highlightQuery(a) AS h FROM " +
    "(SELECT id, a, formatQuerySingleLineOrNull(a) AS x, formatQuerySingleLineOrNull(b) AS y FROM table) FORMAT JSONEachRow";
  const args = ["local", "--implicit_select=0", "--input-format", "JSONEachRow", "--structure", "id UInt32, a String, b String", "-q", query];
  const ask = async (ids: number[]): Promise<void> => {
    const input = ids.map((id) => JSON.stringify({ id, a: pairs[id]!.a, b: pairs[id]!.b })).join("\n") + "\n";
    const answer = await run(clickhouse, args, input);
    if (answer.code === 0) {
      for (const line of answer.stdout.split("\n")) {
        if (!line) continue;
        const row = JSON.parse(line) as { id: number; same: number; x: string | null; y: string | null; h: Verdict["highlights"] };
        result[row.id] = { same: row.same === 1, original: row.x, formatted: row.y, highlights: row.h };
      }
      return;
    }
    if (ids.length === 1) return;
    const half = Math.ceil(ids.length / 2);
    await ask(ids.slice(0, half));
    await ask(ids.slice(half));
  };
  const chunks: number[][] = [];
  for (let i = 0; i < pairs.length; i += 5000) chunks.push(Array.from({ length: Math.min(5000, pairs.length - i) }, (_, k) => i + k));
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(jobs, chunks.length) }, async () => {
      while (next < chunks.length) await ask(chunks[next++]!);
    }),
  );
  return result;
}

/** UTF-16 offset of every UTF-8 byte offset that starts a character. */
function byteOffsets(sql: string): Map<number, number> {
  const map = new Map<number, number>();
  let byte = 0;
  for (let i = 0; i <= sql.length; i++) {
    map.set(byte, i);
    if (i === sql.length) break;
    const c = sql.codePointAt(i)!;
    byte += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    if (c > 0xffff) i++;
  }
  return map;
}

async function readVersion(): Promise<string> {
  const result = await run(values.clickhouse!, ["local", "-q", "SELECT version()"], "");
  return result.stdout.trim();
}

async function statements(): Promise<Entry[]> {
  if (!values.corpus) return readCorpus(values.file).entries.filter((e) => e.valid);
  const extracted = extractCorpus(values.corpus, { maxLength: 100_000 });
  const labelled = await classify(
    extracted.statements.map((s) => s.sql),
    { clickhouse: values.clickhouse!, cacheDir: CACHE_DIR, formatCheck: 0, jobs, log: (line) => console.error(line) },
  );
  return extracted.statements.flatMap((s) => {
    const verdict = labelled.verdicts.get(s.sql);
    return verdict?.valid ? [{ sql: s.sql, file: s.file, line: s.line, ...verdict }] : [];
  });
}

interface Run {
  keywordCase: KeywordCase;
  seconds: number;
  failures: Record<Failure, Case[]>;
  rejectedByCheck: Case[];
  unchanged: number;
  compared: number;
  notComparable: number;
  recased: number;
  keywordsSeen: number;
  keywordsRecased: number;
  formatted: { entry: Entry; text: string }[];
  verified: Set<number>;
  /** Re-cased words that highlightQuery does not cover. */
  unknown: number;
  missed: Map<string, number>;
  missedExamples: Map<string, string[]>;
}

async function checkCase(entries: Entry[], keywordCase: KeywordCase): Promise<Run> {
  const started = performance.now();
  const failures: Record<Failure, Case[]> = {
    meaning: [],
    unsafeKeyword: [],
    idempotence: [],
    validity: [],
    tokens: [],
    comments: [],
    thrown: [],
  };
  const rejectedByCheck: Case[] = [];
  const formatted: { entry: Entry; text: string }[] = [];
  let unchanged = 0;
  for (const entry of entries) {
    const base = { keywordCase, file: entry.file, line: entry.line, sql: entry.sql };
    let text: string;
    try {
      text = format(entry.sql, { keywordCase });
    } catch (error) {
      failures.thrown.push({ ...base, formatted: "", detail: String(error) });
      continue;
    }
    const result = { ...base, formatted: text };
    if (check(entry.sql).length > 0) {
      // By design a statement that check() rejects is left as it is.
      rejectedByCheck.push(result);
      if (text !== entry.sql) failures.tokens.push({ ...result, detail: "a statement that check() rejects was changed" });
      continue;
    }
    if (text === entry.sql) unchanged++;
    const again = format(text, { keywordCase });
    if (again !== text) failures.idempotence.push({ ...result, detail: again });
    if (check(text).length > 0) failures.validity.push({ ...result, detail: check(text)[0]!.message });
    const before = tokensOf(entry.sql);
    const after = tokensOf(text);
    if (!same(before.tokens, after.tokens)) failures.tokens.push(result);
    if (!same(before.comments, after.comments)) failures.comments.push(result);
    formatted.push({ entry, text });
  }
  const seconds = (performance.now() - started) / 1000;

  // ClickHouse: the same query, and re-cased words are keywords.
  let compared = 0;
  let notComparable = 0;
  let recased = 0;
  let unknown = 0;
  const missed = new Map<string, number>();
  const missedExamples = new Map<string, string[]>();
  let keywordsSeen = 0;
  let keywordsRecased = 0;
  const verified = new Set<number>();
  if (values.clickhouse) {
    const changed = formatted.map((f, index) => ({ ...f, index })).filter((f) => f.text !== f.entry.sql);
    const verdicts = await askClickHouse(values.clickhouse, changed.map((f) => ({ a: f.entry.sql, b: f.text })));
    changed.forEach((f, k) => {
      const verdict = verdicts[k];
      const result = { keywordCase, file: f.entry.file, line: f.entry.line, sql: f.entry.sql, formatted: f.text };
      if (!verdict || verdict.original === null) {
        notComparable++;
        return;
      }
      compared++;
      if (!verdict.same) failures.meaning.push({ ...result, detail: `${verdict.original}\n${verdict.formatted}` });
      // Compare word by word; the token lists line up when the tokens did not change.
      const offsets = byteOffsets(f.entry.sql);
      const ranges = verdict.highlights.map((h) => ({ start: offsets.get(h.begin) ?? -1, end: offsets.get(h.end) ?? -1, type: h.type }));
      const a = tokenize(f.entry.sql).filter((t) => t.kind !== TokenKind.Whitespace && t.kind !== TokenKind.Comment);
      const b = tokenize(f.text).filter((t) => t.kind !== TokenKind.Whitespace && t.kind !== TokenKind.Comment);
      if (a.length !== b.length) return;
      let unsafe = "";
      a.forEach((t, i) => {
        if (t.kind !== TokenKind.BareWord) return;
        const before = f.entry.sql.slice(t.start, t.end);
        const after = f.text.slice(b[i]!.start, b[i]!.end);
        const type = ranges.find((r) => r.start <= t.start && r.end >= t.end)?.type ?? "none";
        const wanted = keywordCase === "upper" ? before.toUpperCase() : keywordCase === "lower" ? before.toLowerCase() : before;
        if (type === "keyword" && KEYWORD_WORDS.has(before.toUpperCase()) && before !== wanted) {
          keywordsSeen++;
          if (after !== before) keywordsRecased++;
          else {
            missed.set(before.toUpperCase(), (missed.get(before.toUpperCase()) ?? 0) + 1);
            const list = missedExamples.get(before.toUpperCase()) ?? [];
            if (list.length < 5) list.push(`${f.entry.file}:${f.entry.line}: ${f.entry.sql.slice(Math.max(0, t.start - 60), t.end + 40)}`);
            missedExamples.set(before.toUpperCase(), list);
          }
        }
        if (after === before) return;
        recased++;
        if (type === "none") unknown++;
        else if (type !== "keyword" && !unsafe) unsafe = `${before} (${type})`;
      });
      if (unsafe) failures.unsafeKeyword.push({ ...result, detail: unsafe });
      if (verdict.same && !unsafe) verified.add(f.index);
    });
  }
  return {
    keywordCase,
    seconds,
    failures,
    rejectedByCheck,
    unchanged,
    compared,
    notComparable,
    recased,
    keywordsSeen,
    keywordsRecased,
    formatted,
    verified,
    unknown,
    missed,
    missedExamples,
  };
}

const entries = await statements();
const cases: KeywordCase[] = values["keyword-case"] ? [values["keyword-case"] as KeywordCase] : ["upper", "lower", "preserve"];
const runs: Run[] = [];
for (const keywordCase of cases) runs.push(await checkCase(entries, keywordCase));

const examples = integerOption(values.examples, "--examples");

// Whole files: statements in their context, with the comments around them and inline data.
const FILE_FAILURES = {
  tokens: "the tokens changed",
  comments: "a comment was lost or changed",
  idempotence: "format(format(x)) differs from format(x)",
  statements: "the statements of the file changed",
  crlf: "CRLF text did not keep its line endings or tokens",
  meaning: "ClickHouse reads a statement differently",
  thrown: "format() threw",
} as const;
type FileFailure = keyof typeof FILE_FAILURES;
const fileFailures: Record<FileFailure, { file: string; detail: string }[]> = {
  tokens: [],
  comments: [],
  idempotence: [],
  statements: [],
  crlf: [],
  meaning: [],
  thrown: [],
};
const fileLines: string[] = [];
if (values.corpus) {
  const started = performance.now();
  const pairs: { file: string; a: string; b: string }[] = [];
  let files = 0;
  for (const name of readdirSync(values.corpus).filter((f) => f.endsWith(".sql")).sort()) {
    const text = readFileSync(join(values.corpus, name), "utf8");
    if (usesOtherDialect(text)) continue;
    files++;
    try {
      const formatted = format(text);
      if (format(formatted) !== formatted) fileFailures.idempotence.push({ file: name, detail: "" });
      const a = splitStatements(text);
      const b = splitStatements(formatted);
      if (a.length !== b.length) {
        fileFailures.statements.push({ file: name, detail: `${a.length} statements became ${b.length}` });
        continue;
      }
      // Tokens statement by statement, as inline data must not be lexed as SQL.
      const bad = a.findIndex((s, k) => !same(tokensOf(s.text).tokens, tokensOf(b[k]!.text).tokens));
      if (bad >= 0) fileFailures.tokens.push({ file: `${name}:${a[bad]!.line}`, detail: "" });
      if (!same(fileComments(text, a), fileComments(formatted, b))) fileFailures.comments.push({ file: name, detail: "" });
      a.forEach((s, k) => s.text !== b[k]!.text && pairs.push({ file: `${name}:${s.line}`, a: s.text, b: b[k]!.text }));
      // The same file with CRLF line breaks keeps them; a file without line breaks has none to keep.
      const crlf = text.replace(/\r?\n/g, "\r\n");
      if (crlf.includes("\r\n")) {
        const out = format(crlf);
        const c = splitStatements(crlf);
        const d = splitStatements(out);
        const tokensKept = c.length === d.length && c.every((s, k) => same(tokensOf(s.text).tokens, tokensOf(d[k]!.text).tokens));
        if (/(^|[^\r])\n/.test(out) || !tokensKept) fileFailures.crlf.push({ file: name, detail: "" });
      }
    } catch (error) {
      fileFailures.thrown.push({ file: name, detail: String(error) });
    }
  }
  if (values.clickhouse) {
    const verdicts = await askClickHouse(values.clickhouse, pairs);
    pairs.forEach((p, k) => {
      const v = verdicts[k];
      if (v && v.original !== null && !v.same) fileFailures.meaning.push({ file: p.file, detail: `${v.original}\n${v.formatted}` });
    });
  }
  const out: string[] = [`whole files: ${files} files of ${values.corpus} in ${((performance.now() - started) / 1000).toFixed(1)} s, ${pairs.length} statements changed`];
  for (const [kind, title] of Object.entries(FILE_FAILURES) as [FileFailure, string][]) {
    if (kind === "meaning" && !values.clickhouse) continue;
    out.push(`  ${title}: ${fileFailures[kind].length}`);
    for (const f of fileFailures[kind].slice(0, examples)) out.push(`    ${f.file}${f.detail ? `  [${f.detail.split("\n")[0]!.slice(0, 160)}]` : ""}`);
  }
  fileLines.push(...out);
}

const lines: string[] = [];
for (const r of runs) {
  lines.push(`format() with keywordCase "${r.keywordCase}" over ${entries.length} valid statements of ${values.corpus ?? values.file} in ${r.seconds.toFixed(1)} s`);
  lines.push(`  left unchanged because check() rejects them: ${r.rejectedByCheck.length}`);
  lines.push(`  already formatted: ${r.unchanged}`);
  if (values.clickhouse) {
    lines.push(`  compared with ClickHouse: ${r.compared} (${r.notComparable} that formatQuerySingleLine cannot print)`);
    const share = ((r.keywordsRecased / Math.max(1, r.keywordsSeen)) * 100).toFixed(1);
    lines.push(`  words re-cased: ${r.recased} (${r.unknown} that highlightQuery does not cover); ClickHouse keywords re-cased: ${r.keywordsRecased} of ${r.keywordsSeen} (${share}%)`);
    const top = [...r.missed].sort((a, b) => b[1] - a[1]).slice(0, 20);
    if (top.length) lines.push(`  keywords left as written: ${top.map(([w, n]) => `${w} ${n}`).join(", ")}`);
  }
  for (const [kind, title] of Object.entries(FAILURES) as [Failure, string][]) {
    if (!values.clickhouse && (kind === "meaning" || kind === "unsafeKeyword")) continue;
    const list = r.failures[kind];
    lines.push(`  ${title}: ${list.length}`);
    for (const c of list.slice(0, examples)) {
      lines.push(`    ${c.file}:${c.line}${c.detail ? `  [${c.detail.split("\n")[0]!.slice(0, 160)}]` : ""}`);
      lines.push(`      ${c.sql.replace(/\s+/g, " ").slice(0, 200)}`);
    }
  }
}
console.log([...lines, ...fileLines].join("\n"));
mkdirSync(dirname(values.report), { recursive: true });
const json = runs.map((r) => ({
  keywordCase: r.keywordCase,
  rejectedByCheck: r.rejectedByCheck,
  failures: r.failures,
  keywordsLeftAsWritten: Object.fromEntries([...r.missedExamples].sort((a, b) => (r.missed.get(b[0]) ?? 0) - (r.missed.get(a[0]) ?? 0))),
}));
writeFileSync(values.report, JSON.stringify({ statements: entries.length, runs: json, files: fileFailures }, null, 2) + "\n");
console.log(`\nReport written to ${values.report}`);

if (values["update-sample"]) {
  // A fixed sample of verified statements, with comments and inline data well represented.
  const key = (sql: string): string => createHash("sha1").update(sql).digest("hex");
  const upper = runs.find((r) => r.keywordCase === "upper") ?? runs[0]!;
  const pool = [...upper.verified].map((i) => upper.formatted[i]!).sort((x, y) => (key(x.entry.sql) < key(y.entry.sql) ? -1 : 1));
  const pick = new Set([
    ...pool.slice(0, 300),
    ...pool.filter((f) => /--|\/\*/.test(f.entry.sql)).slice(0, 100),
    ...pool.filter((f) => /^\s*insert\b/i.test(f.entry.sql)).slice(0, 50),
  ]);
  const statements = [...pick].map((f) => ({ file: f.entry.file, line: f.entry.line, sql: f.entry.sql, formatted: f.text }));
  const note = `${SOURCE_NOTE} format() output confirmed with formatQuerySingleLine of ClickHouse ${await readVersion()}.`;
  mkdirSync(dirname(SAMPLE), { recursive: true });
  writeFileSync(SAMPLE, JSON.stringify({ note, statements }, null, 1) + "\n");
  console.log(`Wrote ${statements.length} verified statements to ${SAMPLE}`);
}

const failed = [
  ...runs.flatMap((r) =>
    (Object.entries(FAILURES) as [Failure, string][]).flatMap(([kind, title]) => (r.failures[kind].length > 0 ? [`${title} (${r.failures[kind].length}, ${r.keywordCase})`] : [])),
  ),
  ...(Object.entries(FILE_FAILURES) as [FileFailure, string][]).flatMap(([kind, title]) =>
    fileFailures[kind].length > 0 ? [`${title} (${fileFailures[kind].length}, whole files)`] : [],
  ),
];
if (failed.length > 0) console.log(`Failed: ${failed.join("; ")}`);
process.exit(failed.length > 0 ? 1 : 0);
