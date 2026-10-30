import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import * as vscode from "vscode";

const LANGUAGE_ID = "clickhouse-sql";
const CHECK_DELAY_MS = 300;
const EDITS = 500;
const TYPED = "abcdefghijklmnopqrstuvwxyz0123456789 ,.()+";
// The first statement always has an error, so that every check sets new diagnostics; edits leave it alone.
const BROKEN = "SELECT 1 +;\n";
const TYPING = "SELECT * FROM t WHERE to";
// The time budgets fit a desktop; STRESS_TIME_SCALE=<factor> multiplies them on a slower machine, such as a CI runner.
const SCALE = Number(process.env.STRESS_TIME_SCALE || 1);
assert.ok(SCALE > 0, `STRESS_TIME_SCALE must be a positive number, not ${process.env.STRESS_TIME_SCALE}`);
const DIAGNOSTICS_MS = 300 * SCALE;
const ROUND_TRIP_MS = 500 * SCALE;
const TOOL_MS = 50 * SCALE;

/** BROKEN and then 10,000 statements that ClickHouse accepts, from the oracle's corpus: about 1 MB. */
function corpusFile(): string {
  const extension = vscode.extensions.all.find((e) => e.packageJSON.name === LANGUAGE_ID)!;
  const corpus = gunzipSync(readFileSync(resolve(extension.extensionPath, "../../oracle/fixtures/corpus.jsonl.gz"))).toString("utf8");
  const statements = corpus
    .split("\n")
    .slice(1)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { sql: string; valid: boolean; mutation?: string })
    .filter((entry) => entry.valid && !entry.mutation)
    .slice(0, 10_000)
    .map((entry) => entry.sql);
  return BROKEN + statements.join(";\n") + ";\n";
}

/** A fixed sequence of numbers in [0, 1) (mulberry32), so that every run makes the same edits. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((p / 100) * sorted.length) - 1]!;
}

function summary(values: number[]): string {
  return `p50 ${percentile(values, 50).toFixed(0)} ms, p95 ${percentile(values, 95).toFixed(0)} ms, max ${Math.max(...values).toFixed(0)} ms`;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function open(content: string): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument({ language: LANGUAGE_ID, content });
  return vscode.window.showTextDocument(document);
}

function syntaxErrors(document: vscode.TextDocument): readonly vscode.Diagnostic[] {
  return vscode.languages.getDiagnostics(document.uri).filter((d) => d.source === "ClickHouse SQL");
}

/** Inserts a character at a random place after BROKEN, or every second time deletes a letter, digit, space or comma there. */
function typeOne(editor: vscode.TextEditor, next: () => number, i: number): Thenable<boolean> {
  const text = editor.document.getText();
  const offset = BROKEN.length + Math.floor(next() * (text.length - BROKEN.length));
  const position = editor.document.positionAt(offset);
  const deletes = i % 2 === 1 && /[A-Za-z0-9 ,]/.test(text[offset] ?? "");
  return editor.edit((edit) =>
    deletes ? edit.delete(new vscode.Range(position, position.translate(0, 1))) : edit.insert(position, TYPED[Math.floor(next() * TYPED.length)]!),
  );
}

/** Times round trips of a command through the window until `stop()`, which gives the times. */
function probe(): () => Promise<number[]> {
  const times: number[] = [];
  let running = true;
  const loop = (async () => {
    for (let i = 0; running; i++) {
      const start = performance.now();
      await vscode.commands.executeCommand("setContext", "clickhouseSql.stressProbe", i);
      times.push(performance.now() - start);
      await sleep(10);
    }
  })();
  return async () => {
    running = false;
    await loop;
    return times;
  };
}

async function timed(run: () => Thenable<unknown>): Promise<number> {
  const start = performance.now();
  await run();
  return performance.now() - start;
}

describe("A file of 10,000 statements, about 1 MB", function () {
  this.timeout(900_000);
  const sql = corpusFile();
  afterEach(() => vscode.commands.executeCommand("workbench.action.closeAllEditors"));

  it(`gets its diagnostics within ${DIAGNOSTICS_MS} ms of the check delay after each of 500 edits`, async () => {
    const editor = await open(sql);
    while (syntaxErrors(editor.document).length === 0) await sleep(10);
    const stop = probe();
    const next = random(1);
    const latencies: number[] = [];
    for (let i = 0; i < EDITS; i++) {
      const before = syntaxErrors(editor.document)[0];
      assert.ok(await typeOne(editor, next, i));
      const edited = performance.now();
      while (syntaxErrors(editor.document)[0] === before) await sleep(1);
      latencies.push(performance.now() - edited - CHECK_DELAY_MS);
    }
    const roundTrips = await stop();
    console.log(`      diagnostics after the ${CHECK_DELAY_MS} ms delay: ${summary(latencies)}`);
    console.log(`      command round trips meanwhile: ${summary(roundTrips)}`);
    assert.ok(percentile(latencies, 95) < DIAGNOSTICS_MS, summary(latencies));
    assert.ok(Math.max(...roundTrips) < ROUND_TRIP_MS, summary(roundTrips));
  });

  it(`answers commands within ${ROUND_TRIP_MS} ms through 500 edits in a row`, async () => {
    const editor = await open(sql);
    while (syntaxErrors(editor.document).length === 0) await sleep(10);
    const stop = probe();
    const next = random(2);
    for (let i = 0; i < EDITS - 1; i++) assert.ok(await typeOne(editor, next, i));
    const before = syntaxErrors(editor.document)[0];
    assert.ok(await typeOne(editor, next, EDITS - 1));
    while (syntaxErrors(editor.document)[0] === before) await sleep(1);
    const roundTrips = await stop();
    console.log(`      command round trips: ${summary(roundTrips)}`);
    assert.ok(Math.max(...roundTrips) < ROUND_TRIP_MS, summary(roundTrips));
  });

  it(`gives semantic tokens within ${TOOL_MS} ms after an edit, of the whole file and of a screen of it`, async () => {
    const editor = await open(sql);
    const uri = editor.document.uri;
    const whole = () => vscode.commands.executeCommand("vscode.provideDocumentSemanticTokens", uri);
    const first = await timed(whole);
    const middle = editor.document.positionAt(sql.length / 2);
    const screen = new vscode.Range(middle.line - 30, 0, middle.line + 30, 0);
    const range = () => vscode.commands.executeCommand("vscode.provideDocumentRangeSemanticTokens", uri, screen);
    let afterEdit = Infinity;
    let ofScreen = Infinity;
    for (let i = 0; i < 5; i++) {
      assert.ok(await editor.edit((edit) => edit.insert(middle, " ")));
      afterEdit = Math.min(afterEdit, await timed(whole));
      assert.ok(await editor.edit((edit) => edit.insert(middle, " ")));
      ofScreen = Math.min(ofScreen, await timed(range));
    }
    console.log(`      semantic tokens: first ${first.toFixed(0)} ms, after an edit ${afterEdit.toFixed(0)} ms, of a screen ${ofScreen.toFixed(0)} ms`);
    assert.ok(afterEdit < TOOL_MS, `after an edit: ${afterEdit.toFixed(0)} ms`);
    assert.ok(ofScreen < TOOL_MS, `of a screen: ${ofScreen.toFixed(0)} ms`);
  });

  it(`completes within ${TOOL_MS} ms at its end and in its middle`, async () => {
    const half = sql.indexOf(";\n", sql.length / 2) + 2;
    const editor = await open(`${sql.slice(0, half)}${TYPING};\n${sql.slice(half)}${TYPING}`);
    const document = editor.document;
    const complete = (offset: number) => () =>
      vscode.commands.executeCommand("vscode.executeCompletionItemProvider", document.uri, document.positionAt(offset));
    let atEnd = Infinity;
    let inMiddle = Infinity;
    for (let i = 0; i < 5; i++) {
      atEnd = Math.min(atEnd, await timed(complete(document.getText().length)));
      inMiddle = Math.min(inMiddle, await timed(complete(half + TYPING.length)));
    }
    console.log(`      completion: at the end ${atEnd.toFixed(0)} ms, in the middle ${inMiddle.toFixed(0)} ms`);
    assert.ok(atEnd < TOOL_MS, `at the end: ${atEnd.toFixed(0)} ms`);
    assert.ok(inMiddle < TOOL_MS, `in the middle: ${inMiddle.toFixed(0)} ms`);
  });
});
