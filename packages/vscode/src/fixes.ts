import * as vscode from "vscode";
import { type Fix, messageFixes } from "clickhouse-sql-syntax";

/** A problem of the last check of a document, by offsets, with its fixes. */
export interface Fixable {
  start: number;
  end: number;
  message: string;
  fixes?: Fix[];
}

/** Offers the fixes of the diagnostics under the cursor: those of the last check, and the hints in the server's errors. */
export function registerQuickFixes(languageId: string, lastCheck: (document: vscode.TextDocument) => readonly Fixable[]): vscode.Disposable {
  return vscode.languages.registerCodeActionsProvider(
    languageId,
    {
      provideCodeActions(document, _range, context) {
        const actions: vscode.CodeAction[] = [];
        for (const diagnostic of context.diagnostics) {
          const start = document.offsetAt(diagnostic.range.start);
          const end = document.offsetAt(diagnostic.range.end);
          const fixes =
            diagnostic.source === "ClickHouse server"
              ? messageFixes(document.getText(), start, end, diagnostic.message)
              : lastCheck(document).find((p) => p.start === start && p.end === end && p.message === diagnostic.message)?.fixes ?? [];
          for (const fix of fixes) actions.push(toAction(document, diagnostic, fix));
        }
        return actions;
      },
    },
    { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
  );
}

function toAction(document: vscode.TextDocument, diagnostic: vscode.Diagnostic, fix: Fix): vscode.CodeAction {
  const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
  action.edit = new vscode.WorkspaceEdit();
  for (const edit of fix.edits) action.edit.replace(document.uri, new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)), edit.newText);
  action.diagnostics = [diagnostic];
  action.isPreferred = fix.preferred;
  return action;
}
