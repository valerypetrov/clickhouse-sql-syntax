/**
 * Small helpers shared by the statement parsers: ON CLUSTER, [db.]table names, PARTITION and time intervals.
 * Ports of parseDatabaseAndTableName.cpp, parseIdentifierOrStringLiteral.cpp, ParserPartition.cpp
 * and ParserTimeInterval.cpp.
 */
import { Ast, stringValue } from "./ast.js";
import { parseIdentifier, parseNumber, parseStringLiteral, parseSubstitution } from "./elements.js";
import { parseExpression, parseIntervalKind } from "./expression.js";
import { base, kw, listUtil, P, T, tok, tokQuiet } from "./state.js";

/** parseIdentifierOrStringLiteral: a name or a non-empty string; moves back on failure. */
export function parseIdentifierOrStringLiteral(p: P): string | null {
  const begin = p.i;
  const name = parseIdentifier(p);
  if (name) return name.name;
  const value = parseStringLiteral(p);
  const text = stringValue(value);
  if (text) return text;
  p.restore(begin);
  return null;
}

/** parseIdentifiersOrStringLiterals: a non-empty comma-separated list of them. */
export function parseIdentifiersOrStringLiterals(p: P): boolean {
  return listUtil(p, () => parseIdentifierOrStringLiteral(p) !== null, undefined, false);
}

/** ASTQueryWithOnCluster::parse, called after ON: CLUSTER name. */
export function parseCluster(p: P): boolean {
  if (!kw(p, "CLUSTER")) return false;
  return parseIdentifierOrStringLiteral(p) !== null;
}

/** An optional ON CLUSTER clause; false if ON is not followed by a valid CLUSTER name. */
export function parseOnCluster(p: P): boolean {
  return !kw(p, "ON") || parseCluster(p);
}

/** parseDatabaseAndTableName: [db.]table with plain identifiers. It does not move back on failure. */
export function parseDatabaseAndTableName(p: P): { database: string; table: string } | null {
  const first = parseIdentifier(p);
  if (!first) return null;
  if (tokQuiet(p, T.Dot)) {
    const second = parseIdentifier(p);
    return second ? { database: first.name, table: second.name } : null;
  }
  return { database: "", table: first.name };
}

/** parseDatabaseAndTableAsAST: [db.]table where both may be {name:Identifier} parameters. */
export function parseDatabaseAndTableAsAST(p: P): boolean {
  if (!parseIdentifier(p, true)) return false;
  if (tokQuiet(p, T.Dot)) return parseIdentifier(p, true) !== null;
  return true;
}

/** parseDatabaseAsAST. */
export function parseDatabaseAsAST(p: P): boolean {
  return parseIdentifier(p, true) !== null;
}

/** parseDatabaseAndTableNameOrAsterisks: *, *.*, db.*, db.table, table, with * wildcards after names. */
export function parseDatabaseAndTableNameOrAsterisks(p: P): boolean {
  const begin = p.i;
  if (tok(p, T.Asterisk)) {
    const beforeDot = p.i;
    if (tok(p, T.Dot) && tok(p, T.Asterisk)) return true;
    p.restore(beforeDot);
    return true;
  }
  if (parseIdentifier(p)) {
    let wildcard = tok(p, T.Asterisk);
    const beforeDot = p.i;
    if (tok(p, T.Dot)) {
      if (tok(p, T.Asterisk)) return true;
      if (wildcard) {
        p.restore(begin);
        return false;
      }
      if (parseIdentifier(p)) {
        tok(p, T.Asterisk);
        return true;
      }
    }
    p.restore(beforeDot);
    if (!wildcard) wildcard = tok(p, T.Asterisk);
    return true;
  }
  p.restore(begin);
  return false;
}

/** ParserPartition: ID 'x', ALL, or a partition expression. */
export function parsePartition(p: P): Ast | null {
  return base(p, "partition", () => {
    if (kw(p, "ID")) return parseStringLiteral(p) ?? parseSubstitution(p);
    if (kw(p, "ALL")) return new Ast("Partition");
    if (parseSubstitution(p)) return new Ast("Partition");
    const value = parseExpression(p);
    if (!value) return null;
    if (value.kind === "Function") {
      if (value.name === "tuple") return new Ast("Partition");
      if (value.name === "CAST" || value.name === "_CAST") {
        if (value.children.length !== 2) return null;
        const operand = value.children[0]!;
        const isTuple = operand.kind === "Function" && operand.name === "tuple";
        return isTuple || operand.kind === "Literal" ? new Ast("Partition") : null;
      }
      return null;
    }
    return value.kind === "Literal" ? new Ast("Partition") : null;
  });
}

const CALENDAR_UNITS = new Set(["Month", "Quarter", "Year"]);

/** ParserTimeInterval: 1 HOUR 30 MINUTE, as in REFRESH EVERY. */
export function parseTimeInterval(p: P, allowZero = false, allowMixing = true): Ast | null {
  return base(p, "time interval", () => {
    const kinds: string[] = [];
    const values: number[] = [];
    for (;;) {
      const value = parseNumber(p);
      if (!value) break;
      const kind = parseIntervalKind(p);
      if (kind === null) return null;
      if (value.value!.t !== "UInt64") p.fail("Time interval must be an integer", p.i - 1);
      kinds.push(kind);
      values.push(Number((value.value as { v: number }).v));
    }
    if (!kinds.length) return null;
    const seen = new Set<string>();
    for (const kind of kinds) {
      if (seen.has(kind)) p.fail(`Time interval contains multiple ${kind} components`, p.i - 1);
      seen.add(kind);
    }
    if (!allowZero && values.every((value) => value === 0))
      p.failOther("Interval must be positive", p.i - 1);
    if (!allowMixing && kinds.some((kind) => CALENDAR_UNITS.has(kind)) && kinds.some((kind) => !CALENDAR_UNITS.has(kind)))
      p.failOther("Interval shouldn't contain both calendar units and clock units (e.g. months and days)", p.i - 1);
    return new Ast("Other");
  });
}
