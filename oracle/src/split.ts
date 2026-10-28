import { type Lexeme, isSignificant, readLexeme } from "./lexer.js";

export interface Statement {
  /** From the first to the last significant character, without the closing ';'. */
  text: string;
  start: number;
  /** Line of `start`, from 1. */
  line: number;
  /** Test hints such as "clientError SYNTAX_ERROR" found in the statement or after it on its line. */
  hints: string[];
}

const HINT = /\{\s*((?:client|server)Error\s+[^}]*?)\s*\}/g;

function upperWord(text: string, lexeme: Lexeme): string {
  return lexeme.kind === "word" ? text.slice(lexeme.start, lexeme.end).toUpperCase() : "";
}

// Inline data after `FORMAT <name>` starts after the first newline and ends at an empty line,
// as in ParserInsertQuery and ClientBase::analyzeMultiQueryText.
function formatDataEnd(text: string, nameEnd: number): number {
  let i = nameEnd;
  while (text[i] === " " || text[i] === "\t" || text[i] === "\f") i++;
  if (text[i] === "\r") i++;
  if (text[i] === "\n") i++;
  const blank = text.indexOf("\n\n", i);
  return blank === -1 ? text.length : blank;
}

/**
 * Splits a script into statements the way clickhouse-client does: at ';' tokens, keeping the
 * inline data of an INSERT whole. VALUES data ends at a ';' outside brackets, other data at an
 * empty line. Empty statements are skipped.
 */
export function splitStatements(text: string): Statement[] {
  const statements: Statement[] = [];
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n" || (c === "\r" && text[i + 1] !== "\n")) lineStarts.push(i + 1);
  }
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  let pos = 0;
  while (pos < text.length) {
    let first: Lexeme | undefined;
    let lastEnd = 0;
    let comments: Lexeme[] = [];
    let depth = 0;
    let insert = false;
    let dataMode: "none" | "select" | "values" | "done" = "none";
    let readsInput = false;
    let closedBySemicolon = false;

    while (pos < text.length) {
      const lexeme = readLexeme(text, pos);
      pos = lexeme.end;
      if (!isSignificant(lexeme)) {
        if (lexeme.kind === "comment" && first) comments.push(lexeme);
        continue;
      }
      if (lexeme.kind === "semicolon" && (dataMode !== "values" || depth <= 0)) {
        closedBySemicolon = true;
        break;
      }
      if (!first) {
        first = lexeme;
        insert = upperWord(text, lexeme) === "INSERT";
      }
      lastEnd = lexeme.end;
      if (lexeme.kind === "open") depth++;
      if (lexeme.kind === "close") depth--;
      const word = upperWord(text, lexeme);
      // An INSERT ... SELECT has inline data only when it reads it with input().
      if (dataMode === "select" && word === "INPUT" && text[lexeme.end] === "(") readsInput = true;
      if (!insert || depth !== 0 || (dataMode !== "none" && dataMode !== "select")) continue;

      if (word === "INFILE") {
        dataMode = "done";
      } else if (dataMode === "none" && (word === "SELECT" || word === "WITH" || word === "FROM")) {
        dataMode = "select";
      } else if (dataMode === "none" && word === "VALUES") {
        dataMode = "values";
      } else if (word === "FORMAT" && (dataMode === "none" || readsInput)) {
        let name = readLexeme(text, pos);
        while (!isSignificant(name) && name.end < text.length) name = readLexeme(text, name.end);
        if (name.kind !== "word" && name.kind !== "quoted") continue;
        // The client compares the name exactly, so only `FORMAT Values` gets the VALUES rule.
        if (text.slice(name.start, name.end) === "Values") {
          dataMode = "values";
          continue;
        }
        // ClickHouse rejects a ';' right after the format name, so it stays in the statement.
        if (text[name.end] === ";") {
          lastEnd = name.end + 1;
          pos = name.end + 1;
          closedBySemicolon = true;
          break;
        }
        lastEnd = formatDataEnd(text, name.end);
        pos = lastEnd;
        break;
      }
    }
    if (!first) continue;

    // A hint written after the ';' on the same line belongs to this statement.
    if (closedBySemicolon) {
      const eol = text.indexOf("\n", pos);
      let scan = pos;
      while (scan < (eol === -1 ? text.length : eol)) {
        const lexeme = readLexeme(text, scan);
        if (lexeme.kind === "comment") comments.push(lexeme);
        else if (lexeme.kind !== "space") break;
        scan = lexeme.end;
      }
    }
    const hints: string[] = [];
    for (const comment of comments) {
      for (const match of text.slice(comment.start, comment.end).matchAll(HINT)) hints.push(match[1]!.replace(/\s+/g, " "));
    }
    statements.push({ text: text.slice(first.start, lastEnd), start: first.start, line: lineOf(first.start), hints });
    comments = [];
  }
  return statements;
}
