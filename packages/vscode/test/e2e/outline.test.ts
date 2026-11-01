import * as assert from "node:assert/strict";
import * as vscode from "vscode";

const LANGUAGE_ID = "clickhouse-sql";

async function open(content: string): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument({ language: LANGUAGE_ID, content });
  return vscode.window.showTextDocument(document);
}

/** Each symbol of the document as its name, kind, text, the text of its name, and its children. */
async function symbols(document: vscode.TextDocument): Promise<unknown[]> {
  const found = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>("vscode.executeDocumentSymbolProvider", document.uri);
  const tree = (s: vscode.DocumentSymbol): unknown[] => [
    s.name,
    vscode.SymbolKind[s.kind],
    document.getText(s.range),
    document.getText(s.selectionRange),
    s.children.map(tree),
  ];
  return found.map(tree);
}

const SQL = [
  "-- Events.",
  "CREATE TABLE db.events (",
  "  id UInt64,",
  "  name String",
  ") ENGINE = Memory;",
  "WITH recent AS (SELECT * FROM db.events)",
  "SELECT count() FROM recent;",
].join("\n");

describe("Outline", () => {
  afterEach(() => vscode.commands.executeCommand("workbench.action.closeAllEditors"));

  it("lists each statement with its CTEs and columns", async () => {
    const { document } = await open(SQL);
    assert.deepEqual(await symbols(document), [
      [
        "CREATE TABLE db.events",
        "Struct",
        "CREATE TABLE db.events (\n  id UInt64,\n  name String\n) ENGINE = Memory;",
        "db.events",
        [
          ["id", "Field", "id UInt64", "id", []],
          ["name", "Field", "name String", "name", []],
        ],
      ],
      [
        "SELECT … FROM recent",
        "Method",
        "WITH recent AS (SELECT * FROM db.events)\nSELECT count() FROM recent;",
        "SELECT",
        [["recent", "Variable", "recent AS (SELECT * FROM db.events)", "recent", []]],
      ],
    ]);
  });

  it("follows edits", async () => {
    const editor = await open(SQL);
    assert.ok(await editor.edit((edit) => edit.replace(new vscode.Range(1, 13, 1, 22), "logs")));
    const [table] = (await symbols(editor.document)) as [string, string, string, string, unknown[]][];
    assert.equal(table![0], "CREATE TABLE logs");
    assert.equal(table![3], "logs");
  });
});
