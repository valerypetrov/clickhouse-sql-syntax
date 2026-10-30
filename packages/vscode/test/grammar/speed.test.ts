import * as assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { INITIAL, type StateStack } from "vscode-textmate";
import { loadGrammar } from "./textmate.js";

// The oracle's sample of ClickHouse's tests, or with CLICKHOUSE_CORPUS=<ClickHouse checkout>/tests/queries/0_stateless all of them.
const CORPUS = process.env.CLICKHOUSE_CORPUS;
const MAX_LINE_MS = 50;
// VS Code leaves longer lines uncoloured (editor.maxTokenizationLineLength).
const MAX_LINE_LENGTH = 20_000;

/** Each text that VS Code would tokenize from its first line, and where it comes from. */
function* texts(): Generator<[string, string]> {
  if (CORPUS) {
    for (const name of readdirSync(CORPUS).filter((name) => name.endsWith(".sql")).sort()) {
      yield [name, readFileSync(join(CORPUS, name), "utf8")];
    }
    return;
  }
  const corpus = gunzipSync(readFileSync(join(__dirname, "../../../../oracle/fixtures/corpus.jsonl.gz"))).toString("utf8");
  for (const line of corpus.split("\n").slice(1).filter(Boolean)) {
    const entry = JSON.parse(line) as { sql: string; file: string; line: number };
    yield [`${entry.file}:${entry.line}`, entry.sql];
  }
}

test(`the grammar tokenizes each line of the corpus within ${MAX_LINE_MS} ms`, async (t) => {
  const grammar = await loadGrammar();
  // Compiles the patterns of the first state before the timing starts.
  grammar.tokenizeLine2("SELECT 1", INITIAL);
  const slowest: { ms: number; where: string; length: number }[] = [];
  let lines = 0;
  let longLines = 0;
  for (const [where, text] of texts()) {
    let state: StateStack = INITIAL;
    text.split(/\r\n|\r|\n/).forEach((line, i) => {
      if (line.length > MAX_LINE_LENGTH) return void longLines++;
      lines++;
      let next = state;
      const time = (): number => {
        const start = performance.now();
        next = grammar.tokenizeLine2(line, state).ruleStack;
        return performance.now() - start;
      };
      // A pause for garbage collection or for another process can slow one run, so a slow line is timed again.
      let ms = time();
      if (ms > MAX_LINE_MS) ms = Math.min(ms, time(), time());
      state = next;
      if (slowest.length < 5 || ms > slowest[4]!.ms) {
        slowest.push({ ms, where: `${where} line ${i + 1}`, length: line.length });
        slowest.sort((a, b) => b.ms - a.ms).splice(5);
      }
    });
  }
  t.diagnostic(`${lines} lines, and ${longLines} longer than ${MAX_LINE_LENGTH} characters left out; the slowest:`);
  for (const { ms, where, length } of slowest) t.diagnostic(`${ms.toFixed(1)} ms: ${where}, ${length} characters`);
  assert.ok(slowest[0]!.ms < MAX_LINE_MS, `${slowest[0]!.where} took ${slowest[0]!.ms.toFixed(0)} ms`);
});

// A search from each quote or backslash to the end of the line once made these lines take seconds.
const REPEATED = ["'", "\\", "\\'", "a\\"];
const MAX_REPEATED_MS = 400;

test(`the grammar tokenizes lines of ${MAX_LINE_LENGTH} repeated characters within ${MAX_REPEATED_MS} ms`, async (t) => {
  const grammar = await loadGrammar();
  grammar.tokenizeLine2("SELECT 1", INITIAL);
  const slow: string[] = [];
  for (const unit of REPEATED) {
    const line = unit.repeat(MAX_LINE_LENGTH / unit.length);
    const start = performance.now();
    grammar.tokenizeLine2(line, INITIAL);
    const ms = performance.now() - start;
    t.diagnostic(`${JSON.stringify(unit)}: ${ms.toFixed(1)} ms`);
    if (ms > MAX_REPEATED_MS) slow.push(`${JSON.stringify(unit)} took ${ms.toFixed(0)} ms`);
  }
  assert.deepEqual(slow, []);
});
