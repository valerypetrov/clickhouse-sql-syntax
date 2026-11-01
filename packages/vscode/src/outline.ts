import * as vscode from "vscode";
import { type OutlineKind, type OutlineSymbol, outline, type ParseCache } from "clickhouse-sql-syntax";
import { tooLarge } from "./size.js";

const KINDS: Record<OutlineKind, vscode.SymbolKind> = {
  table: vscode.SymbolKind.Struct,
  view: vscode.SymbolKind.Interface,
  dictionary: vscode.SymbolKind.Key,
  database: vscode.SymbolKind.Namespace,
  function: vscode.SymbolKind.Function,
  query: vscode.SymbolKind.Method,
  statement: vscode.SymbolKind.Event,
  cte: vscode.SymbolKind.Variable,
  column: vscode.SymbolKind.Field,
};

/** The Outline view, breadcrumbs and Go to Symbol in Editor: each statement with its CTEs and columns. */
export function registerOutline(languageId: string, cacheOf: (document: vscode.TextDocument) => ParseCache): vscode.Disposable {
  return vscode.languages.registerDocumentSymbolProvider(languageId, {
    provideDocumentSymbols(document) {
      if (tooLarge(document)) return undefined;
      return outline(document.getText(), cacheOf(document)).map((symbol) => toSymbol(document, symbol));
    },
  });
}

function toSymbol(document: vscode.TextDocument, symbol: OutlineSymbol): vscode.DocumentSymbol {
  const range = (start: number, end: number) => new vscode.Range(document.positionAt(start), document.positionAt(end));
  const result = new vscode.DocumentSymbol(symbol.name, "", KINDS[symbol.kind], range(symbol.start, symbol.end), range(symbol.nameStart, symbol.nameEnd));
  result.children = symbol.children.map((child) => toSymbol(document, child));
  return result;
}
