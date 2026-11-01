// Renames the names of ClickHouse's own test statements and checks with clickhouse local that each query
// gives the same result, as `npm run oracle:rename -- --help` describes.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

import { isSignificant, ParseCache, prepareRename, references, rename, type TextEdit, type Token, TokenKind, tokenize } from "clickhouse-sql-syntax";

import { extractCorpus } from "./extract.js";
import { integerOption } from "./paths.js";

const USAGE = `Usage: npm run oracle:rename -w oracle -- --clickhouse <binary> --corpus <dir> [options]

Takes the SELECT statements of the tests that run in an empty clickhouse local, renames each name that
rename() accepts to a fresh one, runs the original and the renamed query, and reports every difference.

Options:
  --clickhouse <binary> the ClickHouse binary
  --corpus <dir>        tests/queries/0_stateless of a ClickHouse checkout
  --report <file>       where to write the JSON report (default: out/rename-report.json)
  --limit <n>           at most this many statements (default: all)
  --names <n>           at most this many names of one statement, evenly spaced (default: 100)
  --match <text>        only statements of files whose name contains this text
  --jobs <n>            parallel ClickHouse processes, 1 to 4 (default: 4)`;

const { values } = parseArgs({
  options: {
    clickhouse: { type: "string" },
    corpus: { type: "string" },
    report: { type: "string", default: new URL("../out/rename-report.json", import.meta.url).pathname },
    limit: { type: "string", default: "0" },
    names: { type: "string", default: "100" },
    match: { type: "string", default: "" },
    jobs: { type: "string", default: "4" },
    help: { type: "boolean", default: false },
  },
});
if (values.help || !values.clickhouse || !values.corpus) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 2);
}
const clickhouse = values.clickhouse;
const jobs = Math.min(4, integerOption(values.jobs, "--jobs", 1));

interface Run {
  ok: boolean;
  output: string;
}

const MAX_OUTPUT = 4_000_000;

/** Runs one query in a fresh clickhouse local with one thread, so that the order of rows is the same each time. */
function runQuery(sql: string): Promise<Run> {
  return new Promise((resolve) => {
    const args = ["local", "--max_threads", "1", "--max_execution_time", "20", "--max_memory_usage", "2000000000", "--format", "TSV", "--query", sql];
    const child = spawn(clickhouse, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) child.kill("SIGKILL");
      else out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("close", (code) => {
      clearTimeout(timer);
      const ok = code === 0 && size <= MAX_OUTPUT;
      resolve({ ok, output: ok ? Buffer.concat(out).toString("utf8") : Buffer.concat(err).toString("utf8").slice(0, 2000) });
    });
  });
}

async function parallel<T>(items: readonly T[], work: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(jobs, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await work(items[index]!, index);
    }
  });
  await Promise.all(workers);
}

const significant = (sql: string): Token[] => tokenize(sql).filter((token) => isSignificant(token.kind));

/**
 * Whether a statement may run without tables of the user: a SELECT without output options, expected errors or
 * the tables that hold the text of queries, which a rename changes.
 */
function candidate(sql: string, hints: string[]): boolean {
  if (hints.some((hint) => /Error/.test(hint))) return false;
  if (/\bsystem\s*\.\s*(processes|query_log|query_thread_log|query_views_log|text_log)\b/i.test(sql)) return false;
  const tokens = significant(sql);
  const first = tokens[0];
  if (!first) return false;
  const head = sql.slice(first.start, first.end).toUpperCase();
  if (head !== "SELECT" && head !== "WITH" && first.kind !== TokenKind.OpeningRoundBracket) return false;
  for (const token of tokens) {
    if (token.kind !== TokenKind.BareWord) continue;
    const word = sql.slice(token.start, token.end).toUpperCase();
    if (word === "FORMAT" || word === "OUTFILE" || word === "EXPLAIN") return false;
  }
  return true;
}

function applyEdits(sql: string, edits: TextEdit[]): string {
  let result = "";
  let at = 0;
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    result += sql.slice(at, edit.start) + edit.newText;
    at = edit.end;
  }
  return result + sql.slice(at);
}

/** A name that the statement does not contain in any case. */
function freshName(sql: string, n: number, spaced: boolean): string {
  const lower = sql.toLowerCase();
  for (let i = n; ; i++) {
    const name = spaced ? `r${i} x` : `r${i}_n`;
    if (!lower.includes(name.toLowerCase())) return name;
  }
}

/** The token check: only the edited words differ, each one was the old name and became the new one. */
function onlyRenamed(before: string, after: string, edits: TextEdit[], oldName: string, newName: string): string {
  const a = significant(before);
  const b = significant(after);
  if (a.length !== b.length) return `the renamed query has ${b.length} tokens, the original ${a.length}`;
  const edited = new Set(edits.map((edit) => edit.start));
  // Quotes doubled or escaped with a backslash, as ClickHouse reads them.
  const unquote = (sql: string, token: Token): string => {
    const text = sql.slice(token.start, token.end);
    if (token.kind !== TokenKind.QuotedIdentifier) return text;
    const mark = text[0]!;
    return text.slice(1, -1).replaceAll(mark + mark, mark).replace(/\\(.)/g, "$1");
  };
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    const same = before.slice(x.start, x.end) === after.slice(y.start, y.end);
    if (edited.has(x.start)) {
      if (unquote(before, x) !== oldName) return `an edited word at ${x.start} was ${before.slice(x.start, x.end)}`;
      if (unquote(after, y) !== newName) return `an edited word at ${x.start} became ${after.slice(y.start, y.end)}`;
    } else if (!same) {
      return `the word at ${x.start} changed from ${before.slice(x.start, x.end)} to ${after.slice(y.start, y.end)}`;
    }
  }
  return "";
}

interface Rename {
  name: string;
  kind: string;
  newName: string;
  sql: string;
  edits: number;
  tokenCheck: string;
}

interface Mismatch {
  file: string;
  line: number;
  name: string;
  newName: string;
  original: string;
  renamed: string;
  reason: string;
  expected?: string;
  actual?: string;
}

const extracted = extractCorpus(values.corpus, { maxLength: 100_000 });
let statements = extracted.statements.filter((s) => (!values.match || s.file.includes(values.match)) && candidate(s.sql, s.hints));
const limit = integerOption(values.limit, "--limit");
if (limit) statements = statements.slice(0, limit);
console.error(`${extracted.statements.length} statements in ${extracted.files} files; ${statements.length} SELECTs to try`);

const counts = {
  candidates: statements.length,
  ran: 0,
  failedAlone: 0,
  nondeterministic: 0,
  withNames: 0,
  names: 0,
  renamed: 0,
  refused: 0,
  renameErrors: 0,
  same: 0,
  mismatches: 0,
  /** Names left out of statements with more than --names of them. */
  namesOverCap: 0,
};
const maxNames = integerOption(values.names, "--names", 1);
const refusals = new Map<string, number>();
const renameErrors: { file: string; line: number; name: string; error: string }[] = [];
const mismatches: Mismatch[] = [];
const kinds = new Map<string, number>();
const started = Date.now();
let done = 0;

/** The definitions of a statement: every word that prepareRename() accepts, by the place it is defined. */
function namesOf(sql: string, cache: ParseCache): { offset: number; name: string; kind: string; places: number[] }[] {
  const found = new Map<number, { offset: number; name: string; kind: string; places: number[] }>();
  for (const token of significant(sql)) {
    if (token.kind !== TokenKind.BareWord && token.kind !== TokenKind.QuotedIdentifier) continue;
    const prepared = prepareRename(sql, token.start, { cache });
    const places = references(sql, token.start, { cache });
    const site = places.find((place) => place.definition);
    if (prepared.error !== undefined) {
      if (site) {
        const reason = prepared.error.replace(/`[^`]*`/g, "`x`").replace(/^\S+ (is|names|joins)/, "x $1");
        if (site.start === token.start) refusals.set(reason, (refusals.get(reason) ?? 0) + 1);
      }
      continue;
    }
    if (!site || found.has(site.start)) continue;
    const kind = sql.slice(Math.max(0, site.start - 1), site.start) === "{" ? "query parameter" : "name";
    found.set(site.start, { offset: token.start, name: prepared.name, kind, places: places.map((place) => place.start) });
  }
  return [...found.values()];
}

await parallel(statements, async (statement) => {
  const { sql, file, line } = statement;
  const cache = new ParseCache();
  let names: ReturnType<typeof namesOf>;
  try {
    names = namesOf(sql, cache);
  } catch (error) {
    mismatches.push({ file, line, name: "", newName: "", original: sql, renamed: "", reason: `analysis threw: ${(error as Error).stack}` });
    counts.mismatches++;
    return;
  }
  done++;
  if (done % 500 === 0) {
    console.error(`${done} of ${statements.length} after ${Math.round((Date.now() - started) / 1000)} s`);
    writeReport();
  }
  const renames: Rename[] = [];
  const all = names.length;
  if (all > maxNames) names = Array.from({ length: maxNames }, (_, k) => names[Math.floor((k * all) / maxNames)]!);
  const capped = all - names.length;
  names.forEach((item, n) => {
    for (const spaced of n % 7 === 3 ? [false, true] : [false]) {
      if (spaced && item.kind === "query parameter") continue;
      const newName = freshName(sql, n + 1, spaced);
      const result = rename(sql, item.offset, newName, { cache });
      if (result.error !== undefined) {
        counts.renameErrors++;
        renameErrors.push({ file, line, name: item.name, error: result.error });
        continue;
      }
      const renamed = applyEdits(sql, result.edits);
      const starts = result.edits.map((edit) => edit.start).sort((a, b) => a - b);
      const tokenCheck = starts.join(",") === [...item.places].sort((a, b) => a - b).join(",") ? onlyRenamed(sql, renamed, result.edits, item.name, newName) : "the edits are not the references";
      renames.push({ name: item.name, kind: item.kind, newName, sql: renamed, edits: result.edits.length, tokenCheck });
    }
  });
  if (!renames.length) return;
  const original = await runQuery(sql);
  if (!original.ok) {
    counts.failedAlone++;
    return;
  }
  const again = await runQuery(sql);
  if (!again.ok || again.output !== original.output) {
    counts.nondeterministic++;
    return;
  }
  counts.ran++;
  counts.withNames++;
  counts.names += names.length;
  counts.namesOverCap += capped;
  for (const item of renames) {
    counts.renamed++;
    kinds.set(item.kind, (kinds.get(item.kind) ?? 0) + 1);
    if (item.tokenCheck) {
      counts.mismatches++;
      mismatches.push({ file, line, name: item.name, newName: item.newName, original: sql, renamed: item.sql, reason: `token check: ${item.tokenCheck}` });
      continue;
    }
    const result = await runQuery(item.sql);
    if (!result.ok) {
      counts.mismatches++;
      mismatches.push({ file, line, name: item.name, newName: item.newName, original: sql, renamed: item.sql, reason: "the renamed query fails", actual: result.output });
    } else if (result.output !== original.output) {
      counts.mismatches++;
      mismatches.push({ file, line, name: item.name, newName: item.newName, original: sql, renamed: item.sql, reason: "the result differs", expected: original.output.slice(0, 2000), actual: result.output.slice(0, 2000) });
    } else {
      counts.same++;
    }
  }
});

function writeReport(): void {
  const report = {
    clickhouse,
    corpus: values.corpus,
    seconds: Math.round((Date.now() - started) / 1000),
    statementsDone: done,
    counts,
    refusals: Object.fromEntries([...refusals].sort((a, b) => b[1] - a[1])),
    renameErrors,
    mismatches,
  };
  mkdirSync(dirname(values.report!), { recursive: true });
  writeFileSync(values.report!, JSON.stringify(report, null, 2) + "\n");
}

writeReport();
console.log(`${counts.candidates} SELECTs tried: ${counts.ran} run alone with names to rename (${counts.failedAlone} need what an empty clickhouse local lacks, ${counts.nondeterministic} give different results each run)`);
console.log(`${counts.names} names in them (${counts.namesOverCap} more left out over --names), ${counts.renamed} renames run: ${counts.same} give the same result, ${counts.mismatches} mismatches; ${counts.renameErrors} renames refused by the check`);
console.log(`Refusals by prepareRename(): ${[...refusals].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([reason, n]) => `${n} ${reason}`).join("; ")}`);
for (const mismatch of mismatches.slice(0, 20)) console.log(`\n${mismatch.file}:${mismatch.line} ${mismatch.name} -> ${mismatch.newName}: ${mismatch.reason}\n  ${mismatch.original.slice(0, 300)}\n  ${mismatch.renamed.slice(0, 300)}`);
console.log(`\nReport written to ${values.report}`);
