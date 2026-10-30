// Opens a fixed sample of ClickHouse's test files as ClickHouse SQL and compares what VS Code shows with
// check(), format(), complete() and a real ClickHouse. Run it with npm run test:vscode:corpus.
import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { check, complete, type Diagnostic as SyntaxError, format, KEYWORDS } from "clickhouse-sql-syntax";
import * as vscode from "vscode";
import { classify, type ClickHouseInfo, type Verdict } from "../../../../oracle/src/clickhouse.js";
import { sameVerdict, verdictText } from "../../../../oracle/src/compare.js";
import { readCorpus } from "../../../../oracle/src/corpus.js";
import { expectsSyntaxError, sha1, usesOtherDialect } from "../../../../oracle/src/extract.js";
import { type Statement, splitStatements } from "../../../../oracle/src/split.js";

const LANGUAGE_ID = "clickhouse-sql";
const CORPUS = process.env.CLICKHOUSE_CORPUS!;
const CLICKHOUSE = process.env.CLICKHOUSE_BINARY!;
const ROOT = resolve(__dirname, "..", "..");
const REPORT = resolve(ROOT, "out", "corpus-report.json");
const CACHE_DIR = resolve(ROOT, ".vscode-test", "corpus", "verdicts");
/** The oracle's stored labels, which tell a version gap from a disagreement. */
const STORED_LABELS = resolve(ROOT, "..", "..", "oracle", "fixtures", "corpus.jsonl.gz");
/** Files taken in the hash order of their names, before pickFiles() adds more. */
const SAMPLE = 300;
/** Statements per file at whose middle and end completion is asked for, besides the end of the file. */
const COMPLETION_STATEMENTS = 3;
const WAIT_MS = 5000;

/** First words after which the second word tells the kind of statement too, as in CREATE TABLE. */
const LEADS = new Set(["ALTER", "ATTACH", "CREATE", "DESC", "DESCRIBE", "DETACH", "DROP", "EXCHANGE", "EXPLAIN", "RENAME", "SHOW", "SYSTEM", "UNDROP"]);
const KEYWORD_WORDS = new Set(KEYWORDS.flatMap((keyword) => keyword.split(" ")));

interface Problem {
  message: string;
  start: number;
  end: number;
  severity: vscode.DiagnosticSeverity;
  source?: string;
}

interface Visit {
  file: string;
  text: string;
  statements: Statement[];
  errors: SyntaxError[];
  expected: Problem[];
  published: Problem[];
  /** The text after Format Document. */
  formatted: string;
  /** What went wrong with semantic tokens and completion. */
  failures: string[];
  /** Places where completion was asked for. */
  completions: number;
}

/** The kind of a statement, such as SELECT or CREATE TABLE, when it starts with keywords. */
function kindOf(sql: string): string | undefined {
  const [first, second] = (/^[A-Za-z_]+(?:\s+[A-Za-z_]+)?/.exec(sql)?.[0] ?? "").toUpperCase().split(/\s+/);
  if (!first || !KEYWORD_WORDS.has(first)) return undefined;
  return LEADS.has(first) && second && KEYWORD_WORDS.has(second) ? `${first} ${second}` : first;
}

/** SAMPLE files in hash order, every file with an expected syntax error or CRLF line ends, and a file more for each kind of statement still missing. */
function pickFiles(): { files: string[]; kinds: number } {
  const all = readdirSync(CORPUS)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => ({ name, key: sha1(name), text: readFileSync(join(CORPUS, name), "utf8") }))
    // VS Code does not open a file with NUL bytes as text.
    .filter((file) => !usesOtherDialect(file.text) && !file.text.includes("\0"))
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map(({ name, text }) => ({ name, crlf: text.includes("\r\n"), statements: splitStatements(text) }));
  const kinds = (file: (typeof all)[number]): string[] => file.statements.flatMap((s) => kindOf(s.text) ?? []);
  const chosen = new Set(all.slice(0, SAMPLE).map((file) => file.name));
  for (const file of all) if (file.crlf || file.statements.some((s) => expectsSyntaxError(s.hints))) chosen.add(file.name);
  const covered = new Set(all.filter((file) => chosen.has(file.name)).flatMap(kinds));
  for (const file of all) {
    const missing = kinds(file).filter((kind) => !covered.has(kind));
    if (missing.length === 0) continue;
    chosen.add(file.name);
    missing.forEach((kind) => covered.add(kind));
  }
  return { files: [...chosen].sort(), kinds: covered.size };
}

function toProblem(error: SyntaxError): Problem {
  const severity = error.severity === "warning" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error;
  return { message: error.message, start: error.start, end: error.end, severity, source: "ClickHouse SQL" };
}

/** The diagnostics of `document`, once they equal `expected` or WAIT_MS has passed. */
async function published(document: vscode.TextDocument, expected: Problem[]): Promise<Problem[]> {
  const read = (): Problem[] =>
    vscode.languages.getDiagnostics(document.uri).map((d) => ({
      message: d.message,
      start: document.offsetAt(d.range.start),
      end: document.offsetAt(d.range.end),
      severity: d.severity,
      source: d.source,
    }));
  const deadline = Date.now() + WAIT_MS;
  let found = read();
  while (!isDeepStrictEqual(found, expected) && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 50));
    found = read();
  }
  return found;
}

/** The text that Format Document makes, with its edits applied to a copy so that the file stays as it is. */
async function formatDocument(document: vscode.TextDocument): Promise<string> {
  const options = { tabSize: 4, insertSpaces: true };
  const edits = await vscode.commands.executeCommand<vscode.TextEdit[] | undefined>("vscode.executeFormatDocumentProvider", document.uri, options);
  let text = document.getText();
  const offsets = (edits ?? []).map((edit) => ({ edit, from: document.offsetAt(edit.range.start), to: document.offsetAt(edit.range.end) }));
  for (const { edit, from, to } of offsets.sort((a, b) => b.from - a.from)) text = text.slice(0, from) + edit.newText + text.slice(to);
  return text;
}

/** Problems with the semantic tokens: none at all, tokens outside their line or over each other, or a range that disagrees. */
async function semanticTokenFailures(document: vscode.TextDocument): Promise<string[]> {
  const whole = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
  const full = await vscode.commands.executeCommand<vscode.SemanticTokens | undefined>("vscode.provideDocumentSemanticTokens", document.uri);
  const ranged = await vscode.commands.executeCommand<vscode.SemanticTokens | undefined>(
    "vscode.provideDocumentRangeSemanticTokens",
    document.uri,
    whole,
  );
  if (!full || !ranged) return ["no semantic tokens"];
  const failures: string[] = [];
  if (!isDeepStrictEqual([...full.data], [...ranged.data])) failures.push("the semantic tokens of the whole range differ from those of the document");
  let line = 0;
  let character = 0;
  let end = 0;
  // Each token is five numbers: line and start relative to the token before, length, type and modifiers.
  for (let i = 0; i < full.data.length; i += 5) {
    const deltaLine = full.data[i]!;
    const deltaStart = full.data[i + 1]!;
    const length = full.data[i + 2]!;
    line += deltaLine;
    character = deltaLine ? deltaStart : character + deltaStart;
    const text = line < document.lineCount ? document.lineAt(line).text : "";
    const piece = text.slice(character, character + length);
    if (length === 0 || piece.length !== length || !piece.trim() || (deltaLine === 0 && character < end)) {
      failures.push(`semantic token ${JSON.stringify(piece)} at ${line + 1}:${character + 1} does not fit`);
    }
    end = character + length;
  }
  return failures;
}

function label(item: vscode.CompletionItem): string {
  return typeof item.label === "string" ? item.label : item.label.label;
}

/** Offsets at the middle and end of a few statements spread over the file, and at its end. */
function completionOffsets(text: string, statements: Statement[]): number[] {
  const step = Math.max(1, Math.ceil(statements.length / COMPLETION_STATEMENTS));
  const picked = statements.filter((_, i) => i % step === 0);
  return [...picked.flatMap((s) => [s.start + (s.text.length >> 1), s.start + s.text.length]), text.length];
}

/** Places where the completion list of VS Code is not that of complete(). */
async function completionFailures(document: vscode.TextDocument, offsets: number[]): Promise<string[]> {
  const text = document.getText();
  const failures: string[] = [];
  for (const wanted of offsets) {
    const position = document.positionAt(wanted);
    const offset = document.offsetAt(position);
    const list = await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", document.uri, position);
    const found = list.items.filter((item) => item.kind !== vscode.CompletionItemKind.Text).map(label).sort();
    const expected = complete(text, offset).map((candidate) => candidate.label).sort();
    if (!isDeepStrictEqual(found, expected)) {
      failures.push(`completion at ${position.line + 1}:${position.character + 1} has ${found.length} items, complete() ${expected.length}`);
    }
  }
  return failures;
}

async function visit(file: string): Promise<Visit> {
  const opened = await vscode.workspace.openTextDocument(vscode.Uri.file(join(CORPUS, file)));
  const document = await vscode.languages.setTextDocumentLanguage(opened, LANGUAGE_ID);
  const text = document.getText();
  const statements = splitStatements(text);
  const errors = check(text);
  const expected = errors.map(toProblem);
  const offsets = completionOffsets(text, statements);
  return {
    file,
    text,
    statements,
    errors,
    expected,
    published: await published(document, expected),
    formatted: await formatDocument(document),
    failures: [...(await semanticTokenFailures(document)), ...(await completionFailures(document, offsets))],
    completions: offsets.length,
  };
}

/** The UTF-16 offset of a UTF-8 byte offset of `text`. */
function utf16Offset(text: string, bytes: number): number {
  let i = 0;
  for (let byte = 0; i < text.length && byte < bytes; ) {
    const c = text.codePointAt(i)!;
    byte += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    i += c > 0xffff ? 2 : 1;
  }
  return i;
}

/** A statement as the file has it, up to its closing ';', which changes what ClickHouse expects at its end. */
function asWritten(text: string, statement: Statement): string {
  const end = statement.start + statement.text.length;
  const semicolon = /^\s*;/.exec(text.slice(end, end + 1000));
  return text.slice(statement.start, end + (semicolon?.[0].length ?? 0));
}

/** The errors of check() that fall in each statement: from its start to the start of the next one. */
function errorsByStatement(visit: Visit): { inside: SyntaxError[][]; before: SyntaxError[] } {
  const inside = visit.statements.map((): SyntaxError[] => []);
  const before: SyntaxError[] = [];
  for (const error of visit.errors) {
    let index = -1;
    while (index + 1 < visit.statements.length && visit.statements[index + 1]!.start <= error.start) index++;
    (index < 0 ? before : inside[index]!).push(error);
  }
  return { inside, before };
}

/** Runs a command with `input` on its stdin. */
function run(command: string, args: string[], input: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(command, args);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", fail);
    child.on("close", (code) => done({ code: code ?? -1, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }));
    child.stdin.end(input);
  });
}

/** formatQuerySingleLineOrNull of ClickHouse for each pair of texts; a chunk that fails as a whole is split. */
async function singleLines(pairs: { a: string; b: string }[]): Promise<{ a: string | null; b: string | null }[]> {
  const query = "SELECT formatQuerySingleLineOrNull(a) AS a, formatQuerySingleLineOrNull(b) AS b FROM table FORMAT JSONEachRow";
  const args = ["local", "--implicit_select=0", "--input-format", "JSONEachRow", "--structure", "a String, b String", "-q", query];
  const ask = async (chunk: typeof pairs): Promise<{ a: string | null; b: string | null }[]> => {
    const answer = await run(CLICKHOUSE, args, chunk.map((pair) => JSON.stringify(pair)).join("\n") + "\n");
    if (answer.code === 0) return answer.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    if (chunk.length === 1) return [{ a: null, b: null }];
    const half = Math.ceil(chunk.length / 2);
    return [...(await ask(chunk.slice(0, half))), ...(await ask(chunk.slice(half)))];
  };
  const result = [];
  for (let i = 0; i < pairs.length; i += 5000) result.push(...(await ask(pairs.slice(i, i + 5000))));
  return result;
}

/** `clickhouse format --oneline` of a text, which keeps the inline data of an INSERT; null when it cannot print it. */
async function oneLine(sql: string): Promise<string | null> {
  const answer = await run(CLICKHOUSE, ["format", "--oneline"], sql);
  return answer.code === 0 ? answer.stdout.trim() : null;
}

/** ClickHouse's one-line form of each pair of texts, null when it cannot print one. */
async function oneLines(pairs: { a: string; b: string }[]): Promise<{ a: string | null; b: string | null }[]> {
  const answers = await singleLines(pairs);
  // formatQuerySingleLine leaves out the inline data of an INSERT, which clickhouse format prints as it is.
  const withData = answers.flatMap((answer, i) => (/^INSERT .* FORMAT \S+$/.test(answer.a ?? "") ? [i] : []));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < withData.length) {
      const i = withData[next++]!;
      answers[i] = { a: await oneLine(pairs[i]!.a), b: await oneLine(pairs[i]!.b) };
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return answers;
}

/** A message without the bracket positions in it, which count from where the client's query begins, comments included. */
function withoutPositions(message: string): string {
  return message.replace(/ at position \d+(?: \(line \d+, col \d+\))?/g, " at position N");
}

/** How check()'s first error in a statement disagrees with a verdict of ClickHouse, or "" when they agree. */
function disagreement(verdict: Verdict, statement: Statement, first: SyntaxError | undefined): string {
  if (verdict.valid) return first ? `valid for ClickHouse, check() says ${first.message}` : "";
  if (!first) return `check() accepts it, ClickHouse says ${verdict.message}`;
  if (verdict.position === undefined) return "";
  const at = utf16Offset(statement.text, verdict.position - 1);
  const offset = first.start - statement.start;
  if (offset === at && withoutPositions(first.message.replace(/\.$/, "")) === withoutPositions(verdict.message ?? "")) return "";
  return `ClickHouse fails at ${at}: ${verdict.message}; check() at ${offset}: ${first.message}`;
}

/** A failure as "file:line: what | the statement". */
function where(visit: Visit, statement: Statement | undefined, what: string): string {
  const sql = statement ? ` | ${statement.text.replace(/\s+/g, " ").slice(0, 150)}` : "";
  return `${visit.file}:${statement?.line ?? 1}: ${what}${sql}`;
}

/** Fails with the first few failures; the report keeps them all. */
function assertNone(failures: string[]): void {
  assert.ok(failures.length === 0, `${failures.length} failures, the first ones:\n${failures.slice(0, 10).join("\n")}`);
}

describe("ClickHouse test files in VS Code", () => {
  const visits: Visit[] = [];
  let labels = new Map<string, Verdict>();
  let clickhouse: ClickHouseInfo = { version: "", gitHash: "" };
  const report: Record<string, unknown> = {};

  before(async () => {
    await vscode.extensions.getExtension("valerypetrov.clickhouse-sql")!.activate();
    const { files, kinds } = pickFiles();
    const sqls = files.flatMap((file) => {
      const text = readFileSync(join(CORPUS, file), "utf8");
      return splitStatements(text).map((statement) => asWritten(text, statement));
    });
    const labelled = await classify(sqls, { clickhouse: CLICKHOUSE, cacheDir: CACHE_DIR, formatCheck: 0, jobs: 4, log: (line) => console.log(line) });
    labels = labelled.verdicts;
    clickhouse = labelled.info;
    const started = Date.now();
    for (const file of files) visits.push(await visit(file));
    const seconds = (Date.now() - started) / 1000;
    Object.assign(report, { clickhouse: labelled.info, files: files.length, kinds, statements: sqls.length, seconds });
    console.log(`${files.length} files, ${sqls.length} statements of ${kinds} kinds, ${labels.size} labelled by ClickHouse ${labelled.info.version}; visited in ${seconds} s`);
  });

  after(() => {
    writeFileSync(REPORT, JSON.stringify(report, null, 2) + "\n");
    console.log(`report: ${REPORT}`);
  });

  it("publishes the diagnostics of check() for every file", () => {
    const failures = visits.flatMap((v) => {
      const i = v.expected.findIndex((e, k) => !isDeepStrictEqual(e, v.published[k]));
      const at = i < 0 ? v.expected.length : i;
      if (i < 0 && v.published.length === v.expected.length) return [];
      return [where(v, undefined, `diagnostic ${at + 1} is ${JSON.stringify(v.published[at])}, check() gives ${JSON.stringify(v.expected[at])}`)];
    });
    const diagnostics = visits.reduce((n, v) => n + v.expected.length, 0);
    report.diagnostics = { diagnostics, failures };
    console.log(`diagnostics: ${diagnostics} in ${visits.length} files; ${failures.length} files differ from check()`);
    assertNone(failures);
  });

  it("agrees with ClickHouse on every statement, apart from version gaps", async () => {
    const failures: string[] = [];
    const suspects: { visit: Visit; statement: Statement; first: SyntaxError | undefined; problem: string }[] = [];
    const counts = { statements: 0, invalid: 0, positioned: 0, expectedErrors: 0, expectedErrorsReported: 0 };
    for (const visit of visits) {
      const { inside, before } = errorsByStatement(visit);
      for (const error of before) failures.push(where(visit, undefined, `an error before the first statement: ${error.message}`));
      visit.statements.forEach((statement, i) => {
        const verdict = labels.get(asWritten(visit.text, statement));
        if (!verdict) return;
        const first = inside[i]![0];
        counts.statements++;
        if (expectsSyntaxError(statement.hints)) {
          counts.expectedErrors++;
          if (first) counts.expectedErrorsReported++;
        }
        if (!verdict.valid) counts.invalid++;
        if (!verdict.valid && first && verdict.position !== undefined) counts.positioned++;
        const problem = disagreement(verdict, statement, first);
        if (problem) suspects.push({ visit, statement, first, problem });
      });
    }
    // A version gap: the build of the stored labels reads the statement as check() does, and this build reads it otherwise.
    const stored = readCorpus(STORED_LABELS);
    const reference = new Map(stored.header.gitHash === clickhouse.gitHash ? [] : stored.entries.map((e) => [e.sql, e]));
    const bare = suspects.filter((s) => reference.has(s.statement.text)).map((s) => s.statement.text);
    const options = { clickhouse: CLICKHOUSE, cacheDir: CACHE_DIR, formatCheck: 0, jobs: 4, log: () => {} };
    const live = bare.length > 0 ? (await classify(bare, options)).verdicts : new Map<string, Verdict>();
    const versionGaps: string[] = [];
    for (const { visit, statement, first, problem } of suspects) {
      const ref = reference.get(statement.text);
      const now = live.get(statement.text);
      if (ref && now && !sameVerdict(ref, now) && !disagreement(ref, statement, first)) {
        const verdicts = `${clickhouse.version}: ${verdictText(now, statement.text)}; ${stored.header.clickhouse}: ${verdictText(ref, statement.text)}`;
        versionGaps.push(where(visit, statement, `version gap, ${verdicts}`));
      } else {
        failures.push(where(visit, statement, problem));
      }
    }
    report.oracle = { ...counts, failures, versionGaps };
    console.log(
      `oracle: ${counts.statements} statements, ${counts.invalid} invalid for ClickHouse (${counts.positioned} with a position); ` +
        `${failures.length} disagreements and ${versionGaps.length} version gaps; ` +
        `${counts.expectedErrorsReported} of ${counts.expectedErrors} expected syntax errors reported`,
    );
    for (const gap of versionGaps) console.log(`  ${gap}`);
    assertNone(failures);
  });

  it("formats every file as format() does, with the same errors and the same queries for ClickHouse", async () => {
    const failures: string[] = [];
    const pairs: { visit: Visit; statement: Statement; a: string; b: string }[] = [];
    for (const visit of visits) {
      if (visit.formatted !== format(visit.text)) failures.push(where(visit, undefined, "Format Document differs from format()"));
      const before = visit.errors.map((e) => e.message);
      const after = check(visit.formatted).map((e) => e.message);
      if (!isDeepStrictEqual(after, before)) {
        failures.push(where(visit, undefined, `${before.length} errors before formatting, ${after.length} after: ${after.find((m, i) => m !== before[i])}`));
      }
      const formatted = splitStatements(visit.formatted);
      if (formatted.length !== visit.statements.length) {
        failures.push(where(visit, undefined, `${visit.statements.length} statements before formatting, ${formatted.length} after`));
        continue;
      }
      const { inside } = errorsByStatement(visit);
      visit.statements.forEach((statement, i) => {
        const b = formatted[i]!.text;
        const valid = labels.get(asWritten(visit.text, statement))?.valid && inside[i]!.length === 0;
        if (valid && b !== statement.text) pairs.push({ visit, statement, a: statement.text, b });
      });
    }
    const answers = await oneLines(pairs.map(({ a, b }) => ({ a, b })));
    let unprintable = 0;
    pairs.forEach(({ visit, statement, b }, i) => {
      const answer = answers[i]!;
      if (answer.a === null && answer.b === null) unprintable++;
      else if (answer.a !== answer.b) {
        failures.push(where(visit, statement, `ClickHouse reads it differently after formatting: ${b.replace(/\s+/g, " ").slice(0, 150)}`));
      }
    });
    report.format = { changedStatements: pairs.length, unprintable, failures };
    console.log(`format: ${pairs.length} statements changed, ${pairs.length - unprintable} of them compared with ClickHouse; ${failures.length} failures`);
    assertNone(failures);
  });

  it("gives semantic tokens and completion on every file", () => {
    const failures = visits.flatMap((v) => v.failures.map((failure) => where(v, undefined, failure)));
    const completions = visits.reduce((n, v) => n + v.completions, 0);
    report.tools = { completions, failures };
    console.log(`semantic tokens of ${visits.length} files and completion at ${completions} places; ${failures.length} failures`);
    assertNone(failures);
  });
});
