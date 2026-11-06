import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import type { ServerApi } from "../../src/server/index.js";

const WAIT_MS = 10_000;

async function open(content: string): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument({ language: "clickhouse-sql", content });
  return vscode.window.showTextDocument(document);
}

async function until<T>(what: string, poll: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await poll();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The labels offered at the "|" of `text`; VS Code 1.90 can give undefined for none. */
async function labels(text: string, trigger?: string): Promise<string[]> {
  const editor = await open(text.replace("|", ""));
  const position = editor.document.positionAt(text.indexOf("|"));
  const list = await vscode.commands.executeCommand<vscode.CompletionList | undefined>("vscode.executeCompletionItemProvider", editor.document.uri, position, trigger);
  return (list?.items ?? []).filter((item) => item.kind !== vscode.CompletionItemKind.Text).map((item) => (typeof item.label === "string" ? item.label : item.label.label));
}

async function hover(text: string, at: string): Promise<string> {
  const editor = await open(text);
  const position = editor.document.positionAt(text.indexOf(at) + 1);
  const hovers = await vscode.commands.executeCommand<vscode.Hover[] | undefined>("vscode.executeHoverProvider", editor.document.uri, position);
  return (hovers ?? []).flatMap((h) => h.contents.map((c) => (c as vscode.MarkdownString).value)).join("\n");
}

function diagnostics(document: vscode.TextDocument, source: string): string[] {
  return vscode.languages.getDiagnostics(document.uri).filter((d) => d.source === source).map((d) => `${document.getText(d.range)}: ${d.message}`);
}

describe("options in .sql files", () => {
  afterEach(() => vscode.commands.executeCommand("workbench.action.closeAllEditors"));

  it("completes the type of a query parameter after its colon", async () => {
    const types = await labels("SELECT {x:|}", ":");
    assert.ok(types.includes("UInt64") && types.includes("Identifier"), types.join());
    assert.deepEqual(await labels("SELECT * FROM {t:|}", ":"), ["Identifier"]);
    // Any other colon opens nothing by itself.
    assert.deepEqual(await labels("SELECT a ? b :|", ":"), []);
    assert.deepEqual(await labels("SELECT {n:UInt8};\nSET param_|"), ["param_n"]);
  });

  it("documents query parameters, test hints and tags", async () => {
    assert.match(await hover("SET param_n = 3;\nSELECT {n:UInt8}", "{n"), /Query parameter `n`[\s\S]*Set by `param_n` on line 1/);
    assert.match(await hover("SELECT 1; -- { serverError UNKNOWN_TABLE }", "UNKNOWN"), /UNKNOWN_TABLE\*\*: error code 60/);
    assert.match(await hover("-- Tags: no-fasttest\nSELECT 1", "no-fast"), /Skipped in the Fast test/);
  });

  it("completes test hints and tags in comments", async () => {
    assert.ok((await labels("SELECT 1; -- { serverError UNKNOWN_T| }")).includes("UNKNOWN_TABLE"));
    assert.ok((await labels("SELECT 1; -- { |")).includes("clientError"));
    assert.ok((await labels("-- Tags: no-fasttest, |\nSELECT 1")).includes("no-parallel"));
  });

  it("marks what makes clickhouse-client and clickhouse-test stop", async () => {
    const editor = await open("-- Tags: no-stress\nSELECT 1; -- { serverError NO_SUCH_ERROR }\nSELECT (; -- { serverError SYNTAX_ERROR }\n");
    const found = await until("the test diagnostics", () => {
      const list = diagnostics(editor.document, "ClickHouse test");
      return list.length === 3 ? list : undefined;
    });
    assert.deepEqual(found, [
      "no-stress: clickhouse-test refuses the no-stress tag: stress tests must be able to run every test.",
      "NO_SUCH_ERROR: No error code with name: 'NO_SUCH_ERROR'",
      "{ serverError SYNTAX_ERROR }: clickhouse-client rejects this statement before it reaches the server, so serverError does not expect its error; write clientError, as clientError SYNTAX_ERROR.",
    ]);
  });

  it("leaves the statements of another dialect unchecked", async () => {
    const editor = await open("SET allow_experimental_kusto_dialect = 1, dialect = 'kusto';\nprint 1;\nSET dialect = 'clickhouse';\nSELECT (;\n");
    const found = await until("the syntax error after the dialect returns", () => {
      const list = diagnostics(editor.document, "ClickHouse SQL");
      return list.length ? list : undefined;
    });
    assert.equal(found.length, 1);
    assert.match(found[0]!, /Unmatched parentheses/);
  });
});

describe("settings with wrong values", () => {
  const global = vscode.ConfigurationTarget.Global;
  const server = () => vscode.workspace.getConfiguration("clickhouseSql.server");
  let api: ServerApi;

  before(async () => {
    api = (await vscode.extensions.getExtension<ServerApi>("valerypetrov.clickhouse-sql")!.activate())!;
  });

  afterEach(async () => {
    for (const key of ["enabled", "url", "timeoutMs"]) await server().update(key, undefined, global);
    await vscode.workspace.getConfiguration("clickhouseSql.format").update("keywordCase", undefined, global);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("formats with the default keyword case when the setting's value is not one of its values", async () => {
    await vscode.workspace.getConfiguration("clickhouseSql.format").update("keywordCase", "Lower", global);
    const editor = await open("select 1");
    const edits = await vscode.commands.executeCommand<vscode.TextEdit[] | undefined>("vscode.executeFormatDocumentProvider", editor.document.uri, {
      tabSize: 4,
      insertSpaces: true,
    });
    assert.deepEqual(edits?.map((edit) => edit.newText), ["SELECT"]);
  });

  it("shows a wrong server setting as the connection problem, by its name", async () => {
    await server().update("url", "localhost:8123", global);
    await server().update("enabled", true, global);
    await open("SELECT 1");
    const problem = await until("the connection problem", () => api.connection.problem);
    assert.equal(problem, 'clickhouseSql.server.url is "localhost:8123": An http:// or https:// URL of the HTTP interface, such as http://localhost:8123.');
    await server().update("url", undefined, global);
    await server().update("timeoutMs", 0, global);
    const timeout = await until("the timeout problem", () => (api.connection.problem?.includes("timeoutMs") ? api.connection.problem : undefined));
    assert.equal(timeout, "clickhouseSql.server.timeoutMs must be a whole number from 1 to 2147483647, not 0");
  });
});
