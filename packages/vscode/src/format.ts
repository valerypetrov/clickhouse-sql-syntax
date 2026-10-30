import * as vscode from "vscode";
import { format, type KeywordCase, TokenKind, tokenize } from "clickhouse-sql-syntax";
import { tooLarge } from "./size.js";

/** Format Document and Format Selection for ClickHouse SQL. */
export function registerFormatter(languageId: string): vscode.Disposable {
  const provider: vscode.DocumentFormattingEditProvider & vscode.DocumentRangeFormattingEditProvider = {
    provideDocumentFormattingEdits: (document, options) => edits(document, options),
    provideDocumentRangeFormattingEdits: (document, range, options) => edits(document, options, range),
  };
  return vscode.Disposable.from(
    vscode.languages.registerDocumentFormattingEditProvider(languageId, provider),
    vscode.languages.registerDocumentRangeFormattingEditProvider(languageId, provider),
  );
}

function edits(document: vscode.TextDocument, options: vscode.FormattingOptions, range?: vscode.Range): vscode.TextEdit[] {
  if (tooLarge(document)) return [];
  const keywordCase = vscode.workspace.getConfiguration("clickhouseSql.format", document).get<KeywordCase>("keywordCase", "upper");
  const text = document.getText();
  const formatted = formatText(text, options, keywordCase);
  if (!range) {
    if (formatted === text) return [];
    return [vscode.TextEdit.replace(new vscode.Range(document.positionAt(0), document.positionAt(text.length)), formatted)];
  }
  // format() keeps every token and comment, so the two texts line up token by token.
  const before = pieces(text);
  const after = pieces(formatted);
  if (before.length !== after.length || before.some((t, i) => t.kind !== after[i]!.kind)) return [];
  const touched = statementsIn(before, document.offsetAt(range.start), document.offsetAt(range.end));
  if (!touched) return [];
  const [first, last] = touched;
  const replacement = formatted.slice(after[first]!.start, after[last]!.end);
  const from = before[first]!.start;
  const to = before[last]!.end;
  if (text.slice(from, to) === replacement) return [];
  return [vscode.TextEdit.replace(new vscode.Range(document.positionAt(from), document.positionAt(to)), replacement)];
}

/** format() with the editor's indentation: spaces, or one tab per level. */
function formatText(text: string, options: vscode.FormattingOptions, keywordCase: KeywordCase): string {
  if (options.insertSpaces) return format(text, { keywordCase, indentSize: options.tabSize });
  // Lines that format() indents differ between indents of one and two spaces; those get tabs.
  const one = format(text, { keywordCase, indentSize: 1 }).split("\n");
  const two = format(text, { keywordCase, indentSize: 2 }).split("\n");
  if (one.length !== two.length) return format(text, { keywordCase, indentSize: options.tabSize });
  return one
    .map((line, i) => {
      if (line === two[i]) return line;
      const level = /^ */.exec(line)![0].length;
      return "\t".repeat(level) + line.slice(level);
    })
    .join("\n");
}

/** The tokens of a text without whitespace. */
function pieces(text: string): { kind: TokenKind; start: number; end: number }[] {
  return tokenize(text).filter((t) => t.kind !== TokenKind.Whitespace && t.kind !== TokenKind.EndOfStream);
}

/** The first and last piece of the statements that the offsets touch, statements ending at ";". */
function statementsIn(tokens: { kind: TokenKind; start: number; end: number }[], from: number, to: number): [number, number] | undefined {
  let first = -1;
  let last = -1;
  let start = -1;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (start < 0 && token.kind !== TokenKind.Comment) start = i;
    const ends = token.kind === TokenKind.Semicolon || i === tokens.length - 1;
    if (!ends || start < 0) continue;
    // An empty range touches the statement it is in or at the edge of; a selection must overlap it.
    const touches = from === to ? tokens[start]!.start <= to && token.end >= from : tokens[start]!.start < to && token.end > from;
    if (touches) {
      if (first < 0) first = start;
      last = i;
    }
    start = -1;
  }
  return first < 0 ? undefined : [first, last];
}
