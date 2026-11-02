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
    // After the comma before an argument that takes a time zone, but not before any expression.
    assert.ok((await items("SELECT toTimeZone(now(), |)", " ")).some((item) => label(item) === "UTC"));
    assert.ok((await items("SELECT toTimeZone(now(),|)", ",")).some((item) => label(item) === "UTC"));
    assert.equal((await items("SELECT f(a, |)", " ")).length, 0);
    assert.equal((await items("SELECT a,|", ",")).length, 0);
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
    // The cursor can move a moment after the text changes.
    await until(() => editor.document.offsetAt(editor.selection.active) === "SELECT toDate(".length, "the cursor inside the brackets");

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

  it("offers what the argument of an engine takes before the expressions that any argument takes", async () => {
    const table = "CREATE TABLE t (k UInt64, ver UInt32, name String) ENGINE = ReplicatedReplacingMergeTree(";
    const first = await items(`${table}|) ORDER BY k`, "(");
    assert.deepEqual(
      first.slice(0, 2).map((item) => [label(item), item.kind]),
      [
        ["'/clickhouse/tables/{shard}/{database}/{table}', '{replica}'", vscode.CompletionItemKind.Value],
        ["'/clickhouse/tables/{uuid}/{shard}', '{replica}'", vscode.CompletionItemKind.Value],
      ],
    );
    assert.ok(first.some((item) => label(item) === "abs"));
    const ver = (await items(`${table}'/p', '{replica}', |) ORDER BY k`)).slice(0, 2).map((item) => [label(item), item.kind, item.detail]);
    assert.deepEqual(ver, [
      ["k", vscode.CompletionItemKind.Field, "UInt64"],
      ["ver", vscode.CompletionItemKind.Field, "UInt32"],
    ]);
    const csv = (await items("CREATE TABLE f (x UInt8) ENGINE = File(CS|)")).find((item) => label(item) === "CSV")!;
    assert.equal(csv.kind, vscode.CompletionItemKind.Constant);
    assert.equal(typeof csv.insertText === "string" ? csv.insertText : csv.insertText?.value, "'CSV'");
  });

  it("inserts the ZooKeeper path and the replica name of a replicated engine at once", async () => {
    const { editor } = await open("CREATE TABLE t (k UInt64) ENGINE = ReplicatedMergeTree(|) ORDER BY k");
    const before = editor.document.getText();
    await vscode.commands.executeCommand("editor.action.triggerSuggest");
    await until(() => {
      void vscode.commands.executeCommand("acceptSelectedSuggestion");
      return editor.document.getText() !== before;
    }, "the suggestion to be inserted");
    assert.equal(
      editor.document.getText(),
      "CREATE TABLE t (k UInt64) ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/{database}/{table}', '{replica}') ORDER BY k",
    );
  });

  it("gives signature help for the argument of an engine at the cursor", async () => {
    const help = async (text: string) => {
      const { editor, position } = await open(text);
      // VS Code 1.90 gives undefined where there is no signature help.
      return vscode.commands.executeCommand<vscode.SignatureHelp | undefined>("vscode.executeSignatureHelpProvider", editor.document.uri, position);
    };
    const replicated = await help("CREATE TABLE t (k UInt64, v UInt32) ENGINE = ReplicatedReplacingMergeTree('/p', '{replica}', v|) ORDER BY k");
    const signature = replicated!.signatures[0]!;
    assert.equal(signature.label, "ReplicatedReplacingMergeTree('zoo_path', 'replica_name'[, ver [, is_deleted]])");
    assert.deepEqual(
      signature.parameters.map((p) => p.label),
      [
        [30, 38],
        [42, 54],
        [58, 61],
        [65, 75],
      ],
    );
    assert.equal(replicated!.activeParameter, 2);
    // After NOSIGN, S3 takes the format.
    const s3 = (await help("CREATE TABLE t (x UInt8) ENGINE = S3('https://b/k.csv', NOSIGN, |)"))!;
    const names = s3.signatures[0]!.parameters.map((p) => s3.signatures[0]!.label.slice(...(p.label as [number, number])));
    assert.deepEqual(names, ["url", "NOSIGN", "access_key_id", "secret_access_key", "session_token", "format", "compression"]);
    assert.equal(s3.activeParameter, 5);
    assert.equal((await help("CREATE TABLE t (x UInt8) ENGINE = MergeTree(|) ORDER BY x"))?.signatures[0]?.label, "MergeTree()");
    // A function in the brackets of an engine has its own.
    const inner = await help("CREATE TABLE t (x UInt8) ENGINE = Distributed(c, db, t, cityHash64(x|))");
    assert.equal(inner?.signatures[0]?.label.split("(")[0], "cityHash64");
  });

  it("offers what the argument of a function takes before the expressions that any argument takes", async () => {
    const inserted = (item: vscode.CompletionItem) => (typeof item.insertText === "string" ? item.insertText : (item.insertText?.value ?? label(item)));
    const types = await items("SELECT JSONExtract('{}', 'a', |)", "(");
    assert.deepEqual([label(types[0]!), types[0]!.kind], ["Array(String)", vscode.CompletionItemKind.TypeParameter]);
    assert.equal(inserted(types[0]!), "'Array(String)'");
    assert.ok(types.some((item) => label(item) === "abs"));
    const units = await items("SELECT dateDiff(|, a, b)", "(");
    assert.deepEqual([label(units[0]!), inserted(units[0]!), units[0]!.kind], ["day", "'day'", vscode.CompletionItemKind.Value]);
    const zone = (await items("SELECT toTimeZone(now(), |)")).find((item) => label(item) === "Europe/Berlin")!;
    assert.equal(inserted(zone), "'Europe/Berlin'");
    const formats = (await items("SELECT formatRow(|, 1)", "(")).map(label);
    assert.ok(formats.includes("CSV") && !formats.includes("Parquet"));
    assert.equal(label((await items("SELECT toStartOfInterval(t, INTERVAL 1 |)"))[0]!), "DAY");
  });

  it("inserts a JSONPath with the cursor inside its quotes", async () => {
    const { editor } = await open("SELECT JSON_VALUE(j, |)");
    await vscode.commands.executeCommand("editor.action.triggerSuggest");
    await until(() => {
      void vscode.commands.executeCommand("acceptSelectedSuggestion");
      return editor.document.getText() !== "SELECT JSON_VALUE(j, )";
    }, "the suggestion to be inserted");
    assert.equal(editor.document.getText(), "SELECT JSON_VALUE(j, '$.')");
    await until(() => editor.document.offsetAt(editor.selection.active) === "SELECT JSON_VALUE(j, '$.".length, "the cursor inside the quotes");
  });

  it("offers the parameters of the JSON type and the typed paths of a JSON column", async () => {
    const parameters = (await items("CREATE TABLE t (j JSON(|)) ENGINE = Memory", "(")).map(label);
    assert.deepEqual(parameters.slice(0, 4), ["max_dynamic_paths", "max_dynamic_types", "SKIP", "SKIP REGEXP"]);
    const table = "CREATE TABLE t (j JSON(a.b UInt32, c String)) ENGINE = Memory;\n";
    const paths = await items(`${table}SELECT j.| FROM t`, ".");
    assert.deepEqual(
      paths.map((item) => [label(item), item.detail]),
      [
        ["a.b", "UInt32"],
        ["c", "String"],
      ],
    );
  });

  it("gives signature help for the argument of a function past optional and repeated parameters", async () => {
    const help = async (text: string) => {
      const { editor, position } = await open(text);
      // VS Code 1.90 gives undefined where there is no signature help.
      return vscode.commands.executeCommand<vscode.SignatureHelp | undefined>("vscode.executeSignatureHelpProvider", editor.document.uri, position);
    };
    const active = (help: vscode.SignatureHelp | undefined) => {
      const signature = help?.signatures[0];
      const parameter = signature?.parameters[help!.activeParameter];
      return typeof parameter?.label === "string" ? parameter.label : parameter && signature!.label.slice(...parameter.label);
    };
    assert.equal(active(await help("SELECT JSONExtract(j, |)")), "return_type");
    assert.equal(active(await help("SELECT JSONExtract(j, 'a', |, 'Int64')")), "indices_or_keys");
    assert.equal(active(await help("SELECT JSONExtract(j, 'a', 'b', |)")), "return_type");
    assert.equal(active(await help("SELECT toStartOfInterval(t, INTERVAL 1 DAY, |)")), "time_zone");
    assert.equal(active(await help("SELECT quantile(|)(x)")), "level");
    assert.equal(active(await help("SELECT quantile(0.5)(|)")), "expr");
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

  it("shows the documentation of what the parser reads as a call where no expression goes", async () => {
    const { editor } = await open(
      [
        "INSERT INTO FUNCTION file('a.csv', 'CSV', 'x UInt8') SELECT 1;",
        "SELECT * FROM remote('h', view(SELECT * FROM numbers(10)));",
        "CREATE TABLE t (s AggregateFunction(quantile(0.5), UInt8)) ENGINE = Memory;",
        "CREATE DICTIONARY d (a UInt8) PRIMARY KEY a SOURCE(CLICKHOUSE(PORT tcpPort() DB currentDatabase() TABLE 't')) LIFETIME(0) LAYOUT(FLAT());",
        "SELECT timestamp('2020-01-01'), DATE('2020-01-01');|",
      ].join("\n"),
    );
    const text = editor.document.getText();
    const hover = async (name: string) => {
      const position = editor.document.positionAt(text.indexOf(`${name}(`) + 1);
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", editor.document.uri, position);
      return hovers.flatMap((h) => h.contents.map((c) => (c as vscode.MarkdownString).value)).join("\n");
    };
    assert.match(await hover("file"), /^A table engine which provides a table-like interface to SELECT from and INSERT into files/);
    assert.match(await hover("view"), /^Turns a subquery into a table/);
    for (const [name, syntax] of [
      ["quantile", "quantile(level)(expr)"],
      ["tcpPort", "tcpPort()"],
      ["currentDatabase", "currentDatabase()"],
      ["timestamp", "timestamp(expr[, expr_time])"],
      ["DATE", "DATE(expr)"],
    ]) {
      assert.ok((await hover(name!)).startsWith(`\`\`\`sql\n${syntax}\n\`\`\``), name);
    }
  });
});
