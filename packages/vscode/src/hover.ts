import * as vscode from "vscode";
import { checkWithRoles, type CompletionKind, complete, describe, type ParseCache, type Role } from "clickhouse-sql-syntax";
import { tooLarge } from "./size.js";

/** What a word may be documented as, by the role the parser gave it. */
const KINDS: Partial<Record<Role, CompletionKind[]>> = {
  function: ["function", "table function"],
  engine: ["table engine"],
  setting: ["setting"],
};

/** The documentation of the function, setting, engine, format or table function under the mouse. */
export function registerHover(languageId: string, cacheOf: (document: vscode.TextDocument) => ParseCache): vscode.Disposable {
  return vscode.languages.registerHoverProvider(languageId, {
    provideHover(document, position) {
      if (tooLarge(document)) return undefined;
      const range = document.getWordRangeAtPosition(position);
      if (!range) return undefined;
      const word = document.getText(range);
      const text = document.getText();
      // What complete() offers for the whole word tells what the word is at that place.
      const lower = word.toLowerCase();
      const found = complete(text, document.offsetAt(range.end)).find((c) => c.documentation && c.label.toLowerCase() === lower);
      // complete() spells names as ClickHouse does; another spelling counts only for case-insensitive names.
      let documentation = found && (found.label === word ? found.documentation : describe(word, found.kind)?.documentation);
      if (!documentation) {
        // Where no expression goes, as in INSERT INTO FUNCTION file(...), the role the parser gave the word tells.
        const start = document.offsetAt(range.start);
        const role = checkWithRoles(text, cacheOf(document)).spans.find((span) => span.start === start)?.role;
        let kinds = (role && KINDS[role]) || [];
        // file and format are functions too, but INSERT INTO FUNCTION calls a table function.
        if (role === "function" && /\bFUNCTION\s+$/i.test(text.slice(Math.max(0, start - 20), start))) kinds = [...kinds].reverse();
        for (const kind of kinds) documentation ??= describe(word, kind)?.documentation;
      }
      return documentation ? new vscode.Hover(new vscode.MarkdownString(documentation), range) : undefined;
    },
  });
}
