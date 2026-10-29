/**
 * The top-level alternatives: a port of src/Parsers/ParserQuery.cpp and ParserQueryWithOutput.cpp.
 * The order of the alternatives is the order ClickHouse tries them in.
 */
import {
  parseCheckGrantQuery,
  parseCreateMaskingPolicyQuery,
  parseCreateQuotaQuery,
  parseCreateRoleQuery,
  parseCreateRowPolicyQuery,
  parseCreateSettingsProfileQuery,
  parseCreateTokenQuery,
  parseCreateUserQuery,
  parseDropAccessEntityQuery,
  parseExecuteAsQuery,
  parseGrantQuery,
  parseMoveAccessEntityQuery,
  parseSetRoleQuery,
  parseShowAccessEntitiesQuery,
  parseShowAccessQuery,
  parseShowCreateAccessEntityQuery,
  parseShowGrantsQuery,
  parseShowPrivilegesQuery,
} from "./access.js";
import { parseAlterQuery } from "./alter.js";
import { Ast } from "./ast.js";
import { parseBackupQuery } from "./backup.js";
import { parseCreateNamedCollectionQuery, parseCreateQuery } from "./create.js";
import {
  parseAlterNamedCollectionQuery,
  parseCopyQuery,
  parseCreateFunctionQuery,
  parseCreateHandlerQuery,
  parseCreateIndexQuery,
  parseCreateResourceQuery,
  parseCreateWorkloadQuery,
  parseDropFunctionQuery,
  parseDropHandlerQuery,
  parseDropIndexQuery,
  parseDropNamedCollectionQuery,
  parseDropResourceQuery,
  parseDropWorkloadQuery,
  parseHypotheticalObjectQuery,
} from "./ddl.js";
import { parseIdentifier, parseNumber, parseStringLiteral } from "./elements.js";
import { parseExplainQuery } from "./explain.js";
import { parseInsertQuery } from "./insert.js";
import {
  parseCheckQuery,
  parseDeleteQuery,
  parseDropQuery,
  parseKillQueryQuery,
  parseOptimizeQuery,
  parseRenameQuery,
  parseSnapshotQuery,
  parseTransactionControl,
  parseUndropQuery,
  parseUpdateQuery,
  parseUseQuery,
} from "./misc.js";
import { parseSelectWithUnionQuery } from "./select.js";
import { parseSetQuery } from "./set.js";
import {
  parseDescribeCacheQuery,
  parseDescribeTableQuery,
  parseShowColumnsQuery,
  parseShowEnginesQuery,
  parseShowFunctionsQuery,
  parseShowIndexesQuery,
  parseShowProcesslistQuery,
  parseShowSettingQuery,
  parseShowTablesQuery,
  parseTablePropertiesQuery,
} from "./show.js";
import { base, kw, P } from "./state.js";
import { parseSystemQuery } from "./system.js";

/** ParserQueryWithOutput: SELECT, SHOW, CREATE, ALTER and the like, then INTO OUTFILE, FORMAT and SETTINGS. */
export function parseQueryWithOutput(p: P, allowSettingsAfterFormat = false): Ast | null {
  return base(p, "Query with output", () => {
    const query =
      parseExplainQuery(p, false, allowSettingsAfterFormat) ??
      parseSelectWithUnionQuery(p) ??
      parseShowCreateAccessEntityQuery(p) ??
      parseShowTablesQuery(p) ??
      parseShowColumnsQuery(p) ??
      parseShowEnginesQuery(p) ??
      parseShowFunctionsQuery(p) ??
      parseShowIndexesQuery(p) ??
      parseShowSettingQuery(p) ??
      parseTablePropertiesQuery(p) ??
      parseDescribeCacheQuery(p) ??
      parseDescribeTableQuery(p) ??
      parseShowProcesslistQuery(p) ??
      parseCreateTokenQuery(p) ??
      parseCreateQuery(p) ??
      parseAlterQuery(p) ??
      parseRenameQuery(p) ??
      parseDropQuery(p) ??
      parseUndropQuery(p) ??
      parseCheckQuery(p) ??
      parseKillQueryQuery(p) ??
      parseOptimizeQuery(p) ??
      parseShowAccessQuery(p) ??
      parseShowAccessEntitiesQuery(p) ??
      parseShowGrantsQuery(p) ??
      parseShowPrivilegesQuery(p) ??
      parseBackupQuery(p) ??
      parseSnapshotQuery(p);
    if (!query) return null;

    if (kw(p, "INTO OUTFILE")) {
      if (!parseStringLiteral(p)) return null;
      kw(p, "APPEND");
      kw(p, "TRUNCATE");
      kw(p, "AND STDOUT");
      if (kw(p, "COMPRESSION")) {
        if (!parseStringLiteral(p)) return null;
        if (kw(p, "LEVEL") && !parseNumber(p)) return null;
      }
      query.flag("output");
    }
    // FORMAT and SETTINGS may come in either order.
    let format = query.has("format_ast");
    let settings = query.has("settings_ast");
    for (let round = 0; round < 2; round++) {
      if (!format && kw(p, "FORMAT")) {
        if (!parseIdentifier(p)) return null;
        format = true;
      } else if (!settings && kw(p, "SETTINGS")) {
        if (!parseSetQuery(p, true)) return null;
        settings = true;
      } else {
        break;
      }
    }
    if (format || settings) query.flag("output");
    return query;
  });
}

/** ParserParallelWithQuery: q1 PARALLEL WITH q2 [PARALLEL WITH q3 ...]. */
function parseParallelWith(p: P, first: Ast, allowSettingsAfterFormat: boolean): Ast {
  const result = base(p, "ParallelWithClause", () => {
    let before = p.i;
    if (!kw(p, "PARALLEL WITH")) return first;
    const node = new Ast("ParallelWithQuery");
    node.children = [first];
    do {
      const query = parseQueryAlternatives(p, allowSettingsAfterFormat, true, false);
      if (!query) {
        p.restore(before);
        break;
      }
      node.children.push(query);
      before = p.i;
    } while (kw(p, "PARALLEL WITH"));
    return node;
  });
  return result ?? first;
}

function parseQueryAlternatives(
  p: P,
  allowSettingsAfterFormat: boolean,
  allowExecuteAs: boolean,
  allowParallelWith: boolean,
): Ast | null {
  return base(p, "Query", () => {
    let node =
      parseQueryWithOutput(p, allowSettingsAfterFormat) ??
      parseInsertQuery(p, allowSettingsAfterFormat) ??
      parseUseQuery(p) ??
      parseSetRoleQuery(p) ??
      parseSetQuery(p) ??
      parseSystemQuery(p) ??
      parseCreateUserQuery(p) ??
      parseCreateRoleQuery(p) ??
      parseCreateQuotaQuery(p) ??
      parseCreateRowPolicyQuery(p) ??
      parseCreateMaskingPolicyQuery(p) ??
      parseCreateSettingsProfileQuery(p) ??
      parseCreateFunctionQuery(p) ??
      parseDropFunctionQuery(p) ??
      parseCreateWorkloadQuery(p) ??
      parseDropWorkloadQuery(p) ??
      parseCreateResourceQuery(p) ??
      parseDropResourceQuery(p) ??
      parseCreateNamedCollectionQuery(p) ??
      parseDropNamedCollectionQuery(p) ??
      parseAlterNamedCollectionQuery(p) ??
      parseCreateHandlerQuery(p) ??
      parseDropHandlerQuery(p) ??
      parseCreateIndexQuery(p) ??
      parseDropIndexQuery(p) ??
      parseHypotheticalObjectQuery(p) ??
      parseDropAccessEntityQuery(p) ??
      parseMoveAccessEntityQuery(p) ??
      parseGrantQuery(p) ??
      parseCheckGrantQuery(p) ??
      parseTransactionControl(p) ??
      parseDeleteQuery(p) ??
      parseUpdateQuery(p) ??
      parseCopyQuery(p);
    if (!node && allowExecuteAs)
      node = parseExecuteAsQuery(p, () => parseQueryAlternatives(p, allowSettingsAfterFormat, false, true));
    if (node && allowParallelWith) node = parseParallelWith(p, node, allowSettingsAfterFormat);
    return node;
  });
}

/** ParserQuery with the settings of `clickhouse format`: no implicit SELECT. */
export function parseQuery(p: P, allowSettingsAfterFormat = false): Ast | null {
  return parseQueryAlternatives(p, allowSettingsAfterFormat, true, true);
}
