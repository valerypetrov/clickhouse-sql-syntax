import * as assert from "node:assert/strict";
import * as vscode from "vscode";

const LANGUAGE_ID = "clickhouse-sql";
const global = vscode.ConfigurationTarget.Global;

async function hints(text: string): Promise<string[]> {
  const document = await vscode.workspace.openTextDocument({ language: LANGUAGE_ID, content: text });
  await vscode.window.showTextDocument(document);
  const range = new vscode.Range(new vscode.Position(0, 0), document.positionAt(text.length));
  const found = await vscode.commands.executeCommand<vscode.InlayHint[]>("vscode.executeInlayHintProvider", document.uri, range);
  return found.map((hint) => `${document.offsetAt(hint.position)} ${typeof hint.label === "string" ? hint.label : hint.label.map((p) => p.value).join("")}`);
}

describe("Inlay hints", () => {
  const SQL = "SELECT dateDiff('day', a, b), toDate(x), dateDiff(unit, s, e)";

  afterEach(async () => {
    await vscode.workspace.getConfiguration("clickhouseSql.inlayHints").update("enabled", undefined, global);
    await vscode.workspace.getConfiguration("editor.inlayHints").update("enabled", undefined, global);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("are off by default", async () => {
    assert.deepEqual(await hints(SQL), []);
  });

  it("name the parameters of call arguments, but not of an argument that says it", async () => {
    await vscode.workspace.getConfiguration("clickhouseSql.inlayHints").update("enabled", true, global);
    const at = (part: string) => SQL.indexOf(part);
    assert.deepEqual(await hints(SQL), [
      `${at("'day'")} unit:`, `${at("a, b")} startdate:`, `${at("b)")} enddate:`, `${at("s, e")} startdate:`, `${at("e)")} enddate:`,
    ]);
    const engine = "CREATE TABLE t (a Int, v UInt64) ENGINE = ReplacingMergeTree(v, 1) ORDER BY a";
    assert.deepEqual(await hints(engine), [`${engine.indexOf("v, 1")} ver:`, `${engine.indexOf("1)")} is_deleted:`]);
  });

  it("give the type of a query parameter after the param_name that sets it", async () => {
    await vscode.workspace.getConfiguration("clickhouseSql.inlayHints").update("enabled", true, global);
    const sql = "SET param_n = 5;\nSELECT {n:UInt32} SETTINGS param_n = 6, param_other = 1";
    assert.deepEqual(await hints(sql), [`${"SET param_n".length} : UInt32`, `${sql.lastIndexOf("param_n") + 7} : UInt32`]);
  });

  it("are off where editor.inlayHints.enabled is off", async () => {
    await vscode.workspace.getConfiguration("clickhouseSql.inlayHints").update("enabled", true, global);
    await vscode.workspace.getConfiguration("editor.inlayHints").update("enabled", "off", global);
    assert.deepEqual(await hints(SQL), []);
  });
});
