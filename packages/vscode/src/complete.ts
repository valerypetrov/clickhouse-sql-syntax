import * as vscode from "vscode";
import { type CompletionCandidate, type CompletionKind, type CompletionSchema, complete } from "clickhouse-sql-syntax";

/** Where the databases, tables and columns to complete come from, such as a live server; a failure means none. */
export type SchemaSource = (document: vscode.TextDocument) => CompletionSchema | undefined | Promise<CompletionSchema | undefined>;

const KINDS: Record<CompletionKind, vscode.CompletionItemKind> = {
  keyword: vscode.CompletionItemKind.Keyword,
  function: vscode.CompletionItemKind.Function,
  combinator: vscode.CompletionItemKind.Function,
  "table function": vscode.CompletionItemKind.Function,
  "table engine": vscode.CompletionItemKind.Class,
  format: vscode.CompletionItemKind.Constant,
  setting: vscode.CompletionItemKind.Property,
  "data type": vscode.CompletionItemKind.TypeParameter,
  database: vscode.CompletionItemKind.Module,
  table: vscode.CompletionItemKind.Struct,
  column: vscode.CompletionItemKind.Field,
};

/** Kinds that are called, so they are inserted with brackets and the cursor between them. */
const CALLED = new Set<CompletionKind>(["function", "combinator", "table function"]);

/** After a space, completion opens by itself only after these words, where a name has to follow. */
const OPENS_AFTER_SPACE = new Set(["from", "join", "into", "table", "format", "settings", "engine", "use", "database"]);

/** Suggestions for ClickHouse SQL, from complete() of the library. */
export function registerCompletion(languageId: string, schema?: SchemaSource): vscode.Disposable {
  const provider: vscode.CompletionItemProvider = {
    async provideCompletionItems(document, position, _token, context) {
      const text = document.getText();
      const offset = document.offsetAt(position);
      if (context.triggerCharacter === " " && !opensAfterSpace(text, offset)) return undefined;
      const names = await Promise.resolve(schema?.(document)).catch(() => undefined);
      const candidates = complete(text, offset, { schema: names });
      const word = document.getWordRangeAtPosition(position);
      const bracketFollows = text[word ? document.offsetAt(word.end) : offset] === "(";
      return candidates.map((candidate, i) => toItem(candidate, i, bracketFollows));
    },
  };
  return vscode.languages.registerCompletionItemProvider(languageId, provider, ".", "(", " ");
}

/** Whether the space at `offset` follows a word after which a name comes, as in FROM or ENGINE =. */
function opensAfterSpace(text: string, offset: number): boolean {
  const word = /([A-Za-z_]\w*)\s*=?\s+$/.exec(text.slice(Math.max(0, offset - 100), offset));
  return word !== null && OPENS_AFTER_SPACE.has(word[1]!.toLowerCase());
}

function toItem(candidate: CompletionCandidate, index: number, bracketFollows: boolean): vscode.CompletionItem {
  const item = new vscode.CompletionItem(candidate.label, KINDS[candidate.kind]);
  item.detail = candidate.detail;
  if (candidate.documentation) item.documentation = new vscode.MarkdownString(candidate.documentation);
  // complete() sorts best first; VS Code keeps that order among equally good matches.
  item.sortText = String(index).padStart(5, "0");
  const insert = candidate.insertText ?? candidate.label;
  if (CALLED.has(candidate.kind) && !bracketFollows) {
    item.insertText = new vscode.SnippetString().appendText(insert).appendText("(").appendTabstop(0).appendText(")");
    item.command = { title: "Signature help", command: "editor.action.triggerParameterHints" };
  } else if (candidate.insertText) {
    item.insertText = candidate.insertText;
  }
  return item;
}
