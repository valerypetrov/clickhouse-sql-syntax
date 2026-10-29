import * as vscode from "vscode";
import { complete, describe } from "clickhouse-sql-syntax";

/** The documentation of the function, setting, engine, format or table function under the mouse. */
export function registerHover(languageId: string): vscode.Disposable {
  return vscode.languages.registerHoverProvider(languageId, {
    provideHover(document, position) {
      const range = document.getWordRangeAtPosition(position);
      if (!range) return undefined;
      const word = document.getText(range);
      // What complete() offers for the whole word tells what the word is at that place.
      const lower = word.toLowerCase();
      const found = complete(document.getText(), document.offsetAt(range.end)).find(
        (c) => c.documentation && c.label.toLowerCase() === lower,
      );
      if (!found) return undefined;
      // complete() spells names as ClickHouse does; another spelling counts only for case-insensitive names.
      const documentation = found.label === word ? found.documentation : describe(word, found.kind)?.documentation;
      return documentation ? new vscode.Hover(new vscode.MarkdownString(documentation), range) : undefined;
    },
  });
}
