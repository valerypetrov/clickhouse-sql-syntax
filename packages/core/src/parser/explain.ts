/**
 * EXPLAIN queries: a port of src/Parsers/ParserExplainQuery.cpp.
 */
import { Ast } from "./ast.js";
import { parseCreateTableQuery, parseTableOverrideDeclaration } from "./create.js";
import { parseFunction } from "./expression.js";
import { parseInsertQuery } from "./insert.js";
import { parseQuery } from "./query.js";
import { parseSelectWithUnionQuery } from "./select.js";
import { parseSetQuery } from "./set.js";
import { parseSystemQuery } from "./system.js";
import { base, kw, P, peekKw, T } from "./state.js";

const KINDS = ["AST", "SYNTAX", "QUERY TREE", "PIPELINE", "PLAN", "ESTIMATE", "TABLE OVERRIDE", "CURRENT TRANSACTION", "ANALYZE", "WHATIF"];

/**
 * ParserExplainQuery. A subquery (EXPLAIN ...) uses `selectOnly`, where only
 * SELECT can be explained; a statement can also explain CREATE TABLE, INSERT and SYSTEM.
 */
export function parseExplainQuery(p: P, selectOnly = false, allowSettingsAfterFormat = false): Ast | null {
  return base(p, "EXPLAIN", () => {
    if (!kw(p, "EXPLAIN")) return null;
    let kind = "PLAN";
    for (const word of KINDS) {
      if (kw(p, word)) {
        kind = word;
        break;
      }
    }
    const node = new Ast("ExplainQuery");
    node.name = kind;

    const beforeSettings = p.i;
    if (!parseSetQuery(p, true, false)) p.restore(beforeSettings);

    if (kind === "AST") {
      let query = parseQuery(p, allowSettingsAfterFormat);
      if (!query && p.kind() === T.OpeningRoundBracket) {
        const saved = p.i;
        p.i++;
        query = parseQuery(p, allowSettingsAfterFormat);
        if (query && p.kind() === T.ClosingRoundBracket) p.i++;
        else {
          query = null;
          p.restore(saved);
        }
      }
      if (!query) return null;
      node.set("query", query);
    } else if (kind === "TABLE OVERRIDE") {
      const fn = parseFunction(p, true, true);
      if (!fn) return null;
      const override = parseTableOverrideDeclaration(p, false);
      if (!override) return null;
      node.set("table_function", fn);
      node.set("table_override", override);
    } else if (kind === "QUERY TREE") {
      const query = parseSelectWithUnionQuery(p);
      if (!query) return null;
      node.set("query", query);
    } else if (kind === "CURRENT TRANSACTION") {
      // Nothing to explain.
    } else if (selectOnly) {
      const query = parseSelectWithUnionQuery(p);
      if (!query) return null;
      node.set("query", query);
    } else {
      const query =
        parseSelectWithUnionQuery(p) ??
        parseCreateTableQuery(p) ??
        parseInsertQuery(p, allowSettingsAfterFormat) ??
        parseSystemQuery(p);
      if (!query) return null;
      // The FORMAT of EXPLAIN INSERT ... SELECT ... FORMAT x belongs to EXPLAIN, unless another FORMAT follows.
      if (query.kind === "InsertQuery" && query.get("select") && query.has("format") && !query.has("infile")) {
        if (!query.has("input") && !peekKw(p, "FORMAT")) {
          query.flag("format", false);
          node.flag("format_ast");
        }
      }
      node.set("query", query);
    }
    return node;
  });
}
