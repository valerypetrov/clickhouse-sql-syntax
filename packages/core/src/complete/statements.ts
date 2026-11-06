/**
 * keywordDocumentation(): the documentation of the SYSTEM command, or of the clause of a statement that makes or
 * changes a user, role, quota, row policy or settings profile, whose keyword is at an offset.
 */
import { split } from "../format/index.js";
import { ACCESS_DOCS, type AccessStatementDoc, type KeywordDoc, SYSTEM_DOCS } from "../generated/statements.js";
import { checkWithRoles, type ParseCache } from "../parser/index.js";
import { isSignificant, type KeywordDocumentation, type Token, TokenKind as T } from "../types.js";

/** The words after CREATE or ALTER that name each kind of access entity, as ClickHouse takes them. */
const ENTITIES: Record<string, string> = { USER: "USER", ROLE: "ROLE", QUOTA: "QUOTA", "ROW POLICY": "ROW POLICY", POLICY: "ROW POLICY", "SETTINGS PROFILE": "SETTINGS PROFILE", PROFILE: "SETTINGS PROFILE" };

const upper = (sql: string, token: Token | undefined) => (token?.kind === T.BareWord ? sql.slice(token.start, token.end).toUpperCase() : undefined);

/** The doc whose keywords the words at `from` start with, the longest one, and how many words it has. */
function longest(sql: string, tokens: Token[], from: number, docs: readonly KeywordDoc[]): { doc: KeywordDoc; length: number } | undefined {
  let found: { doc: KeywordDoc; length: number } | undefined;
  for (const doc of docs) {
    for (const keyword of doc.keywords) {
      const words = keyword.split(" ");
      if (words.length > (found?.length ?? 0) && words.every((w, i) => upper(sql, tokens[from + i]) === w)) found = { doc, length: words.length };
    }
  }
  return found;
}

/** The access statement that the tokens make or change, by its first words. */
function accessStatement(sql: string, tokens: Token[]): AccessStatementDoc | undefined {
  const verb = upper(sql, tokens[0]);
  if (verb !== "CREATE" && verb !== "ALTER") return undefined;
  const entity = ENTITIES[`${upper(sql, tokens[1])} ${upper(sql, tokens[2])}`] ?? ENTITIES[upper(sql, tokens[1]) ?? ""];
  return entity ? ACCESS_DOCS.find((d) => d.statement === `${verb} ${entity}`) : undefined;
}

/** The documentation of the SYSTEM command or access statement clause whose keyword is at `offset`. */
export function keywordDocumentation(sql: string, offset: number, cache?: ParseCache): KeywordDocumentation | undefined {
  const unit = split(sql).find((u) => u.statement && u.statement.start <= offset && offset <= u.statement.end);
  if (!unit) return undefined;
  const tokens = unit.tokens.filter((t) => isSignificant(t.kind) && t.kind !== T.Semicolon && t.kind !== T.EndOfStream);
  const at = tokens.findIndex((t) => t.start <= offset && offset <= t.end && t.kind === T.BareWord);
  if (at < 0) return undefined;
  const span = (from: number, length: number) => ({ start: tokens[from]!.start, end: tokens[from + length - 1]!.end });

  if (upper(sql, tokens[0]) === "SYSTEM") {
    const found = longest(sql, tokens, 1, SYSTEM_DOCS);
    return found && at <= found.length ? { ...span(0, found.length + 1), documentation: found.doc.markdown } : undefined;
  }

  const statement = accessStatement(sql, tokens);
  if (!statement) return undefined;
  // Only a word that the parser reads as a keyword, so not the name of a user called host.
  const start = unit.statement!.start;
  const role = checkWithRoles(sql.slice(start, unit.statement!.end), cache).spans.find((s) => s.start + start === tokens[at]!.start)?.role;
  if (role !== "keyword") return undefined;
  let best: { from: number; doc: KeywordDoc; length: number } | undefined;
  for (let from = Math.max(0, at - 3); from <= at; from++) {
    const found = longest(sql, tokens, from, statement.clauses);
    if (found && from + found.length > at && found.length > (best?.length ?? 0)) best = { from, ...found };
  }
  if (best) return { ...span(best.from, best.length), documentation: best.doc.markdown };
  return { ...span(at, 1), documentation: statement.markdown };
}
