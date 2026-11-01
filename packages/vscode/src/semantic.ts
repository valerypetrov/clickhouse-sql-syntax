import * as vscode from "vscode";
import { checkWithRoles, type ParseCache, type Role, type RoleSpan, TokenKind, tokenize } from "clickhouse-sql-syntax";
import { tooLarge } from "./size.js";

/** The semantic token type of each role; package.json maps each type to the scope the grammar uses. */
const TYPE_OF_ROLE: Record<Role, string> = {
  keyword: "keyword",
  identifier: "variable",
  function: "function",
  type: "type",
  engine: "class",
  setting: "property",
  parameter: "parameter",
  number: "number",
};
const ROLES = Object.keys(TYPE_OF_ROLE) as Role[];
const LEGEND = new vscode.SemanticTokensLegend(ROLES.map((role) => TYPE_OF_ROLE[role]));

/** The grammar already colours these keywords as constants. */
const CONSTANTS = new Set(["NULL", "TRUE", "FALSE"]);

/** Longer lines get no semantic tokens, as VS Code merges them all again for each column that completion looks at. */
const MAX_LINE_LENGTH = 10_000;

interface Result {
  id: string;
  data: Uint32Array;
}

let lastId = 0;

/** The semantic tokens of one document, with the roles of its pieces kept for the next request. */
class DocumentTokens {
  /** The roles of each piece of the text by its text, so that an edit parses only the pieces it changed. */
  private byText = new Map<string, RoleSpan[]>();
  last?: Result;

  constructor(private readonly cache: ParseCache) {}

  /** Tokens of the whole document, or of the pieces that overlap `range`. */
  tokens(document: vscode.TextDocument, range?: vscode.Range): Result {
    const text = document.getText();
    const from = range ? document.offsetAt(range.start) : 0;
    const to = range ? document.offsetAt(range.end) : text.length;
    const byText = range ? this.byText : new Map<string, RoleSpan[]>();
    const builder = new vscode.SemanticTokensBuilder(LEGEND);
    const lines = new LineCounter(text);
    let checked = -1;
    let long = false;
    for (const [start, end] of pieces(text)) {
      if (end <= from || start >= to) continue;
      const piece = text.slice(start, end);
      const spans = this.byText.get(piece) ?? checkWithRoles(piece, this.cache).spans;
      byText.set(piece, spans);
      for (const span of spans) {
        const length = span.end - span.start;
        if (span.role === "keyword" && length <= 5 && CONSTANTS.has(piece.slice(span.start, span.end).toUpperCase())) continue;
        const line = lines.lineAt(start + span.start);
        const character = start + span.start - lines.lineStart;
        // A quoted name may span lines, which a semantic token cannot.
        if (lines.lineAt(start + span.end) !== line) continue;
        if (line !== checked) {
          checked = line;
          long = document.lineAt(line).text.length > MAX_LINE_LENGTH;
        }
        if (long) continue;
        builder.push(line, character, length, ROLES.indexOf(span.role));
      }
    }
    this.byText = byText;
    const result = { id: String(++lastId), data: builder.build().data };
    if (!range) this.last = result;
    return result;
  }
}

/** Line numbers of increasing offsets, with lines ending at "\n", "\r\n" or a lone "\r" as in VS Code. */
class LineCounter {
  line = 0;
  lineStart = 0;
  private scanned = 0;

  constructor(private readonly text: string) {}

  lineAt(offset: number): number {
    for (; this.scanned < offset; this.scanned++) {
      const c = this.text.charCodeAt(this.scanned);
      if (c === 10 || (c === 13 && this.text.charCodeAt(this.scanned + 1) !== 10)) {
        this.line++;
        this.lineStart = this.scanned + 1;
      }
    }
    return this.line;
  }
}

/** Semantic tokens from the parser's roles, so that a keyword used as a name is coloured as a name. */
export function registerSemanticTokens(languageId: string, cacheOf: (document: vscode.TextDocument) => ParseCache): vscode.Disposable {
  const documents = new Map<string, DocumentTokens>();
  const tokensOf = (document: vscode.TextDocument): DocumentTokens => {
    const key = document.uri.toString();
    let found = documents.get(key);
    if (!found) documents.set(key, (found = new DocumentTokens(cacheOf(document))));
    return found;
  };

  const provider: vscode.DocumentSemanticTokensProvider & vscode.DocumentRangeSemanticTokensProvider = {
    provideDocumentSemanticTokens(document) {
      if (tooLarge(document)) return undefined;
      const result = tokensOf(document).tokens(document);
      return new vscode.SemanticTokens(result.data, result.id);
    },
    // Sends only what changed since the last result, which is little after a small edit.
    provideDocumentSemanticTokensEdits(document, previousId) {
      if (tooLarge(document)) return undefined;
      const state = tokensOf(document);
      const previous = state.last;
      const result = state.tokens(document);
      if (previous?.id !== previousId) return new vscode.SemanticTokens(result.data, result.id);
      return new vscode.SemanticTokensEdits([difference(previous.data, result.data)], result.id);
    },
    provideDocumentRangeSemanticTokens(document, range) {
      if (tooLarge(document)) return undefined;
      return new vscode.SemanticTokens(tokensOf(document).tokens(document, range).data);
    },
  };

  return vscode.Disposable.from(
    vscode.languages.registerDocumentSemanticTokensProvider({ language: languageId }, provider, LEGEND),
    vscode.languages.registerDocumentRangeSemanticTokensProvider({ language: languageId }, provider, LEGEND),
    vscode.workspace.onDidCloseTextDocument((document) => documents.delete(document.uri.toString())),
  );
}

/**
 * The text split after each ';', as offsets; the parser reads each piece alone. A ';' in inline
 * INSERT data ends a piece too, so the rest of that data is read as SQL, as the grammar reads it.
 */
function pieces(text: string): [number, number][] {
  const result: [number, number][] = [];
  let start = 0;
  for (const token of tokenize(text)) {
    if (token.kind !== TokenKind.Semicolon) continue;
    result.push([start, token.end]);
    start = token.end;
  }
  if (start < text.length) result.push([start, text.length]);
  return result;
}

/** One edit that turns `before` into `after`: what lies between their common start and end. */
function difference(before: Uint32Array, after: Uint32Array): vscode.SemanticTokensEdit {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++;
  return new vscode.SemanticTokensEdit(start, before.length - start - end, after.slice(start, after.length - end));
}
