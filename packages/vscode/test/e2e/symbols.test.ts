import * as assert from "node:assert/strict";
import * as vscode from "vscode";

const folder = () => vscode.workspace.workspaceFolders![0]!.uri;
const fixture = (path: string) => vscode.Uri.joinPath(folder(), path);

async function symbols(query = ""): Promise<vscode.SymbolInformation[]> {
  return (await vscode.commands.executeCommand<vscode.SymbolInformation[]>("vscode.executeWorkspaceSymbolProvider", query)) ?? [];
}

/** Each symbol as `kind container.name path:line`, sorted. */
async function listed(query = ""): Promise<string[]> {
  return (await symbols(query))
    .map((s) => `${vscode.SymbolKind[s.kind]} ${s.containerName ? `${s.containerName}.` : ""}${s.name} ${vscode.workspace.asRelativePath(s.location.uri)}:${s.location.range.start.line + 1}`)
    .sort();
}

/** Waits until `check` holds for the symbols, as the file watcher reports changes a little later. */
async function until(check: (names: string[]) => boolean): Promise<string[]> {
  let names: string[] = [];
  for (let i = 0; i < 100; i++) {
    names = (await symbols()).map((s) => s.name);
    if (check(names)) return names;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return names;
}

/** The position of the `nth` occurrence of `text` in the document, `skip` characters into it. */
function at(document: vscode.TextDocument, text: string, nth = 0, skip = 0): vscode.Position {
  let offset = -1;
  for (let i = 0; i <= nth; i++) offset = document.getText().indexOf(text, offset + 1);
  assert.ok(offset >= 0, `${text} is in the document ${nth + 1} times`);
  return document.positionAt(offset + skip);
}

/** Locations as `path:line:column`, sorted. */
function places(locations: (vscode.Location | vscode.LocationLink)[]): string[] {
  return locations
    .map((l) => ("targetUri" in l ? { uri: l.targetUri, range: l.targetRange } : l))
    .map((l) => `${vscode.workspace.asRelativePath(l.uri)}:${l.range.start.line + 1}:${l.range.start.character + 1}`)
    .sort();
}

describe("Workspace symbols", () => {
  afterEach(() => vscode.commands.executeCommand("workbench.action.closeAllEditors"));

  it("Go to Symbol in Workspace finds what the CREATE statements of ClickHouse files make", async () => {
    const found = await listed();
    for (const symbol of [
      "Namespace analytics objects/schema.chsql:1",
      "Struct analytics.events objects/schema.chsql:3",
      "Interface analytics.events_by_kind objects/schema.chsql:4",
      "Key analytics.kinds objects/schema.chsql:5",
      "Function kind_title objects/schema.chsql:6",
      "Struct staging.events objects/staging.chsql:1",
      "Interface staging.recent objects/staging.chsql:2",
      "Struct hits sample.chsql:2",
      "Interface logs.mv keywords-as-names.chsql:1",
    ]) {
      assert.ok(found.includes(symbol), `${symbol} in ${found.join(", ")}`);
    }
    assert.ok(!found.some((symbol) => symbol.includes("ignored_table")), "a plain .sql file is not ClickHouse SQL");
    const narrowed = (await symbols("kndtitle")).map((s) => s.name);
    assert.deepEqual(narrowed, ["kind_title"]);
  });

  it("follows files as they are created, changed and deleted", async function () {
    this.timeout(60_000);
    await symbols();
    const uri = fixture("objects/new.chsql");
    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from("CREATE TABLE fresh_table (x UInt8) ENGINE = Memory;\n"));
      assert.ok((await until((names) => names.includes("fresh_table"))).includes("fresh_table"));
      await vscode.workspace.fs.writeFile(uri, Buffer.from("CREATE TABLE renamed_table (x UInt8) ENGINE = Memory;\n"));
      const renamed = await until((names) => names.includes("renamed_table") && !names.includes("fresh_table"));
      assert.ok(renamed.includes("renamed_table") && !renamed.includes("fresh_table"));
      // A file longer than clickhouseSql.maxFileSize, 5,000,000 characters by default, is left out.
      await vscode.workspace.fs.writeFile(uri, Buffer.from(`CREATE TABLE big_table (x UInt8) ENGINE = Memory;\n${"-- a comment\n".repeat(400_000)}`));
      const big = await until((names) => !names.includes("renamed_table"));
      assert.ok(!big.includes("renamed_table") && !big.includes("big_table"));
    } finally {
      await vscode.workspace.fs.delete(uri);
    }
    assert.ok(!(await until((names) => !names.includes("big_table"))).includes("big_table"));
  });

  it("an open file counts as it is edited", async () => {
    const document = await vscode.workspace.openTextDocument(fixture("objects/staging.chsql"));
    const editor = await vscode.window.showTextDocument(document);
    await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), "CREATE TABLE unsaved_table (x UInt8) ENGINE = Memory;\n"));
    try {
      assert.ok((await symbols()).some((s) => s.name === "unsaved_table"));
    } finally {
      await vscode.commands.executeCommand("workbench.action.files.revert");
    }
    assert.ok(!(await until((names) => !names.includes("unsaved_table"))).includes("unsaved_table"));
  });
});

describe("Tables across files", () => {
  afterEach(() => vscode.commands.executeCommand("workbench.action.closeAllEditors"));

  const definitionsAt = async (document: vscode.TextDocument, position: vscode.Position) =>
    places(await vscode.commands.executeCommand<vscode.Location[]>("vscode.executeDefinitionProvider", document.uri, position));

  it("go from a table name to the CREATE statement in another file, by the database it means", async () => {
    const document = await vscode.workspace.openTextDocument(fixture("objects/queries.chsql"));
    await vscode.window.showTextDocument(document);
    const analytics = "objects/schema.chsql:3:14";
    const staging = "objects/staging.chsql:1:14";
    assert.deepEqual(await definitionsAt(document, at(document, "analytics.events", 0, 12)), [analytics]);
    assert.deepEqual(await definitionsAt(document, at(document, "staging.events", 0, 10)), [staging]);
    // Before USE, the database of the session is not known, so both tables may be meant.
    assert.deepEqual(await definitionsAt(document, at(document, "FROM events", 0, 6)), [analytics, staging]);
    assert.deepEqual(await definitionsAt(document, at(document, "FROM events", 1, 6)), [analytics]);
    assert.deepEqual(await definitionsAt(document, at(document, "kinds")), ["objects/schema.chsql:5:19"]);
    assert.deepEqual(await definitionsAt(document, at(document, "analytics.events")), ["objects/schema.chsql:1:17"]);
    // A CTE of the same name takes the place of the table.
    assert.deepEqual(await definitionsAt(document, at(document, "FROM events", 2, 6)), ["objects/queries.chsql:6:6"]);
  });

  it("go from an opted-in .sql file to the table of a .chsql file", async () => {
    const document = await vscode.workspace.openTextDocument(fixture("opt-in/report.sql"));
    await vscode.window.showTextDocument(document);
    assert.deepEqual(await definitionsAt(document, at(document, "hits")), ["sample.chsql:2:28"]);
  });

  it("find the references of a table in every file", async () => {
    const document = await vscode.workspace.openTextDocument(fixture("objects/schema.chsql"));
    await vscode.window.showTextDocument(document);
    const position = at(document, "events (");
    const references = await vscode.commands.executeCommand<vscode.Location[]>("vscode.executeReferenceProvider", document.uri, position);
    assert.deepEqual(places(references), [
      "objects/queries.chsql:1:21",
      "objects/queries.chsql:2:43",
      // This one may also be staging.events.
      "objects/queries.chsql:3:15",
      "objects/queries.chsql:5:15",
      "objects/schema.chsql:3:14",
      "objects/schema.chsql:4:115",
      "objects/staging.chsql:2:45",
    ]);
  });
});
