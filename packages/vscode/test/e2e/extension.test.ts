import * as assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { check } from "clickhouse-sql-syntax";
import * as vscode from "vscode";

const LANGUAGE_ID = "clickhouse-sql";
const ROOT_SCOPE = "source.clickhouse-sql";
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

/** Resolves once the diagnostics of `document` are what check() reports for its current text. */
function waitForCheck(document: vscode.TextDocument): Promise<vscode.Diagnostic[]> {
  const expected = check(document.getText()).map((e) => ({
    message: e.message,
    start: e.start,
    end: e.end,
    severity: vscode.DiagnosticSeverity.Error,
    source: "ClickHouse SQL",
  }));
  return waitForDiagnostics(document.uri, (found) =>
    isDeepStrictEqual(
      found.map((d) => ({
        message: d.message,
        start: document.offsetAt(d.range.start),
        end: document.offsetAt(d.range.end),
        severity: d.severity,
        source: d.source,
      })),
      expected,
    ),
  );
}

async function replaceAll(editor: vscode.TextEditor, text: string): Promise<void> {
  const document = editor.document;
  const whole = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
  assert.ok(await editor.edit((edit) => edit.replace(whole, text)));
}

async function untitled(content: string, language = LANGUAGE_ID): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument({ language, content });
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

  it("shows the errors of check() when a file opens", async () => {
    const counts: Record<string, number> = {};
    for (const path of ["broken.chsql", "sample.chsql", "query.clickhouse.sql", "opt-in/report.sql"]) {
      const document = await vscode.workspace.openTextDocument(fixture(path));
      await vscode.window.showTextDocument(document);
      counts[path] = (await waitForCheck(document)).length;
    }
    assert.ok(counts["broken.chsql"]! > 0, "the unclosed parenthesis of broken.chsql is an error");
    assert.equal(counts["query.clickhouse.sql"], 0);
    assert.equal(counts["opt-in/report.sql"], 0);

    const [first] = vscode.languages.getDiagnostics(fixture("broken.chsql"));
    assert.equal(first!.range.start.line, 1, "the error is on the second line, after the comment");
  });

  it("leaves other languages alone", async () => {
    const other = await untitled("SELECT (", "sql");
    const ours = await untitled("SELECT (");
    assert.equal((await waitForCheck(ours.document)).length, 1);
    assert.deepEqual(vscode.languages.getDiagnostics(other.document.uri), []);
  });

  it("updates diagnostics as the text changes", async () => {
    const editor = await untitled("SELECT 1");
    assert.deepEqual(await waitForCheck(editor.document), []);

    await replaceAll(editor, "SELECT (1 + 2");
    assert.equal((await waitForCheck(editor.document)).length, 1, "an unclosed parenthesis");

    await replaceAll(editor, "SELECT (1 + 2)");
    assert.deepEqual(await waitForCheck(editor.document), []);
  });

  it("clears diagnostics when the language changes", async () => {
    const editor = await untitled("SELECT (1");
    assert.equal((await waitForCheck(editor.document)).length, 1);
    const document = await vscode.languages.setTextDocumentLanguage(editor.document, "plaintext");
    await waitForDiagnostics(document.uri, (found) => found.length === 0);
  });

  it("colours the editor with the TextMate grammar", async () => {
    const uri = fixture("sample.chsql");
    const text = (await vscode.workspace.openTextDocument(uri)).getText();
    // The internal command VS Code's own colorizer tests use to read the scopes of a file.
    const tokens = await vscode.commands.executeCommand<{ c: string; t: string }[]>(
      "_workbench.captureSyntaxTokens",
      uri,
    );
    // Find where each token starts, so that a piece of the file can be looked up by its offset.
    const located: { start: number; end: number; scopes: string }[] = [];
    let offset = 0;
    for (const token of tokens) {
      const start = text.indexOf(token.c, offset);
      assert.ok(start >= 0, `token ${JSON.stringify(token.c)} is in the file`);
      located.push({ start, end: start + token.c.length, scopes: token.t });
      offset = start + token.c.length;
    }
    // The scopes of the tokens that cover the first occurrence of `piece`, whitespace aside.
    const scopesOf = (piece: string): string[] => {
      const start = text.indexOf(piece);
      assert.ok(start >= 0, `${piece} is in sample.chsql`);
      const covering = located.filter(
        (token) => token.end > start && token.start < start + piece.length && text.slice(token.start, token.end).trim(),
      );
      return [...new Set(covering.map((token) => token.scopes))];
    };

    for (const [piece, scope] of [
      ["-- Page views per country, with a query parameter for the first day.", "comment.line.sql"],
      ["/* Totals by country. */", "comment.block.sql"],
      ["CREATE", "keyword.other.sql"],
      ["event_time", "variable.other.sql"],
      ["DateTime64", "storage.type.sql"],
      ["MergeTree", "variable.other.sql"],
      ["toStartOfDay", "entity.name.function.sql"],
      ["{start:DateTime}", "variable.parameter.sql"],
      ["'%/docs/%'", "string.quoted.single.sql"],
      ["$$it's a heredoc$$", "string.unquoted.heredoc.sql"],
      ["0x1F", "constant.numeric.sql"],
      ["1.5e-3", "constant.numeric.sql"],
      ["NULL", "constant.language.sql"],
      [">=", "keyword.operator.sql"],
      ["::", "keyword.operator.sql"],
      ["(", "punctuation.sql"],
    ]) {
      assert.deepEqual(scopesOf(piece!), [`${ROOT_SCOPE} ${scope}`], piece);
    }
  });
});
