import * as vscode from "vscode";
import { type CompletionCandidate, type CompletionKind, type CompletionSchema, complete, describe, functionArgument } from "clickhouse-sql-syntax";
import { tooLarge } from "./size.js";

/** Where the databases, tables and columns to complete at `offset` come from, such as a live server; a failure means none. */
export type SchemaSource = (document: vscode.TextDocument, offset: number) => CompletionSchema | undefined | Promise<CompletionSchema | undefined>;

/** How long completion waits for the schema; a list made without it is asked for again at the next key. */
const SCHEMA_WAIT_MS = 1000;

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
  value: vscode.CompletionItemKind.Value,
};

/** Kinds that are called, so they are inserted with brackets and the cursor between them. */
const CALLED = new Set<CompletionKind>(["function", "combinator", "table function"]);

/** After a space, completion opens by itself only after these words, where a name has to follow. */
const OPENS_AFTER_SPACE = new Set(["from", "join", "into", "table", "format", "settings", "engine", "use", "database"]);

/** Suggestions for ClickHouse SQL, from complete() of the library. */
export function registerCompletion(languageId: string, schema?: SchemaSource): vscode.Disposable {
  const provider: vscode.CompletionItemProvider = {
    async provideCompletionItems(document, position, _token, context) {
      if (tooLarge(document)) return undefined;
      const text = document.getText();
      const offset = document.offsetAt(position);
      if (context.triggerCharacter === " " && !opensAfterSpace(text, offset) && !takesKind(text, offset)) return undefined;
      if (context.triggerCharacter === "," && !takesKind(text, offset)) return undefined;
      const names = await schemaWithin(schema, document, offset);
      const candidates = complete(text, offset, { schema: names === "late" ? undefined : names });
      const word = document.getWordRangeAtPosition(position);
      const bracketFollows = text[word ? document.offsetAt(word.end) : offset] === "(";
      const items = candidates.map((candidate, i) => toItem(candidate, i, bracketFollows));
      return new vscode.CompletionList(items, names === "late");
    },
  };
  return vscode.languages.registerCompletionItemProvider(languageId, provider, ".", "(", " ", ",");
}

/** The schema from the source, undefined when it fails, or "late" when it takes longer than SCHEMA_WAIT_MS. */
async function schemaWithin(source: SchemaSource | undefined, document: vscode.TextDocument, offset: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), SCHEMA_WAIT_MS)));
  const names = Promise.resolve(source?.(document, offset)).catch(() => undefined);
  return Promise.race([names, late]).finally(() => clearTimeout(timer));
}

/** Whether the space at `offset` follows a word after which a name comes, as in FROM or ENGINE =. */
function opensAfterSpace(text: string, offset: number): boolean {
  const word = /([A-Za-z_]\w*)\s*=?\s+$/.exec(text.slice(Math.max(0, offset - 100), offset));
  return word !== null && OPENS_AFTER_SPACE.has(word[1]!.toLowerCase());
}

/** Whether the cursor is after the comma before an argument of a function whose documentation says what it takes. */
function takesKind(text: string, offset: number): boolean {
  if (!/,\s*$/.test(text.slice(Math.max(0, offset - 100), offset))) return false;
  const argument = functionArgument(text, offset);
  const description = argument && describe(argument.function, "function");
  const list = argument?.parameters ? description?.parameters : description?.arguments;
  return list?.some((a) => a.kind && argument!.arguments.includes(a.name)) ?? false;
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
  } else if (candidate.cursor !== undefined) {
    // The cursor goes inside, as between the quotes of '$.'.
    item.insertText = new vscode.SnippetString()
      .appendText(insert.slice(0, candidate.cursor))
      .appendTabstop(0)
      .appendText(insert.slice(candidate.cursor));
  } else if (candidate.insertText) {
    item.insertText = candidate.insertText;
  }
  return item;
}
