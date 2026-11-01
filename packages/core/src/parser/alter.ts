/**
 * ALTER TABLE and ALTER DATABASE: a port of src/Parsers/ParserAlterQuery.cpp.
 */
import { Ast, keep, list } from "./ast.js";
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
function parseInPartition(p: P, command: Ast): boolean {
  return !kw(p, "IN PARTITION") || keep(command, "partition", parsePartition(p));
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
function parsePartitionsAndPredicate(p: P, command: Ast): boolean {
  if (kw(p, "IN PARTITION")) {
    const partitions = parseList(p, () => parsePartition(p), undefined, false);
    if (!partitions) return false;
    // A single partition is the command's own child, more stay in their list.
    command.set("partition", partitions.children.length === 1 ? partitions.children[0]! : partitions);
  }
  if (!kw(p, "WHERE")) return false;
  const predicate = parseExpressionWithOptionalAlias(p, false);
  if (!predicate) return false;
  command.set("predicate", predicate);
  return !predicate.alias;
}

/** MODIFY COLUMN and ALTER COLUMN: a declaration, or REMOVE, MODIFY SETTING, RESET SETTING, ADD ENUM VALUES. */
function parseModifyColumn(p: P, isModify: boolean, command: Ast): boolean {
  kw(p, "IF EXISTS");
  const declaration = parseColumnDeclaration(p, {
    compoundName: true,
    requireType: false,
    allowNullModifiers: true,
    checkKeywordsAfterName: true,
    checkTypeKeyword: !isModify,
  });
  if (!declaration) return false;
  command.set("col_decl", declaration);
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
    if (!tok(p, T.OpeningRoundBracket)) return false;
    return keep(command, "add_enum_values", parseExpressionList(p, false)) && tok(p, T.ClosingRoundBracket);
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
function parseStatisticsOperation(p: P, command: Ast): boolean {
  if (kw(p, "ALL")) return true;
  kw(p, "IF EXISTS");
  return parseStatisticsDeclarationWithoutTypes(p) !== null && parseInPartition(p, command);
}

type Command = [keyword: string, body: () => boolean];

/** The commands of ALTER TABLE, in the order ClickHouse tries them. */
function tableCommands(p: P, command: Ast): Command[] {
  const partition = () => keep(command, "partition", parsePartition(p));
  const inPartition = () => parseInPartition(p, command);
  const part = () => parseStringAndSubstitution(p) !== null;
  const ifExistsName = () => {
    kw(p, "IF EXISTS");
    return parseName(p);
  };
  return [
    ["ADD COLUMN", () => {
      kw(p, "IF NOT EXISTS");
      const declaration = parseColumnDeclaration(p, { compoundName: true, allowNullModifiers: true });
      return keep(command, "col_decl", declaration) && parseFirstOrAfter(p);
    }],
    ["RENAME COLUMN", () => ifExistsName() && kw(p, "TO") && parseName(p)],
    ["MATERIALIZE COLUMN", () => parseName(p) && inPartition()],
    ["DROP PARTITION", partition],
    ["DROP PART", part],
    ["FORGET PARTITION", partition],
    ["DROP DETACHED PARTITION", partition],
    ["DROP DETACHED PART", part],
    ["DROP COLUMN", ifExistsName],
    ["CLEAR COLUMN", () => ifExistsName() && inPartition()],
    ["ADD INDEX", () => {
      kw(p, "IF NOT EXISTS");
      return keep(command, "index_decl", parseIndexDeclaration(p)) && parseFirstOrAfter(p);
    }],
    ["DROP INDEX", ifExistsName],
    ["CLEAR INDEX", () => ifExistsName() && inPartition()],
    ["MATERIALIZE INDEX", () => ifExistsName() && inPartition()],
    ["ADD STATISTICS", () => {
      kw(p, "IF NOT EXISTS");
      return keep(command, "statistics_decl", parseStatisticsDeclaration(p));
    }],
    ["MODIFY STATISTICS", () => keep(command, "statistics_decl", parseStatisticsDeclaration(p))],
    ["DROP STATISTICS", () => {
      kw(p, "IF EXISTS");
      return parseStatisticsDeclarationWithoutTypes(p) !== null;
    }],
    ["CLEAR STATISTICS", () => parseStatisticsOperation(p, command)],
    ["MATERIALIZE STATISTICS", () => parseStatisticsOperation(p, command)],
    ["ADD PROJECTION", () => {
      kw(p, "IF NOT EXISTS");
      return keep(command, "projection_decl", parseProjectionDeclaration(p)) && parseFirstOrAfter(p);
    }],
    ["DROP PROJECTION", ifExistsName],
    ["CLEAR PROJECTION", () => ifExistsName() && inPartition()],
    ["MATERIALIZE PROJECTION", () => ifExistsName() && inPartition()],
    ["MODIFY PROJECTION", () => {
      kw(p, "IF EXISTS");
      return keep(command, "projection_decl", parseProjectionDeclaration(p));
    }],
    ["MOVE PART", () => part() && parseMoveDestination(p, true)],
    ["MOVE PARTITION", () => partition() && parseMoveDestination(p, false)],
    ["ADD CONSTRAINT", () => {
      kw(p, "IF NOT EXISTS");
      return keep(command, "constraint_decl", parseConstraintDeclaration(p));
    }],
    ["MODIFY CONSTRAINT", () => {
      kw(p, "IF EXISTS");
      return keep(command, "constraint_decl", parseConstraintDeclaration(p));
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
      parseStringLiteral(p) !== null &&
      (!kw(p, "FROM") || keep(command, "snapshot_desc", parseIdentifierWithOptionalParameters(p)))],
    ["MODIFY COLUMN", () => parseModifyColumn(p, true, command)],
    ["ALTER COLUMN", () => parseModifyColumn(p, false, command)],
    ["MODIFY ORDER BY", () => keep(command, "order_by", parseExpressionWithOptionalAlias(p, false))],
    ["MODIFY SAMPLE BY", () => keep(command, "sample_by", parseExpressionWithOptionalAlias(p, false))],
    ["REMOVE SAMPLE BY", () => true],
    ["DELETE", () => parsePartitionsAndPredicate(p, command)],
    ["UPDATE", () =>
      keep(command, "update_assignments", parseList(p, () => parseAssignment(p), undefined, false)) &&
      parsePartitionsAndPredicate(p, command)],
    ["COMMENT COLUMN", () => ifExistsName() && parseStringLiteral(p) !== null],
    ["MODIFY TTL", () => {
      if (peekKw(p, "MATERIALIZE") || peekKw(p, "REMOVE") || peekKw(p, "MODIFY")) return false;
      return keep(command, "ttl", parseTTLExpressionList(p));
    }],
    ["REMOVE TTL", () => true],
    ["MATERIALIZE TTL", inPartition],
    ["REWRITE PARTS", inPartition],
    ["MODIFY SETTING", () => parseSetQuery(p, true) !== null],
    ["RESET SETTING", () => parseList(p, () => parseIdentifier(p), undefined, false) !== null],
    ["MODIFY QUERY", () => keep(command, "select", parseSelectWithUnionQuery(p))],
  ];
}

/** The commands after MODIFY QUERY, which start differently. */
function parseLaterTableCommand(p: P, command: Ast): boolean | null {
  // MODIFY SQL SECURITY and MODIFY DEFINER leave the keyword after MODIFY to the SQL SECURITY parser.
  if (peekKw(p, "MODIFY SQL SECURITY") || peekKw(p, "MODIFY DEFINER")) {
    kw(p, "MODIFY");
    return parseSQLSecurity(p) !== null;
  }
  if (kw(p, "MODIFY REFRESH")) return parseRefreshStrategy(p) !== null;
  if (kw(p, "MODIFY COMMENT")) return parseStringLiteral(p) !== null;
  if (kw(p, "APPLY DELETED MASK") || kw(p, "APPLY PATCHES")) return parseInPartition(p, command);
  if (kw(p, "EXECUTE")) {
    if (!parseIdentifier(p)) return false;
    if (!tok(p, T.OpeningRoundBracket)) return false;
    if (!keep(command, "execute_args", parseList(p, () => parseExpressionWithOptionalAlias(p, false)))) return false;
    return tok(p, T.ClosingRoundBracket);
  }
  return null;
}

function parseTableCommand(p: P, command: Ast): boolean {
  for (const [keyword, body] of tableCommands(p, command)) if (kw(p, keyword)) return body();
  return parseLaterTableCommand(p, command) ?? false;
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
    const command = new Ast("AlterCommand");
    if (!(database ? parseDatabaseCommand(p) : parseTableCommand(p, command))) return null;
    if (withBracket && !tok(p, T.ClosingRoundBracket)) return null;
    return command;
  });
}

/** ParserAlterCommandList: commands separated by commas, all in brackets or none. */
function parseAlterCommandList(p: P, database: boolean): Ast | null {
  return base(p, "a list of ALTER commands", () => {
    const withBracket = p.kind() === T.OpeningRoundBracket;
    const commands: Ast[] = [];
    do {
      const command = parseAlterCommand(p, withBracket, database);
      if (!command) return null;
      commands.push(command);
    } while (tok(p, T.Comma));
    return list(commands);
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
    const commands = parseAlterCommandList(p, database);
    return commands ? new Ast("AlterQuery").set("commands", commands) : null;
  });
}
