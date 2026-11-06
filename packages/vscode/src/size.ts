import * as vscode from "vscode";
import { setting } from "./settings.js";

/** The documents already said to be too long, so that each is said once. */
const noted = new Set<string>();

/** Whether the document is longer than clickhouseSql.maxFileSize, so that every feature leaves it alone. */
export function tooLarge(document: vscode.TextDocument): boolean {
  const max = setting<number>("clickhouseSql.maxFileSize");
  // The offset of the end, which unlike getText() does not copy the text.
  if (document.offsetAt(document.lineAt(document.lineCount - 1).range.end) <= max) return false;
  const key = document.uri.toString();
  if (!noted.has(key)) {
    noted.add(key);
    const name = vscode.workspace.asRelativePath(document.uri);
    void vscode.window.showInformationMessage(
      `${name} is longer than clickhouseSql.maxFileSize, ${max} characters, so ClickHouse SQL does not check, colour, format or complete it.`,
    );
  }
  return true;
}
