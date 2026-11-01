/**
 * SELECT queries: a port of ParserSelectWithUnionQuery.cpp, ParserSelectQuery.cpp,
 * ParserTablesInSelectQuery.cpp, ParserWithElement.cpp, ParserSampleRatio.cpp and ParserPipeOperators.cpp.
 */
import { Ast, keep, list } from "./ast.js";
import {
  parseAlias,
  parseCompoundIdentifier,
  parseIdentifier,
  parseList,
  parseNumber,
  parseStringLiteral,
  parseSubquery,
  parseTableAsStringLiteral,
  parseUnsignedInteger,
  parseWindowList,
  parseWithOptionalAlias,
} from "./elements.js";
import {
  parseAliasesExpressionList,
  parseExpression,
  parseExpressionList,
  parseExpressionWithOptionalAlias,
  parseFunction,
  parseGroupingSetsExpressionList,
  parseIntervalKind,
  parseInterpolateExpressionList,
  parseNotEmptyExpressionList,
  parseOrderByExpressionList,
} from "./expression.js";
import { parseSetQuery } from "./set.js";
import { base, kw, P, peekKw, T, tok } from "./state.js";

/** ParserSelectWithUnionQuery: selects joined by UNION, EXCEPT and INTERSECT, then pipe operators. */
export function parseSelectWithUnionQuery(p: P): Ast | null {
  const begin = p.i;
  let pipe = false;
  const result = base(p, "SELECT query, possibly with UNION", () => {
    const elements = parseUnionList(p);
    if (!elements) return null;
    let node: Ast;
    if (elements.length === 1 && elements[0]!.kind === "SelectWithUnionQuery") {
      node = elements[0]!;
    } else {
      node = new Ast("SelectWithUnionQuery");
      node.children = elements;
    }
    pipe = p.kind() === T.PipeOperator;
    if (pipe) return parsePipeOperators(p, node);
    return node;
  });
  if (result) p.names?.add("union", begin, p.i - 1, pipe ? { flag: "pipe" } : {});
  return result;
}

/** ParserUnionList: the elements of a UNION chain. */
function parseUnionList(p: P): Ast[] | null {
  const elements: Ast[] = [];
  const ok = base(p, "list of union elements", () => {
    const element = () => {
      const node = parseUnionQueryElement(p);
      if (node) elements.push(node);
      return node !== null;
    };
    const separator = () => {
      for (const keyword of ["UNION", "EXCEPT", "INTERSECT"]) {
        if (kw(p, keyword)) {
          if (!kw(p, "ALL")) kw(p, "DISTINCT");
          return true;
        }
      }
      return false;
    };
    const begin = p.i;
    if (!element()) {
      p.restore(begin);
      return null;
    }
    for (;;) {
      const at = p.i;
      if (!separator() || !element()) {
        p.restore(at);
        return true;
      }
    }
  });
  return ok ? elements : null;
}

/** ParserUnionQueryElement: a SELECT, or a subquery in brackets. */
export function parseUnionQueryElement(p: P): Ast | null {
  return base(p, "SELECT query, subquery, possibly with UNION", () => {
    const subquery = parseSubquery(p);
    if (subquery) {
      let node = subquery.children[0]!;
      if (node.kind === "SelectWithUnionQuery" && node.children.length === 1) node = node.children[0]!;
      return node;
    }
    return parseSelectQuery(p);
  });
}

/** parseOrderByClauseBody: ORDER BY ALL [ASC|DESC] [NULLS ...] or a list with WITH FILL and INTERPOLATE. */
export function parseOrderByClauseBody(p: P, node: Ast): boolean {
  const saved = p.i;
  let orderByAll = false;
  if (kw(p, "ALL")) {
    orderByAll = true;
    if (!kw(p, "DESC") && !kw(p, "DESCENDING")) {
      if (!kw(p, "ASC")) kw(p, "ASCENDING");
    }
    if (kw(p, "NULLS")) {
      if (!kw(p, "FIRST") && !kw(p, "LAST")) return false;
    }
    // ORDER BY all, a: here all is a column.
    if (p.kind() === T.Comma) {
      p.restore(saved);
      orderByAll = false;
    }
  }
  if (!orderByAll) {
    const orderList = parseOrderByExpressionList(p);
    if (!orderList) return false;
    node.set("order_by", orderList);
    const interpolateStart = p.i;
    if (orderList.children.some((element) => element.has("with_fill")) && kw(p, "INTERPOLATE")) {
      if (tok(p, T.OpeningRoundBracket)) {
        const interpolate = parseInterpolateExpressionList(p);
        if (!interpolate) return false;
        node.set("interpolate", interpolate);
        if (!tok(p, T.ClosingRoundBracket)) return false;
      }
      p.names?.add("interpolate", interpolateStart, p.i - 1);
    }
  }
  return true;
}

/** parseLimitRange: AFTER start [ALL] [UNTIL end] or UNTIL end; AFTER and UNTIL may be names. */
function parseLimitRange(p: P, node: Ast): boolean {
  const begin = p.i;
  const hasAfter = kw(p, "AFTER");
  if (!hasAfter && !kw(p, "UNTIL")) return false;
  const followers = [
    "AS", "BY", "OFFSET", "WITH TIES", "AFTER", "UNTIL", "FETCH", "SETTINGS", "FORMAT", "INTO OUTFILE", "UNION",
    "EXCEPT", "INTERSECT", "PARALLEL WITH",
  ];
  for (const keyword of followers) {
    if (peekKw(p, keyword)) {
      p.restore(begin);
      return false;
    }
  }
  let after: Ast | null = null;
  let until: Ast | null = null;
  let parsed: boolean;
  if (hasAfter) {
    after = parseExpressionWithOptionalAlias(p, false);
    parsed = after !== null;
    if (parsed) {
      kw(p, "ALL");
      if (kw(p, "UNTIL")) parsed = (until = parseExpressionWithOptionalAlias(p, false)) !== null;
    }
  } else {
    until = parseExpressionWithOptionalAlias(p, false);
    parsed = until !== null;
  }
  if (!parsed) {
    p.restore(begin);
    return false;
  }
  node.set("limit_after", after).set("limit_until", until);
  return true;
}

/** The top-level table expressions, for the checks of the FROM-first form. */
function tableExpressions(tables: Ast): Ast[] {
  return tables.children.map((element) => element.get("table")).filter((table): table is Ast => !!table);
}

function hasTopLevelSelectAlias(tables: Ast | null): boolean {
  if (!tables) return false;
  return tableExpressions(tables).some((table) => {
    const source = table.get("source");
    return source?.alias.toLowerCase() === "select";
  });
}

/** ParserSelectQuery: WITH, SELECT and every clause after it, or the FROM-first form. */
export function parseSelectQuery(p: P, implicitSelect = false): Ast | null {
  const begin = p.i;
  let projection: [number, number] | undefined;
  let recursive = false;
  const result = base(p, "SELECT query", () => {
    const node = new Ast("SelectQuery");
    let withList: Ast | null = null;
    if (kw(p, "WITH")) {
      recursive = kw(p, "RECURSIVE");
      withList = parseList(p, () => parseWithElement(p), undefined, true, true);
      if (!withList) return null;
      if (!withList.children.length) return null;
    }

    let tables: Ast | null = null;
    let lastTableHasSampleOffset = false;
    if (kw(p, "FROM")) {
      let tablesEnd = p.i;
      const parseTablesAndAliases = (allowWithoutAs: boolean): boolean => {
        tables = parseTablesInSelectQuery(p, allowWithoutAs);
        if (!tables) return false;
        tablesEnd = p.i;
        if (tok(p, T.OpeningRoundBracket)) {
          if (!parseAliasesExpressionList(p)) return false;
          if (!tok(p, T.ClosingRoundBracket)) return false;
          p.names?.add("opaque", tablesEnd, p.i - 1);
        }
        return true;
      };
      const begin = p.i;
      if (
        !parseTablesAndAliases(true) ||
        (!peekKw(p, "SELECT") && hasTopLevelSelectAlias(tables) && endsWithBareSelect(p, begin, tablesEnd))
      ) {
        p.restore(begin);
        tables = null;
        if (!parseTablesAndAliases(false)) return null;
      }
      const last = (tables as Ast | null)?.children.at(-1)?.get("table");
      lastTableHasSampleOffset = last?.has("sample_offset") ?? false;
    }

    const hasSelect = kw(p, "SELECT");
    if (!hasSelect && tables) {
      if (lastTableHasSampleOffset && !nextClauseCannotFollowOffset(p)) {
        p.expect("SELECT (it cannot be omitted when the last table has SAMPLE with OFFSET)");
        return null;
      }
    } else {
      if (!hasSelect && (!implicitSelect || withList)) return null;
      let hasAll = kw(p, "ALL");
      let distinct = false;
      let distinctOn = false;
      if (kw(p, "DISTINCT ON")) {
        if (!tok(p, T.OpeningRoundBracket)) return null;
        const distinctOnList = parseNotEmptyExpressionList(p, false);
        if (!distinctOnList) return null;
        if (!tok(p, T.ClosingRoundBracket)) return null;
        // ClickHouse makes DISTINCT ON (list) a LIMIT 1 BY list.
        node.set("limit_by", distinctOnList);
        distinctOn = true;
      } else if (kw(p, "DISTINCT")) {
        distinct = true;
      }
      if (!hasAll && kw(p, "ALL")) hasAll = true;
      if (hasAll && (distinct || distinctOn)) return null;
      if (kw(p, "TOP")) {
        if (tok(p, T.OpeningRoundBracket)) {
          if (!parseNumber(p)) return null;
          if (!tok(p, T.ClosingRoundBracket)) return null;
        } else if (!parseNumber(p)) {
          return null;
        }
        node.flag("top");
        if (kw(p, "WITH TIES")) node.flag("with_ties");
      }
      const columnsBegin = p.i;
      const columns = parseNotEmptyExpressionList(p, true, true);
      if (!columns) return null;
      projection = [columnsBegin, p.i - 1];
      node.set("select", columns);
      if (distinctOn) node.flag("distinct_on");
    }

    if (!tables && kw(p, "FROM")) {
      tables = parseTablesInSelectQuery(p);
      if (!tables) return null;
    }
    const open = p.i;
    if (tables && tok(p, T.OpeningRoundBracket)) {
      if (!parseAliasesExpressionList(p)) return null;
      if (!tok(p, T.ClosingRoundBracket)) return null;
      p.names?.add("opaque", open, p.i - 1);
    }
    node.set("tables", tables);
    for (const clause of ["PREWHERE", "WHERE"]) {
      if (kw(p, clause)) {
        const condition = parseExpressionWithOptionalAlias(p, false);
        if (!condition) return null;
        node.set(clause.toLowerCase(), condition);
      }
    }
    if (!parseGroupBy(p, node)) return null;
    if (kw(p, "HAVING")) {
      const condition = parseExpressionWithOptionalAlias(p, false);
      if (!condition) return null;
      node.set("having", condition);
    }
    if (kw(p, "WINDOW")) {
      const windows = parseWindowList(p);
      if (!windows) return null;
      node.set("window", windows);
    }
    if (kw(p, "QUALIFY")) {
      const condition = parseExpressionWithOptionalAlias(p, false);
      if (!condition) return null;
      node.set("qualify", condition);
    }
    let hasOrderBy = false;
    if (kw(p, "ORDER BY")) {
      if (!parseOrderByClauseBody(p, node)) return null;
      hasOrderBy = true;
    }
    if (!parseLimitClauses(p, node, hasOrderBy)) return null;
    if (kw(p, "SETTINGS")) {
      if (!parseSetQuery(p, true)) return null;
      node.flag("settings");
    }
    if (withList) node.set("with", withList);
    return node;
  });
  if (result) p.names?.add("query", begin, p.i - 1, { part: projection, flag: recursive ? "recursive" : undefined });
  return result;
}

/** endsWithBarewordSelect: the tables parse ended right after a bare word `select`. */
function endsWithBareSelect(p: P, begin: number, end: number): boolean {
  if (!(begin < end)) return false;
  return p.isWord("select", end - 1);
}

function nextClauseCannotFollowOffset(p: P): boolean {
  const clauses = ["PREWHERE", "WHERE", "GROUP BY", "HAVING", "WINDOW", "QUALIFY", "ORDER BY", "LIMIT"];
  return clauses.some((keyword) => peekKw(p, keyword));
}

/** GROUP BY [ROLLUP|CUBE|GROUPING SETS|ALL] ... and the WITH ROLLUP|CUBE|TOTALS modifiers. */
function parseGroupBy(p: P, node: Ast): boolean {
  let rollup = false;
  let cube = false;
  let totals = false;
  if (kw(p, "GROUP BY")) {
    let groupingSets = false;
    let all = false;
    if (kw(p, "ROLLUP")) rollup = true;
    else if (kw(p, "CUBE")) cube = true;
    else if (kw(p, "GROUPING SETS")) groupingSets = true;
    else if (kw(p, "ALL")) all = true;
    const bracketed = rollup || cube || groupingSets;
    if (bracketed && !tok(p, T.OpeningRoundBracket)) return false;
    if (groupingSets) {
      const sets = parseGroupingSetsExpressionList(p);
      if (!sets) return false;
      node.set("group_by", sets);
    } else if (!all) {
      const keys = parseNotEmptyExpressionList(p, false);
      if (!keys) return false;
      node.set("group_by", keys);
    }
    if (bracketed && !tok(p, T.ClosingRoundBracket)) return false;
  }
  while (kw(p, "WITH")) {
    if (kw(p, "ROLLUP")) {
      if (rollup) return false;
      rollup = true;
    } else if (kw(p, "CUBE")) {
      if (cube) return false;
      cube = true;
    } else if (kw(p, "TOTALS")) {
      if (totals) return false;
      totals = true;
    } else {
      return false;
    }
  }
  return true;
}

/** LIMIT, LIMIT BY, OFFSET and FETCH, with the exceptions ClickHouse throws for invalid mixes. */
function parseLimitClauses(p: P, node: Ast, hasOrderBy: boolean): boolean {
  const distinctOn = node.has("distinct_on");
  let withTies = node.has("with_ties");
  let limitByLength = false;
  let limitLength = false;
  let limitRange = false;
  let hasOffsetClause = false;
  let offsetHasRows = false;
  // The expressions of these clauses, which ClickHouse moves between its fields as it reads them.
  let length: Ast | null = null;
  let offset: Ast | null = null;
  let byLength: Ast | null = null;
  let byOffset: Ast | null = null;
  if (kw(p, "LIMIT")) {
    if (parseLimitRange(p, node)) {
      limitRange = true;
    } else {
      if (!(length = parseExpressionWithOptionalAlias(p, false))) return false;
      limitLength = true;
      let tiesHere = false;
      if (tok(p, T.Comma)) {
        offset = length;
        if (!(length = parseExpressionWithOptionalAlias(p, false))) return false;
        if (kw(p, "WITH TIES")) tiesHere = true;
      } else if (kw(p, "OFFSET")) {
        if (!(offset = parseExpressionWithOptionalAlias(p, false))) return false;
        hasOffsetClause = true;
        if (kw(p, "WITH TIES")) tiesHere = true;
      } else if (kw(p, "WITH TIES")) {
        tiesHere = true;
      }
      if (tiesHere) withTies = true;
      if (tiesHere && distinctOn)
        p.failOther("Can not use WITH TIES alongside LIMIT BY/DISTINCT ON", p.i - 1);
      if (kw(p, "BY")) {
        if (tiesHere) p.failOther("Can not use WITH TIES alongside LIMIT BY/DISTINCT ON", p.i - 1);
        if (distinctOn) p.fail("Can not use DISTINCT ON alongside LIMIT BY", p.i - 1);
        limitByLength = true;
        limitLength = false;
        byLength = length;
        byOffset = offset;
        length = offset = null;
        if (!kw(p, "ALL")) {
          const by = parseNotEmptyExpressionList(p, false);
          if (!by) return false;
          node.set("limit_by", by);
        }
      }
      if (limitLength && parseLimitRange(p, node)) limitRange = true;
    }
    if (node.has("top") && (limitLength || limitRange)) p.failOther("Can not use TOP and LIMIT together", p.i - 1);
  } else if (kw(p, "OFFSET")) {
    hasOffsetClause = true;
    if (!(offset = parseExpressionWithOptionalAlias(p, false))) return false;
    if (kw(p, "ROW")) offsetHasRows = true;
    if (kw(p, "ROWS")) {
      if (offsetHasRows) p.failOther("Can not use ROW and ROWS together", p.i - 1);
      offsetHasRows = true;
    }
  }
  if ((!hasOffsetClause || offsetHasRows) && kw(p, "FETCH")) {
    if (!hasOrderBy) p.failOther("Can not use OFFSET FETCH clause without ORDER BY", p.i - 1);
    if (kw(p, "FIRST")) {
      if (kw(p, "NEXT")) p.failOther("Can not use FIRST and NEXT together", p.i - 1);
    } else if (!kw(p, "NEXT")) {
      return false;
    }
    if (!(length = parseExpressionWithOptionalAlias(p, false))) return false;
    limitLength = true;
    if (kw(p, "ROW")) {
      if (kw(p, "ROWS")) p.failOther("Can not use ROW and ROWS together", p.i - 1);
    } else if (!kw(p, "ROWS")) {
      return false;
    }
    if (kw(p, "WITH TIES")) withTies = true;
    else if (kw(p, "ONLY")) withTies = false;
    else return false;
  }
  if (distinctOn) limitByLength = true;
  if (node.has("top")) {
    limitLength = true;
    length = null;
  }
  if (kw(p, "LIMIT")) {
    if (!limitByLength || limitLength || limitRange) return false;
    if (!parseLimitRange(p, node)) {
      if (!(length = parseExpressionWithOptionalAlias(p, false))) return false;
      if (tok(p, T.Comma)) {
        offset = length;
        if (!(length = parseExpressionWithOptionalAlias(p, false))) return false;
      } else if (kw(p, "OFFSET")) {
        if (!(offset = parseExpressionWithOptionalAlias(p, false))) return false;
      }
      if (kw(p, "WITH TIES")) withTies = true;
      parseLimitRange(p, node);
    }
  }
  if (!hasOrderBy && withTies) p.failOther("Can not use WITH TIES without ORDER BY", p.i - 1);
  node.set("limit_length", length).set("limit_offset", offset);
  node.set("limit_by_length", byLength).set("limit_by_offset", byOffset);
  return true;
}

/** ParserWithElement: name [(aliases)] AS [MATERIALIZED] (subquery), or expr AS name. */
export function parseWithElement(p: P): Ast | null {
  return base(p, "WITH element", () => {
    const begin = p.i;
    const ident = parseIdentifier(p);
    if (ident && p.kindAt(begin) === T.BareWord && ident.name.toLowerCase() === "select") return null;
    p.restore(begin);
    let columns: [number, number] | undefined;
    const isCte =
      parseIdentifier(p) !== null &&
      (() => {
        if (!tok(p, T.OpeningRoundBracket)) return true;
        const first = p.i;
        if (!parseAliasesExpressionList(p)) return false;
        columns = [first, p.i - 1];
        return tok(p, T.ClosingRoundBracket);
      })() &&
      kw(p, "AS");
    if (isCte) {
      const materialized = kw(p, "MATERIALIZED");
      const subquery = parseSubquery(p);
      if (subquery) {
        const flag = materialized ? "materialized" : "cte";
        p.names?.add("with", begin, p.i - 1, columns ? { name: [begin, begin], part: columns, flag } : { name: [begin, begin], flag });
        return new Ast("WithElement").set("subquery", subquery);
      }
    }
    p.restore(begin);
    const node = parseExpressionWithOptionalAlias(p, false);
    if (node) p.names?.add("with", begin, p.i - 1, { flag: "expr" });
    return node;
  });
}

/** ParserTablesInSelectQuery: a table expression followed by joins. */
export function parseTablesInSelectQuery(p: P, allowWithoutAs = true): Ast | null {
  return base(p, "table, table function, subquery or list of joined tables", () => {
    const first = parseTablesInSelectQueryElement(p, true, allowWithoutAs);
    if (!first) return null;
    const node = new Ast("TablesInSelectQuery");
    node.children = [first];
    for (;;) {
      const previous = node.children[node.children.length - 1]!;
      // A comma join right after an ARRAY JOIN is not supported.
      if (previous.has("array_join") && p.kind() === T.Comma) break;
      const element = parseTablesInSelectQueryElement(p, false, allowWithoutAs);
      if (!element) break;
      node.children.push(element);
    }
    return node;
  });
}

/** [LEFT] ARRAY JOIN list. */
function parseArrayJoin(p: P): Ast | null {
  return base(p, "array join", () => {
    const saved = p.i;
    let found = kw(p, "LEFT ARRAY JOIN");
    if (!found) {
      p.restore(saved);
      kw(p, "INNER");
      found = kw(p, "ARRAY JOIN");
    }
    if (!found) return null;
    const first = p.i;
    const columns = parseNotEmptyExpressionList(p, false);
    if (!columns) return null;
    p.names?.add("arrayjoin", saved, p.i - 1, { part: [first, p.i - 1], flag: p.isWord("left", saved) ? "left" : "inner" });
    return new Ast("ArrayJoin").set("columns", columns);
  });
}

function parseJoinStrictness(p: P): string {
  if (kw(p, "ANY")) return "any";
  if (kw(p, "ALL")) return "all";
  if (kw(p, "ASOF")) return "asof";
  if (kw(p, "SEMI")) return "semi";
  if (kw(p, "ANTI") || kw(p, "ONLY")) return "anti";
  return "";
}

/** ParserTablesInSelectQueryElement: the first table, or a join, or an ARRAY JOIN. */
export function parseTablesInSelectQueryElement(p: P, isFirst: boolean, allowWithoutAs = true): Ast | null {
  return base(p, "table, table function, subquery or list of joined tables", () => {
    const begin = p.i;
    const node = new Ast("TablesInSelectQueryElement");
    if (isFirst) {
      const table = parseTableExpression(p, allowWithoutAs);
      if (!table) return null;
      return node.set("table", table);
    }
    const arrayJoin = parseArrayJoin(p);
    if (arrayJoin) return node.flag("array_join").set("array_join", arrayJoin);

    let kind = "";
    let strictness = "";
    let natural = false;
    if (p.kind() === T.Comma) {
      p.i++;
      kind = "comma";
    } else {
      if (!kw(p, "GLOBAL")) kw(p, "LOCAL");
      natural = kw(p, "NATURAL");
      strictness = parseJoinStrictness(p);
      let noKind = false;
      if (kw(p, "INNER")) kind = "inner";
      else if (kw(p, "LEFT")) kind = "left";
      else if (kw(p, "RIGHT")) kind = "right";
      else if (kw(p, "FULL")) kind = "full";
      else if (kw(p, "CROSS")) kind = "cross";
      else if (kw(p, "PASTE")) kind = "paste";
      else noKind = true;
      const second = parseJoinStrictness(p);
      if (second) strictness = second;
      if (kind === "left" || kind === "right" || kind === "full") kw(p, "OUTER");
      if (noKind) kind = strictness === "semi" || strictness === "anti" ? "left" : "inner";
      if (strictness && (kind === "cross" || kind === "paste"))
        p.fail(`You must not specify ANY or ALL for ${kind === "cross" ? "CROSS" : "PASTE"} JOIN.`, p.i - 1);
      if ((strictness === "semi" || strictness === "anti") && kind !== "left" && kind !== "right")
        p.fail("SEMI|ANTI JOIN should be LEFT or RIGHT.", p.i - 1);
      if (natural && strictness) p.fail("NATURAL JOIN cannot be combined with ANY/ALL/ASOF/SEMI/ANTI modifiers.", p.i - 1);
      if (natural && (kind === "cross" || kind === "paste"))
        p.fail("NATURAL JOIN cannot be used with CROSS or PASTE join.", p.i - 1);
      if (!kw(p, "JOIN")) return null;
    }

    // LATERAL is a keyword only when a subquery follows.
    const beforeLateral = p.i;
    let table: Ast | null = null;
    let lateral = false;
    if (kw(p, "LATERAL") && p.kind() === T.OpeningRoundBracket) {
      table = parseTableExpression(p, allowWithoutAs);
      lateral = table?.has("subquery") ?? false;
    }
    if (lateral) {
      if (kind === "cross" || kind === "comma")
        p.fail(`LATERAL is not supported with ${kind === "cross" ? "CROSS" : "COMMA"} JOIN`, p.i - 1);
    } else {
      p.restore(beforeLateral);
      table = parseTableExpression(p, allowWithoutAs);
      if (!table) return null;
    }

    let part: [number, number] | undefined;
    let flag = `${kind}${natural ? " natural" : ""}${lateral ? " lateral" : ""}`;
    if (kind !== "comma" && kind !== "cross" && kind !== "paste" && !natural) {
      if (kw(p, "USING")) {
        const inBrackets = p.kind() === T.OpeningRoundBracket;
        if (inBrackets) p.i++;
        const first = p.i;
        const columns = parseExpressionList(p, false);
        if (!columns) return null;
        if (!columns.children.length) {
          p.e.clearVariants();
          p.expect("column identifier for USING");
          return null;
        }
        part = [first, p.i - 1];
        flag += " using";
        if (inBrackets) {
          if (p.kind() !== T.ClosingRoundBracket) return null;
          p.i++;
        }
        node.set("join", new Ast("TableJoin").set("using", columns));
      } else if (kw(p, "ON")) {
        const first = p.i;
        const condition = parseExpression(p);
        if (!condition) return null;
        part = [first, p.i - 1];
        flag += " on";
        node.set("join", new Ast("TableJoin").set("on", condition));
      } else {
        return null;
      }
    }
    p.names?.add("join", begin, p.i - 1, { part, flag });
    return node.set("table", table);
  });
}

/** ParserTableExpression: a subquery, table function, table or (joined tables), with FINAL, SAMPLE, STREAM. */
export function parseTableExpression(p: P, allowWithoutAs = true): Ast | null {
  return base(p, "table or subquery or table function", () => {
    const begin = p.i;
    const node = new Ast("TableExpression");
    let source =
      parseWithOptionalAlias(p, () => parseSubquery(p), allowWithoutAs) ??
      parseWithOptionalAlias(p, () => parseFunction(p, false, true), allowWithoutAs) ??
      parseWithOptionalAlias(p, () => parseCompoundIdentifier(p, true, true), allowWithoutAs) ??
      parseWithOptionalAlias(p, () => parseTableAsStringLiteral(p), allowWithoutAs);
    if (source?.kind === "Subquery") node.flag("subquery");
    let sourceKind = source?.kind === "Subquery" ? "subquery" : source?.kind === "Function" ? "function" : source?.kind === "TableIdentifier" && p.kindAt(begin) === T.StringLiteral ? "string" : "name";
    if (!source) {
      sourceKind = "joined";
      // (t1 JOIN t2 ON ...) in brackets.
      if (p.kind() !== T.OpeningRoundBracket) return null;
      const open = p.i;
      p.i++;
      const tables = parseTablesInSelectQuery(p, false);
      if (tables && p.kind() === T.ClosingRoundBracket && tables.children.length > 1) {
        p.i++;
        // ClickHouse makes the brackets a subquery: SELECT * FROM t1 JOIN t2.
        const select = new Ast("SelectQuery").set("select", list([new Ast("Asterisk")])).set("tables", tables);
        const union = new Ast("SelectWithUnionQuery");
        union.children = [select];
        source = new Ast("Subquery");
        source.children = [union];
        node.flag("subquery");
        const alias = parseAlias(p, allowWithoutAs);
        if (alias) source.alias = alias.name;
      } else {
        p.restore(open);
        return null;
      }
    }
    node.set("source", source);
    const alias: [number, number] | undefined = source.alias ? [p.i - 1, p.i - 1] : undefined;
    let columns: [number, number] | undefined;
    if (p.kind() === T.OpeningRoundBracket) {
      p.i++;
      const first = p.i;
      if (!parseAliasesExpressionList(p)) return null;
      columns = [first, p.i - 1];
      if (p.kind() !== T.ClosingRoundBracket) return null;
      p.i++;
    }
    kw(p, "FINAL");
    if (kw(p, "SAMPLE")) {
      if (!parseSampleRatio(p)) return null;
      if (kw(p, "OFFSET")) {
        if (!parseSampleRatio(p)) return null;
        node.flag("sample_offset");
      }
    }
    if (kw(p, "STREAM")) {
      const stream = parseStreamSettings(p);
      if (!stream) return null;
      node.set("stream", stream);
    }
    p.names?.add("table", begin, p.i - 1, { alias, part: columns, flag: sourceKind });
    return node;
  });
}

/** readUInt128Text: digits after an optional '+', so a lone '+' also reads as zero. */
function readDigits(text: string, i: number): number {
  let j = i;
  if (text[j] === "+") j++;
  while (j < text.length && text[j]! >= "0" && text[j]! <= "9") j++;
  return j;
}

/** parseDecimal of ParserSampleRatio: 12, 0.5, .5, 1e-3 written in one token. */
function isSampleDecimal(token: string): boolean {
  const text = token.replaceAll("_", "");
  let i = readDigits(text, 0);
  const hasNumberBeforePoint = i > 0;
  const hasPoint = text[i] === ".";
  if (hasPoint) i++;
  if (!hasNumberBeforePoint && !hasPoint) return false;
  if (hasPoint) i = readDigits(text, i);
  if (text[i] === "e" || text[i] === "E") {
    i++;
    if (text[i] === "+" || text[i] === "-") i++;
    const afterSign = i;
    i = readDigits(text, i);
    if (i === afterSign) return false;
  }
  return i === text.length;
}

/** ParserSampleRatio: a number or a fraction like 1/10, read from the token text. */
function parseSampleRatio(p: P): Ast | null {
  return base(p, "Sample ratio or offset", () => {
    if (!isSampleDecimal(p.text())) return null;
    p.i++;
    if (p.kind() === T.Slash) {
      p.i++;
      if (!isSampleDecimal(p.text())) return null;
      p.i++;
    }
    return new Ast("Other");
  });
}

/** The CURSOR {'key': N, 'nested': {...}} object of STREAM. */
function parseCursorObject(p: P): boolean {
  if (!tok(p, T.OpeningCurlyBrace)) return false;
  let first = true;
  while (!tok(p, T.ClosingCurlyBrace)) {
    if (!first && !tok(p, T.Comma)) return false;
    first = false;
    if (!parseStringLiteral(p)) return false;
    if (!tok(p, T.Colon)) return false;
    if (p.kind() === T.OpeningCurlyBrace) {
      p.increaseDepth();
      const ok = parseCursorObject(p);
      p.depth--;
      if (!ok) return false;
    } else if (!parseUnsignedInteger(p)) {
      return false;
    }
  }
  return true;
}

/** ParserStreamSettings: [BOUNDED] [UNORDERED] [CURSOR {...}] [WATERMARK FOR col AS expr [IDLE TIMEOUT ...]]. */
function parseStreamSettings(p: P): Ast | null {
  return base(p, "STREAM Settings", () => {
    kw(p, "BOUNDED");
    kw(p, "UNORDERED");
    if (kw(p, "CURSOR") && !parseCursorObject(p)) return null;
    let watermark: Ast | null = null;
    if (kw(p, "WATERMARK")) {
      if (!kw(p, "FOR")) return null;
      if (!parseIdentifier(p)) return null;
      if (!kw(p, "AS")) return null;
      watermark = parseExpression(p);
      if (!watermark) return null;
      if (kw(p, "IDLE TIMEOUT")) {
        if (!kw(p, "INTERVAL")) return null;
        if (!parseUnsignedInteger(p)) return null;
        if (parseIntervalKind(p) === null) return null;
      }
    }
    return new Ast("StreamSettings").set("watermark", watermark);
  });
}

/** A query made by a pipe operator: one SELECT inside a union. */
function wrapped(select: Ast): Ast {
  const node = new Ast("SelectWithUnionQuery");
  node.children = [select];
  return node;
}

/** wrapQueryIntoSelect: `select` reads FROM (query) and the joined tables, with the WITH of the first SELECT of the query. */
function selectFrom(select: Ast, query: Ast, joined: Ast[] = []): Ast {
  let first: Ast | undefined = query;
  while (first?.kind === "SelectWithUnionQuery") first = first.children[0];
  const subquery = new Ast("Subquery");
  subquery.children = [query];
  const tables = new Ast("TablesInSelectQuery");
  const element = new Ast("TablesInSelectQueryElement").set("table", new Ast("TableExpression").set("source", subquery));
  tables.children = [element, ...joined];
  if (!select.get("select")) select.set("select", list([new Ast("Asterisk")]));
  return select.set("with", first?.get("with")).set("tables", tables);
}

/** Comma-separated items after a pipe operator; a comma that has no item after it is left alone. */
function parsePipeItems(p: P, item: () => boolean): boolean {
  if (!item()) return false;
  while (p.kind() === T.Comma) {
    const saved = p.i;
    p.i++;
    if (!item()) {
      p.restore(saved);
      break;
    }
  }
  return true;
}

/** ParserPipeOperators: FROM t |> WHERE x |> SELECT y |> ...; each operator makes a SELECT from the query before it. */
function parsePipeOperators(p: P, query: Ast): Ast | null {
  return base(p, "pipe operators", () => {
    const depth = p.depth;
    let current = query;
    // AS names the query for the next operator to wrap.
    let pendingAlias = false;
    while (p.kind() === T.PipeOperator) {
      p.i++;
      p.increaseDepth();
      let select: Ast | null = new Ast("SelectQuery");
      const joined: Ast[] = [];
      if (kw(p, "WHERE")) {
        if (!keep(select, "where", parseExpressionWithOptionalAlias(p, false))) return null;
      } else if (kw(p, "SELECT")) {
        kw(p, "DISTINCT");
        if (!keep(select, "select", parseNotEmptyExpressionList(p, true, true))) return null;
      } else if (kw(p, "EXTEND")) {
        const extend = parseNotEmptyExpressionList(p, true, true);
        if (!extend) return null;
        select.set("select", list([new Ast("Asterisk"), ...extend.children]));
      } else if (kw(p, "SET")) {
        const transformer = new Ast("ColumnsTransformer");
        const replacement = () => {
          if (!parseIdentifier(p)) return false;
          if (p.kind() !== T.Equals) return false;
          p.i++;
          const expr = parseExpression(p);
          if (!expr) return false;
          const node = new Ast("Replacement");
          node.children = [expr];
          transformer.children.push(node);
          return true;
        };
        if (!parsePipeItems(p, replacement)) return null;
        select.set("select", list([new Ast("Asterisk").set("transformers", list([transformer]))]));
      } else if (kw(p, "DROP")) {
        if (!parsePipeItems(p, () => parseIdentifier(p, true) !== null)) return null;
      } else if (kw(p, "AS")) {
        if (!parseIdentifier(p)) return null;
        pendingAlias = true;
        select = null;
      } else if (kw(p, "AGGREGATE")) {
        const aggregates = parseNotEmptyExpressionList(p, true, true);
        if (!aggregates) return null;
        let keys: Ast | null = null;
        if (kw(p, "GROUP BY") && !(keys = parseNotEmptyExpressionList(p, true))) return null;
        // The grouping keys come first in the SELECT list, and are the GROUP BY too.
        select.set("select", list([...(keys?.children ?? []), ...aggregates.children])).set("group_by", keys);
      } else if (kw(p, "DISTINCT")) {
        // SELECT DISTINCT *.
      } else if (kw(p, "ORDER BY")) {
        if (!parseOrderByClauseBody(p, select)) return null;
      } else if (kw(p, "LIMIT")) {
        if (!keep(select, "limit_length", parseExpressionWithOptionalAlias(p, false))) return null;
        if (kw(p, "OFFSET") && !keep(select, "limit_offset", parseExpressionWithOptionalAlias(p, false))) return null;
      } else if (kw(p, "OFFSET")) {
        if (!keep(select, "limit_offset", parseExpressionWithOptionalAlias(p, false))) return null;
      } else if (kw(p, "UNION") || kw(p, "INTERSECT") || kw(p, "EXCEPT")) {
        if (!kw(p, "ALL")) kw(p, "DISTINCT");
        let lastParenthesized = p.kind() === T.OpeningRoundBracket;
        const first = parseUnionQueryElement(p);
        if (!first) return null;
        const elements = [first];
        while (p.kind() === T.Comma) {
          const saved = p.i;
          p.i++;
          const parenthesized = p.kind() === T.OpeningRoundBracket;
          const element = parseUnionQueryElement(p);
          if (!element) {
            p.restore(saved);
            break;
          }
          elements.push(element);
          lastParenthesized = parenthesized;
        }
        if (!lastParenthesized && p.kind() === T.PipeOperator) {
          p.expect("parenthesized set operation operand before a pipe operator");
          return null;
        }
        // An aliased query gets a level of its own, and a single SELECT is not kept in a union.
        if (pendingAlias) current = wrapped(selectFrom(new Ast("SelectQuery"), current));
        pendingAlias = false;
        if (current.kind === "SelectWithUnionQuery" && current.children.length === 1) current = current.children[0]!;
        const union = new Ast("SelectWithUnionQuery");
        union.children = [current, ...elements];
        current = union;
        select = null;
      } else {
        const first = parseTablesInSelectQueryElement(p, false);
        if (!first) return null;
        joined.push(first);
        let previous = first;
        for (;;) {
          if (previous.has("array_join") && p.kind() === T.Comma) break;
          const saved = p.i;
          const element = parseTablesInSelectQueryElement(p, false);
          if (!element) {
            p.restore(saved);
            break;
          }
          joined.push(element);
          previous = element;
        }
      }
      if (select) {
        current = wrapped(selectFrom(select, current, joined));
        pendingAlias = false;
      }
      // A SETTINGS clause goes to the SELECT made by the operator.
      if (peekKw(p, "SETTINGS")) {
        const only = current.children.length === 1 ? current.children[0]! : null;
        if (current.kind === "SelectWithUnionQuery" && only?.kind === "SelectQuery" && !only.has("settings")) {
          kw(p, "SETTINGS");
          if (!parseSetQuery(p, true)) return null;
          only.flag("settings");
        }
      }
    }
    p.depth = depth;
    return current;
  });
}
