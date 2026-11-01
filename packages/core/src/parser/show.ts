/**
 * SHOW, DESCRIBE and EXISTS queries: a port of ParserShowTablesQuery.cpp, ParserShowColumnsQuery.cpp,
 * ParserShowIndexesQuery.cpp, ParserTablePropertiesQuery.cpp, ParserDescribeTableQuery.cpp and friends.
 */
import { Ast } from "./ast.js";
import { parseIdentifierOrStringLiteral } from "./common.js";
import { parseCompoundIdentifier, parseIdentifier, parseLiteral, parseStringLiteral } from "./elements.js";
import { parseExpressionWithOptionalAlias } from "./expression.js";
import { parseSelectWithUnionQuery, parseTableExpression } from "./select.js";
import { parseSetQuery } from "./set.js";
import { base, Expected, kw, lookahead, P, peekKw, T, tok } from "./state.js";

/** [NOT] LIKE|ILIKE 'pattern', or WHERE expr when allowed. */
function parseLikeOrWhere(p: P, allowWhere: boolean): boolean {
  const not = kw(p, "NOT");
  if (kw(p, "ILIKE") || kw(p, "LIKE")) return parseStringLiteral(p) !== null;
  if (not) return false;
  if (allowWhere && kw(p, "WHERE")) return parseExpressionWithOptionalAlias(p, false) !== null;
  return true;
}

function parseLimit(p: P): boolean {
  return !kw(p, "LIMIT") || parseExpressionWithOptionalAlias(p, false) !== null;
}

/** ParserShowTablesQuery: SHOW TABLES, DATABASES, CLUSTERS, MERGES, SETTINGS, DICTIONARIES and the like. */
export function parseShowTablesQuery(p: P): Ast | null {
  const name = "SHOW [FULL] [TEMPORARY] TABLES|DATABASES|CLUSTERS|CLUSTER|MERGES 'name' [[NOT] [I]LIKE 'str'] [LIMIT expr]";
  return base(p, name, () => {
    if (!kw(p, "SHOW")) return null;
    kw(p, "FULL");
    if (kw(p, "DATABASES") || kw(p, "CLUSTERS") || kw(p, "MERGES")) {
      if (!parseLikeOrWhere(p, false)) return null;
      if (!parseLimit(p)) return null;
    } else if (kw(p, "FILESYSTEM CACHES")) {
      // Nothing follows.
    } else if (kw(p, "CLUSTER")) {
      if (parseIdentifierOrStringLiteral(p) === null) return null;
    } else {
      const changed = kw(p, "CHANGED");
      if (changed || kw(p, "SETTINGS")) {
        if (changed && !kw(p, "SETTINGS")) return null;
        if (!kw(p, "ILIKE") && !kw(p, "LIKE")) return null;
        if (!parseStringLiteral(p)) return null;
      } else {
        kw(p, "TEMPORARY");
        if (!kw(p, "TABLES") && !kw(p, "DICTIONARIES")) return null;
        if ((kw(p, "FROM") || kw(p, "IN")) && !parseIdentifier(p, true)) return null;
        if (!parseLikeOrWhere(p, true)) return null;
        if (!parseLimit(p)) return null;
      }
    }
    return new Ast("ShowQuery");
  });
}

/** {FROM|IN} table [{FROM|IN} db], as in SHOW COLUMNS and SHOW INDEXES. */
function parseShowSource(p: P): boolean {
  if (!kw(p, "FROM") && !kw(p, "IN")) return false;
  const table = parseCompoundIdentifier(p);
  if (!table) return false;
  if (table.parts!.length === 1 && (kw(p, "FROM") || kw(p, "IN")) && !parseIdentifier(p)) return false;
  return true;
}

/** ParserShowColumnsQuery: SHOW [EXTENDED] [FULL] COLUMNS|FIELDS FROM t [FROM db] [[NOT] LIKE ... | WHERE ...] [LIMIT n]. */
export function parseShowColumnsQuery(p: P): Ast | null {
  return base(p, "SHOW COLUMNS query", () => {
    if (!kw(p, "SHOW")) return null;
    kw(p, "EXTENDED");
    kw(p, "FULL");
    if (!kw(p, "COLUMNS") && !kw(p, "FIELDS")) return null;
    if (!parseShowSource(p)) return null;
    if (!parseLikeOrWhere(p, true)) return null;
    if (!parseLimit(p)) return null;
    return new Ast("ShowQuery");
  });
}

/** ParserShowEnginesQuery. */
export function parseShowEnginesQuery(p: P): Ast | null {
  return base(p, "SHOW ENGINES query", () => (kw(p, "SHOW ENGINES") ? new Ast("ShowQuery") : null));
}

/** ParserShowFunctionsQuery: SHOW FUNCTIONS [[I]LIKE 'x']. */
export function parseShowFunctionsQuery(p: P): Ast | null {
  return base(p, "SHOW FUNCTIONS query", () => {
    if (!kw(p, "SHOW FUNCTIONS")) return null;
    if ((kw(p, "ILIKE") || kw(p, "LIKE")) && !parseStringLiteral(p)) return null;
    return new Ast("ShowQuery");
  });
}

/** ParserShowIndexesQuery: SHOW [EXTENDED] INDEX|INDEXES|INDICES|KEYS FROM t [FROM db] [WHERE expr]. */
export function parseShowIndexesQuery(p: P): Ast | null {
  return base(p, "SHOW INDEXES query", () => {
    if (!kw(p, "SHOW")) return null;
    kw(p, "EXTENDED");
    if (!kw(p, "INDEX") && !kw(p, "INDEXES") && !kw(p, "INDICES") && !kw(p, "KEYS")) return null;
    if (!parseShowSource(p)) return null;
    if (kw(p, "WHERE") && !parseExpressionWithOptionalAlias(p, false)) return null;
    return new Ast("ShowQuery");
  });
}

/** ParserShowSettingQuery: SHOW SETTING name. */
export function parseShowSettingQuery(p: P): Ast | null {
  return base(p, "SHOW SETTING query", () => (kw(p, "SHOW SETTING") && parseIdentifier(p) ? new Ast("ShowQuery") : null));
}

/** ParserShowProcesslistQuery. */
export function parseShowProcesslistQuery(p: P): Ast | null {
  return base(p, "SHOW PROCESSLIST query", () => (kw(p, "SHOW PROCESSLIST") ? new Ast("ShowQuery") : null));
}

/** ParserTablePropertiesQuery: EXISTS [TEMPORARY] TABLE|VIEW|DICTIONARY|DATABASE x and SHOW CREATE ... x. */
export function parseTablePropertiesQuery(p: P): Ast | null {
  return base(p, "EXISTS or SHOW CREATE query", () => {
    let onlyDatabase = false;
    let isView = false;
    let temporary = false;
    if (kw(p, "EXISTS")) {
      if (kw(p, "DATABASE")) {
        onlyDatabase = true;
      } else {
        if (kw(p, "TEMPORARY")) temporary = true;
        if (kw(p, "VIEW")) isView = true;
        else if (!peekKw(p, "TABLE")) peekKw(p, "DICTIONARY");
      }
    } else if (kw(p, "SHOW")) {
      let hasCreate = false;
      if (peekKw(p, "CREATE")) {
        hasCreate = true;
        kw(p, "CREATE");
      }
      if (kw(p, "TEMPORARY")) temporary = true;
      if (kw(p, "DATABASE")) onlyDatabase = true;
      else if (peekKw(p, "DICTIONARY")) {
        // SHOW CREATE DICTIONARY d.
      } else if (kw(p, "VIEW")) isView = true;
      else if (!hasCreate && !peekKw(p, "TABLE")) return null;
    } else {
      return null;
    }
    if (onlyDatabase) return parseIdentifier(p, true) ? new Ast("ShowQuery") : null;
    if (!isView) {
      if (!temporary) kw(p, "TEMPORARY");
      if (!kw(p, "TABLE")) kw(p, "DICTIONARY");
    }
    if (!parseIdentifier(p, true)) return null;
    if (tok(p, T.Dot) && !parseIdentifier(p, true)) return null;
    return new Ast("ShowQuery");
  });
}

/** ParserDescribeCacheQuery: DESCRIBE FILESYSTEM CACHE 'name'. */
export function parseDescribeCacheQuery(p: P): Ast | null {
  return base(p, "DESCRIBE FILESYSTEM CACHE query", () => {
    if ((!kw(p, "DESCRIBE") && !kw(p, "DESC")) || !kw(p, "FILESYSTEM CACHE")) return null;
    const name = parseLiteral(p);
    if (!name) return null;
    if (name.value!.t !== "String") p.failOther(`Bad get: has ${name.value!.t}, requested String`, p.i - 1);
    return new Ast("ShowQuery");
  });
}

/** isTopLevelSetOperation: (SELECT 1) UNION ... rather than one subquery in brackets. */
function isTopLevelSetOperation(p: P, start: number): boolean {
  return lookahead(
    p,
    () => {
      p.i = start;
      let depth = 0;
      do {
        if (p.kind() === T.OpeningRoundBracket) depth++;
        else if (p.kind() === T.ClosingRoundBracket) depth--;
        p.i++;
      } while (depth > 0 && p.valid());
      return kw(p, "UNION") || kw(p, "EXCEPT") || kw(p, "INTERSECT");
    },
    new Expected(),
  );
}

/** ParserDescribeTableQuery: DESCRIBE [TEMPORARY] [TABLE] table | (subquery) | SELECT ... [SETTINGS ...]. */
export function parseDescribeTableQuery(p: P): Ast | null {
  return base(p, "DESCRIBE query", () => {
    if (!kw(p, "DESCRIBE") && !kw(p, "DESC")) return null;
    let temporary = false;
    const beforeTemporary = p.i;
    if (kw(p, "TEMPORARY")) {
      if (kw(p, "TABLE")) temporary = true;
      else {
        p.restore(beforeTemporary);
        kw(p, "TABLE");
      }
    } else {
      kw(p, "TABLE");
    }
    let asSelect = false;
    const beforeSelect = p.i;
    const select = parseSelectWithUnionQuery(p);
    if (select) {
      if (p.kindAt(beforeSelect) !== T.OpeningRoundBracket || isTopLevelSetOperation(p, beforeSelect)) asSelect = true;
      else p.restore(beforeSelect);
    }
    let table: Ast | null;
    if (asSelect) {
      if (temporary) return null;
      // ClickHouse describes a SELECT as a table expression with that subquery.
      const subquery = new Ast("Subquery");
      subquery.children = [select!];
      table = new Ast("TableExpression").set("source", subquery);
    } else {
      table = parseTableExpression(p);
      if (!table) return null;
      if (temporary) {
        const source = table.get("source");
        if (!source || source.kind !== "TableIdentifier") return null;
      }
    }
    const node = new Ast("DescribeQuery").set("table_expression", table);
    if (kw(p, "SETTINGS")) {
      if (!parseSetQuery(p, true)) return null;
      node.flag("settings_ast");
    }
    return node;
  });
}
