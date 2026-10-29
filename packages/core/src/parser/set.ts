/**
 * SET queries and SETTINGS clauses: a port of src/Parsers/ParserSetQuery.cpp.
 */
import { Ast } from "./ast.js";
import {
  parseAllCollectionsOfLiterals,
  parseCompoundIdentifier,
  parseLiteral,
  parseStringLiteral,
  parseSubstitution,
} from "./elements.js";
import { parseFunction } from "./expression.js";
import { base, kw, P, T, tok, tokQuiet } from "./state.js";

/** ParserLiteralOrMap: a literal or {'key': 'value', ...}. */
function parseLiteralOrMap(p: P): Ast | null {
  return base(p, "literal or map", () => {
    const value = parseLiteral(p);
    if (value) return value;
    if (!tok(p, T.OpeningCurlyBrace)) return null;
    let empty = true;
    while (!tok(p, T.ClosingCurlyBrace)) {
      if (!empty && !tok(p, T.Comma)) return null;
      if (!parseStringLiteral(p)) return null;
      if (!tok(p, T.Colon)) return null;
      if (!parseStringLiteral(p)) return null;
      empty = false;
    }
    return new Ast("Literal");
  });
}

/** ParserSetQuery::parseNameValuePair: name = literal, map or disk(...); it does not move back on failure. */
export function parseNameValuePair(p: P): boolean {
  if (!parseCompoundIdentifier(p)) return false;
  if (!tok(p, T.Equals)) return false;
  const beforeFunction = p.i;
  const fn = parseFunction(p);
  if (fn && fn.name === "disk") return true;
  p.restore(beforeFunction);
  return parseLiteralOrMap(p) !== null;
}

/** name = value, ... as in named collections and dictionary SETTINGS; `after` runs after each pair. */
export function parseNameValuePairs(p: P, after: () => void = () => {}): boolean {
  let count = 0;
  for (;;) {
    if (count && !tokQuiet(p, T.Comma)) return true;
    if (!parseNameValuePair(p)) return false;
    after();
    count++;
  }
}

/** parseParameterValueIntoString: an identifier, a literal or a collection of literals. */
function parseParameterValue(p: P): boolean {
  return parseCompoundIdentifier(p) !== null || parseLiteral(p) !== null || parseAllCollectionsOfLiterals(p) !== null;
}

/** name = value, param_name = value, name = DEFAULT, or just name when shorthand is allowed. */
function parseSetting(p: P, shorthand: boolean): "setting" | "parameter" | "default" | null {
  const name = parseCompoundIdentifier(p);
  if (!name) return null;
  const hasEquals = tok(p, T.Equals);
  if (!shorthand && !hasEquals) return null;
  if (name.name.startsWith("param_")) {
    if (!hasEquals) return null;
    if (name.name === "param_") p.failOther("Parameter name cannot be empty");
    return parseParameterValue(p) ? "parameter" : null;
  }
  if (!hasEquals) return "setting";
  if (kw(p, "DEFAULT")) return "default";
  const beforeFunction = p.i;
  const fn = parseFunction(p);
  if (fn && fn.name === "disk") return "setting";
  p.restore(beforeFunction);
  if (parseSubstitution(p)) return "setting";
  return parseLiteralOrMap(p) ? "setting" : null;
}

/**
 * ParserSetQuery. With `onlyInternals` it reads the list after SETTINGS;
 * otherwise a whole SET statement, including SET TIME ZONE.
 */
export function parseSetQuery(p: P, onlyInternals = false, shorthand = true): Ast | null {
  return base(p, "SET query", () => {
    if (!onlyInternals) {
      if (!kw(p, "SET")) return null;
      // SET TRANSACTION SNAPSHOT is a transaction control query.
      if (kw(p, "TRANSACTION")) return null;
      if (kw(p, "TIME ZONE")) {
        tok(p, T.Equals);
        return parseLiteralOrMap(p) ? new Ast("SetQuery") : null;
      }
    }
    let count = 0;
    for (;;) {
      if (count && !tokQuiet(p, T.Comma)) break;
      if (!parseSetting(p, shorthand)) return null;
      count++;
    }
    return new Ast("SetQuery");
  });
}
