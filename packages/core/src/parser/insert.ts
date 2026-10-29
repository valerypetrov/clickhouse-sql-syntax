/**
 * INSERT queries: a port of src/Parsers/ParserInsertQuery.cpp.
 * The node remembers where the inline data starts, as an offset into the text.
 */
import { Ast } from "./ast.js";
import {
  parseAsterisk,
  parseColumnsMatcher,
  parseCompoundIdentifier,
  parseIdentifier,
  parseList,
  parseQualifiedAsterisk,
  parseQualifiedColumnsMatcher,
  parseStringLiteral,
} from "./elements.js";
import { parseExpressionWithOptionalAlias, parseFunction } from "./expression.js";
import { parseSelectWithUnionQuery, parseWithElement } from "./select.js";
import { parseSetQuery } from "./set.js";
import { base, kw, P, T, tok, tokQuiet } from "./state.js";

/** ParserInsertElement: a column, or a matcher such as * or COLUMNS('x'). */
function parseInsertElement(p: P): Ast | null {
  return base(
    p,
    "insert element",
    () =>
      parseColumnsMatcher(p) ??
      parseQualifiedAsterisk(p) ??
      parseAsterisk(p) ??
      parseQualifiedColumnsMatcher(p) ??
      parseCompoundIdentifier(p),
  );
}

/** Whether the SELECT reads inline data through the input() table function. */
function readsInput(select: Ast): boolean {
  // A loop, not recursion: the tree can be deeper than the JavaScript stack, and share nodes.
  const stack = [select];
  const seen = new Set<Ast>();
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (seen.has(node)) continue;
    seen.add(node);
    if (node.kind === "Function" && node.name === "input") return true;
    for (const child of node.children) stack.push(child);
    for (const param of node.params ?? []) stack.push(param);
    for (const value of Object.values(node.fields ?? {})) if (value) stack.push(value);
  }
  return false;
}

/** ParserInsertQuery. `data` is set to the offset of the inline data, if there is any. */
export function parseInsertQuery(p: P, allowSettingsAfterFormat = false): Ast | null {
  return base(p, "INSERT query", () => {
    let withList: Ast | null = null;
    if (kw(p, "WITH")) {
      withList = parseList(p, () => parseWithElement(p));
      if (!withList || !withList.children.length) return null;
    }
    if (!kw(p, "INSERT INTO")) return null;
    kw(p, "TABLE");
    if (kw(p, "FUNCTION")) {
      if (!parseFunction(p, false, true)) return null;
      if (kw(p, "PARTITION BY") && !parseExpressionWithOptionalAlias(p, false)) return null;
    } else {
      if (!parseIdentifier(p, true)) return null;
      if (tok(p, T.Dot) && !parseIdentifier(p, true)) return null;
    }

    const beforeBracket = p.i;
    if (tok(p, T.OpeningRoundBracket)) {
      if (!parseList(p, () => parseInsertElement(p), undefined, false)) {
        // Not a column list: ((SELECT ... starts a query.
        p.restore(beforeBracket);
      } else {
        tokQuiet(p, T.Comma);
        if (!tok(p, T.ClosingRoundBracket)) p.restore(beforeBracket);
      }
    }

    if (kw(p, "RETURNING")) {
      if (!tok(p, T.OpeningRoundBracket)) return null;
      if (!parseSelectWithUnionQuery(p)) return null;
      if (!tok(p, T.ClosingRoundBracket)) return null;
    }

    let infile = false;
    if (kw(p, "FROM INFILE")) {
      if (!parseStringLiteral(p)) return null;
      infile = true;
      if (kw(p, "COMPRESSION") && !parseStringLiteral(p)) return null;
    }

    let settings = false;
    if (kw(p, "SETTINGS")) {
      if (!parseSetQuery(p, true)) return null;
      settings = true;
    }

    const node = new Ast("InsertQuery");
    let data = -1;
    let format = false;
    let select: Ast | null = null;
    const beforeValues = p.i;
    if (!infile && kw(p, "VALUES")) {
      // Everything after VALUES is data, unless a ';' ends the query right there.
      if (p.kind() !== T.Semicolon) data = p.tok().start;
      node.flag("values");
    } else if (kw(p, "FORMAT")) {
      const name = parseIdentifier(p, true);
      if (!name) return null;
      node.name = name.name;
      format = true;
    } else if (kw(p, "SELECT") || kw(p, "WITH") || kw(p, "FROM") || tok(p, T.OpeningRoundBracket)) {
      p.restore(beforeValues);
      select = parseSelectWithUnionQuery(p);
      if (withList && select) {
        for (const child of select.children) {
          if (child.kind === "SelectQuery" && child.get("with"))
            p.fail("Only one WITH should be presented, either before INSERT or SELECT.");
        }
      }
      if (kw(p, "FORMAT")) {
        const name = parseIdentifier(p, true);
        if (!name) return null;
        node.name = name.name;
        format = true;
      }
    } else if (!infile) {
      return null;
    }

    if (allowSettingsAfterFormat && kw(p, "SETTINGS")) {
      if (settings)
        p.fail(
          "You have SETTINGS before and after FORMAT, this is not allowed. " +
            "Consider switching to SETTINGS before FORMAT and disable allow_settings_after_format_in_insert.",
        );
      if (!parseSetQuery(p, true)) return null;
      if (data >= 0) data = p.tok().start;
    }

    if (format && !infile && (!select || readsInput(select))) {
      const sql = p.sql;
      let at = p.toks[p.i - 1]!.end;
      if (sql[at] === ";")
        p.fail(
          "You have excessive ';' symbol before data for INSERT.\n" +
            "Example:\n\n" +
            "INSERT INTO t (x, y) FORMAT TabSeparated\n" +
            ";\tHello\n" +
            "2\tWorld\n" +
            "\n" +
            "Note that there is no ';' just after format name, " +
            "you need to put at least one whitespace symbol before the data.",
        );
      while (at < sql.length && (sql[at] === " " || sql[at] === "\t" || sql[at] === "\f")) at++;
      if (sql[at] === "\r") at++;
      if (sql[at] === "\n") at++;
      data = at;
    }
    if (select) {
      node.set("select", select);
      if (readsInput(select)) node.flag("input");
    }
    if (format) node.flag("format");
    if (infile) node.flag("infile");
    if (data >= 0 && data < p.sql.length) node.data = data;
    return node;
  });
}
