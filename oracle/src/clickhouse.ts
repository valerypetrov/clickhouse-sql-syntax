import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { sha1 } from "./extract.js";

/** What ClickHouse says about one statement. */
export interface Verdict {
  valid: boolean;
  /** For an invalid statement: ClickHouse's "failed at position N", a 1-based UTF-8 byte offset. */
  position?: number;
  /** For an invalid statement: the error text without the excerpt of the query. */
  message?: string;
}

export interface ClickHouseInfo {
  version: string;
  gitHash: string;
}

export interface ClassifyOptions {
  clickhouse: string;
  cacheDir: string;
  /** How many valid statements to confirm with `clickhouse format` as well. */
  formatCheck: number;
  /** Parallel ClickHouse processes, at most 4. */
  jobs: number;
  log: (line: string) => void;
}

export interface ClassifyResult {
  info: ClickHouseInfo;
  /** One entry per classified statement; statements that fail for other reasons are missing. */
  verdicts: Map<string, Verdict>;
  /** Statements left out, with the reason. */
  excluded: Map<string, string>;
  /** Valid statements that `clickhouse format` confirmed too. */
  formatChecked: number;
}

interface CacheRecord {
  h: string;
  v?: 0 | 1;
  p?: number;
  m?: string;
  /** Why the statement is left out. */
  x?: string;
  /** Exit code of `clickhouse format` for a valid statement. */
  f?: number;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const BULK_CHUNK = 5000;
// Code 48 means the query parsed but `clickhouse format` cannot print it, as for INSERT ... FORMAT CSV.
const PARSED_CODES = new Set([0, 48]);

function run(command: string, args: string[], input: string): Promise<RunResult> {
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

async function parallel<T>(items: readonly T[], jobs: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(jobs, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  });
  await Promise.all(workers);
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

export async function clickhouseInfo(clickhouse: string): Promise<ClickHouseInfo> {
  const query = "SELECT version(), (SELECT value FROM system.build_options WHERE name = 'GIT_HASH') FORMAT TSV";
  const result = await run(clickhouse, ["local", "-q", query], "");
  if (result.code !== 0) throw new Error(`cannot run ${clickhouse}: ${result.stderr.trim()}`);
  const [version = "", gitHash = ""] = result.stdout.trim().split("\t");
  return { version, gitHash };
}

/**
 * The error text of a syntax error without the part that quotes the query, for example
 * "Expected one of: ..." or "Unmatched parentheses: ...".
 */
export function errorSummary(message: string): string {
  const lexical = /^([^:]+): Syntax error/.exec(message);
  if (lexical) return lexical[1]!;
  const unmatched = message.lastIndexOf("Unmatched parentheses: ");
  if (unmatched !== -1) return message.slice(unmatched);
  const expected = message.lastIndexOf("Expected ");
  if (expected !== -1) {
    const before = message.slice(0, expected);
    const maybe = /Maybe you meant: [^.]*\. $/.exec(before);
    return message.slice(maybe ? maybe.index : expected);
  }
  // With nothing expected ClickHouse writes only where it failed, and the token there may hold a ")".
  return /^Syntax error(?: \([^)]*\))?: failed at position \d+ \(/.test(message) ? "Syntax error" : message;
}

/** Bulk check with formatQueryOrNull(); a chunk that fails as a whole is split until the culprit is found. */
async function classifyBulk(sqls: readonly string[], options: ClassifyOptions, valid: Map<string, boolean>, failed: Map<string, string>): Promise<void> {
  const args = ["local", "--implicit_select=0", "--input-format", "JSONEachRow", "--structure", "id UInt32, q String"];
  const query = "SELECT id, formatQueryOrNull(q) IS NOT NULL FROM table FORMAT TSV";
  const rows = sqls.map((q, id) => JSON.stringify({ id, q })).join("\n") + "\n";
  const result = await run(options.clickhouse, [...args, "-q", query], rows);
  if (result.code === 0) {
    const seen = new Set<number>();
    for (const line of result.stdout.split("\n")) {
      if (!line) continue;
      const [id, ok] = line.split("\t");
      seen.add(Number(id));
      valid.set(sqls[Number(id)]!, ok === "1");
    }
    if (seen.size !== sqls.length) throw new Error(`clickhouse local returned ${seen.size} of ${sqls.length} rows`);
    return;
  }
  if (sqls.length === 1) {
    const code = /Code: (\d+)/.exec(result.stderr)?.[1] ?? String(result.code);
    failed.set(sqls[0]!, `formatQueryOrNull failed with code ${code}`);
    return;
  }
  const half = Math.ceil(sqls.length / 2);
  await classifyBulk(sqls.slice(0, half), options, valid, failed);
  await classifyBulk(sqls.slice(half), options, valid, failed);
}

/** Runs `clickhouse format` on one statement: its exit code and, for a syntax error, where and why. */
async function format(sql: string, options: ClassifyOptions): Promise<{ code: number; position?: number; message?: string }> {
  const result = await run(options.clickhouse, ["format", "--quiet"], sql);
  if (result.code !== 62) return { code: result.code };
  const text = /DB::Exception: ([\s\S]*?)\. \(SYNTAX_ERROR\)/.exec(result.stderr)?.[1] ?? "";
  const position = /failed at position (\d+)/.exec(text)?.[1];
  return { code: 62, ...(position ? { position: Number(position) } : {}), message: errorSummary(text) };
}

/**
 * Asks ClickHouse whether each statement is valid and, if not, where it fails. Verdicts are
 * cached in `cacheDir`, one file per ClickHouse build.
 */
export async function classify(sqls: readonly string[], options: ClassifyOptions): Promise<ClassifyResult> {
  const info = await clickhouseInfo(options.clickhouse);
  mkdirSync(options.cacheDir, { recursive: true });
  const cacheFile = join(options.cacheDir, `verdicts-${info.version}-${info.gitHash.slice(0, 12) || "unknown"}.jsonl`);
  const cache = new Map<string, CacheRecord>();
  if (existsSync(cacheFile)) {
    for (const line of readFileSync(cacheFile, "utf8").split("\n")) {
      if (!line) continue;
      const record = JSON.parse(line) as CacheRecord;
      cache.set(record.h, { ...cache.get(record.h), ...record });
    }
  }
  let pending: string[] = [];
  const flush = (): void => {
    if (pending.length > 0) appendFileSync(cacheFile, pending.join(""));
    pending = [];
  };
  const remember = (record: CacheRecord): void => {
    cache.set(record.h, { ...cache.get(record.h), ...record });
    pending.push(JSON.stringify(record) + "\n");
    if (pending.length >= 1000) flush();
  };

  const unique = [...new Set(sqls)];
  const missing = unique.filter((sql) => !cache.has(sha1(sql)));
  options.log(`ClickHouse ${info.version}: ${unique.length - missing.length} of ${unique.length} statements cached`);
  if (missing.length > 0) {
    const valid = new Map<string, boolean>();
    const failed = new Map<string, string>();
    await parallel(chunks(missing, BULK_CHUNK), options.jobs, (chunk) => classifyBulk(chunk, options, valid, failed));
    for (const [sql, reason] of failed) remember({ h: sha1(sql), x: reason });
    for (const [sql, ok] of valid) remember({ h: sha1(sql), v: ok ? 1 : 0 });
    flush();
  }

  // Each rejected statement goes through `clickhouse format` for its exit code, position and message.
  const invalid = unique.filter((sql) => {
    const record = cache.get(sha1(sql))!;
    return record.v === 0 && record.m === undefined && record.x === undefined;
  });
  if (invalid.length > 0) options.log(`reading ${invalid.length} errors with clickhouse format`);
  let done = 0;
  await parallel(invalid, options.jobs, async (sql) => {
    const result = await format(sql, options);
    const h = sha1(sql);
    if (result.code === 62) {
      remember({ h, ...(result.position !== undefined ? { p: result.position } : {}), m: result.message ?? "" });
    } else if (PARSED_CODES.has(result.code)) {
      remember({ h, x: "formatQuery rejects it but clickhouse format accepts it" });
    } else {
      remember({ h, x: `clickhouse format exited with code ${result.code}` });
    }
    if (++done % 500 === 0) options.log(`  ${done} of ${invalid.length}`);
  });
  flush();

  // Confirm a fixed sample of the valid statements with `clickhouse format` as well.
  const sample = unique
    .filter((sql) => cache.get(sha1(sql))!.v === 1)
    .map((sql) => ({ sql, key: sha1(`format:${sql}`) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, options.formatCheck)
    .map(({ sql }) => sql);
  const toRun = sample.filter((sql) => cache.get(sha1(sql))!.f === undefined);
  if (toRun.length > 0) options.log(`confirming ${toRun.length} valid statements with clickhouse format`);
  await parallel(toRun, options.jobs, async (sql) => remember({ h: sha1(sql), f: (await format(sql, options)).code }));
  flush();

  const verdicts = new Map<string, Verdict>();
  const excluded = new Map<string, string>();
  for (const sql of unique) {
    const record = cache.get(sha1(sql))!;
    if (record.x !== undefined) {
      excluded.set(sql, record.x);
    } else if (record.f !== undefined && !PARSED_CODES.has(record.f)) {
      excluded.set(sql, `formatQuery accepts it but clickhouse format exited with code ${record.f}`);
    } else {
      verdicts.set(sql, {
        valid: record.v === 1,
        ...(record.p !== undefined ? { position: record.p } : {}),
        ...(record.m !== undefined ? { message: record.m } : {}),
      });
    }
  }
  return { info, verdicts, excluded, formatChecked: sample.length };
}
