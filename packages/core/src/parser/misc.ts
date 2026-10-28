/**
 * Smaller statements: RENAME, DROP, UNDROP, CHECK, KILL, OPTIMIZE, USE, transactions, DELETE, UPDATE
 * and SNAPSHOT. Ports of the ClickHouse parsers with the same names.
 */
import { Ast, stringValue } from "./ast.js";
import {
  parseCluster,
  parseDatabaseAndTableAsAST,
  parseDatabaseAndTableName,
  parseDatabaseAsAST,
  parseOnCluster,
  parsePartition,
} from "./common.js";
import {
  parseAsterisk,
  parseAssignment,
  parseColumnsMatcher,
  parseCompoundIdentifier,
  parseIdentifier,
  parseIdentifierWithOptionalParameters,
  parseList,
  parseNumber,
  parseStringLiteral,
} from "./elements.js";
import { parseExpression } from "./expression.js";
import { parseSetQuery } from "./set.js";
import { base, Expected, kw, listUtil, lookahead, P, peekKw, T, tok } from "./state.js";

const UUID_TEXT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;

/** UUID 'xxxxxxxx-...'; parseFromString<UUID> throws a non-syntax error for a bad value. */
export function parseUuidClause(p: P): boolean {
  if (!kw(p, "UUID")) return true;
  const value = parseStringLiteral(p);
  if (!value) return false;
  const text = stringValue(value)!;
  if (!UUID_TEXT.test(text)) p.failOther(`Cannot parse UUID from '${text}'`, p.i - 1);
  return true;
}

/** ParserRenameQuery: RENAME|EXCHANGE TABLE|DICTIONARY a TO|AND b, ... and RENAME DATABASE. */
export function parseRenameQuery(p: P): Ast | null {
  return base(p, "RENAME query", () => {
    if (kw(p, "RENAME DATABASE")) {
      kw(p, "IF EXISTS");
      if (!parseIdentifier(p, true)) return null;
      if (!kw(p, "TO")) return null;
      if (!parseIdentifier(p, true)) return null;
      if (!parseOnCluster(p)) return null;
      return new Ast("RenameQuery");
    }
    let exchange = false;
    if (kw(p, "RENAME TABLE")) {
      // RENAME TABLE.
    } else if (kw(p, "EXCHANGE TABLES")) {
      exchange = true;
    } else if (kw(p, "RENAME DICTIONARY")) {
      // RENAME DICTIONARY.
    } else if (kw(p, "EXCHANGE DICTIONARIES")) {
      exchange = true;
    } else if (!kw(p, "RENAME")) {
      return null;
    }
    let count = 0;
    for (;;) {
      if (count && !p.quiet(() => tok(p, T.Comma))) break;
      count++;
      if (!exchange) kw(p, "IF EXISTS");
      if (!parseDatabaseAndTableAsAST(p) || !kw(p, exchange ? "AND" : "TO") || !parseDatabaseAndTableAsAST(p))
        return null;
    }
    if (!parseOnCluster(p)) return null;
    return new Ast("RenameQuery");
  });
}

/** ParserNameList: a list of [db.]table names. */
function parseNameList(p: P): Ast | null {
  return base(p, "name list", () => parseList(p, () => parseCompoundIdentifier(p, true, true), undefined, false));
}

/** parseDropQuery: the part after DROP, DETACH or TRUNCATE. */
function parseDropBody(p: P, kind: "drop" | "detach" | "truncate"): boolean {
  peekKw(p, "ALL");
  if (kw(p, "DATABASE")) {
    kw(p, "IF EXISTS");
    kw(p, "IF EMPTY");
    if (!parseIdentifier(p, true)) return false;
  } else if ((kw(p, "TABLES") || (kw(p, "ALL") && kw(p, "TABLES"))) && kind === "truncate") {
    if (!kw(p, "FROM")) return false;
    kw(p, "IF EXISTS");
    if (!parseIdentifier(p, true)) return false;
    kw(p, "NOT");
    if (kw(p, "LIKE") && !parseStringLiteral(p)) return false;
    if (kw(p, "ILIKE") && !parseStringLiteral(p)) return false;
  } else {
    kw(p, "TEMPORARY");
    const isView = kw(p, "VIEW");
    const isDictionary = !isView && kw(p, "DICTIONARY");
    // TABLE may be left out in TRUNCATE.
    if (!isView && !isDictionary && !kw(p, "TABLE") && kind !== "truncate") return false;
    kw(p, "IF EXISTS");
    kw(p, "IF EMPTY");
    const tables = parseNameList(p);
    if (!tables) return false;
    if (tables.children.length > 1 && kind !== "drop") p.fail("Only Support DROP multiple tables currently", p.i - 1);
  }
  if (!parseOnCluster(p)) return false;
  if (kind === "detach") kw(p, "PERMANENTLY");
  if (!kw(p, "NO DELAY")) kw(p, "SYNC");
  return true;
}

/** ParserDropQuery: DROP, DETACH and TRUNCATE. */
export function parseDropQuery(p: P): Ast | null {
  return base(p, "DROP query", () => {
    let kind: "drop" | "detach" | "truncate";
    if (kw(p, "DROP")) kind = "drop";
    else if (kw(p, "DETACH")) kind = "detach";
    else if (kw(p, "TRUNCATE")) kind = "truncate";
    else return null;
    return parseDropBody(p, kind) ? new Ast("DropQuery") : null;
  });
}

/** ParserUndropQuery: UNDROP TABLE [db.]t [UUID 'x'] [ON CLUSTER c]. */
export function parseUndropQuery(p: P): Ast | null {
  return base(p, "UNDROP query", () => {
    if (!kw(p, "UNDROP")) return null;
    if (!kw(p, "TABLE")) return null;
    if (!parseIdentifier(p, true)) return null;
    if (tok(p, T.Dot) && !parseIdentifier(p, true)) return null;
    if (!parseUuidClause(p)) return null;
    if (!parseOnCluster(p)) return null;
    return new Ast("UndropQuery");
  });
}

/** ParserCheckQuery: CHECK ALL TABLES, CHECK TABLE t [PARTITION p | PART 'x'], CHECK DATABASE d. */
export function parseCheckQuery(p: P): Ast | null {
  return base(p, "CHECK query", () => {
    if (kw(p, "CHECK ALL TABLES")) return new Ast("CheckQuery");
    if (parseCheckTable(p)) return new Ast("CheckQuery");
    if (kw(p, "CHECK DATABASE") && parseDatabaseAsAST(p)) return new Ast("CheckQuery");
    return null;
  });
}

/** ParserCheckQuery::parseCheckTable; like ClickHouse it leaves the position where it failed. */
function parseCheckTable(p: P): boolean {
  if (!kw(p, "CHECK TABLE")) return false;
  if (!parseDatabaseAndTableAsAST(p)) return false;
  if (kw(p, "PARTITION")) {
    if (!parsePartition(p)) return false;
  } else if (kw(p, "PART")) {
    const name = parseStringLiteral(p);
    if (!name || !stringValue(name)) return false;
  }
  return true;
}

/** ParserKillQueryQuery: KILL QUERY|MUTATION|PART_MOVE_TO_SHARD|TRANSACTION [ON CLUSTER c] WHERE expr [SYNC|ASYNC|TEST]. */
export function parseKillQueryQuery(p: P): Ast | null {
  return base(p, "KILL QUERY query", () => {
    if (!kw(p, "KILL")) return null;
    if (!kw(p, "QUERY") && !kw(p, "MUTATION") && !kw(p, "PART_MOVE_TO_SHARD") && !kw(p, "TRANSACTION")) return null;
    if (kw(p, "ON") && !parseCluster(p)) return null;
    if (!kw(p, "WHERE") || !parseExpression(p)) return null;
    if (!kw(p, "SYNC") && !kw(p, "ASYNC")) kw(p, "TEST");
    return new Ast("KillQuery");
  });
}

/** ParserOptimizeQueryColumnsSpecification: COLUMNS(...), * EXCEPT ... or a column. */
function parseOptimizeColumns(p: P): Ast | null {
  const exceptOnly = { apply: false, except: true, replace: false };
  return base(
    p,
    "column specification for OPTIMIZE ... DEDUPLICATE BY",
    () => parseColumnsMatcher(p, exceptOnly) ?? parseAsterisk(p, exceptOnly) ?? parseIdentifier(p),
  );
}

/** ParserOptimizeQuery. */
export function parseOptimizeQuery(p: P): Ast | null {
  return base(p, "OPTIMIZE query", () => {
    if (!kw(p, "OPTIMIZE TABLE")) return null;
    if (!parseIdentifier(p, true)) return null;
    if (tok(p, T.Dot) && !parseIdentifier(p, true)) return null;
    if (kw(p, "ON") && !parseCluster(p)) return null;
    if (kw(p, "PARTITION") && !parsePartition(p)) return null;
    if (kw(p, "DRY RUN")) {
      if (!kw(p, "PARTS")) return null;
      if (!parseList(p, () => parseStringLiteral(p), undefined, false)) return null;
    }
    if (!kw(p, "FINAL")) kw(p, "FORCE");
    const deduplicate = kw(p, "DEDUPLICATE");
    kw(p, "CLEANUP");
    kw(p, "MANIFEST");
    if (deduplicate && kw(p, "BY") && !parseList(p, () => parseOptimizeColumns(p), undefined, false)) return null;
    return new Ast("OptimizeQuery");
  });
}

/** ParserUseQuery: USE [DATABASE] name. */
export function parseUseQuery(p: P): Ast | null {
  return base(p, "USE query", () => {
    if (!kw(p, "USE")) return null;
    const hasDatabaseKeyword = lookahead(p, () => kw(p, "DATABASE") && parseIdentifier(p, true) !== null, new Expected());
    if (hasDatabaseKeyword) kw(p, "DATABASE");
    return parseIdentifier(p, true) ? new Ast("UseQuery") : null;
  });
}

/** ParserTransactionControl: BEGIN, START TRANSACTION, COMMIT, ROLLBACK, SET TRANSACTION SNAPSHOT n. */
export function parseTransactionControl(p: P): Ast | null {
  return base(p, "TCL query", () => {
    if (kw(p, "BEGIN TRANSACTION") || kw(p, "START TRANSACTION") || kw(p, "COMMIT") || kw(p, "ROLLBACK"))
      return new Ast("TransactionControl");
    if (kw(p, "SET TRANSACTION SNAPSHOT")) {
      const snapshot = parseNumber(p);
      if (!snapshot || snapshot.value!.t !== "UInt64") return null;
      return new Ast("TransactionControl");
    }
    return null;
  });
}

/** IN PARTITION p, ... of lightweight DELETE and UPDATE. */
function parseInPartition(p: P): boolean {
  return !kw(p, "IN PARTITION") || parseList(p, () => parsePartition(p), undefined, false) !== null;
}

/** WHERE expr without an alias, then optional SETTINGS. */
function parsePredicateAndSettings(p: P): boolean {
  if (!kw(p, "WHERE")) return false;
  const predicate = parseExpression(p);
  if (!predicate || predicate.alias) return false;
  if (kw(p, "SETTINGS") && !parseSetQuery(p, true)) return false;
  return true;
}

/** ParserDeleteQuery: DELETE FROM t [ON CLUSTER c] [IN PARTITION p] WHERE expr [SETTINGS ...]. */
export function parseDeleteQuery(p: P): Ast | null {
  return base(p, "Delete query", () => {
    if (!kw(p, "DELETE")) return null;
    if (!kw(p, "FROM")) return null;
    if (!parseDatabaseAndTableAsAST(p)) return null;
    if (kw(p, "ON") && !parseCluster(p)) return null;
    if (!parseInPartition(p)) return null;
    return parsePredicateAndSettings(p) ? new Ast("DeleteQuery") : null;
  });
}

/** ParserUpdateQuery: UPDATE t [ON CLUSTER c] SET a = x, ... [IN PARTITION p] WHERE expr [SETTINGS ...]. */
export function parseUpdateQuery(p: P): Ast | null {
  return base(p, "Update query", () => {
    if (!kw(p, "UPDATE")) return null;
    if (!parseDatabaseAndTableAsAST(p)) return null;
    if (kw(p, "ON") && !parseCluster(p)) return null;
    if (!kw(p, "SET")) return null;
    if (!parseList(p, () => parseAssignment(p))) return null;
    if (!parseInPartition(p)) return null;
    return parsePredicateAndSettings(p) ? new Ast("UpdateQuery") : null;
  });
}

/** EXCEPT DATABASE[S] a, b; moves back on failure. */
export function parseExceptDatabases(p: P): boolean {
  const begin = p.i;
  if ((kw(p, "EXCEPT DATABASE") || kw(p, "EXCEPT DATABASES")) && listUtil(p, () => parseIdentifier(p) !== null, undefined, false))
    return true;
  p.restore(begin);
  return false;
}

/** EXCEPT TABLE[S] [db.]a, ...; a database other than `database` is a syntax error. */
export function parseExceptTables(p: P, database?: string): boolean {
  const begin = p.i;
  const element = () => {
    const start = p.i;
    const name = parseDatabaseAndTableName(p);
    if (!name) return false;
    if (database !== undefined && name.database && name.database !== database)
      p.fail(
        `Database name in EXCEPT TABLES clause doesn't match the database name in DATABASE clause: ${name.database} != ${database}`,
        start,
      );
    return true;
  };
  if ((kw(p, "EXCEPT TABLE") || kw(p, "EXCEPT TABLES")) && listUtil(p, element, undefined, false)) return true;
  p.restore(begin);
  return false;
}

/** ParserSnapshotQuery: SNAPSHOT TABLE t | ALL [EXCEPT ...] TO destination. */
export function parseSnapshotQuery(p: P): Ast | null {
  return base(p, "SNAPSHOT", () => {
    if (!kw(p, "SNAPSHOT")) return null;
    const begin = p.i;
    let element = false;
    if (kw(p, "TABLE")) {
      element = parseDatabaseAndTableName(p) !== null;
    } else if (kw(p, "ALL")) {
      parseExceptDatabases(p);
      parseExceptTables(p);
      element = true;
    }
    if (!element) {
      p.restore(begin);
      return null;
    }
    if (!kw(p, "TO")) return null;
    if (!parseIdentifierWithOptionalParameters(p)) return null;
    return new Ast("SnapshotQuery");
  });
}
