import assert from "node:assert/strict";
import { test } from "node:test";

import type { Diagnostic } from "clickhouse-sql-syntax";

import { errorSummary } from "../src/clickhouse.js";
import { compare, formatReport, signature, statementKind, utf16Offset } from "../src/compare.js";
import type { Corpus, Entry } from "../src/corpus.js";

function corpusOf(entries: Omit<Entry, "file" | "line">[]): Corpus {
  return {
    header: { clickhouse: "test", gitHash: "", source: "", note: "", statements: entries.length, mutations: 0 },
    entries: entries.map((e, i) => ({ file: "t.sql", line: i + 1, ...e })),
  };
}

function error(start: number, message = "Expected end of query"): Diagnostic {
  return { message, start, end: start + 1, line: 1, col: start + 1, severity: "error" };
}

test("counts the four outcomes and the position matches", () => {
  const corpus = corpusOf([
    { sql: "SELECT 1", valid: true },
    { sql: "SELECT 2", valid: true },
    { sql: "SELECT (", valid: false, position: 9, message: "Expected one of: x" },
    { sql: "SELECT )", valid: false, position: 8, message: "Expected end of query" },
    { sql: "SELECT ,", valid: false, position: 8 },
    { sql: "SELECT boom", valid: true },
  ]);
  const fake = (sql: string): Diagnostic[] => {
    if (sql === "SELECT boom") throw new Error("boom");
    if (sql === "SELECT 2") return [error(0)];
    if (sql === "SELECT (") return [error(8)];
    if (sql === "SELECT )") return [error(7)];
    return [];
  };
  const { metrics, falsePositives, falseNegatives, positionMismatches, thrown } = compare(corpus, fake, "test");
  assert.equal(metrics.validAccepted, 1);
  assert.equal(metrics.validRejected, 1);
  assert.equal(metrics.validThrew, 1);
  assert.equal(metrics.invalidRejected, 2);
  assert.equal(metrics.invalidAccepted, 1);
  assert.equal(metrics.verdictAgreement, 3 / 6);
  assert.equal(metrics.positionCompared, 2);
  assert.equal(metrics.positionMatch, 1);
  assert.equal(metrics.messageMatch, 0.5);
  assert.deepEqual(
    [falsePositives.length, falseNegatives.length, positionMismatches.length, thrown.length],
    [1, 1, 0, 1],
  );
});

test("a check() that always throws scores 0", () => {
  const corpus = corpusOf([{ sql: "SELECT 1", valid: true }, { sql: "SELECT (", valid: false, position: 9 }]);
  const report = compare(corpus, () => {
    throw new Error("not implemented");
  }, "test");
  assert.equal(report.metrics.verdictAgreement, 0);
  assert.equal(report.metrics.validThrew + report.metrics.invalidThrew, 2);
  assert.match(formatReport(report, 3), /check\(\) threw on 2 statements/);
});

test("converts ClickHouse byte positions to UTF-16 offsets", () => {
  assert.equal(utf16Offset("SELECT 1", 1), 0);
  assert.equal(utf16Offset("SELECT 'é', (", 14), 12);
  assert.equal(utf16Offset("SELECT '😀' x", 15), 12);
});

test("groups statements by their leading keywords", () => {
  assert.equal(statementKind("select 1"), "SELECT");
  assert.equal(statementKind("CREATE TABLE t (a Int8)"), "CREATE TABLE");
  assert.equal(statementKind("(SELECT 1)"), "(");
});

test("error signatures blank out names and numbers", () => {
  assert.equal(signature("Expected one of: 'x', column 12"), "Expected one of: '…', column N");
});

test("errorSummary keeps the part of a ClickHouse error that check() reports", () => {
  assert.equal(
    errorSummary("Syntax error (query): failed at position 11 (end of query): . Expected one of: token, OR"),
    "Expected one of: token, OR",
  );
  assert.equal(
    errorSummary("Syntax error: failed at position 1 (SELEC): SELEC 1. Maybe you meant: SELECT. Expected one of: Query"),
    "Maybe you meant: SELECT. Expected one of: Query",
  );
  assert.equal(errorSummary("Single quoted string is not closed: Syntax error: failed at position 8 ('abc): 'abc. "), "Single quoted string is not closed");
  assert.equal(
    errorSummary("Syntax error: failed at position 10 (end of query): (1. Unmatched parentheses: '(' at position 8 is never closed"),
    "Unmatched parentheses: '(' at position 8 is never closed",
  );
});
