// Test hints such as "-- { serverError UNKNOWN_TABLE }", read as TestHint in src/Client/TestHint.cpp of ClickHouse does.
import { type Fix, isSignificant, nameHints, replaceFixes, split, type Token, TokenKind as T, tokenize } from "clickhouse-sql-syntax";
import { ERROR_CODES } from "./generated/errors.js";

/** A problem in the file, by offsets. */
export interface Problem {
  start: number;
  end: number;
  message: string;
  severity: "error" | "warning" | "information";
  fixes?: Fix[];
}

/** A suggestion inside a hint. */
export interface HintCompletion {
  label: string;
  detail: string;
  documentation?: string;
}

const ERROR_COMMANDS = ["serverError", "clientError", "error"];
const COMMANDS: Record<string, string> = {
  serverError: "The statement must fail on the server with one of these errors, given by name or code and split by commas.",
  clientError:
    "The statement must fail in clickhouse-client with one of these errors, given by name or code and split by commas. " +
    "The client parses each statement first, so a syntax error is a client error: `clientError SYNTAX_ERROR`.",
  error: "The statement must fail with one of these errors, on the server or in the client.",
  echo: "clickhouse-client prints the statement before its result, for a readable reference file.",
  echoOn: "clickhouse-client prints the statement before its result, as `echo` does.",
  echoOff: "clickhouse-client does not print the statement, even with `--echo`.",
  retry: "`retry N until serverError X` runs the statement again, up to N times, until it fails with X; `retry N while serverError X`, while it fails with X.",
};
const NAMES = new Map(Object.entries(ERROR_CODES).map(([name, code]) => [code, name]));

/** The {...} of a comment, and its tokens with offsets in the file. */
interface Hint {
  comment: Token;
  start: number;
  end: number;
  tokens: Token[];
  /** Before any statement of the file: clickhouse-client takes only echo and retry from it. */
  leading: boolean;
  /** Without a } in the comment, which clickhouse-client then skips. */
  open: boolean;
}

/** The hints of the comments of `text`: the part between the first { and the next } of each comment. */
function hints(text: string): Hint[] {
  const found: Hint[] = [];
  let leading = true;
  for (const token of tokenize(text)) {
    if (isSignificant(token.kind) && token.kind !== T.EndOfStream) leading = false;
    if (token.kind !== T.Comment) continue;
    const open = text.indexOf("{", token.start);
    if (open < 0 || open >= token.end) continue;
    const close = text.indexOf("}", open);
    const end = close < 0 || close >= token.end ? token.end : close;
    found.push({ comment: token, start: open + 1, end, tokens: contentTokens(text, open + 1, end), leading, open: end === token.end });
  }
  return found;
}

/** The tokens of text[start, end), without whitespace, as ClickHouse's lexer reads the inside of a hint. */
function contentTokens(text: string, start: number, end: number): Token[] {
  return tokenize(text.slice(start, end))
    .filter((token) => token.kind !== T.Whitespace)
    .map((token) => ({ ...token, start: token.start + start, end: token.end + start }));
}

/** What a hint expects, or the problem that makes clickhouse-client stop reading the file. */
interface Parsed {
  serverErrors: number[];
  clientErrors: number[];
  problem?: Problem;
}

function parse(text: string, hint: Hint): Parsed {
  const result: Parsed = { serverErrors: [], clientErrors: [] };
  const tokens = hint.tokens;
  const word = (token: Token) => text.slice(token.start, token.end);
  const fail = (token: Token, message: string, fixes?: Fix[]): Parsed => ({
    ...result,
    problem: { start: token.start, end: Math.max(token.end, token.start + 1), message, severity: "error", ...(fixes?.length && { fixes }) },
  });
  let retries = 0;
  let retryToken: Token | undefined;
  for (let i = 0; i < tokens.length && tokens[i]!.kind !== T.EndOfStream; i++) {
    const token = tokens[i]!;
    const item = word(token);
    if (token.kind !== T.BareWord) continue;
    if (item === "retry") {
      retryToken = token;
      const count = tokens[++i]!;
      if (count.kind !== T.Number) return fail(count, `Could not parse the number of retries: ${word(count)}`);
      retries = Number.parseInt(word(count), 10);
      const mode = tokens[++i]!;
      if (mode.kind !== T.BareWord || (word(mode) !== "until" && word(mode) !== "while"))
        return fail(mode, `Expected 'until' or 'while' after the number of retries, got: ${word(mode)}`);
    } else if (!hint.leading && ERROR_COMMANDS.includes(item)) {
      const codes: number[] = [];
      for (i++; ; i++) {
        const code = tokens[i]!;
        if (code.kind === T.Number) {
          if (!/^\d/.test(word(code))) return fail(code, `Could not parse integer number for errorcode: ${word(code)}`);
          codes.push(Number.parseInt(word(code), 10));
        } else if (code.kind === T.BareWord) {
          const known = Object.hasOwn(ERROR_CODES, word(code)) ? ERROR_CODES[word(code)] : undefined;
          if (known === undefined) return fail(code, `No error code with name: '${word(code)}'`, replaceFixes(code.start, code.end, nameHints(word(code), Object.keys(ERROR_CODES))));
          codes.push(known);
        } else return fail(code, `Could not parse error code in ${code.kind}: ${word(code)}`);
        const next = tokens[i + 1]!;
        if (next.kind === T.EndOfStream) break;
        if (next.kind !== T.Comma) return fail(next, `Could not parse error code. Expected ','. Got '${word(next)}'`);
        i++;
      }
      if (item !== "clientError") result.serverErrors = codes;
      if (item !== "serverError") result.clientErrors = codes;
      break;
    }
  }
  if (retries && result.serverErrors.length !== 1) return fail(retryToken!, "Expected one serverError after the 'retry N while|until' command");
  return result;
}

/**
 * The problems of the test hints of `text`: the ones that make clickhouse-client stop, and a serverError hint of a
 * statement with an error at one of `syntaxErrors`, the offsets of the errors that check() gives.
 */
export function checkHints(text: string, syntaxErrors: readonly number[] = []): Problem[] {
  if (!text.includes("{")) return [];
  const found = hints(text).filter((hint) => !hint.open);
  if (!found.length) return [];
  const problems: Problem[] = [];
  const parsed = new Map<Hint, Parsed>();
  for (const hint of found) {
    const result = parse(text, hint);
    parsed.set(hint, result);
    if (result.problem) problems.push(result.problem);
  }
  if (!syntaxErrors.length) return problems;
  for (const unit of split(text)) {
    const statement = unit.statement;
    if (!statement) continue;
    // A statement's hints run from its start to the end of the line of its end.
    const newline = text.slice(statement.end).search(/[\r\n]/);
    const end = newline < 0 ? text.length : statement.end + newline;
    if (!syntaxErrors.some((at) => at >= statement.start && at <= statement.end)) continue;
    const own = found.filter((hint) => hint.comment.start > statement.start && hint.comment.start < end && !parsed.get(hint)!.problem);
    const expected = own.map((hint) => parsed.get(hint)!).filter((p) => p.serverErrors.length || p.clientErrors.length).pop();
    // The parser's errors, SYNTAX_ERROR or another, are client errors, which serverError does not expect.
    if (!expected || expected.clientErrors.length) continue;
    const hint = own[own.length - 1]!;
    const message = "clickhouse-client rejects this statement before it reaches the server, so serverError does not expect its error; write clientError, as clientError SYNTAX_ERROR.";
    problems.push({ start: hint.start - 1, end: hint.end + 1, message, severity: "warning" });
  }
  return problems.sort((a, b) => a.start - b.start);
}

/** The hint whose {...} `offset` is in, if any. */
function hintAt(text: string, offset: number): Hint | undefined {
  // A hint is written on one line, so a line without { before the offset has none there.
  const lineStart = Math.max(text.lastIndexOf("\n", offset - 1), text.lastIndexOf("\r", offset - 1)) + 1;
  if (!text.slice(lineStart, offset).includes("{")) return undefined;
  const comment = tokenize(text).find((t) => t.kind === T.Comment && t.start < offset && offset <= t.end);
  if (!comment) return undefined;
  return hints(text.slice(0, comment.end)).find((hint) => hint.comment.start === comment.start && hint.start <= offset && offset <= hint.end);
}

/** The suggestions at `offset` inside the {...} of a test hint, or undefined outside one. */
export function hintCompletions(text: string, offset: number): HintCompletion[] | undefined {
  const hint = hintAt(text, offset);
  if (!hint) return undefined;
  const before = hint.tokens.filter((token) => token.kind !== T.EndOfStream).filter((token) => token.end < offset || (token.end === offset && token.kind !== T.BareWord && token.kind !== T.Number));
  const words = before.map((token) => text.slice(token.start, token.end));
  const last = words[words.length - 1];
  let errorList = words.length - 1;
  while (errorList >= 0 && !ERROR_COMMANDS.includes(words[errorList]!)) errorList--;
  if (errorList >= 0 && (errorList === words.length - 1 || last === ",")) {
    return Object.entries(ERROR_CODES).map(([name, code]) => ({ label: name, detail: `error ${code}` }));
  }
  if (words.length >= 2 && words[words.length - 2] === "retry") return ["until", "while"].map((label) => ({ label, detail: "retry", documentation: COMMANDS.retry }));
  if (words.length >= 3 && words[words.length - 3] === "retry") return [{ label: "serverError", detail: "test hint", documentation: COMMANDS.serverError }];
  return Object.entries(COMMANDS).map(([label, documentation]) => ({ label, detail: "test hint", documentation }));
}

/** The documentation of the command or error under `offset` in a test hint. */
export function hintHover(text: string, offset: number): { markdown: string; start: number; end: number } | undefined {
  const hint = hintAt(text, offset);
  const token = hint?.tokens.find((t) => t.start <= offset && offset <= t.end && (t.kind === T.BareWord || t.kind === T.Number));
  if (!token) return undefined;
  const word = text.slice(token.start, token.end);
  let markdown: string | undefined;
  if (Object.hasOwn(COMMANDS, word)) markdown = `**Test hint \`${word}\`**\n\n${COMMANDS[word]}`;
  else if (Object.hasOwn(ERROR_CODES, word)) markdown = `**${word}**: error code ${ERROR_CODES[word]}`;
  else if (token.kind === T.Number && NAMES.has(Number.parseInt(word, 10))) markdown = `**${NAMES.get(Number.parseInt(word, 10))}**: error code ${word}`;
  return markdown ? { markdown, start: token.start, end: token.end } : undefined;
}
