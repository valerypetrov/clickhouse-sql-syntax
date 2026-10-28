import { performance } from "node:perf_hooks";

import type { Diagnostic } from "clickhouse-sql-syntax";

import type { Corpus, Entry } from "./corpus.js";
import { expectsSyntaxError } from "./extract.js";
import { isSignificant, lex } from "./lexer.js";

export type CheckFunction = (sql: string) => Diagnostic[];

export interface Metrics {
  statements: number;
  valid: number;
  invalid: number;
  validAccepted: number;
  validRejected: number;
  validThrew: number;
  invalidRejected: number;
  invalidAccepted: number;
  invalidThrew: number;
  /** Share of statements where check() and ClickHouse agree on valid or invalid. */
  verdictAgreement: number;
  /** Share of valid statements that check() accepts. */
  validAcceptedRate: number;
  /** Share of invalid statements that check() rejects. */
  invalidRejectedRate: number;
  /** Of the statements both reject at a known position, the share where the first diagnostic starts there. */
  positionMatch: number;
  positionCompared: number;
  /** Of the same statements, the share where the first message equals ClickHouse's. */
  messageMatch: number;
  /** Statements marked clientError SYNTAX_ERROR in the tests. */
  expectedErrors: number;
  expectedErrorsClickHouseRejects: number;
  expectedErrorsCheckRejects: number;
  seconds: number;
}

interface Case {
  file: string;
  line: number;
  mutation?: string;
  sql: string;
}

/** The most common statement kinds and error signatures of a list of cases, with counts. */
export interface Group {
  byKeyword: [string, number][];
  bySignature: [string, number][];
}

export interface Report {
  clickhouse: string;
  corpus: string;
  metrics: Metrics;
  falsePositives: (Case & { message: string; start: number })[];
  falseNegatives: (Case & { clickhouseMessage?: string; clickhouseOffset?: number })[];
  positionMismatches: (Case & { clickhouseOffset: number; clickhouseMessage?: string; start: number; message: string })[];
  thrown: (Case & { error: string })[];
  groups: Record<"falsePositives" | "falseNegatives" | "positionMismatches", Group>;
  slowest: (Case & { ms: number })[];
}

const MAX_THROWN_CASES = 100;
const TWO_WORD_STATEMENTS = new Set(["ALTER", "ATTACH", "CREATE", "DETACH", "DROP", "EXPLAIN", "SHOW", "SYSTEM"]);

/** The UTF-16 offset of a 1-based UTF-8 byte position, as ClickHouse reports it. */
export function utf16Offset(sql: string, position: number): number {
  return Buffer.from(sql, "utf8").subarray(0, position - 1).toString("utf8").length;
}

/** The leading keyword of a statement, with the second word for statements like CREATE TABLE. */
export function statementKind(sql: string): string {
  const words = lex(sql).filter(isSignificant).slice(0, 2);
  const first = words[0];
  if (!first) return "(empty)";
  const head = sql.slice(first.start, first.end).toUpperCase();
  if (first.kind !== "word") return head;
  const second = words[1];
  if (TWO_WORD_STATEMENTS.has(head) && second?.kind === "word") return `${head} ${sql.slice(second.start, second.end).toUpperCase()}`;
  return head;
}

/** A short form of an error message for grouping: numbers and quoted text are blanked. */
export function signature(message: string): string {
  const short = message.replace(/'[^']*'|`[^`]*`|"[^"]*"/g, "'…'").replace(/\d+/g, "N");
  return short.length > 80 ? `${short.slice(0, 79)}…` : short;
}

function ratio(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

function top(values: string[], limit = 15): [string, number][] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, limit);
}

function asCase(entry: Entry): Case {
  return { file: entry.file, line: entry.line, ...(entry.mutation ? { mutation: entry.mutation } : {}), sql: entry.sql };
}

function first(diagnostics: Diagnostic[]): Diagnostic {
  return diagnostics.reduce((a, b) => (b.start < a.start ? b : a));
}

/** Runs check() on every statement of the corpus and compares it with ClickHouse. */
export function compare(corpus: Corpus, check: CheckFunction, corpusName: string): Report {
  const falsePositives: Report["falsePositives"] = [];
  const falseNegatives: Report["falseNegatives"] = [];
  const positionMismatches: Report["positionMismatches"] = [];
  const thrown: Report["thrown"] = [];
  const m = {
    validAccepted: 0, validRejected: 0, validThrew: 0, invalidRejected: 0, invalidAccepted: 0, invalidThrew: 0,
    positionCompared: 0, positionMatched: 0, messageMatched: 0,
    expectedErrors: 0, expectedErrorsClickHouseRejects: 0, expectedErrorsCheckRejects: 0,
  };
  const timings: { entry: Entry; ms: number }[] = [];
  const started = performance.now();

  for (const entry of corpus.entries) {
    let diagnostics: Diagnostic[] | undefined;
    let error = "";
    const t0 = performance.now();
    try {
      diagnostics = check(entry.sql);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    timings.push({ entry, ms: performance.now() - t0 });
    const rejected = diagnostics !== undefined && diagnostics.length > 0;

    if (entry.hints && expectsSyntaxError(entry.hints)) {
      m.expectedErrors++;
      if (!entry.valid) m.expectedErrorsClickHouseRejects++;
      if (rejected) m.expectedErrorsCheckRejects++;
    }
    if (diagnostics === undefined) {
      if (entry.valid) m.validThrew++;
      else m.invalidThrew++;
      if (thrown.length < MAX_THROWN_CASES) thrown.push({ ...asCase(entry), error });
      continue;
    }
    if (entry.valid) {
      if (!rejected) {
        m.validAccepted++;
      } else {
        m.validRejected++;
        const d = first(diagnostics);
        falsePositives.push({ ...asCase(entry), message: d.message, start: d.start });
      }
      continue;
    }
    const offset = entry.position === undefined ? undefined : utf16Offset(entry.sql, entry.position);
    const clickhouse = {
      ...(entry.message !== undefined ? { clickhouseMessage: entry.message } : {}),
      ...(offset !== undefined ? { clickhouseOffset: offset } : {}),
    };
    if (!rejected) {
      m.invalidAccepted++;
      falseNegatives.push({ ...asCase(entry), ...clickhouse });
      continue;
    }
    m.invalidRejected++;
    if (offset === undefined) continue;
    const d = first(diagnostics);
    m.positionCompared++;
    if (d.message === entry.message) m.messageMatched++;
    if (d.start === offset) m.positionMatched++;
    else positionMismatches.push({ ...asCase(entry), ...clickhouse, clickhouseOffset: offset, start: d.start, message: d.message });
  }

  const valid = m.validAccepted + m.validRejected + m.validThrew;
  const invalid = m.invalidAccepted + m.invalidRejected + m.invalidThrew;
  const metrics: Metrics = {
    statements: corpus.entries.length,
    valid,
    invalid,
    validAccepted: m.validAccepted,
    validRejected: m.validRejected,
    validThrew: m.validThrew,
    invalidRejected: m.invalidRejected,
    invalidAccepted: m.invalidAccepted,
    invalidThrew: m.invalidThrew,
    verdictAgreement: ratio(m.validAccepted + m.invalidRejected, corpus.entries.length),
    validAcceptedRate: ratio(m.validAccepted, valid),
    invalidRejectedRate: ratio(m.invalidRejected, invalid),
    positionMatch: ratio(m.positionMatched, m.positionCompared),
    positionCompared: m.positionCompared,
    messageMatch: ratio(m.messageMatched, m.positionCompared),
    expectedErrors: m.expectedErrors,
    expectedErrorsClickHouseRejects: m.expectedErrorsClickHouseRejects,
    expectedErrorsCheckRejects: m.expectedErrorsCheckRejects,
    seconds: (performance.now() - started) / 1000,
  };
  const group = <T extends Case>(cases: T[], message: (c: T) => string): Group => ({
    byKeyword: top(cases.map((c) => statementKind(c.sql))),
    bySignature: top(cases.map((c) => signature(message(c)))),
  });
  const slowest = timings
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 10)
    .map(({ entry, ms }) => ({ ...asCase(entry), ms: Math.round(ms * 10) / 10 }));
  return {
    clickhouse: corpus.header.clickhouse,
    corpus: corpusName,
    metrics,
    falsePositives,
    falseNegatives,
    positionMismatches,
    thrown,
    groups: {
      falsePositives: group(falsePositives, (c) => c.message),
      falseNegatives: group(falseNegatives, (c) => c.clickhouseMessage ?? "(no message)"),
      positionMismatches: group(positionMismatches, (c) => c.clickhouseMessage ?? "(no message)"),
    },
    slowest,
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function short(sql: string, width = 110): string {
  const flat = sql.replace(/\s+/g, " ");
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
}

function where(c: Case): string {
  return `${c.file}:${c.line}${c.mutation ? ` (${c.mutation})` : ""}`;
}

/** The report as text for the terminal. */
export function formatReport(report: Report, examples: number): string {
  const m = report.metrics;
  const out: string[] = [];
  const row = (label: string, a: number, b: number, c: number): string =>
    `  ${label.padEnd(20)}${String(a).padStart(12)}${String(b).padStart(12)}${String(c).padStart(12)}`;
  out.push(`ClickHouse ${report.clickhouse}, ${report.corpus}: ${m.statements} statements, check() took ${m.seconds.toFixed(1)} s`);
  out.push("");
  out.push(`  ${"".padEnd(20)}${"accepted".padStart(12)}${"rejected".padStart(12)}${"threw".padStart(12)}`);
  out.push(row(`ClickHouse valid`, m.validAccepted, m.validRejected, m.validThrew));
  out.push(row(`ClickHouse invalid`, m.invalidAccepted, m.invalidRejected, m.invalidThrew));
  out.push("");
  out.push(`  verdict agreement      ${percent(m.verdictAgreement)}`);
  out.push(`  valid accepted         ${percent(m.validAcceptedRate)} of ${m.valid}`);
  out.push(`  invalid rejected       ${percent(m.invalidRejectedRate)} of ${m.invalid}`);
  out.push(`  error position match   ${percent(m.positionMatch)} of ${m.positionCompared}`);
  out.push(`  error message match    ${percent(m.messageMatch)} of ${m.positionCompared}`);
  out.push(
    `  clientError SYNTAX_ERROR statements: ${m.expectedErrors}, ClickHouse rejects ${m.expectedErrorsClickHouseRejects}, check() rejects ${m.expectedErrorsCheckRejects}`,
  );

  const section = (title: string, group: Group, cases: string[]): void => {
    if (cases.length === 0) return;
    out.push("", title);
    out.push("  by statement:");
    for (const [key, n] of group.byKeyword) out.push(`    ${String(n).padStart(6)}  ${key}`);
    out.push("  by error:");
    for (const [key, n] of group.bySignature) out.push(`    ${String(n).padStart(6)}  ${key}`);
    out.push("  examples:");
    for (const line of cases.slice(0, examples)) out.push(`    ${line}`);
  };
  section(
    `False positives, valid SQL that check() rejects (${report.falsePositives.length}):`,
    report.groups.falsePositives,
    report.falsePositives.map((c) => `${where(c)}: ${short(c.sql)}\n      -> ${short(c.message)}`),
  );
  section(
    `False negatives, invalid SQL that check() accepts (${report.falseNegatives.length}):`,
    report.groups.falseNegatives,
    report.falseNegatives.map((c) => `${where(c)}: ${short(c.sql)}\n      ClickHouse at ${c.clickhouseOffset ?? "?"}: ${short(c.clickhouseMessage ?? "")}`),
  );
  section(
    `Errors at another position (${report.positionMismatches.length}):`,
    report.groups.positionMismatches,
    report.positionMismatches.map(
      (c) => `${where(c)}: ${short(c.sql)}\n      ClickHouse at ${c.clickhouseOffset}, check() at ${c.start}: ${short(c.message, 80)}`,
    ),
  );
  if (report.thrown.length > 0) {
    out.push("", `check() threw on ${m.validThrew + m.invalidThrew} statements, for example:`);
    for (const c of report.thrown.slice(0, Math.min(examples, 3))) out.push(`    ${where(c)}: ${short(c.sql, 60)}\n      -> ${c.error}`);
  }
  out.push("", "Slowest statements:");
  for (const c of report.slowest.slice(0, 5)) out.push(`  ${String(c.ms).padStart(8)} ms  ${where(c)}: ${short(c.sql, 70)}`);
  return out.join("\n");
}
