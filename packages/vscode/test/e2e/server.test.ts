import * as assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import type { ServerApi } from "../../src/server/index.js";

// These tests start a real server: CLICKHOUSE_BINARY=<clickhouse> [CLICKHOUSE_SERVER_DIR=<dir>] npm run test:vscode.
const BINARY = process.env.CLICKHOUSE_BINARY;
const USER = "vscode";
const PASSWORD = "pässwörd 1";
const WAIT_MS = 15_000;

const QUERY = `CREATE MATERIALIZED VIEW logs.unique_message_keys_mv_365 on cluster '{cluster}' TO logs.unique_message_keys_replicated AS SELECT
       Timestamp as timestamp, component_type as component_type, log_type as log_type, mapKeys(message) as message_keys FROM
       logs.rc_logs_replicated_365 GROUP BY component_type, log_type, timestamp, message_key;`;
const FIXED = QUERY.replace("message_key;", "message_keys;");

/** A request the extension sent, as the proxy in front of the server saw it. */
interface Sent {
  sql: string;
  params: URLSearchParams;
  status: number;
}

function config(dir: string, port: number): string {
  const user = (name: string, password: string) =>
    `<${name}><password>${password}</password><networks><ip>127.0.0.1</ip></networks><profile>default</profile><quota>default</quota></${name}>`;
  return `<clickhouse>
    <logger><level>information</level><log>${dir}/log/server.log</log><errorlog>${dir}/log/error.log</errorlog><console>0</console></logger>
    <listen_host>127.0.0.1</listen_host>
    <http_port>${port}</http_port>
    <path>${dir}/data/</path>
    <tmp_path>${dir}/tmp/</tmp_path>
    <user_files_path>${dir}/user_files/</user_files_path>
    <format_schema_path>${dir}/format_schemas/</format_schema_path>
    <query_log><database>system</database><table>query_log</table><flush_interval_milliseconds>1000</flush_interval_milliseconds></query_log>
    <profiles><default/></profiles>
    <quotas><default/></quotas>
    <users>${user("default", "")}${user(USER, PASSWORD)}</users>
  </clickhouse>`;
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** Resolves with the first value of `poll` that is not undefined, polling until `timeoutMs` runs out. */
async function until<T>(what: string, poll: () => T | undefined | Promise<T | undefined>, timeoutMs = WAIT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await poll();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function serverDiagnostics(document: vscode.TextDocument): vscode.Diagnostic[] {
  return vscode.languages.getDiagnostics(document.uri).filter((d) => d.source === "ClickHouse server");
}

async function open(content: string): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument({ language: "clickhouse-sql", content });
  return vscode.window.showTextDocument(document);
}

/** The completion items at the "|" of `text`, as label and detail. */
async function completions(text: string, kind: vscode.CompletionItemKind, trigger?: string): Promise<string[][]> {
  const editor = await open(text.replace("|", ""));
  const position = editor.document.positionAt(text.indexOf("|"));
  const list = await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", editor.document.uri, position, trigger);
  const items = list.items.filter((item) => item.kind === kind);
  return items.map((item) => [typeof item.label === "string" ? item.label : item.label.label, item.detail ?? ""]).sort();
}

async function replaceAll(editor: vscode.TextEditor, text: string): Promise<void> {
  const document = editor.document;
  const whole = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
  assert.ok(await editor.edit((edit) => edit.replace(whole, text)));
}

describe("ClickHouse server check", function () {
  const sent: Sent[] = [];
  let dir: string;
  let clickhouse: ChildProcess;
  let port: number;
  let proxy: Server;
  let api: ServerApi;
  const settings = () => vscode.workspace.getConfiguration("clickhouseSql.server");
  const global = vscode.ConfigurationTarget.Global;

  /** Runs a query on the server as the default user, past the proxy. */
  async function admin(sql: string): Promise<string> {
    const reply = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: sql });
    const body = await reply.text();
    assert.ok(reply.ok, body);
    return body;
  }

  async function rows(sql: string): Promise<Record<string, string>[]> {
    return (await admin(`${sql} FORMAT JSONEachRow`)).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  before(async function () {
    if (!BINARY) this.skip();
    this.timeout(120_000);
    const parent = process.env.CLICKHOUSE_SERVER_DIR ?? tmpdir();
    mkdirSync(parent, { recursive: true });
    dir = mkdtempSync(join(parent, "server-"));
    port = await freePort();
    writeFileSync(join(dir, "config.xml"), config(dir, port));
    clickhouse = spawn(BINARY!, ["server", "--config-file", join(dir, "config.xml")], { cwd: dir, stdio: "ignore" });
    const ping = () => fetch(`http://127.0.0.1:${port}/ping`).then((r) => r.ok || undefined, () => undefined);
    await until("the server to start", ping, 90_000);
    await admin("CREATE DATABASE logs");
    await admin(
      "CREATE TABLE logs.rc_logs_replicated_365 (Timestamp DateTime, component_type String, log_type String, message Map(String, String)) ENGINE = MergeTree ORDER BY Timestamp",
    );
    await admin(
      "CREATE TABLE logs.unique_message_keys_replicated (timestamp DateTime, component_type String, log_type String, message_keys Array(String)) ENGINE = MergeTree ORDER BY timestamp",
    );

    // A proxy in front of the server shows every request that the extension makes.
    proxy = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const sql = Buffer.concat(chunks).toString();
      const reply = await fetch(`http://127.0.0.1:${port}${request.url}`, {
        method: request.method,
        headers: { authorization: request.headers.authorization ?? "" },
        body: sql,
      });
      const body = Buffer.from(await reply.arrayBuffer());
      sent.push({ sql, params: new URL(request.url!, "http://proxy").searchParams, status: reply.status });
      const code = reply.headers.get("X-ClickHouse-Exception-Code");
      response.writeHead(reply.status, code ? { "X-ClickHouse-Exception-Code": code } : {});
      response.end(body);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));

    api = (await vscode.extensions.getExtension<ServerApi>("valerypetrov.clickhouse-sql")!.activate())!;
    await settings().update("url", `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, global);
    await settings().update("user", USER, global);
    await vscode.commands.executeCommand("clickhouseSql.server.setPassword", PASSWORD);
    await settings().update("enabled", true, global);
  });

  after(async function () {
    if (!BINARY) return;
    this.timeout(60_000);
    await vscode.commands.executeCommand("clickhouseSql.server.setPassword", "");
    for (const key of ["enabled", "url", "user"]) await settings().update(key, undefined, global);
    proxy?.close();
    const running = () => clickhouse?.exitCode === null && clickhouse.signalCode === null;
    if (running()) {
      const exited = new Promise((resolve) => clickhouse.once("exit", resolve));
      clickhouse.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 30_000))]);
      if (running()) clickhouse.kill("SIGKILL");
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => vscode.commands.executeCommand("workbench.action.closeAllEditors"));

  it("marks the identifier the server does not know, until it is fixed", async () => {
    const editor = await open(QUERY);
    const found = await until("a server diagnostic", () => {
      const diagnostics = serverDiagnostics(editor.document);
      return diagnostics.length ? diagnostics : undefined;
    });
    assert.equal(found.length, 1);
    const [diagnostic] = found as [vscode.Diagnostic];
    assert.equal(editor.document.getText(diagnostic.range), "message_key");
    assert.match(diagnostic.message, /^Unknown expression identifier `message_key`/);
    assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Error);
    assert.equal(diagnostic.code, "UNKNOWN_IDENTIFIER");

    const select = QUERY.slice(QUERY.indexOf("SELECT"), QUERY.length - 1);
    const explained = sent.find((request) => request.sql === `EXPLAIN QUERY TREE ${select}`);
    assert.ok(explained, "only the SELECT of the view is explained");
    assert.equal(explained.params.get("readonly"), "1");

    const before = sent.length;
    await replaceAll(editor, FIXED);
    await until("the fixed query to be explained", () => sent.slice(before).find((r) => r.sql.endsWith("message_keys") && r.status === 200));
    await until("the diagnostic to go", () => serverDiagnostics(editor.document).length === 0 || undefined);
  });

  it("lists databases, tables and columns, cached until Refresh Schema", async () => {
    assert.ok((await api.schema.databases()).includes("logs"));
    assert.deepEqual(await api.schema.tables("logs"), ["rc_logs_replicated_365", "unique_message_keys_replicated"]);
    assert.deepEqual(await api.schema.columns("logs", "rc_logs_replicated_365"), [
      { name: "Timestamp", type: "DateTime" },
      { name: "component_type", type: "String" },
      { name: "log_type", type: "String" },
      { name: "message", type: "Map(String, String)" },
    ]);
    const before = sent.length;
    await api.schema.tables("logs");
    assert.equal(sent.length, before, "the second call is answered from the cache");
    await vscode.commands.executeCommand("clickhouseSql.server.refreshSchema");
    await api.schema.tables("logs");
    assert.ok(sent.slice(before).some((request) => request.sql.includes("FROM system.tables")));
  });

  it("completes the databases, tables and columns of the server", async () => {
    const columns = [
      ["Timestamp", "DateTime"],
      ["component_type", "String"],
      ["log_type", "String"],
      ["message", "Map(String, String)"],
    ];
    const { Field, Module, Struct } = vscode.CompletionItemKind;
    assert.deepEqual(await completions("SELECT | FROM logs.rc_logs_replicated_365", Field), columns);
    assert.deepEqual(await completions("SELECT t.| FROM logs.rc_logs_replicated_365 AS t", Field, "."), columns);
    assert.deepEqual(await completions("SELECT * FROM logs.|", Struct, "."), [
      ["rc_logs_replicated_365", "logs"],
      ["unique_message_keys_replicated", "logs"],
    ]);
    for (const text of ["SELECT * FROM |", "SELECT * FROM logs.rc_logs_replicated_365 JOIN |", "INSERT INTO |"])
      assert.ok((await completions(text, Module, " ")).some(([name]) => name === "logs"), text);

    await settings().update("database", "logs", global);
    try {
      assert.deepEqual(await completions("SELECT | FROM rc_logs_replicated_365", Field), columns);
    } finally {
      await settings().update("database", undefined, global);
    }
  });

  it("completes without the names of a server that does not answer", async () => {
    const silent = createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const url = settings().get<string>("url");
    await settings().update("url", `http://127.0.0.1:${(silent.address() as AddressInfo).port}`, global);
    try {
      const editor = await open("SELECT * FROM ");
      const start = Date.now();
      const list = await vscode.commands.executeCommand<vscode.CompletionList>(
        "vscode.executeCompletionItemProvider",
        editor.document.uri,
        editor.document.positionAt(14),
      );
      assert.ok(Date.now() - start < 3_000, "completion does not wait for the 5 s timeout");
      assert.ok(list.isIncomplete);
      assert.ok(list.items.some((item) => item.label === "numbers"));
      assert.ok(!list.items.some((item) => item.kind === vscode.CompletionItemKind.Module));
    } finally {
      await settings().update("url", url, global);
      silent.closeAllConnections();
      silent.close();
    }
  });

  it("notes a wrong password once and shows no diagnostics for it", async () => {
    const editor = await open(QUERY);
    const notes = api.connection.notes;
    const before = sent.length;
    const refused = () => sent.slice(before).filter((request) => request.status === 403).length;
    await vscode.commands.executeCommand("clickhouseSql.server.setPassword", "wrong");
    await until("a refused request", () => refused() || undefined);
    for (let edit = 0; edit < 3; edit++) {
      const count = refused();
      await editor.edit((builder) => builder.insert(editor.document.positionAt(0), " "));
      await until("one more refused request", () => refused() > count || undefined);
    }
    assert.equal(api.connection.notes, notes + 1);
    assert.match(api.connection.problem!, /Authentication failed/);
    assert.deepEqual(serverDiagnostics(editor.document), []);
  });

  it("sends nothing when it is turned off", async () => {
    await settings().update("enabled", false, global);
    const before = sent.length;
    const editor = await open(QUERY);
    await editor.edit((edit) => edit.insert(editor.document.positionAt(0), " "));
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    assert.deepEqual(await api.schema.databases(), []);
    assert.equal(sent.length, before);
    assert.deepEqual(serverDiagnostics(editor.document), []);
    assert.equal(api.connection.problem, undefined);
  });

  it("never creates or runs anything on the server", async () => {
    assert.ok(sent.length > 0);
    for (const request of sent) {
      assert.equal(request.params.get("readonly"), "1", request.sql);
      assert.match(request.sql, /^(EXPLAIN QUERY TREE |SELECT .* FROM system\.(databases|tables|columns)\b)/s);
    }
    await admin("SYSTEM FLUSH LOGS");
    const logged = await rows(`SELECT DISTINCT query_kind, query FROM system.query_log WHERE user = '${USER}'`);
    assert.ok(logged.some((row) => row.query_kind === "Explain"));
    for (const row of logged) {
      const explain = row.query_kind === "Explain" && row.query!.startsWith("EXPLAIN QUERY TREE ");
      const schema = row.query_kind === "Select" && /^SELECT .* FROM system\.(databases|tables|columns)\b/s.test(row.query!);
      assert.ok(explain || schema, row.query);
    }
    const tables = await rows("SELECT name FROM system.tables WHERE database = 'logs' ORDER BY name");
    assert.deepEqual(tables.map((row) => row.name), ["rc_logs_replicated_365", "unique_message_keys_replicated"]);
  });
});
