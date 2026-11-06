import { isSignificant, type Token, TokenKind as T, tokenize } from "clickhouse-sql-syntax";

const DOCS = "https://clickhouse.com/docs/sql-reference/syntax#defining-and-using-query-parameters";

/** The parameters that clickhouse-test sets for a test that writes {CLICKHOUSE_...}. */
const TEST_PARAMETERS: Record<string, string> = {
  CLICKHOUSE_DATABASE: "the database of the test",
  CLICKHOUSE_DATABASE_1: "the database of the test with `_1` after its name",
  CLICKHOUSE_DATABASE_2: "the database of the test with `_2` after its name",
  CLICKHOUSE_USER_FILES: "the user_files directory of the server, when its environment has CLICKHOUSE_USER_FILES",
  CLICKHOUSE_USER_FILES_UNIQUE: "a path in user_files of the test's own, when its environment has CLICKHOUSE_USER_FILES_UNIQUE",
};

/** A {name:Type} of the text, by offsets. */
export interface Substitution {
  name: string;
  type: string;
  start: number;
  end: number;
}

/** A SET param_name = value of the text: the value as the server gets it, or undefined when it is not plain. */
export interface ParameterSetting {
  name: string;
  value: string | undefined;
  /** In a SET statement, which clickhouse-client keeps for later ones, rather than in the SETTINGS of a query. */
  inSet: boolean;
  start: number;
  end: number;
}

/** The {name:Type} substitutions and the param_name settings of the text, in order. */
export function parameters(text: string): { substitutions: Substitution[]; settings: ParameterSetting[] } {
  const tokens = tokenize(text).filter((token) => isSignificant(token.kind));
  const substitutions: Substitution[] = [];
  const settings: ParameterSetting[] = [];
  let inSet = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (i === 0 || tokens[i - 1]!.kind === T.Semicolon) inSet = /^SET$/i.test(word(text, token));
    if (token.kind === T.OpeningCurlyBrace && tokens[i + 1]?.kind === T.BareWord && tokens[i + 2]?.kind === T.Colon) {
      const close = closingBrace(tokens, i);
      if (close === undefined) continue;
      const type = text.slice(tokens[i + 2]!.end, tokens[close]!.start).trim();
      substitutions.push({ name: word(text, tokens[i + 1]!), type, start: token.start, end: tokens[close]!.end });
    }
    if (token.kind === T.BareWord && /^param_\w/.test(word(text, token)) && tokens[i + 1]?.kind === T.Equals) {
      settings.push({ name: word(text, token).slice(6), value: plainValue(text, tokens[i + 2], tokens[i + 3]), inSet, start: token.start, end: token.end });
    }
  }
  return { substitutions, settings };
}

function word(text: string, token: Token): string {
  return text.slice(token.start, token.end);
}

/** The index of the } that closes the { at `open`, with the brackets of the type in between. */
function closingBrace(tokens: Token[], open: number): number | undefined {
  let depth = 0;
  for (let i = open + 3; i < tokens.length; i++) {
    const kind = tokens[i]!.kind;
    if (kind === T.OpeningRoundBracket) depth++;
    else if (kind === T.ClosingRoundBracket) depth--;
    else if (kind === T.ClosingCurlyBrace && depth === 0) return i;
    else if (kind === T.Semicolon || kind === T.OpeningCurlyBrace || depth < 0) return undefined;
  }
  return undefined;
}

/**
 * The text that SET param_x gives the server for a value that ends where the setting does: a string without
 * escapes, an unsigned integer, or a name. Other literals are written otherwise by ClickHouse, so they are left out.
 */
function plainValue(text: string, value: Token | undefined, after: Token | undefined): string | undefined {
  if (!value || (after && after.kind !== T.Comma && after.kind !== T.Semicolon && after.kind !== T.EndOfStream)) return undefined;
  const written = word(text, value);
  if (value.kind === T.StringLiteral && /^'[^'\\]*'$/.test(written)) return written.slice(1, -1);
  if (value.kind === T.Number && /^\d+$/.test(written)) return written;
  if (value.kind === T.BareWord && !/^(?:DEFAULT|NULL|TRUE|FALSE)$/i.test(written)) return written;
  return undefined;
}

/** The documentation of the query parameter at `offset`: in {name:Type}, or the name of a param_name setting. */
export function parameterHover(text: string, offset: number): { markdown: string; start: number; end: number } | undefined {
  const { substitutions, settings } = parameters(text);
  const substitution = substitutions.find((s) => s.start <= offset && offset <= s.end);
  const setting = settings.find((s) => s.start <= offset && offset <= s.end);
  const name = substitution?.name ?? setting?.name;
  if (name === undefined) return undefined;
  const line = (at: number) => text.slice(0, at).split(/\r\n|\r|\n/).length;
  const types = substitutions.filter((s) => s.name === name);
  const values = settings.filter((s) => s.name === name);
  const lines = [`**Query parameter \`${name}\`**`, ""];
  const type = substitution?.type;
  if (type === "Identifier") lines.push("`Identifier`: its value is a name, of a database, table, column or other object, not a value.", "");
  else if (type) lines.push(`ClickHouse reads its value, which is text, as \`${type}\`; text it cannot read so fails the query with BAD_QUERY_PARAMETER.`, "");
  if (TEST_PARAMETERS[name]) lines.push(`clickhouse-test sets it to ${TEST_PARAMETERS[name]}, for a test that writes \`{${name}:...}\`.`, "");
  if (types.length) lines.push(`In this file: ${types.map((s) => `\`${text.slice(s.start, s.end)}\` on line ${line(s.start)}`).join(", ")}.`, "");
  if (values.length) lines.push(`Set by \`param_${name}\` on line ${values.map((s) => line(s.start)).join(", ")}.`, "");
  lines.push(
    "A query whose parameter has no value fails with UNKNOWN_QUERY_PARAMETER. It gets its value from:",
    "",
    `- \`SET param_${name} = 'value'\`, which clickhouse-client keeps for the statements after it;`,
    `- \`SETTINGS param_${name} = 'value'\` at the end of the query;`,
    `- \`--param_${name}='value'\` on the command line of clickhouse-client or clickhouse local;`,
    `- \`param_${name}=value\` in the URL of the HTTP interface.`,
    "",
    `[Query parameters](${DOCS})`,
  );
  const span = substitution ?? setting!;
  return { markdown: lines.join("\n"), start: span.start, end: span.end };
}

/** The values that the SET param_x statements of `settings` before `offset` give, for the server check. */
export function parameterValuesBefore(settings: ParameterSetting[], offset: number): Record<string, string> {
  const values: Record<string, string> = {};
  for (const setting of settings) {
    if (setting.start >= offset) break;
    if (!setting.inSet) continue;
    if (setting.value === undefined) delete values[setting.name];
    else values[setting.name] = setting.value;
  }
  return values;
}
