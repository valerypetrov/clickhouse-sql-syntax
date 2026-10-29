/**
 * ALTER TABLE and ALTER DATABASE: a port of src/Parsers/ParserAlterQuery.cpp.
 */
import { Ast } from "./ast.js";
import {
  parseCluster,
  parseDatabaseAndTableAsAST,
  parseDatabaseAndTableName,
  parseDatabaseAsAST,
  parsePartition,
} from "./common.js";
import {
  parseColumnDeclaration,
  parseConstraintDeclaration,
  parseIndexDeclaration,
  parseProjectionDeclaration,
  parseRefreshStrategy,
  parseSQLSecurity,
  parseStatisticsDeclaration,
  parseStatisticsDeclarationWithoutTypes,
} from "./create.js";
import {
  parseAssignment,
  parseCompoundIdentifier,
  parseIdentifier,
  parseIdentifierWithOptionalParameters,
  parseList,
  parseStringLiteral,
  parseSubstitution,
} from "./elements.js";
import { parseExpressionList, parseExpressionWithOptionalAlias, parseTTLExpressionList } from "./expression.js";
import { parseSelectWithUnionQuery } from "./select.js";
import { parseSetQuery } from "./set.js";
import { base, kw, P, peekKw, T, tok } from "./state.js";

/** ParserStringAndSubstitution: a part name as a string or a {name:String} parameter. */
export function parseStringAndSubstitution(p: P): Ast | null {
  return base(p, "ParserStringAndSubstitution", () => parseStringLiteral(p) ?? parseSubstitution(p));
}

function parseName(p: P): boolean {
  return parseCompoundIdentifier(p) !== null;
}

/** [IN PARTITION p]. */
function parseInPartition(p: P): boolean {
  return !kw(p, "IN PARTITION") || parsePartition(p) !== null;
}

/** [FIRST | AFTER name]. */
function parseFirstOrAfter(p: P): boolean {
  if (kw(p, "FIRST")) return true;
  return !kw(p, "AFTER") || parseName(p);
}

/** WITH NAME 'name' after FREEZE and UNFREEZE. */
function parseWithName(p: P): boolean {
  return kw(p, "NAME") && parseStringLiteral(p) !== null;
}

/** [IN PARTITION p, ...] WHERE expr, where the condition has no alias. */
function parsePartitionsAndPredicate(p: P): boolean {
  if (kw(p, "IN PARTITION") && !parseList(p, () => parsePartition(p), undefined, false)) return false;
  if (!kw(p, "WHERE")) return false;
  const predicate = parseExpressionWithOptionalAlias(p, false);
  return predicate !== null && !predicate.alias;
}

/** MODIFY COLUMN and ALTER COLUMN: a declaration, or REMOVE, MODIFY SETTING, RESET SETTING, ADD ENUM VALUES. */
function parseModifyColumn(p: P, isModify: boolean): boolean {
  kw(p, "IF EXISTS");
  const declaration = parseColumnDeclaration(p, {
    compoundName: true,
    requireType: false,
    allowNullModifiers: true,
    checkKeywordsAfterName: true,
    checkTypeKeyword: !isModify,
  });
  if (!declaration) return false;
  if (declaration.has("null_modifier") && !declaration.get("type"))
    p.fail("NULL / NOT NULL modifier requires an explicit column type");
  const checkNoType = (keyword: string): void => {
    if (["children", "null_modifier", "default_specifier", "primary_key"].some((flag) => declaration.has(flag)))
      p.fail(`Cannot specify column properties before '${keyword}'`);
  };
  if (kw(p, "REMOVE")) {
    checkNoType("REMOVE");
    return ["DEFAULT", "MATERIALIZED", "ALIAS", "COMMENT", "CODEC", "TTL", "SETTINGS"].some((keyword) => kw(p, keyword));
  }
  if (kw(p, "MODIFY SETTING")) {
    checkNoType("MODIFY SETTING");
    return parseSetQuery(p, true) !== null;
  }
  if (kw(p, "RESET SETTING")) {
    checkNoType("RESET SETTING");
    return parseList(p, () => parseIdentifier(p), undefined, false) !== null;
  }
  if (kw(p, "ADD ENUM VALUES")) {
    checkNoType("ADD ENUM VALUES");
    return tok(p, T.OpeningRoundBracket) && parseExpressionList(p, false) !== null && tok(p, T.ClosingRoundBracket);
  }
  return parseFirstOrAfter(p);
}

/** MOVE PART|PARTITION ... TO DISK|VOLUME 'name', TO SHARD 'path' or TO TABLE t. */
function parseMoveDestination(p: P, part: boolean): boolean {
  if (kw(p, "TO DISK") || kw(p, "TO VOLUME")) return parseStringLiteral(p) !== null;
  if (part) return kw(p, "TO SHARD") && parseStringLiteral(p) !== null;
  return kw(p, "TO TABLE") && parseDatabaseAndTableName(p) !== null;
}

/** CLEAR|MATERIALIZE STATISTICS ALL | [IF EXISTS] columns [IN PARTITION p]. */
function parseStatisticsOperation(p: P): boolean {
  if (kw(p, "ALL")) return true;
  kw(p, "IF EXISTS");
  return parseStatisticsDeclarationWithoutTypes(p) !== null && parseInPartition(p);
}

type Command = [keyword: string, body: () => boolean];

/** The commands of ALTER TABLE, in the order ClickHouse tries them. */
function tableCommands(p: P): Command[] {
  const partition = () => parsePartition(p) !== null;
  const part = () => parseStringAndSubstitution(p) !== null;
  const ifExistsName = () => {
    kw(p, "IF EXISTS");
    return parseName(p);
  };
  return [
    ["ADD COLUMN", () => {
      kw(p, "IF NOT EXISTS");
      const declaration = parseColumnDeclaration(p, { compoundName: true, allowNullModifiers: true });
      return declaration !== null && parseFirstOrAfter(p);
    }],
    ["RENAME COLUMN", () => ifExistsName() && kw(p, "TO") && parseName(p)],
    ["MATERIALIZE COLUMN", () => parseName(p) && parseInPartition(p)],
    ["DROP PARTITION", partition],
    ["DROP PART", part],
    ["FORGET PARTITION", partition],
    ["DROP DETACHED PARTITION", partition],
    ["DROP DETACHED PART", part],
    ["DROP COLUMN", ifExistsName],
    ["CLEAR COLUMN", () => ifExistsName() && parseInPartition(p)],
    ["ADD INDEX", () => {
      kw(p, "IF NOT EXISTS");
      return parseIndexDeclaration(p) !== null && parseFirstOrAfter(p);
    }],
    ["DROP INDEX", ifExistsName],
    ["CLEAR INDEX", () => ifExistsName() && parseInPartition(p)],
    ["MATERIALIZE INDEX", () => ifExistsName() && parseInPartition(p)],
    ["ADD STATISTICS", () => {
      kw(p, "IF NOT EXISTS");
      return parseStatisticsDeclaration(p) !== null;
    }],
    ["MODIFY STATISTICS", () => parseStatisticsDeclaration(p) !== null],
    ["DROP STATISTICS", () => {
      kw(p, "IF EXISTS");
      return parseStatisticsDeclarationWithoutTypes(p) !== null;
    }],
    ["CLEAR STATISTICS", () => parseStatisticsOperation(p)],
    ["MATERIALIZE STATISTICS", () => parseStatisticsOperation(p)],
    ["ADD PROJECTION", () => {
      kw(p, "IF NOT EXISTS");
      return parseProjectionDeclaration(p) !== null && parseFirstOrAfter(p);
    }],
    ["DROP PROJECTION", ifExistsName],
    ["CLEAR PROJECTION", () => ifExistsName() && parseInPartition(p)],
    ["MATERIALIZE PROJECTION", () => ifExistsName() && parseInPartition(p)],
    ["MODIFY PROJECTION", () => {
      kw(p, "IF EXISTS");
      return parseProjectionDeclaration(p) !== null;
    }],
    ["MOVE PART", () => part() && parseMoveDestination(p, true)],
    ["MOVE PARTITION", () => partition() && parseMoveDestination(p, false)],
    ["ADD CONSTRAINT", () => {
      kw(p, "IF NOT EXISTS");
      return parseConstraintDeclaration(p) !== null;
    }],
    ["MODIFY CONSTRAINT", () => {
      kw(p, "IF EXISTS");
      return parseConstraintDeclaration(p) !== null;
    }],
    ["DROP CONSTRAINT", ifExistsName],
    ["DETACH PARTITION", partition],
    ["DETACH PART", part],
    ["ATTACH PARTITION", () => partition() && (!kw(p, "FROM") || parseDatabaseAndTableName(p) !== null)],
    ["REPLACE PARTITION", () => partition() && kw(p, "FROM") && parseDatabaseAndTableName(p) !== null],
    ["ATTACH PART", () => part() && (!kw(p, "FROM") || parseStringLiteral(p) !== null)],
    ["FETCH PARTITION", () => partition() && kw(p, "FROM") && parseStringLiteral(p) !== null],
    ["FETCH PART", () => part() && kw(p, "FROM") && parseStringLiteral(p) !== null],
    ["FREEZE", () => (!kw(p, "PARTITION") || partition()) && (!kw(p, "WITH") || parseWithName(p))],
    ["UNFREEZE", () => (!kw(p, "PARTITION") || partition()) && kw(p, "WITH") && parseWithName(p)],
    ["UNLOCK SNAPSHOT", () =>
      parseStringLiteral(p) !== null && (!kw(p, "FROM") || parseIdentifierWithOptionalParameters(p) !== null)],
    ["MODIFY COLUMN", () => parseModifyColumn(p, true)],
    ["ALTER COLUMN", () => parseModifyColumn(p, false)],
    ["MODIFY ORDER BY", () => parseExpressionWithOptionalAlias(p, false) !== null],
    ["MODIFY SAMPLE BY", () => parseExpressionWithOptionalAlias(p, false) !== null],
    ["REMOVE SAMPLE BY", () => true],
    ["DELETE", () => parsePartitionsAndPredicate(p)],
    ["UPDATE", () =>
      parseList(p, () => parseAssignment(p), undefined, false) !== null && parsePartitionsAndPredicate(p)],
    ["COMMENT COLUMN", () => ifExistsName() && parseStringLiteral(p) !== null],
    ["MODIFY TTL", () => {
      if (peekKw(p, "MATERIALIZE") || peekKw(p, "REMOVE") || peekKw(p, "MODIFY")) return false;
      return parseTTLExpressionList(p) !== null;
    }],
    ["REMOVE TTL", () => true],
    ["MATERIALIZE TTL", () => parseInPartition(p)],
    ["REWRITE PARTS", () => parseInPartition(p)],
    ["MODIFY SETTING", () => parseSetQuery(p, true) !== null],
    ["RESET SETTING", () => parseList(p, () => parseIdentifier(p), undefined, false) !== null],
    ["MODIFY QUERY", () => parseSelectWithUnionQuery(p) !== null],
  ];
}

/** The commands after MODIFY QUERY, which start differently. */
function parseLaterTableCommand(p: P): boolean | null {
  // MODIFY SQL SECURITY and MODIFY DEFINER leave the keyword after MODIFY to the SQL SECURITY parser.
  if (peekKw(p, "MODIFY SQL SECURITY") || peekKw(p, "MODIFY DEFINER")) {
    kw(p, "MODIFY");
    return parseSQLSecurity(p) !== null;
  }
  if (kw(p, "MODIFY REFRESH")) return parseRefreshStrategy(p) !== null;
  if (kw(p, "MODIFY COMMENT")) return parseStringLiteral(p) !== null;
  if (kw(p, "APPLY DELETED MASK") || kw(p, "APPLY PATCHES")) return parseInPartition(p);
  if (kw(p, "EXECUTE")) {
    if (!parseIdentifier(p)) return false;
    if (!tok(p, T.OpeningRoundBracket)) return false;
    if (!parseList(p, () => parseExpressionWithOptionalAlias(p, false))) return false;
    return tok(p, T.ClosingRoundBracket);
  }
  return null;
}

function parseTableCommand(p: P): boolean {
  for (const [keyword, body] of tableCommands(p)) if (kw(p, keyword)) return body();
  return parseLaterTableCommand(p) ?? false;
}

function parseDatabaseCommand(p: P): boolean {
  if (kw(p, "MODIFY SETTING")) return parseSetQuery(p, true) !== null;
  if (kw(p, "MODIFY COMMENT")) return parseStringLiteral(p) !== null;
  return false;
}

/** ParserAlterCommand, optionally in round brackets. */
function parseAlterCommand(p: P, withBracket: boolean, database: boolean): Ast | null {
  return base(p, "ALTER command", () => {
    if (withBracket && !tok(p, T.OpeningRoundBracket)) return null;
    if (!(database ? parseDatabaseCommand(p) : parseTableCommand(p))) return null;
    if (withBracket && !tok(p, T.ClosingRoundBracket)) return null;
    return new Ast("AlterCommand");
  });
}

/** ParserAlterCommandList: commands separated by commas, all in brackets or none. */
function parseAlterCommandList(p: P, database: boolean): Ast | null {
  return base(p, "a list of ALTER commands", () => {
    const withBracket = p.kind() === T.OpeningRoundBracket;
    do {
      if (!parseAlterCommand(p, withBracket, database)) return null;
    } while (tok(p, T.Comma));
    return new Ast("AlterCommandList");
  });
}

/** ParserAlterQuery: ALTER [TEMPORARY] TABLE t [ON CLUSTER c] commands, or ALTER DATABASE d ... */
export function parseAlterQuery(p: P): Ast | null {
  return base(p, "ALTER query", () => {
    let database = false;
    if (kw(p, "ALTER TABLE") || kw(p, "ALTER TEMPORARY TABLE")) {
      if (!parseDatabaseAndTableAsAST(p)) return null;
    } else if (kw(p, "ALTER DATABASE")) {
      database = true;
      if (!parseDatabaseAsAST(p)) return null;
    } else {
      return null;
    }
    if (kw(p, "ON") && !parseCluster(p)) return null;
    return parseAlterCommandList(p, database) ? new Ast("AlterQuery") : null;
  });
}
