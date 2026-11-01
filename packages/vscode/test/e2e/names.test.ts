import * as assert from "node:assert/strict";
import * as vscode from "vscode";

const LANGUAGE_ID = "clickhouse-sql";

async function open(text: string): Promise<vscode.TextDocument> {
  const document = await vscode.workspace.openTextDocument({ language: LANGUAGE_ID, content: text });
  await vscode.window.showTextDocument(document);
  return document;
}

/** The position of the `nth` occurrence of `word` in the document. */
function at(document: vscode.TextDocument, word: string, nth = 0): vscode.Position {
  const text = document.getText();
  let offset = -1;
  for (let i = 0; i <= nth; i++) offset = text.indexOf(word, offset + 1);
  assert.ok(offset >= 0, `${word} is not in the document ${nth + 1} times`);
  return document.positionAt(offset);
}

/** The offsets where the ranges start, in order. */
function starts(document: vscode.TextDocument, ranges: vscode.Range[]): number[] {
  return ranges.map((range) => document.offsetAt(range.start)).sort((a, b) => a - b);
}

describe("Names", () => {
  afterEach(() => vscode.commands.executeCommand("workbench.action.closeAllEditors"));

  it("go to the definition of an alias, a CTE, a table alias and a lambda parameter", async () => {
    const document = await open("WITH c AS (SELECT 1 AS a) SELECT t.a + 1 AS b, arrayMap(x -> x * b, [1]) FROM c AS t WHERE b > 0");
    const definitionOf = async (position: vscode.Position) => {
      const found = await vscode.commands.executeCommand<vscode.Location[]>("vscode.executeDefinitionProvider", document.uri, position);
      return starts(document, found.map((location) => location.range));
    };
    const text = document.getText();
    assert.deepEqual(await definitionOf(at(document, "b > 0")), [text.indexOf("b,")]);
    assert.deepEqual(await definitionOf(at(document, "c AS t")), [text.indexOf("c AS (")]);
    assert.deepEqual(await definitionOf(at(document, "t.a")), [text.indexOf("t WHERE")]);
    assert.deepEqual(await definitionOf(at(document, "a + 1")), [text.indexOf("a)")]);
    assert.deepEqual(await definitionOf(at(document, "x * b")), [text.indexOf("x ->")]);
    assert.deepEqual(await definitionOf(at(document, "SELECT", 1)), []);
  });

  it("find the references and highlight them, the definition as written", async () => {
    const document = await open("SELECT number + 1 AS n FROM numbers(3) WHERE n > 1 ORDER BY n");
    const text = document.getText();
    const uses = [text.indexOf("n FROM"), text.indexOf("n >"), text.lastIndexOf("n")];
    const references = await vscode.commands.executeCommand<vscode.Location[]>("vscode.executeReferenceProvider", document.uri, at(document, "n >"));
    assert.deepEqual(starts(document, references.map((location) => location.range)), uses);
    const highlights = await vscode.commands.executeCommand<vscode.DocumentHighlight[]>("vscode.executeDocumentHighlights", document.uri, at(document, "n FROM"));
    assert.deepEqual(
      highlights.map((highlight) => [document.offsetAt(highlight.range.start), highlight.kind]).sort((a, b) => a[0]! - b[0]!),
      [[uses[0], vscode.DocumentHighlightKind.Write], [uses[1], vscode.DocumentHighlightKind.Read], [uses[2], vscode.DocumentHighlightKind.Read]],
    );
  });

  it("find nothing for a column of a table or a name ClickHouse may read otherwise", async () => {
    const document = await open("SELECT a FROM t;\nSELECT 1 AS x, (SELECT x FROM t)");
    for (const position of [at(document, "a FROM"), at(document, "x FROM")]) {
      const references = await vscode.commands.executeCommand<vscode.Location[]>("vscode.executeReferenceProvider", document.uri, position);
      assert.deepEqual(references, []);
    }
  });

  it("rename a name everywhere its statement uses it, quoting it where needed", async () => {
    const document = await open("WITH c AS (SELECT 1 AS a) SELECT a + 1 AS b FROM c WHERE b > 0;\nSELECT 2 AS b, b");
    const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>("vscode.executeDocumentRenameProvider", document.uri, at(document, "b > 0"), "total sum");
    assert.ok(await vscode.workspace.applyEdit(edit));
    assert.equal(document.getText(), "WITH c AS (SELECT 1 AS a) SELECT a + 1 AS `total sum` FROM c WHERE `total sum` > 0;\nSELECT 2 AS b, b");
    const again = await vscode.commands.executeCommand<vscode.WorkspaceEdit>("vscode.executeDocumentRenameProvider", document.uri, at(document, "c WHERE"), "source");
    assert.ok(await vscode.workspace.applyEdit(again));
    assert.equal(document.getText(), "WITH source AS (SELECT 1 AS a) SELECT a + 1 AS `total sum` FROM source WHERE `total sum` > 0;\nSELECT 2 AS b, b");
  });

  it("prepare a rename with the name, and refuse names the query does not define", async () => {
    const document = await open("SELECT a + 1 AS x FROM t WHERE x > 0");
    const prepared = await vscode.commands.executeCommand<{ range: vscode.Range; placeholder: string }>("vscode.prepareRename", document.uri, at(document, "x >"));
    assert.equal(prepared.placeholder, "x");
    assert.equal(document.offsetAt(prepared.range.start), document.getText().indexOf("x >"));
    await assert.rejects(
      Promise.resolve(vscode.commands.executeCommand("vscode.prepareRename", document.uri, at(document, "a + 1"))),
      /not defined in this query/,
    );
  });

  it("refuse a new name that would change what the query means", async () => {
    const document = await open("SELECT a + 1 AS x, b FROM t WHERE x > 0");
    await assert.rejects(
      Promise.resolve(vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", document.uri, at(document, "x >"), "b")),
      /already used/,
    );
    assert.equal(document.getText(), "SELECT a + 1 AS x, b FROM t WHERE x > 0");
  });
});
