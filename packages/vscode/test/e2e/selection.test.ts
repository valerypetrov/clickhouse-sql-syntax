import * as assert from "node:assert/strict";
import * as vscode from "vscode";

const LANGUAGE_ID = "clickhouse-sql";
const SQL = "SELECT a, f(b + 1, c) AS x\nFROM t\nWHERE y IN (SELECT z FROM u WHERE z > 1);";

async function open(content: string): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument({ language: LANGUAGE_ID, content });
  return vscode.window.showTextDocument(document);
}

/** The text of a selection range and of each one around it. */
function texts(document: vscode.TextDocument, range: vscode.SelectionRange | undefined): string[] {
  const result: string[] = [];
  for (; range; range = range.parent) result.push(document.getText(range.range));
  return result;
}

/** VS Code adds the ranges of words and lines to those of the extension, so these must come in this order. */
function assertInOrder(found: string[], expected: string[]): void {
  let at = -1;
  for (const text of expected) {
    const next = found.indexOf(text, at + 1);
    assert.ok(next > at, `${JSON.stringify(text)} after ${JSON.stringify(found[at])} in ${JSON.stringify(found)}`);
    at = next;
  }
}

describe("Expand Selection", () => {
  afterEach(() => vscode.commands.executeCommand("workbench.action.closeAllEditors"));

  it("grows from the word at each cursor through its expression, call, clause and subquery", async () => {
    const { document } = await open(SQL);
    const positions = ["b +", "z >"].map((marker) => document.positionAt(SQL.indexOf(marker)));
    const ranges = await vscode.commands.executeCommand<vscode.SelectionRange[]>("vscode.executeSelectionRangeProvider", document.uri, positions);
    assert.equal(ranges.length, 2);
    const statement = SQL.slice(0, -1);
    assertInOrder(texts(document, ranges[0]), [
      "b",
      "b + 1",
      "b + 1, c",
      "(b + 1, c)",
      "f(b + 1, c)",
      "f(b + 1, c) AS x",
      "a, f(b + 1, c) AS x",
      "SELECT a, f(b + 1, c) AS x",
      statement,
      SQL,
    ]);
    assertInOrder(texts(document, ranges[1]), [
      "z",
      "z > 1",
      "WHERE z > 1",
      "SELECT z FROM u WHERE z > 1",
      "(SELECT z FROM u WHERE z > 1)",
      "y IN (SELECT z FROM u WHERE z > 1)",
      "WHERE y IN (SELECT z FROM u WHERE z > 1)",
      statement,
    ]);
  });

  it("Expand Selection selects the expression around the word", async () => {
    const editor = await open(SQL);
    const at = editor.document.positionAt(SQL.indexOf("b +"));
    editor.selection = new vscode.Selection(at, at);
    await vscode.commands.executeCommand("editor.action.smartSelect.expand");
    assert.equal(editor.document.getText(editor.selection), "b");
    await vscode.commands.executeCommand("editor.action.smartSelect.expand");
    assert.equal(editor.document.getText(editor.selection), "b + 1");
  });
});
