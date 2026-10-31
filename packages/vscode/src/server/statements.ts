import { check, isSignificant, roles, type Token, TokenKind as T, tokenize } from "clickhouse-sql-syntax";

/** A piece of the document, by offsets. */
export interface Span {
  start: number;
  end: number;
}

/** A SELECT of the document, and the text of it to explain. */
export interface Query extends Span {
  sql: string;
}

/**
 * The SELECT queries the server can analyze without running anything: SELECT and WITH statements,
 * and the SELECT of CREATE ... AS SELECT and INSERT ... SELECT. Statements with syntax errors are left out.
 */
export function selectQueries(text: string): Query[] {
  const queries: Query[] = [];
  const valid = (sql: string) => check(sql).length === 0;
  for (const statement of statements(text)) {
    const select = selectPart(text, statement);
    if (!select?.length) continue;
    const query = spanOf(select);
    const whole = spanOf(statement);
    const sql = withoutOutput(text, select);
    if (valid(text.slice(whole.start, whole.end)) && valid(text.slice(query.start, query.end)) && valid(sql)) queries.push({ ...query, sql });
  }
  return queries;
}

/**
 * The text of a query without INTO OUTFILE, which only the client can do, and FORMAT, which EXPLAIN
 * would write its own output in. Its SETTINGS stay, so that readonly=1 still refuses them.
 */
function withoutOutput(text: string, toks: Token[]): string {
  const { start, end } = spanOf(toks);
  const words = toks.map((t) => word(text, t));
  if (!words.includes("FORMAT") && !words.includes("INTO")) return text.slice(start, end);
  const keywords = new Set(roles(text.slice(start, end)).flatMap((r) => (r.role === "keyword" ? [start + r.start] : [])));
  const kept = toks.map(() => true);
  let depth = 0;
  for (let i = 0, outfile = false; i < toks.length; i++) {
    const keyword = depth === 0 && keywords.has(toks[i]!.start) ? words[i] : undefined;
    depth += nesting(toks[i]!);
    if (keyword === "INTO" && words[i + 1] === "OUTFILE") outfile = true;
    else if (keyword === "SETTINGS") outfile = false;
    if (keyword === "FORMAT") kept[i] = kept[++i] = false;
    else kept[i] = !outfile;
  }
  // The runs of kept tokens, as they are written.
  const runs: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (!kept[i]) continue;
    const first = i;
    while (kept[i + 1]) i++;
    runs.push(text.slice(toks[first]!.start, toks[i]!.end));
  }
  return runs.join(" ");
}

function spanOf(toks: Token[]): Span {
  return { start: toks[0]!.start, end: toks[toks.length - 1]!.end };
}

/** The significant tokens of each ';'-separated statement, without the inline data of INSERTs. */
function statements(text: string): Token[][] {
  const result: Token[][] = [];
  let toks = significantTokens(text, { start: 0, end: text.length });
  let i = 0;
  while (toks[i]!.kind !== T.EndOfStream) {
    if (toks[i]!.kind === T.Semicolon) {
      i++;
      continue;
    }
    const first = i;
    while (toks[i]!.kind !== T.Semicolon && toks[i]!.kind !== T.EndOfStream) i++;
    const data = inlineData(text, toks.slice(first, i));
    if (data === undefined) {
      result.push(toks.slice(first, i));
    } else if (data === "values") {
      // VALUES data runs to a ';' outside brackets, as in check().
      let depth = 0;
      for (i = first; toks[i]!.kind !== T.EndOfStream && !(toks[i]!.kind === T.Semicolon && depth <= 0); i++) {
        depth += nesting(toks[i]!);
      }
    } else {
      // Other data runs to the first empty line, where lexing starts again.
      const blank = text.indexOf("\n\n", data);
      if (blank === -1) break;
      toks = significantTokens(text, { start: blank, end: text.length });
      i = 0;
    }
  }
  return result;
}

/**
 * The inline data of an INSERT, as ParserInsertQuery finds it: "values" for data after VALUES or
 * FORMAT Values, the offset of the data after another FORMAT <name>, or undefined when there is none.
 */
function inlineData(text: string, toks: Token[]): "values" | number | undefined {
  if (word(text, toks[0]) !== "INSERT") return undefined;
  const input = toks.some((t, i) => word(text, t) === "INPUT" && toks[i + 1]?.kind === T.OpeningRoundBracket);
  let depth = 0;
  let select = false;
  for (let i = 0; i < toks.length; i++) {
    depth += nesting(toks[i]!);
    const w = depth === 0 ? word(text, toks[i]) : undefined;
    if (w === "INFILE") return undefined;
    if (w === "SELECT" || w === "WITH") select = true;
    if (w === "VALUES" && !select) return "values";
    if (w === "FORMAT" && toks[i + 1]?.kind === T.BareWord && (!select || input)) {
      if (word(text, toks[i + 1]) === "VALUES") return "values";
      // The data starts after the spaces and the line break that follow the name.
      let at = toks[i + 1]!.end;
      while (text[at] === " " || text[at] === "\t" || text[at] === "\f") at++;
      if (text[at] === "\r") at++;
      if (text[at] === "\n") at++;
      return at;
    }
  }
  return undefined;
}

/** The tokens of the SELECT that a statement is or ends with. */
function selectPart(text: string, toks: Token[]): Token[] | undefined {
  const first = word(text, toks[0]);
  let depth = 0;
  for (let i = 0; i < toks.length; i++) {
    depth += nesting(toks[i]!);
    if (depth !== 0 || i === 0) continue;
    const w = word(text, toks[i]);
    const next = word(text, toks[i + 1]);
    if (first === "SELECT" || first === "WITH") {
      // WITH ... INSERT is an INSERT.
      if (w === "INSERT") return undefined;
    } else if (first === "INSERT") {
      if (w === "SELECT" || w === "WITH") return toks.slice(i);
    } else if (first === "CREATE" || first === "REPLACE") {
      if (w === "AS" && (next === "SELECT" || next === "WITH")) return withoutComment(text, toks.slice(i + 1));
    }
  }
  return first === "SELECT" || first === "WITH" ? toks : undefined;
}

/** A view may end with COMMENT 'text', which is not part of its SELECT. */
function withoutComment(text: string, toks: Token[]): Token[] {
  const n = toks.length;
  const comment = n > 2 && toks[n - 1]!.kind === T.StringLiteral && word(text, toks[n - 2]) === "COMMENT";
  return comment ? toks.slice(0, n - 2) : toks;
}

// The name in a ClickHouse message, as in "Unknown expression identifier `x`" or "of function f".
const NAMED =
  /\b(?:[Ii]dentifier|with name|Database|Table|table function|type family:|Column|of function|for function) (`[^`]+`|'[^']+'|[\w.$]+)/;

/**
 * The identifier of `query` that a ClickHouse error message is about, such as `x` in
 * "Unknown expression identifier `x`", or undefined when the query has no such name.
 */
export function namedSpan(text: string, query: Span, message: string): Span | undefined {
  const head = message.split(/\. Maybe you meant|\.? In (?:scope|query) /)[0]!;
  const match = NAMED.exec(head);
  if (!match) return undefined;
  const name = /^[`']/.test(match[1]!) ? match[1]!.slice(1, -1) : match[1]!.replace(/\.+$/, "");
  const toks = significantTokens(text, query);
  const whole = toks.find((t) => identifier(text, t) === name);
  if (whole) return { start: whole.start, end: whole.end };
  // A compound name like db.table.column: the longest tail of it that the query spells out.
  const parts = name.split(".");
  for (let k = 0; k < parts.length; k++) {
    const tail = parts.slice(k);
    for (let i = 0; i + 2 * tail.length - 1 <= toks.length; i++) {
      const spelled = tail.every((part, j) => identifier(text, toks[i + 2 * j]) === part && (j === 0 || toks[i + 2 * j - 1]!.kind === T.Dot));
      if (spelled) return { start: toks[i]!.start, end: toks[i + 2 * tail.length - 2]!.end };
    }
  }
  return undefined;
}

/** The name an identifier token stands for, without its quotes. */
function identifier(text: string, token: Token | undefined): string | undefined {
  if (token?.kind === T.BareWord) return text.slice(token.start, token.end);
  if (token?.kind === T.QuotedIdentifier) return text.slice(token.start + 1, token.end - 1);
  return undefined;
}

function word(text: string, token: Token | undefined): string | undefined {
  return token?.kind === T.BareWord ? text.slice(token.start, token.end).toUpperCase() : undefined;
}

/** +1 for an opening bracket, -1 for a closing one, 0 for other tokens. */
function nesting(token: Token): number {
  const k = token.kind;
  if (k === T.OpeningRoundBracket || k === T.OpeningSquareBracket || k === T.OpeningCurlyBrace) return 1;
  if (k === T.ClosingRoundBracket || k === T.ClosingSquareBracket || k === T.ClosingCurlyBrace) return -1;
  return 0;
}

/** The significant tokens of a span of `text`, with offsets into `text`. */
function significantTokens(text: string, span: Span): Token[] {
  return tokenize(text.slice(span.start, span.end))
    .filter((t) => isSignificant(t.kind))
    .map((t) => ({ ...t, start: t.start + span.start, end: t.end + span.start }));
}
