import * as assert from "node:assert/strict";
import { check } from "clickhouse-sql-syntax";
import * as vscode from "vscode";

const LANGUAGE_ID = "clickhouse-sql";
const WAIT_MS = 10_000;

function fixture(path: string): vscode.Uri {
  return vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0]!.uri, path);
}

/** Resolves with the diagnostics of `uri` once `ready` accepts them. */
function waitForDiagnostics(
  uri: vscode.Uri,
  ready: (diagnostics: vscode.Diagnostic[]) => boolean,
): Promise<vscode.Diagnostic[]> {
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      const diagnostics = vscode.languages.getDiagnostics(uri);
      if (!ready(diagnostics)) return;
      listener.dispose();
      clearTimeout(timer);
      resolve(diagnostics);
    };
    const listener = vscode.languages.onDidChangeDiagnostics(poll);
    const timer = setTimeout(() => {
      listener.dispose();
      const found = JSON.stringify(vscode.languages.getDiagnostics(uri).map((d) => d.message));
      reject(new Error(`Diagnostics of ${uri.toString()} did not settle; found ${found}`));
    }, WAIT_MS);
    poll();
  });
}

async function replaceAll(editor: vscode.TextEditor, text: string): Promise<void> {
  const document = editor.document;
  const whole = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
  assert.ok(await editor.edit((edit) => edit.replace(whole, text)));
}

async function untitled(content: string): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument({ language: LANGUAGE_ID, content });
  return vscode.window.showTextDocument(document);
}

describe("ClickHouse SQL extension", () => {
  afterEach(() => vscode.commands.executeCommand("workbench.action.closeAllEditors"));

  it("gives ClickHouse files the clickhouse-sql language", async () => {
    const languages: Record<string, string> = {};
    for (const path of ["sample.chsql", "query.clickhouse.sql", "opt-in/report.sql", "plain.sql"]) {
      languages[path] = (await vscode.workspace.openTextDocument(fixture(path))).languageId;
    }
    assert.deepEqual(languages, {
      "sample.chsql": LANGUAGE_ID,
      "query.clickhouse.sql": LANGUAGE_ID,
      "opt-in/report.sql": LANGUAGE_ID,
      "plain.sql": "sql",
    });
  });

  it("reports syntax errors of a file when it opens", async () => {
    const document = await vscode.workspace.openTextDocument(fixture("broken.chsql"));
    await vscode.window.showTextDocument(document);
    const diagnostics = await waitForDiagnostics(document.uri, (found) => found.length > 0);

    const expected = check(document.getText());
    assert.ok(expected.length > 0, "check() finds the error of broken.chsql");
    assert.deepEqual(
      diagnostics.map((d) => ({
        message: d.message,
        line: d.range.start.line + 1,
        col: d.range.start.character + 1,
        severity: d.severity,
        source: d.source,
      })),
      expected.map((e) => ({
        message: e.message,
        line: e.line,
        col: e.col,
        severity: vscode.DiagnosticSeverity.Error,
        source: "ClickHouse SQL",
      })),
    );
    assert.equal(diagnostics[0]!.range.start.line, 1, "the error is on the second line, after the comment");
  });

  it("finds no errors in valid files", async () => {
    for (const path of ["sample.chsql", "query.clickhouse.sql", "opt-in/report.sql"]) {
      const document = await vscode.workspace.openTextDocument(fixture(path));
      await vscode.window.showTextDocument(document);
      assert.deepEqual(check(document.getText()), [], path);
      assert.deepEqual(vscode.languages.getDiagnostics(document.uri), [], path);
    }
  });

  it("updates diagnostics as the text changes", async () => {
    const editor = await untitled("SELECT 1");
    const uri = editor.document.uri;
    await waitForDiagnostics(uri, (found) => found.length === 0);

    await replaceAll(editor, "SELECT * FROM hits ORDER");
    const [error] = await waitForDiagnostics(uri, (found) => found.length === 1);
    assert.equal(error!.range.start.character, "SELECT * FROM hits ORDER".length, "an end-of-input error");
    assert.ok(error!.range.isEmpty);

    await replaceAll(editor, "SELECT * FROM hits ORDER BY 1");
    await waitForDiagnostics(uri, (found) => found.length === 0);
  });

  it("clears diagnostics when the language changes", async () => {
    const editor = await untitled("SELECT (1");
    await waitForDiagnostics(editor.document.uri, (found) => found.length > 0);
    const document = await vscode.languages.setTextDocumentLanguage(editor.document, "plaintext");
    await waitForDiagnostics(document.uri, (found) => found.length === 0);
  });

  it("colours the editor with the TextMate grammar", async () => {
    // The internal command VS Code's own colorizer tests use to read the scopes of a file.
    const tokens = await vscode.commands.executeCommand<{ c: string; t: string }[]>(
      "_workbench.captureSyntaxTokens",
      fixture("query.clickhouse.sql"),
    );
    const scopes = new Map(tokens.map((token) => [token.c.trim(), token.t.split(" ")]));
    for (const [text, scope] of [
      ["SELECT", "keyword.other.sql"],
      ["%", "keyword.operator.sql"],
      ["3", "constant.numeric.sql"],
      ["system", "variable.other.sql"],
      ["5", "constant.numeric.sql"],
    ]) {
      assert.deepEqual(scopes.get(text!), ["source.clickhouse-sql", scope], text);
    }
  });
});
