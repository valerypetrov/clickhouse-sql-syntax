import * as vscode from "vscode";
import { type Connection, ConnectionError, query, QueryError } from "./client.js";
import { Schema } from "./schema.js";
import { namedSpan, selectQueries, type Span } from "./statements.js";
import { parameters, parameterValuesBefore } from "../parameters.js";
import { userSetting } from "../settings.js";
import { tooLarge } from "../size.js";

const CHECK_DELAY_MS = 500;
const RETRY_MS = 30_000;
const CACHE_SIZE = 1000;
const PASSWORD_KEY = "clickhouseSql.server.password";
// READONLY and UNKNOWN_QUERY_PARAMETER: what checking read-only and without the parameters given elsewhere causes;
// TOO_MANY_ROWS, TIMEOUT_EXCEEDED, TOO_SLOW, MEMORY_LIMIT_EXCEEDED, TOO_MANY_BYTES, TOO_MANY_ROWS_OR_BYTES: the limits.
const UNCHECKABLE = new Set([164, 456, 158, 159, 160, 241, 307, 396]);
// A check sends no new query after this long, so that a file of slow queries costs little per change.
const CHECK_BUDGET_MS = 10_000;

/** What the extension exports: the schema for autocomplete, and the state of the connection. */
export interface ServerApi {
  readonly schema: Schema;
  /** The connection problem now, if any, and how many problems have been noted so far. */
  readonly connection: { readonly problem: string | undefined; readonly notes: number };
}

/** Checks statements against a ClickHouse server, when the clickhouseSql.server settings turn it on. */
export function registerServer(context: vscode.ExtensionContext, languageId: string): ServerApi {
  const connect = () => readConnection(context.secrets);
  const status = new ConnectionStatus();
  const schema = new Schema(connect);
  const check = new ServerCheck(languageId, connect, status);
  const reset = (): void => {
    schema.refresh();
    check.reset();
  };
  context.subscriptions.push(
    status,
    check,
    vscode.workspace.onDidOpenTextDocument((document) => check.schedule(document, 0)),
    vscode.workspace.onDidChangeTextDocument((event) => check.schedule(event.document)),
    vscode.workspace.onDidCloseTextDocument((document) => check.close(document)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("clickhouseSql.server")) reset();
    }),
    context.secrets.onDidChange((event) => {
      if (event.key.startsWith(PASSWORD_KEY)) reset();
    }),
    vscode.commands.registerCommand("clickhouseSql.server.setPassword", (password?: string) => setPassword(context.secrets, password)),
    vscode.commands.registerCommand("clickhouseSql.server.refreshSchema", reset),
  );
  check.recheck();
  return { schema, connection: status };
}

/** The server settings from the user's settings, and the first one whose value does not fit, if any. */
function serverSettings() {
  // The user's settings only: a workspace could otherwise send its SQL, and the user name, to another server.
  let invalid: ConnectionError | undefined;
  const fromUser = <T>(name: string): T => {
    const key = `clickhouseSql.server.${name}`;
    const { value, problem } = userSetting<T>(key);
    if (problem) invalid ??= new ConnectionError(problem, key);
    return value;
  };
  return {
    enabled: fromUser<boolean>("enabled"),
    url: fromUser<string>("url"),
    user: fromUser<string>("user"),
    database: fromUser<string>("database"),
    timeoutMs: fromUser<number>("timeoutMs"),
    invalid,
  };
}

/** The password is kept for one user at one URL, so that no other URL receives it. */
function passwordKey(url: string, user: string): string {
  return `${PASSWORD_KEY}:${user}@${url}`;
}

async function readConnection(secrets: vscode.SecretStorage): Promise<Connection | undefined> {
  const { enabled, invalid, ...settings } = serverSettings();
  if (!enabled) return undefined;
  if (invalid) throw invalid;
  return { ...settings, password: (await secrets.get(passwordKey(settings.url, settings.user))) ?? "" };
}

/** Asks for the password unless it is given; an empty one is removed. */
async function setPassword(secrets: vscode.SecretStorage, password?: string): Promise<void> {
  const { url, user } = serverSettings();
  if (typeof password !== "string") {
    password = await vscode.window.showInputBox({ password: true, ignoreFocusOut: true, prompt: `Password of ${user} at ${url}` });
    if (password === undefined) return;
  }
  const key = passwordKey(url, user);
  await (password ? secrets.store(key, password) : secrets.delete(key));
}

/** A connection problem, shown in the status bar and noted once in the output channel. */
class ConnectionStatus implements vscode.Disposable {
  problem: string | undefined;
  notes = 0;
  private readonly output = vscode.window.createOutputChannel("ClickHouse Server", { log: true });
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);

  failed(error: ConnectionError): void {
    const problem = error.message;
    if (problem === this.problem) return;
    this.problem = problem;
    this.notes++;
    this.output.warn(problem);
    this.item.text = "$(debug-disconnect) ClickHouse";
    const fix = error.setting ? ` Select to open ${error.setting}.` : "";
    this.item.tooltip = `${problem}\nStatements are checked again in ${RETRY_MS / 1000} s, and at once when a clickhouseSql.server setting changes.${fix}`;
    // The settings editor, at the setting that would fix the problem.
    this.item.command = error.setting ? { title: "Open the setting", command: "workbench.action.openSettings", arguments: [error.setting] } : undefined;
    this.item.show();
  }

  connected(): void {
    if (this.problem !== undefined) this.output.info("The server answers again.");
    this.clear();
  }

  /** Forgets the problem, as when the settings change. */
  clear(): void {
    this.problem = undefined;
    this.item.hide();
  }

  dispose(): void {
    this.output.dispose();
    this.item.dispose();
  }
}

/** Explains the SELECT queries of each document to the server and shows its errors. */
class ServerCheck implements vscode.Disposable {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("clickhouse-sql-server");
  /** The error of each query text, or null when it has none. */
  private readonly results = new Map<string, QueryError | null>();
  private readonly timers = new Map<vscode.TextDocument, ReturnType<typeof setTimeout>>();
  private readonly running = new Map<vscode.TextDocument, AbortController>();
  private retry: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly languageId: string,
    private readonly connect: () => Promise<Connection | undefined>,
    private readonly status: ConnectionStatus,
  ) {}

  schedule(document: vscode.TextDocument, delay = CHECK_DELAY_MS): void {
    this.cancel(document);
    if (document.languageId !== this.languageId) return;
    if (tooLarge(document)) {
      this.diagnostics.delete(document.uri);
      return;
    }
    this.timers.set(document, setTimeout(() => void this.run(document), delay));
  }

  close(document: vscode.TextDocument): void {
    this.cancel(document);
    this.diagnostics.delete(document.uri);
  }

  /** Checks every open document again. */
  recheck(): void {
    clearTimeout(this.retry);
    this.retry = undefined;
    vscode.workspace.textDocuments.forEach((document) => this.schedule(document, 0));
  }

  /** Forgets all results and the connection problem, and checks every open document again. */
  reset(): void {
    this.results.clear();
    this.diagnostics.clear();
    this.status.clear();
    this.recheck();
  }

  dispose(): void {
    [...this.timers.keys(), ...this.running.keys()].forEach((document) => this.cancel(document));
    clearTimeout(this.retry);
    this.diagnostics.dispose();
  }

  private cancel(document: vscode.TextDocument): void {
    clearTimeout(this.timers.get(document));
    this.timers.delete(document);
    this.running.get(document)?.abort();
    this.running.delete(document);
  }

  private async run(document: vscode.TextDocument): Promise<void> {
    this.timers.delete(document);
    const abort = new AbortController();
    this.running.set(document, abort);
    try {
      const found = await this.problems(document, abort.signal);
      if (!abort.signal.aborted) this.diagnostics.set(document.uri, found);
    } catch (error) {
      if (abort.signal.aborted) return;
      if (!(error instanceof ConnectionError)) throw error;
      this.status.failed(error);
      this.retry ??= setTimeout(() => this.recheck(), RETRY_MS);
    } finally {
      if (this.running.get(document) === abort) this.running.delete(document);
    }
  }

  private async problems(document: vscode.TextDocument, signal: AbortSignal): Promise<vscode.Diagnostic[]> {
    const connection = await this.connect();
    if (!connection) return [];
    const text = document.getText();
    const found: vscode.Diagnostic[] = [];
    const deadline = Date.now() + CHECK_BUDGET_MS;
    const settings = text.includes("param_") ? parameters(text).settings : [];
    for (const query of selectQueries(text)) {
      const values = parameterValuesBefore(settings, query.start);
      const key = resultKey(query.sql, values);
      if (Date.now() > deadline && !this.results.has(key)) continue;
      const error = await this.explain(connection, query.sql, values, signal);
      if (error) found.push(toDiagnostic(document, text, query, error));
    }
    return found;
  }

  private async explain(connection: Connection, sql: string, values: Record<string, string>, signal: AbortSignal): Promise<QueryError | null> {
    const key = resultKey(sql, values);
    let result = this.results.get(key);
    if (result !== undefined) return result;
    try {
      await query(connection, `EXPLAIN QUERY TREE ${sql}`, {}, signal, values);
      result = null;
    } catch (error) {
      if (!(error instanceof QueryError)) throw error;
      result = UNCHECKABLE.has(error.code) ? null : error;
    }
    this.status.connected();
    if (this.results.size >= CACHE_SIZE) this.results.delete(this.results.keys().next().value!);
    this.results.set(key, result);
    return result;
  }
}

/** The key of a result: the query, and the values of the parameters it was checked with. */
function resultKey(sql: string, values: Record<string, string>): string {
  return Object.keys(values).length ? `${sql}\0${JSON.stringify(values)}` : sql;
}

function toDiagnostic(document: vscode.TextDocument, text: string, query: Span, error: QueryError): vscode.Diagnostic {
  const span = namedSpan(text, query, error.message) ?? query;
  const range = new vscode.Range(document.positionAt(span.start), document.positionAt(span.end));
  const diagnostic = new vscode.Diagnostic(range, error.message, vscode.DiagnosticSeverity.Error);
  diagnostic.source = "ClickHouse server";
  if (error.codeName) diagnostic.code = error.codeName;
  return diagnostic;
}
