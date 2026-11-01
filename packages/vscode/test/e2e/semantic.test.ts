import * as assert from "node:assert/strict";
import * as vscode from "vscode";

const LANGUAGE_ID = "clickhouse-sql";
const ROOT_SCOPE = "source.clickhouse-sql";

async function open(text: string): Promise<vscode.TextDocument> {
  const document = await vscode.workspace.openTextDocument({ language: LANGUAGE_ID, content: text });
  await vscode.window.showTextDocument(document);
  return document;
}

/** The semantic tokens of `document`, or of `range` of it, as their text and type. */
async function semanticTokens(document: vscode.TextDocument, range?: vscode.Range): Promise<[string, string][]> {
  const kind = range ? "DocumentRangeSemanticTokens" : "DocumentSemanticTokens";
  const args = range ? [document.uri, range] : [document.uri];
  const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>(`vscode.provide${kind}Legend`, ...args);
  const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>(`vscode.provide${kind}`, ...args);
  const result: [string, string][] = [];
  let line = 0;
  let character = 0;
  // Each token is five numbers: line and start relative to the token before, length, type and modifiers.
  for (let i = 0; i < tokens.data.length; i += 5) {
    const [deltaLine, deltaStart, length, type] = tokens.data.subarray(i, i + 4);
    line += deltaLine;
    character = deltaLine ? deltaStart : character + deltaStart;
    const start = new vscode.Position(line, character);
    result.push([document.getText(new vscode.Range(start, start.translate(0, length))), legend.tokenTypes[type]!]);
  }
  return result;
}

describe("Semantic tokens", () => {
  afterEach(() => vscode.commands.executeCommand("workbench.action.closeAllEditors"));

  it("colour the keywords that name columns in the user's query as names", async () => {
    const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0]!.uri, "keywords-as-names.chsql");
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    assert.deepEqual(await semanticTokens(document), [
      ["CREATE", "keyword"], ["MATERIALIZED", "keyword"], ["VIEW", "keyword"], ["logs", "variable"], ["mv", "variable"],
      ["on", "keyword"], ["cluster", "keyword"], ["TO", "keyword"], ["logs", "variable"], ["t", "variable"],
      ["AS", "keyword"], ["SELECT", "keyword"], ["Timestamp", "variable"], ["as", "keyword"], ["timestamp", "variable"],
      ["mapKeys", "function"], ["message", "variable"], ["as", "keyword"], ["message_keys", "variable"],
      ["FROM", "keyword"], ["logs", "variable"], ["src", "variable"], ["GROUP", "keyword"], ["BY", "keyword"],
      ["component_type", "variable"], ["timestamp", "variable"], ["message_key", "variable"],
    ]);
    // The grammar alone takes Timestamp for the TIMESTAMP keyword; the semantic token is what fixes it.
    const syntax = await vscode.commands.executeCommand<{ c: string; t: string }[]>("_workbench.captureSyntaxTokens", uri);
    assert.equal(syntax.find((token) => token.c === "Timestamp")?.t, `${ROOT_SCOPE} keyword.other.sql`);
  });

  it("give types, engines, settings, functions, parameters and numbers their own types", async () => {
    const document = await open(
      "CREATE TABLE t (key String, j JSON(max_dynamic_paths = 2)) ENGINE = MergeTree ORDER BY key SETTINGS index_granularity = 1;\n" +
        "SELECT {id:UInt64}, count(), nan FROM t",
    );
    assert.deepEqual(await semanticTokens(document), [
      ["CREATE", "keyword"], ["TABLE", "keyword"], ["t", "variable"], ["key", "variable"], ["String", "type"], ["j", "variable"],
      ["JSON", "type"], ["max_dynamic_paths", "property"], ["ENGINE", "keyword"], ["MergeTree", "class"], ["ORDER", "keyword"],
      ["BY", "keyword"], ["key", "variable"], ["SETTINGS", "keyword"], ["index_granularity", "property"],
      ["SELECT", "keyword"], ["id", "parameter"], ["UInt64", "parameter"], ["count", "function"], ["nan", "number"],
      ["FROM", "keyword"], ["t", "variable"],
    ]);
  });

  it("leave statements with errors, and NULL, TRUE and FALSE, to the grammar", async () => {
    const document = await open("SELECT Timestamp FROM;\nSELECT NULL, true, Timestamp FROM t");
    assert.deepEqual(await semanticTokens(document), [
      ["SELECT", "keyword"], ["Timestamp", "variable"], ["FROM", "keyword"], ["t", "variable"],
    ]);
  });

  it("follow edits", async () => {
    const document = await open("SELECT key FROM t;\nSELECT type FROM u;");
    const editor = vscode.window.activeTextEditor!;
    const second = new vscode.Range(1, 7, 1, 11);
    assert.ok(await editor.edit((edit) => edit.replace(second, "user, date")));
    assert.deepEqual(await semanticTokens(document), [
      ["SELECT", "keyword"], ["key", "variable"], ["FROM", "keyword"], ["t", "variable"],
      ["SELECT", "keyword"], ["user", "variable"], ["date", "variable"], ["FROM", "keyword"], ["u", "variable"],
    ]);
    assert.ok(await editor.edit((edit) => edit.insert(new vscode.Position(0, 6), " DISTINCT ON")));
    assert.deepEqual((await semanticTokens(document)).slice(0, 2), [["SELECT", "keyword"], ["user", "variable"]]);
  });

  it("cover only the statements of a range", async () => {
    const document = await open("SELECT key FROM t;\nSELECT type FROM u;\nSELECT user FROM v;");
    assert.deepEqual(await semanticTokens(document, new vscode.Range(1, 0, 1, 19)), [
      ["SELECT", "keyword"], ["type", "variable"], ["FROM", "keyword"], ["u", "variable"],
    ]);
  });

  it("map each type to a scope of the grammar, and are on for every theme", () => {
    const manifest = vscode.extensions.all.find((extension) => extension.packageJSON.name === "clickhouse-sql")!.packageJSON;
    const scopes = manifest.contributes.semanticTokenScopes[0].scopes as Record<string, string[]>;
    for (const type of ["keyword", "variable", "function", "type", "class", "property", "parameter", "number"]) {
      assert.ok(scopes[type]?.[0]?.endsWith(".sql"), type);
    }
    const editor = vscode.workspace.getConfiguration("editor", { languageId: LANGUAGE_ID });
    assert.equal(editor.get("semanticHighlighting.enabled"), true);
  });

  // With semantic tokens on this line of 237,801 characters, completion at its end took 39 s.
  it("leave lines over 10,000 characters to the grammar, so that completion on them stays quick", async function () {
    this.timeout(120_000);
    const columns = Array.from({ length: 10_000 }, (_, i) => `number + ${i} AS c${i}`).join(", ");
    const document = await open(`SELECT key FROM t;\nSELECT ${columns} FROM numbers(1)`);
    // Long enough for VS Code to ask for the semantic tokens and apply them.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const start = performance.now();
    const end = document.positionAt(document.getText().length);
    await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", document.uri, end);
    const ms = performance.now() - start;
    assert.ok(ms < 10_000, `completion took ${ms.toFixed(0)} ms`);
    assert.deepEqual(await semanticTokens(document), [
      ["SELECT", "keyword"], ["key", "variable"], ["FROM", "keyword"], ["t", "variable"],
    ]);
  });
});
