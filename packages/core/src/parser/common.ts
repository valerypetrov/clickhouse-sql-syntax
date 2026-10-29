/**
 * Small helpers shared by the statement parsers: ON CLUSTER, [db.]table names, PARTITION and time intervals.
 * Ports of parseDatabaseAndTableName.cpp, parseIdentifierOrStringLiteral.cpp, ParserPartition.cpp
 * and ParserTimeInterval.cpp.
 */
import { Ast, stringValue } from "./ast.js";
import { parseIdentifier, parseNumber, parseStringLiteral, parseSubstitution } from "./elements.js";
import { parseExpression, parseIntervalKind } from "./expression.js";
import { attempt, base, kw, listUtil, P, T, tok, tokQuiet } from "./state.js";

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
export function parseIdentifiersOrStringLiterals(p: P): string[] | null {
  const names: string[] = [];
  const element = () => {
    const name = parseIdentifierOrStringLiteral(p);
    if (name !== null) names.push(name);
    return name !== null;
  };
  return listUtil(p, element, undefined, false) ? names : null;
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

export interface TableNameOrAsterisks {
  database: string;
  table: string;
  wildcard: boolean;
  /** The name has no database part, so the current database is meant. */
  defaultDatabase: boolean;
}

/** parseDatabaseAndTableNameOrAsterisks: *, *.*, db.*, db.table or table, a name maybe with a * wildcard after it. */
export function parseDatabaseAndTableNameOrAsterisks(p: P): TableNameOrAsterisks | null {
  return attempt(p, () => {
    const result: TableNameOrAsterisks = { database: "", table: "", wildcard: false, defaultDatabase: false };
    if (tok(p, T.Asterisk)) {
      const beforeDot = p.i;
      if (tok(p, T.Dot) && tok(p, T.Asterisk)) return result;
      p.restore(beforeDot);
      result.defaultDatabase = true;
      return result;
    }
    const first = parseIdentifier(p);
    if (!first) return null;
    if (tok(p, T.Asterisk)) result.wildcard = true;
    const beforeDot = p.i;
    if (tok(p, T.Dot)) {
      if (tok(p, T.Asterisk)) {
        result.database = first.name;
        return result;
      }
      // db*.table: a database wildcard cannot go with a table name.
      if (result.wildcard) return null;
      const second = parseIdentifier(p);
      if (second) {
        result.database = first.name;
        result.table = second.name;
        if (tok(p, T.Asterisk)) result.wildcard = true;
        return result;
      }
    }
    p.restore(beforeDot);
    result.table = first.name;
    result.defaultDatabase = true;
    if (!result.wildcard && tok(p, T.Asterisk)) result.wildcard = true;
    return result;
  });
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

const SECONDS: Record<string, number> = { Second: 1, Minute: 60, Hour: 3600, Day: 86400, Week: 604800 };
const MONTHS: Record<string, number> = { Month: 1, Quarter: 3, Year: 12 };
const DAY = 86400;

/** A CalendarTimeInterval: months and seconds, kept apart because months differ in length. */
export interface TimeInterval {
  months: number;
  seconds: number;
}

/** CalendarTimeInterval::minSeconds and maxSeconds: a month is 28 to 31 days, a year 365 to 366. */
export function intervalSeconds(interval: TimeInterval, longest: boolean): number {
  const { months, seconds } = interval;
  const years = Math.floor(months / 12);
  return (years * (longest ? 366 : 365) + (months % 12) * (longest ? 31 : 28)) * DAY + seconds;
}

/** ParserTimeInterval: 1 HOUR 30 MINUTE, as in REFRESH EVERY. */
export function parseTimeInterval(p: P, allowZero = false, allowMixing = true): TimeInterval | null {
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
    const interval: TimeInterval = { months: 0, seconds: 0 };
    kinds.forEach((kind, index) => {
      if (kind in MONTHS) interval.months += values[index]! * MONTHS[kind]!;
      else if (kind in SECONDS) interval.seconds += values[index]! * SECONDS[kind]!;
      else p.failOther("Sub-second intervals are not supported here.", p.i - 1);
    });
    if (!allowZero && !interval.months && !interval.seconds) p.failOther("Interval must be positive", p.i - 1);
    if (!allowMixing && interval.months && interval.seconds)
      p.failOther("Interval shouldn't contain both calendar units and clock units (e.g. months and days)", p.i - 1);
    return interval;
  });
}
