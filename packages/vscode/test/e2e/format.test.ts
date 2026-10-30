import * as assert from "node:assert/strict";
import { format } from "clickhouse-sql-syntax";
import * as vscode from "vscode";

const LANGUAGE_ID = "clickhouse-sql";

async function open(content: string, options: vscode.TextEditorOptions = { tabSize: 4, insertSpaces: true }): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument({ language: LANGUAGE_ID, content });
  const editor = await vscode.window.showTextDocument(document);
  editor.options = options;
  return editor;
}

async function formatDocument(editor: vscode.TextEditor): Promise<string> {
  await vscode.commands.executeCommand("editor.action.formatDocument");
  return editor.document.getText();
}

const SQL = [
  "-- Views per day.",
  "select toStartOfDay(t) as day, count() from hits where url like '%/docs/%' group by day order by day;",
  "select a from (select 1 as a) where a in (select 1)",
].join("\n");

const global = vscode.ConfigurationTarget.Global;

describe("Formatting ClickHouse SQL", () => {
  afterEach(async () => {
    await vscode.workspace.getConfiguration("clickhouseSql.format").update("keywordCase", undefined, global);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("Format Document gives the output of format() for a file", async () => {
    const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0]!.uri, "sample.chsql");
    const document = await vscode.workspace.openTextDocument(uri);
    const original = document.getText();
    const editor = await vscode.window.showTextDocument(document);
    editor.options = { tabSize: 4, insertSpaces: true };
    try {
      const formatted = await formatDocument(editor);
      assert.equal(formatted, format(original));
      assert.notEqual(formatted, original);
    } finally {
      await vscode.commands.executeCommand("workbench.action.files.revert");
    }
  });

  it("indents by the tab size of the editor", async () => {
    const editor = await open(SQL, { tabSize: 2, insertSpaces: true });
    assert.equal(await formatDocument(editor), format(SQL, { indentSize: 2 }));
  });

  it("indents with tabs when the editor does", async () => {
    const editor = await open(SQL, { tabSize: 8, insertSpaces: false });
    const expected = format(SQL, { indentSize: 1 }).replace(/^ +/gm, (spaces) => "\t".repeat(spaces.length));
    assert.equal(await formatDocument(editor), expected);
    assert.match(expected, /^\tcount\(\)$/m);
  });

  it("writes keywords in the case of the clickhouseSql.format.keywordCase setting", async () => {
    await vscode.workspace.getConfiguration("clickhouseSql.format").update("keywordCase", "lower", global);
    const editor = await open(SQL);
    assert.equal(await formatDocument(editor), format(SQL, { keywordCase: "lower" }));

    await vscode.workspace.getConfiguration("clickhouseSql.format").update("keywordCase", "preserve", global);
    const second = await open("select a FROM t");
    assert.equal(await formatDocument(second), "select a\nFROM t");
  });

  it("Format Selection formats only the statements that the selection touches", async () => {
    const editor = await open("select  1;\nselect a,b from t;\nselect  3;");
    // A selection inside the second statement, from "a" to "b".
    editor.selection = new vscode.Selection(new vscode.Position(1, 7), new vscode.Position(1, 10));
    await vscode.commands.executeCommand("editor.action.formatSelection");
    assert.equal(editor.document.getText(), "select  1;\nSELECT\n    a,\n    b\nFROM t;\nselect  3;");

    // A selection across the first two statements.
    editor.selection = new vscode.Selection(new vscode.Position(0, 3), new vscode.Position(1, 2));
    await vscode.commands.executeCommand("editor.action.formatSelection");
    assert.equal(editor.document.getText(), "SELECT 1;\n\nSELECT\n    a,\n    b\nFROM t;\nselect  3;");
  });

  it("Format Selection of whole lines leaves the statement on the next line alone", async () => {
    const editor = await open("select  1;\nselect  2;\nselect  3;");
    editor.selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(2, 0));
    await vscode.commands.executeCommand("editor.action.formatSelection");
    assert.equal(editor.document.getText(), "select  1;\nSELECT 2;\nselect  3;");
  });

  it("leaves a statement with a syntax error as it is", async () => {
    const sql = "select  1;\nselect count(* from hits;\nselect a,b from t";
    const editor = await open(sql);
    const formatted = await formatDocument(editor);
    assert.equal(formatted, "SELECT 1;\n\nselect count(* from hits;\n\nSELECT\n    a,\n    b\nFROM t");
    assert.equal(formatted, format(sql));
  });

  it("re-cases only the words that ClickHouse reads as keywords", async () => {
    const sql = "update metrics set value = 42 where id = 1;\nselect case offset when 0 then 'first' else 'later' end from kafka;\nselect * except format from t";
    const editor = await open(sql);
    const formatted = await formatDocument(editor);
    assert.equal(
      formatted,
      "UPDATE metrics SET value = 42 WHERE id = 1;\n\nSELECT CASE offset WHEN 0 THEN 'first' ELSE 'later' END\nFROM kafka;\n\nSELECT * EXCEPT format\nFROM t",
    );
  });

  it("Format Selection after inline data with a quote in it changes only the selected statement", async () => {
    const sql = "insert into people format CSV\n1,O'Brien\n\nupdate metrics set value = 42 where id = 1;\nselect  1;";
    const editor = await open(sql);
    editor.selection = new vscode.Selection(new vscode.Position(4, 8), new vscode.Position(4, 9));
    await vscode.commands.executeCommand("editor.action.formatSelection");
    assert.equal(editor.document.getText(), "insert into people format CSV\n1,O'Brien\n\nupdate metrics set value = 42 where id = 1;\nSELECT 1;");
  });

  it("keeps CRLF with line breaks in strings, in literals kept as written and after line comments", async () => {
    const sql = "-- head\r\nselect 'a\r\nb' as s, [1,\r\n2]::Array(UInt8) as a -- two\r\nfrom t;\r\nselect 2\r\n";
    const editor = await open(sql);
    assert.equal(editor.document.eol, vscode.EndOfLine.CRLF);
    const formatted = await formatDocument(editor);
    assert.equal(formatted, format(sql));
    assert.equal(formatted, "-- head\r\nSELECT\r\n    'a\r\nb' AS s,\r\n    [1,\r\n2]::Array(UInt8) AS a -- two\r\nFROM t;\r\n\r\nSELECT 2\r\n");
    assert.equal(await formatDocument(editor), formatted);
  });

  it("keeps the CRLF line breaks of a document", async () => {
    const sql = "select a,b -- two columns\r\nfrom t;\r\nselect 2\r\n";
    const editor = await open(sql);
    assert.equal(editor.document.eol, vscode.EndOfLine.CRLF);
    const formatted = await formatDocument(editor);
    assert.equal(formatted, format(sql));
    assert.equal(formatted, "SELECT\r\n    a,\r\n    b -- two columns\r\nFROM t;\r\n\r\nSELECT 2\r\n");
  });
});
