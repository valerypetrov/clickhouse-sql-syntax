import * as vscode from "vscode";
import { check, type Diagnostic as SyntaxError } from "clickhouse-sql-syntax";

export const LANGUAGE_ID = "clickhouse-sql";
const CHECK_DELAY_MS = 300;

/** Checks ClickHouse SQL documents when they open and shortly after each change. */
export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection(LANGUAGE_ID);
  const pending = new Map<vscode.TextDocument, ReturnType<typeof setTimeout>>();

  const cancel = (document: vscode.TextDocument): void => {
    clearTimeout(pending.get(document));
    pending.delete(document);
  };

  const validate = (document: vscode.TextDocument): void => {
    cancel(document);
    if (document.languageId !== LANGUAGE_ID) return;
    const errors = check(document.getText());
    diagnostics.set(document.uri, errors.map((error) => toDiagnostic(document, error)));
  };

  const schedule = (document: vscode.TextDocument): void => {
    cancel(document);
    if (document.languageId !== LANGUAGE_ID) return;
    pending.set(document, setTimeout(() => validate(document), CHECK_DELAY_MS));
  };

  context.subscriptions.push(
    diagnostics,
    vscode.workspace.onDidOpenTextDocument(validate),
    vscode.workspace.onDidChangeTextDocument((event) => schedule(event.document)),
    vscode.workspace.onDidCloseTextDocument((document) => {
      cancel(document);
      diagnostics.delete(document.uri);
    }),
    { dispose: () => [...pending.keys()].forEach(cancel) },
  );
  vscode.workspace.textDocuments.forEach(validate);
}

function toDiagnostic(document: vscode.TextDocument, error: SyntaxError): vscode.Diagnostic {
  const range = new vscode.Range(document.positionAt(error.start), document.positionAt(error.end));
  const severity = error.severity === "warning" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error;
  const diagnostic = new vscode.Diagnostic(range, error.message, severity);
  diagnostic.source = "ClickHouse SQL";
  return diagnostic;
}
