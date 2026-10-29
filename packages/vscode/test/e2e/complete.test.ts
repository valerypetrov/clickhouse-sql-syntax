import * as assert from "node:assert/strict";
import * as vscode from "vscode";

const LANGUAGE_ID = "clickhouse-sql";
const WAIT_MS = 10_000;

/** Opens an editor with `text`, its cursor at the "|" of the text. */
async function open(text: string): Promise<{ editor: vscode.TextEditor; position: vscode.Position }> {
  const offset = text.indexOf("|");
  const document = await vscode.workspace.openTextDocument({ language: LANGUAGE_ID, content: text.replace("|", "") });
  const editor = await vscode.window.showTextDocument(document);
  const position = document.positionAt(offset);
  editor.selection = new vscode.Selection(position, position);
  return { editor, position };
}

async function items(text: string, trigger?: string): Promise<vscode.CompletionItem[]> {
  const { editor, position } = await open(text);
  const list = await vscode.commands.executeCommand<vscode.CompletionList>(
    "vscode.executeCompletionItemProvider",
    editor.document.uri,
    position,
    trigger,
  );
  return list.items.filter((item) => item.kind !== vscode.CompletionItemKind.Text);
}

function label(item: vscode.CompletionItem): string {
  return typeof item.label === "string" ? item.label : item.label.label;
}

/** Resolves once `ready` is true, polling as VS Code applies an edit. */
async function until(ready: () => boolean, what: string): Promise<void> {
  const start = Date.now();
  while (!ready()) {
    if (Date.now() - start > WAIT_MS) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("Completion, hover and signature help", () => {
  afterEach(() => vscode.commands.executeCommand("workbench.action.closeAllEditors"));

  it("offers functions with brackets and keywords valid at the cursor", async () => {
    const found = await items("SELECT toDa| FROM t");
    const toDate = found.find((item) => label(item) === "toDate")!;
    assert.equal(toDate.kind, vscode.CompletionItemKind.Function);
    assert.equal((toDate.insertText as vscode.SnippetString).value, "toDate($0)");
    assert.match((toDate.documentation as vscode.MarkdownString).value, /Converts an input value to type `Date`/);

    const keywords = (await items("SELECT a |")).filter((item) => item.kind === vscode.CompletionItemKind.Keyword).map(label);
    assert.ok(keywords.includes("FROM"));
    assert.ok(!keywords.includes("SELECT"));
  });

  it("offers engines, formats, settings and data types where they go", async () => {
    assert.ok((await items("CREATE TABLE t (a UInt8) ENGINE = Merge|")).some((item) => label(item) === "MergeTree" && item.kind === vscode.CompletionItemKind.Class));
    assert.ok((await items("SELECT 1 FORMAT JSONE|")).some((item) => label(item) === "JSONEachRow"));
    assert.ok((await items("SELECT 1 SETTINGS max_thr|")).some((item) => label(item) === "max_threads"));
    assert.ok((await items("SELECT CAST(x AS Nulla|")).some((item) => label(item) === "Nullable"));
  });

  it("opens after a space only where a name has to follow", async () => {
    assert.equal((await items("SELECT 1 |", " ")).length, 0);
    assert.ok((await items("SELECT * FROM |", " ")).some((item) => label(item) === "numbers"));
    assert.ok((await items("CREATE TABLE t (a UInt8) ENGINE = |", " ")).some((item) => label(item) === "Memory"));
  });

  it("inserts the chosen function with its brackets and shows its arguments", async () => {
    const { editor } = await open("SELECT toDat|");
    await vscode.commands.executeCommand("editor.action.triggerSuggest");
    // The suggest widget opens asynchronously; accepting before it shows does nothing.
    await until(() => {
      void vscode.commands.executeCommand("acceptSelectedSuggestion");
      return editor.document.getText() !== "SELECT toDat";
    }, "the suggestion to be inserted");
    assert.equal(editor.document.getText(), "SELECT toDate()");
    assert.equal(editor.document.offsetAt(editor.selection.active), "SELECT toDate(".length);

    const help = await vscode.commands.executeCommand<vscode.SignatureHelp>(
      "vscode.executeSignatureHelpProvider",
      editor.document.uri,
      editor.selection.active,
    );
    assert.equal(help.signatures[0]!.label, "toDate(x)");
    assert.equal(help.activeParameter, 0);
  });

  it("gives signature help for the argument at the cursor", async () => {
    const { editor, position } = await open("SELECT quantile(0.5)(x|) FROM t");
    const help = await vscode.commands.executeCommand<vscode.SignatureHelp>("vscode.executeSignatureHelpProvider", editor.document.uri, position);
    const signature = help.signatures[0]!;
    assert.equal(signature.label, "quantile(level)(expr)");
    assert.deepEqual(
      signature.parameters.map((p) => p.label),
      [
        [9, 14],
        [16, 20],
      ],
    );
    assert.equal(help.activeParameter, 1);

    const second = await open("SELECT substring('abc', 2|)");
    const substring = await vscode.commands.executeCommand<vscode.SignatureHelp>(
      "vscode.executeSignatureHelpProvider",
      second.editor.document.uri,
      second.position,
    );
    assert.equal(substring.activeParameter, 1);
  });

  it("shows the documentation of functions and settings on hover", async () => {
    const { editor } = await open("SELECT toDate(x) FROM t SETTINGS max_threads = 1|");
    const hover = async (offset: number) => {
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        "vscode.executeHoverProvider",
        editor.document.uri,
        editor.document.positionAt(offset),
      );
      return hovers.flatMap((h) => h.contents.map((c) => (c as vscode.MarkdownString).value)).join("\n");
    };
    const text = editor.document.getText();
    assert.match(await hover(text.indexOf("toDate") + 2), /Converts an input value to type `Date`/);
    assert.match(await hover(text.indexOf("max_threads") + 2), /The maximum number of query processing threads/);
    assert.equal(await hover(text.indexOf("FROM") + 1), "");
  });
});
