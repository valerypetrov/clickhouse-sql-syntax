import * as vscode from "vscode";
import { checkWithRoles, type Diagnostic as SyntaxError, ParseCache } from "clickhouse-sql-syntax";
import { registerCompletion } from "./complete.js";
import { registerFolding } from "./folding.js";
import { registerFormatter } from "./format.js";
import { registerHover } from "./hover.js";
import { registerOutline } from "./outline.js";
import { registerSelectionRanges } from "./selection.js";
import { registerNames } from "./names.js";
import { registerSemanticTokens } from "./semantic.js";
import { registerServer, type ServerApi } from "./server/index.js";
import { registerSignatureHelp } from "./signature.js";
import { tooLarge } from "./size.js";

export const LANGUAGE_ID = "clickhouse-sql";
const CHECK_DELAY_MS = 300;

/** Checks ClickHouse SQL documents shortly after they open and after each change. */
export function activate(context: vscode.ExtensionContext): ServerApi {
  const diagnostics = vscode.languages.createDiagnosticCollection(LANGUAGE_ID);
  const server = registerServer(context, LANGUAGE_ID);
  const pending = new Map<vscode.TextDocument, ReturnType<typeof setTimeout>>();
  // The statements of each document parsed once, for its diagnostics, semantic tokens, hover, outline, selections and names.
  const caches = new Map<string, ParseCache>();
  const cacheOf = (document: vscode.TextDocument): ParseCache => {
    const key = document.uri.toString();
    let cache = caches.get(key);
    if (!cache) caches.set(key, (cache = new ParseCache()));
    return cache;
  };

  const cancel = (document: vscode.TextDocument): void => {
    clearTimeout(pending.get(document));
    pending.delete(document);
  };

  const validate = (document: vscode.TextDocument): void => {
    cancel(document);
    if (document.languageId !== LANGUAGE_ID) return;
    if (tooLarge(document)) {
      diagnostics.delete(document.uri);
      return;
    }
    const errors = checkWithRoles(document.getText(), cacheOf(document)).diagnostics;
    diagnostics.set(document.uri, errors.map((error) => toDiagnostic(document, error)));
  };

  const schedule = (document: vscode.TextDocument): void => {
    cancel(document);
    if (document.languageId !== LANGUAGE_ID) return;
    pending.set(document, setTimeout(() => validate(document), CHECK_DELAY_MS));
  };

  context.subscriptions.push(
    registerFormatter(LANGUAGE_ID),
    registerFolding(LANGUAGE_ID),
    registerCompletion(LANGUAGE_ID, (document, offset) => server.schema.completion(document.getText(), offset)),
    registerHover(LANGUAGE_ID, cacheOf),
    registerOutline(LANGUAGE_ID, cacheOf),
    registerSelectionRanges(LANGUAGE_ID, cacheOf),
    registerSignatureHelp(LANGUAGE_ID),
    registerSemanticTokens(LANGUAGE_ID, cacheOf),
    registerNames(LANGUAGE_ID, cacheOf),
    diagnostics,
    vscode.workspace.onDidOpenTextDocument(schedule),
    vscode.workspace.onDidChangeTextDocument((event) => schedule(event.document)),
    vscode.workspace.onDidCloseTextDocument((document) => {
      cancel(document);
      diagnostics.delete(document.uri);
      caches.delete(document.uri.toString());
    }),
    { dispose: () => [...pending.keys()].forEach(cancel) },
  );
  vscode.workspace.textDocuments.forEach(schedule);
  return server;
}

function toDiagnostic(document: vscode.TextDocument, error: SyntaxError): vscode.Diagnostic {
  const range = new vscode.Range(document.positionAt(error.start), document.positionAt(error.end));
  const severity = error.severity === "warning" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error;
  const diagnostic = new vscode.Diagnostic(range, error.message, severity);
  diagnostic.source = "ClickHouse SQL";
  return diagnostic;
}
