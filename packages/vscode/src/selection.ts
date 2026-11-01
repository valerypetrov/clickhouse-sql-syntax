import * as vscode from "vscode";
import { type ParseCache, selectionRanges } from "clickhouse-sql-syntax";
import { tooLarge } from "./size.js";

/** Expand and Shrink Selection: from the word at each cursor out to its expression, call, clause, subquery and statement. */
export function registerSelectionRanges(languageId: string, cacheOf: (document: vscode.TextDocument) => ParseCache): vscode.Disposable {
  return vscode.languages.registerSelectionRangeProvider(languageId, {
    provideSelectionRanges(document, positions) {
      if (tooLarge(document)) return undefined;
      const offsets = positions.map((position) => document.offsetAt(position));
      return selectionRanges(document.getText(), offsets, cacheOf(document)).map((ranges, i) => {
        let selection: vscode.SelectionRange | undefined;
        for (const { start, end } of [...ranges].reverse()) {
          selection = new vscode.SelectionRange(new vscode.Range(document.positionAt(start), document.positionAt(end)), selection);
        }
        // VS Code wants a range for every position; where nothing is found, the empty one at it.
        return selection ?? new vscode.SelectionRange(new vscode.Range(positions[i]!, positions[i]!));
      });
    },
  });
}
