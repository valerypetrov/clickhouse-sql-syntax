import * as vscode from "vscode";
import { type FoldingRange, foldingRanges } from "clickhouse-sql-syntax";
import { tooLarge } from "./size.js";

const KINDS: Record<NonNullable<FoldingRange["kind"]>, vscode.FoldingRangeKind> = {
  comment: vscode.FoldingRangeKind.Comment,
  region: vscode.FoldingRangeKind.Region,
};

/** Folding of statements, brackets and comments of several lines, and of -- #region blocks. */
export function registerFolding(languageId: string): vscode.Disposable {
  return vscode.languages.registerFoldingRangeProvider(languageId, {
    provideFoldingRanges(document) {
      // Without ranges VS Code folds by indentation and the markers of language-configuration.json.
      if (tooLarge(document)) return undefined;
      return foldingRanges(document.getText()).map(
        (range) => new vscode.FoldingRange(range.startLine - 1, range.endLine - 1, range.kind && KINDS[range.kind]),
      );
    },
  });
}
