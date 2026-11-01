import * as assert from "node:assert/strict";
import * as vscode from "vscode";

const LANGUAGE_ID = "clickhouse-sql";
const { Comment, Region } = vscode.FoldingRangeKind;

async function open(content: string): Promise<vscode.TextDocument> {
  const document = await vscode.workspace.openTextDocument({ language: LANGUAGE_ID, content });
  await vscode.window.showTextDocument(document);
  return document;
}

/** The folding ranges of `document` as [start, end, kind], in order. */
async function folds(document: vscode.TextDocument): Promise<[number, number, vscode.FoldingRangeKind | undefined][]> {
  const ranges = await vscode.commands.executeCommand<vscode.FoldingRange[]>("vscode.executeFoldingRangeProvider", document.uri);
  return ranges.map((r): [number, number, vscode.FoldingRangeKind | undefined] => [r.start, r.end, r.kind]).sort((a, b) => a[0] - b[0]);
}

describe("Folding", () => {
  afterEach(() => vscode.commands.executeCommand("workbench.action.closeAllEditors"));

  it("folds statements, subqueries, comments and regions", async () => {
    const document = await open(
      [
        "-- #region tables",
        "/* The table",
        "   of events. */",
        "CREATE TABLE t (",
        "  id UInt64,",
        "  s String",
        ") ENGINE = Memory;",
        "-- #endregion",
        "-- Every row,",
        "-- twice.",
        "SELECT *",
        "FROM (",
        "  SELECT 1",
        ")",
      ].join("\n"),
    );
    assert.deepEqual(await folds(document), [
      [0, 7, Region],
      [1, 2, Comment],
      [3, 6, undefined],
      [8, 9, Comment],
      [10, 13, undefined],
      [11, 12, undefined],
    ]);
  });

  it("folds no bracket inside a string", async () => {
    const document = await open("SELECT\n  '(\n',\n  1\nFROM t");
    assert.deepEqual(await folds(document), [[0, 4, undefined]]);
  });
});
