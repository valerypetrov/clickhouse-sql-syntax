/**
 * Query parameters: {name:Type} in a query, and the param_name settings that give them values.
 */
import { tokenize } from "../lexer/index.js";
import { type CompletionCandidate, isSignificant, TokenKind as T } from "../types.js";

/** The parameters that clickhouse-test sets for the tests that use them. */
export const TEST_PARAMETERS: Readonly<Record<string, string>> = {
  CLICKHOUSE_DATABASE: "The database of the test, which clickhouse-test sets.",
  CLICKHOUSE_DATABASE_1: "The database of the test with `_1` after its name, which clickhouse-test sets.",
  CLICKHOUSE_DATABASE_2: "The database of the test with `_2` after its name, which clickhouse-test sets.",
  CLICKHOUSE_USER_FILES: "The user_files directory of the server, which clickhouse-test sets when its environment has it.",
  CLICKHOUSE_USER_FILES_UNIQUE: "A path in user_files of the test's own, which clickhouse-test sets when its environment has it.",
};

const IDENTIFIER_DOCUMENTATION =
  "The value is a name, not a value: a database, table, column or other identifier, as in `SELECT * FROM {table:Identifier}`. " +
  "Only `Identifier` may stand for a name.";

/** The names of the parameters that `sql` writes, as {name:Type} or as a param_name setting. */
export function parameterNames(sql: string): Set<string> {
  const tokens = tokenize(sql).filter((token) => isSignificant(token.kind));
  const names = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== T.BareWord) continue;
    const word = sql.slice(token.start, token.end);
    if (tokens[i - 1]?.kind === T.OpeningCurlyBrace && tokens[i + 1]?.kind === T.Colon) names.add(word);
    else if (word.startsWith("param_") && word.length > 6 && tokens[i + 1]?.kind === T.Equals) names.add(word.slice(6));
  }
  return names;
}

/** `Identifier`, where the type of a parameter goes. */
export function identifierType(): CompletionCandidate {
  return { label: "Identifier", kind: "data type", detail: "query parameter of a name", documentation: IDENTIFIER_DOCUMENTATION };
}

/** The names of the parameters of `sql`, where the name of a parameter goes, and those of clickhouse-test after them. */
export function parameterNameCandidates(sql: string): { tier: number; candidate: CompletionCandidate }[] {
  const names = parameterNames(sql);
  const found = [...names].map((name) => ({ tier: 0, candidate: { label: name, kind: "value" as const, detail: "query parameter" } }));
  const tests = Object.entries(TEST_PARAMETERS)
    .filter(([name]) => !names.has(name))
    .map(([name, documentation]) => ({ tier: 1, candidate: { label: name, kind: "value" as const, detail: "query parameter of clickhouse-test", documentation } }));
  return [...found, ...tests];
}

/** param_name for each parameter of `sql`, where a setting goes. */
export function parameterSettings(sql: string): CompletionCandidate[] {
  return [...parameterNames(sql)].map((name) => ({
    label: `param_${name}`,
    kind: "setting" as const,
    detail: "query parameter",
    documentation: `Gives \`{${name}:Type}\` its value, as text that is read as the type, as in \`SET param_${name} = 'value'\`.`,
  }));
}
