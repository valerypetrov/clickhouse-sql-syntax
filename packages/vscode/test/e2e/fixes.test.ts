import * as assert from "node:assert/strict";
import * as vscode from "vscode";

const WAIT_MS = 10_000;

async function until<T>(what: string, poll: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await poll();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The quick fixes at the diagnostic of `source` on `word` in a new document of `content`, once it is shown. */
async function quickFixes(content: string, word: string, source: string): Promise<{ editor: vscode.TextEditor; actions: vscode.CodeAction[] }> {
  const document = await vscode.workspace.openTextDocument({ language: "clickhouse-sql", content });
  const editor = await vscode.window.showTextDocument(document);
  const at = document.positionAt(content.indexOf(word) + 1);
  await until(`a diagnostic on ${word}`, () => vscode.languages.getDiagnostics(document.uri).find((d) => d.source === source && d.range.contains(at)));
  const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>("vscode.executeCodeActionProvider", document.uri, new vscode.Range(at, at), vscode.CodeActionKind.QuickFix.value);
  return { editor, actions: actions ?? [] };
}

/** The titles of the actions, with a * for the preferred one. */
const titles = (actions: vscode.CodeAction[]) => actions.map((a) => `${a.isPreferred ? "*" : ""}${a.title}`);

describe("quick fixes", () => {
  afterEach(() => vscode.commands.executeCommand("workbench.action.closeAllEditors"));

  it("renames an unknown setting and the diagnostic goes", async () => {
    const { editor, actions } = await quickFixes("SELECT 1 SETTINGS max_thread = 1", "max_thread", "ClickHouse SQL");
    assert.deepEqual(titles(actions), ["*Change to max_threads"]);
    assert.equal(actions[0]!.kind?.value, vscode.CodeActionKind.QuickFix.value);
    assert.ok(await vscode.workspace.applyEdit(actions[0]!.edit!));
    assert.equal(editor.document.getText(), "SELECT 1 SETTINGS max_threads = 1");
    await until("the diagnostic to go", () => (vscode.languages.getDiagnostics(editor.document.uri).length === 0 ? true : undefined));
  });

  it("writes the keyword that a syntax error hints at", async () => {
    const { actions } = await quickFixes("SELEC 1", "SELEC", "ClickHouse SQL");
    assert.deepEqual(titles(actions), ["*Change to SELECT"]);
  });

  it("adds an ENGINE where default_table_engine is None", async () => {
    const { editor, actions } = await quickFixes("SET default_table_engine = 'None';\nCREATE TABLE t (x UInt64)", "t (", "ClickHouse SQL");
    assert.deepEqual(titles(actions), ["*Add ENGINE = MergeTree ORDER BY tuple()"]);
    assert.ok(await vscode.workspace.applyEdit(actions[0]!.edit!));
    assert.equal(editor.document.getText(), "SET default_table_engine = 'None';\nCREATE TABLE t (x UInt64) ENGINE = MergeTree ORDER BY tuple()");
  });

  it("fixes an unknown error name of a test hint", async () => {
    const { actions } = await quickFixes("SELECT 1; -- { serverError SYNTAX_EROR }", "SYNTAX_EROR", "ClickHouse test");
    assert.deepEqual(titles(actions), ["*Change to SYNTAX_ERROR", "Change to SYSTEM_ERROR"]);
  });
});
