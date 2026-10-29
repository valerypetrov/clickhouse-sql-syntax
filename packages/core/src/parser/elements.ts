/**
 * Expression elements: a port of src/Parsers/ExpressionElementParsers.cpp.
 * Each parser returns a node, or null after moving back to where it started.
 */
import {
  Ast,
  canHaveAlias,
  func,
  identifier,
  identifierName,
  list,
  literal,
  type Lit,
} from "./ast.js";
import { parseDataType, parseDataTypeAsText, typeReadsLiteralExactly } from "./datatype.js";
import {
  parenthesesHoldExpressionOverColumnNamedFrom,
  parseExpression,
  parseExpressionList,
  parseExpressionWithOptionalAlias,
  parseFunction,
  parseKeyValuePairsList,
  parseLeftAssociativeOperators,
  parseNotEmptyExpressionList,
  parseOrderByExpressionList,
} from "./expression.js";
import { parseExplainQuery } from "./explain.js";
import {
  floatLit,
  heredocValue,
  isUnsignedIntegerText,
  numberValue,
  quotedIdentifierName,
  stringLiteralValue,
  unquote,
} from "./literals.js";
import { parseSelectWithUnionQuery } from "./select.js";
import { base, kw, listUtil, P, peekKw, peekKwQuiet, T, tok, tokSeq } from "./state.js";

/** ParserIdentifier: a bare word, a quoted name, or a {name:Identifier} parameter. */
export function parseIdentifier(p: P, allowParam = false): Ast | null {
  return base(p, "identifier", () => {
    const kind = p.kind();
    if (kind === T.QuotedIdentifier) {
      const name = quotedIdentifierName(p.text());
      if (!name) return null;
      p.i++;
      return identifier([name]);
    }
    if (kind === T.BareWord) {
      const node = identifier([p.text()]);
      p.i++;
      return node;
    }
    if (allowParam && kind === T.OpeningCurlyBrace) {
      p.i++;
      if (p.kind() !== T.BareWord) {
        p.expect("substitution name (identifier)");
        return null;
      }
      p.i++;
      if (p.kind() !== T.Colon) {
        p.expect("colon between name and type");
        return null;
      }
      p.i++;
      if (p.kind() !== T.BareWord) {
        p.expect("substitution type (identifier)");
        return null;
      }
      const type = p.text();
      p.i++;
      if (type !== "Identifier") {
        p.expect("substitution type (identifier)");
        return null;
      }
      if (p.kind() !== T.ClosingCurlyBrace) {
        p.expect("closing curly brace");
        return null;
      }
      p.i++;
      return identifier([""]).flag("param");
    }
    return null;
  });
}

/** ParserTableAsStringLiteralIdentifier: a table named by a string, like 'data.csv'. */
export function parseTableAsStringLiteral(p: P): Ast | null {
  return base(p, "string literal table identifier", () => {
    if (p.kind() !== T.StringLiteral) return null;
    const value = unquote(p.text(), "'", false);
    if (value === undefined) {
      p.expect("string literal");
      return null;
    }
    if (value === "") {
      p.expect("non-empty string literal");
      return null;
    }
    p.i++;
    const node = identifier([value]);
    node.kind = "TableIdentifier";
    return node;
  });
}

/** ParserArrayOfJSONIdentifierAddition: the [][] of json.a[][].b; returns the depth. */
function parseArrayOfJsonAddition(p: P): number {
  let level = 0;
  base(p, "ParserArrayOfJSONIdentifierDelimiter", () => {
    if (!tokSeq(p, [T.OpeningSquareBracket, T.ClosingSquareBracket])) return null;
    level = 1;
    while (tokSeq(p, [T.OpeningSquareBracket, T.ClosingSquareBracket])) level++;
    return true;
  });
  return level;
}

const UUID_TEXT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;

/** ParserCompoundIdentifier: a.b.c, json.a.:Type, or db.table UUID '...'. */
export function parseCompoundIdentifier(p: P, tableWithUuid = false, allowParam = false): Ast | null {
  return base(p, "compound identifier", () => {
    const parts: string[] = [];
    let hasParam = false;
    let special = "";
    let isFirst = true;
    let begin = p.i;
    for (;;) {
      const element = parseIdentifier(p, allowParam);
      if (!element) {
        if (isFirst) return null;
        p.restore(begin);
        break;
      }
      if (special) {
        parts.push(`${special}\`${element.name}\``);
      } else {
        parts.push(element.name);
        if (!isFirst) {
          const level = parseArrayOfJsonAddition(p);
          if (level) parts.push(":`" + "Array(".repeat(level) + "JSON" + ")".repeat(level) + "`");
        }
      }
      if (parts[parts.length - 1] === "") hasParam = true;
      isFirst = false;
      begin = p.i;
      if (tokSeq(p, [T.Dot, T.Colon])) special = ":";
      else if (tokSeq(p, [T.Dot, T.Caret])) special = "^";
      else if (tokSeq(p, [T.Dot, T.At])) special = "@";
      else if (tok(p, T.Dot)) special = "";
      else {
        p.restore(begin);
        break;
      }
    }

    if (tableWithUuid) {
      if (parts.length > 2) return null;
      let uuid: Ast | null = null;
      if (kw(p, "UUID")) {
        uuid = parseStringLiteral(p);
        if (!uuid) return null;
        const text = stringValueOf(uuid);
        if (!UUID_TEXT.test(text)) p.failOther(`Cannot parse UUID from '${text}'`, p.i - 1);
      }
      const node = identifier(parts);
      node.kind = "TableIdentifier";
      node.set("uuid", uuid);
      return hasParam ? node.flag("param") : node;
    }
    const node = identifier(parts);
    return hasParam ? node.flag("param") : node;
  });
}

function stringValueOf(node: Ast): string {
  return node.value?.t === "String" ? node.value.v : "";
}

/** ParserSubquery; `out.startsValid` tells that it read a SELECT or EXPLAIN but no closing bracket. */
export function parseSubquery(p: P, out?: { startsValid: boolean }): Ast | null {
  if (out) out.startsValid = false;
  return base(p, "SELECT or EXPLAIN subquery", () => {
    if (p.kind() !== T.OpeningRoundBracket) return null;
    const open = p.i;
    p.i++;
    const possibleInner = p.kind() === T.OpeningRoundBracket;
    const startsWithFrom = p.isWord("from");
    if (startsWithFrom && parenthesesHoldExpressionOverColumnNamedFrom(p, open)) return null;

    let result = parseWithOptionalAlias(p, () => parseSelectWithUnionQuery(p), false);
    if (!result) {
      const explain = parseExplainQuery(p, true);
      if (explain) {
        checkExplainInSubquery(p, explain);
        result = new Ast("SelectWithUnionQuery");
      } else if (kw(p, "VALUES")) {
        if (p.kind() !== T.OpeningRoundBracket) return null;
        if (!parseExpression(p)) return null;
        while (p.kind() === T.Comma) {
          p.i++;
          if (!parseExpression(p)) return null;
        }
        result = new Ast("SelectWithUnionQuery");
      } else {
        return null;
      }
    }
    if (out) out.startsValid = !possibleInner && !startsWithFrom;
    if (p.kind() !== T.ClosingRoundBracket) return null;
    p.i++;
    const node = new Ast("Subquery");
    node.children = [result];
    return node;
  });
}

/** The checks ParserSubquery makes on (EXPLAIN ...); they throw BAD_ARGUMENTS. */
function checkExplainInSubquery(p: P, explain: Ast): void {
  if (explain.get("table_function") || explain.get("table_override"))
    p.failOther("EXPLAIN in a subquery cannot have a table function or table override");
  const query = explain.get("query");
  if (query?.has("output"))
    p.failOther("EXPLAIN in a subquery cannot have output options, such as FORMAT or INTO OUTFILE");
  if (query && query.kind !== "SelectWithUnionQuery")
    p.failOther("EXPLAIN inside subquery supports only SELECT queries");
}

/** ParserLiteral: NULL, a number, TRUE or FALSE, or a string. */
export function parseLiteral(p: P): Ast | null {
  return base(p, "literal", () => parseNull(p) ?? parseNumber(p) ?? parseBool(p) ?? parseStringLiteral(p));
}

export function parseNull(p: P): Ast | null {
  return base(p, "NULL", () => (kw(p, "NULL") ? literal({ t: "Null" }) : null));
}

export function parseBool(p: P): Ast | null {
  return base(p, "Bool", () => {
    if (kw(p, "TRUE")) return literal({ t: "Bool", v: true });
    if (kw(p, "FALSE")) return literal({ t: "Bool", v: false });
    return null;
  });
}

/** ParserNumber: a number with an optional sign, or inf and nan as bare words. */
export function parseNumber(p: P): Ast | null {
  return base(p, "number", () => {
    let negative = false;
    if (p.kind() === T.Minus) {
      p.i++;
      negative = true;
    } else if (p.kind() === T.Plus) {
      p.i++;
    }
    if (!p.valid()) return null;
    const text = p.text();
    if (p.kind() === T.BareWord) {
      const value = floatLit(text, negative);
      if (!value) {
        p.expect("number");
        return null;
      }
      p.i++;
      return literal(value);
    }
    if (p.kind() !== T.Number) {
      p.expect("number");
      return null;
    }
    const value = numberValue(text, negative);
    if (!value) {
      // A bad binary number fails without saying what was expected.
      const digits = text.replaceAll("_", "");
      if (!(digits.length <= 319 && digits.startsWith("0b"))) p.expect("number");
      return null;
    }
    p.i++;
    return literal(value);
  });
}

/** ParserUnsignedInteger, used for x.1 and a few clauses. */
export function parseUnsignedInteger(p: P): Ast | null {
  return base(p, "unsigned integer", () => {
    if (!p.valid()) return null;
    if (!isUnsignedIntegerText(p.text())) {
      p.expect("unsigned integer");
      return null;
    }
    const node = literal({ t: "UInt64", v: Number(p.text()) });
    p.i++;
    return node;
  });
}

/** ParserStringLiteral: a quoted string or a heredoc. */
export function parseStringLiteral(p: P): Ast | null {
  return base(p, "string literal", () => {
    if (p.kind() === T.HereDoc) {
      const node = literal({ t: "String", v: heredocValue(p.text()) });
      p.i++;
      return node;
    }
    if (p.kind() !== T.StringLiteral) return null;
    const value = stringLiteralValue(p.text());
    if (value === undefined) {
      p.expect("string literal");
      return null;
    }
    p.i++;
    return literal({ t: "String", v: value });
  });
}

/** ParserCollectionOfLiterals: [1, 2] or (1, 'a') made of literals only. */
function parseCollectionOfLiterals(p: P, tuple: boolean): Ast | null {
  const opening = tuple ? T.OpeningRoundBracket : T.OpeningSquareBracket;
  const closing = tuple ? T.ClosingRoundBracket : T.ClosingSquareBracket;
  return base(p, "collection of literals", () => {
    if (p.kind() !== opening) return null;
    const layers: Lit[][] = [[]];
    p.i++;
    p.increaseDepth();
    while (p.valid()) {
      const top = layers[layers.length - 1]!;
      if (top.length) {
        if (p.kind() === closing) {
          if (tuple && top.length === 1) return null;
          p.i++;
          layers.pop();
          p.depth--;
          const value: Lit = { t: tuple ? "Tuple" : "Array", v: top };
          if (!layers.length) return literal(value);
          layers[layers.length - 1]!.push(value);
          continue;
        }
        if (p.kind() === T.Comma) {
          p.i++;
        } else {
          p.expect("comma or closing bracket");
          return null;
        }
      }
      const element = parseLiteral(p);
      if (element) {
        layers[layers.length - 1]!.push(element.value!);
      } else if (p.kind() === opening) {
        layers.push([]);
        p.i++;
        p.increaseDepth();
      } else {
        return null;
      }
    }
    p.expect(closing);
    return null;
  });
}

export function parseTupleOfLiterals(p: P): Ast | null {
  return base(p, "tuple", () => parseCollectionOfLiterals(p, true));
}

export function parseArrayOfLiterals(p: P): Ast | null {
  return base(p, "array", () => parseCollectionOfLiterals(p, false));
}

type Collection = { kind: "map" | "tuple" | "array"; values: Lit[] };

function startCollection(p: P, collections: Collection[], allowMap: boolean): boolean {
  if (allowMap && p.kind() === T.OpeningCurlyBrace) collections.push({ kind: "map", values: [] });
  else if (p.kind() === T.OpeningRoundBracket) collections.push({ kind: "tuple", values: [] });
  else if (p.kind() === T.OpeningSquareBracket) collections.push({ kind: "array", values: [] });
  else return false;
  p.i++;
  return true;
}

/** One step of a collection of ParserAllCollectionsOfLiterals; `done` holds a finished one. */
function parseCollectionStep(
  p: P,
  collections: Collection[],
  done: { value: Lit | null },
  allowMap: boolean,
): boolean {
  const current = collections[collections.length - 1]!;
  if (done.value) {
    current.values.push(done.value);
    done.value = null;
  }
  const end =
    current.kind === "map" ? T.ClosingCurlyBrace : current.kind === "tuple" ? T.ClosingRoundBracket : T.ClosingSquareBracket;
  for (;;) {
    if (tok(p, end)) {
      done.value = { t: current.kind === "map" ? "Map" : current.kind === "tuple" ? "Tuple" : "Array", v: current.values };
      return true;
    }
    if (current.values.length && !tok(p, T.Comma)) return false;
    if (current.kind === "map") {
      const key = parseLiteral(p);
      if (!key) return false;
      if (!tok(p, T.Colon)) return false;
      current.values.push(key.value!);
    }
    const element = parseLiteral(p);
    if (element) current.values.push(element.value!);
    else return startCollection(p, collections, allowMap);
  }
}

/** ParserAllCollectionsOfLiterals: nested maps, arrays and tuples of literals. */
export function parseAllCollectionsOfLiterals(p: P, allowMap = true): Ast | null {
  return base(p, "combination of maps, arrays, tuples", () => {
    const collections: Collection[] = [];
    if (!startCollection(p, collections, allowMap)) return null;
    const done: { value: Lit | null } = { value: null };
    while (collections.length) {
      if (!parseCollectionStep(p, collections, done, allowMap)) return null;
      if (done.value) collections.pop();
    }
    return literal(done.value!);
  });
}

const RESTRICTED_ALIASES = new Set([
  "all", "anti", "any", "array", "asof", "between", "cross", "paste", "final", "format", "from", "full",
  "global", "group", "having", "ilike", "inner", "into", "join", "left", "like", "limit", "natural", "not",
  "offset", "on", "only", "order", "parallel", "prewhere", "right", "sample", "semi", "settings", "similar",
  "stream", "union", "using", "where", "window", "qualify", "with", "intersect", "except", "else",
]);

/** ParserAlias: [AS] name, where a name without AS must not be a clause keyword. */
export function parseAlias(p: P, allowWithoutAs: boolean): Ast | null {
  return base(p, "alias", () => {
    const hasAs = kw(p, "AS");
    if (!allowWithoutAs && !hasAs) return null;
    const quoted = p.kind() === T.QuotedIdentifier;
    const node = parseIdentifier(p, true);
    if (!node) return null;
    if (!hasAs && !quoted) {
      const name = node.name.toLowerCase();
      if (RESTRICTED_ALIASES.has(name)) return null;
      if (name === "comment") {
        // A trailing COMMENT 'text' of a view or table is not an alias.
        const begin = p.i;
        const isTrailingComment = p.quiet(() => {
          if (!parseStringLiteral(p)) return false;
          return p.kind() === T.EndOfStream || p.kind() === T.Semicolon;
        });
        p.i = begin;
        if (isTrailingComment) return null;
      }
    }
    return node;
  });
}

/** ParserWithOptionalAlias: an element, then an alias if the element can carry one. */
export function parseWithOptionalAlias(p: P, element: () => Ast | null, allowWithoutAs: boolean): Ast | null {
  return base(p, "element of expression with optional alias", () => {
    const node = element();
    if (!node) return null;
    const allowNow = allowWithoutAs && identifierName(node)?.toLowerCase() !== "from";
    const alias = parseAlias(p, allowNow);
    if (alias) {
      if (canHaveAlias(node)) {
        node.alias = alias.name;
      } else {
        p.expect("alias cannot be here");
        return null;
      }
    }
    return node;
  });
}

/** ParserSubstitution: a {name:Type} query parameter. */
export function parseSubstitution(p: P): Ast | null {
  return base(p, "substitution", () => {
    if (p.kind() !== T.OpeningCurlyBrace) return null;
    p.i++;
    if (p.kind() !== T.BareWord) {
      p.expect("substitution name (identifier)");
      return null;
    }
    const name = p.text();
    p.i++;
    if (p.kind() !== T.Colon) {
      p.expect("colon between name and type");
      return null;
    }
    p.i++;
    if (!parseDataType(p)) {
      p.expect("substitution type");
      return null;
    }
    if (p.kind() !== T.ClosingCurlyBrace) {
      p.expect("closing curly brace");
      return null;
    }
    p.i++;
    const node = new Ast("QueryParameter");
    node.name = name;
    return node;
  });
}

/** ParserMySQLGlobalVariable: @@name or @@session.name. */
export function parseMySQLGlobalVariable(p: P): Ast | null {
  return base(p, "MySQL-style global variable", () => {
    if (p.kind() !== T.DoubleAt) return null;
    p.i++;
    if (p.kind() !== T.BareWord) {
      p.expect("variable name");
      return null;
    }
    let name = p.text();
    p.i++;
    if (p.kind() === T.Dot) {
      p.i++;
      if (p.kind() !== T.BareWord) {
        p.expect("variable name");
        return null;
      }
      name = p.text();
      p.i++;
    }
    const node = func("globalVariable", [literal({ t: "String", v: name })]);
    node.alias = "@@" + name;
    return node;
  });
}

const ALL_TRANSFORMERS = { apply: true, except: true, replace: true };
export type Transformers = typeof ALL_TRANSFORMERS;

/** ParserColumnsTransformers: APPLY(f), EXCEPT(a, b) or REPLACE(x AS y) after * or COLUMNS. */
export function parseColumnsTransformer(p: P, allowed: Transformers = ALL_TRANSFORMERS): Ast | null {
  return base(p, "COLUMNS transformers", () => {
    if (allowed.apply && kw(p, "APPLY")) return parseApplyTransformer(p);
    if (allowed.except && kw(p, "EXCEPT")) {
      kw(p, "STRICT");
      const parseId = () => parseIdentifier(p, true) !== null;
      if (p.kind() === T.OpeningRoundBracket) {
        p.i++;
        if (!listUtil(p, parseId, undefined, false) && !parseStringLiteral(p)) return null;
        if (p.kind() !== T.ClosingRoundBracket) return null;
        p.i++;
      } else if (!parseId() && !parseStringLiteral(p)) {
        return null;
      }
      return new Ast("ColumnsTransformer");
    }
    if (allowed.replace && kw(p, "REPLACE")) {
      kw(p, "STRICT");
      const parseReplacement = () => parseExpression(p) !== null && kw(p, "AS") && parseIdentifier(p) !== null;
      if (p.kind() === T.OpeningRoundBracket) {
        p.i++;
        if (!listUtil(p, parseReplacement, undefined, false)) return null;
        if (p.kind() !== T.ClosingRoundBracket) return null;
        p.i++;
      } else if (!parseReplacement()) {
        return null;
      }
      return new Ast("ColumnsTransformer");
    }
    return null;
  });
}

/** True for lambda(tuple(...), body), like isASTLambdaFunction. */
export function isLambdaFunction(node: Ast): boolean {
  return node.kind === "Function" && node.name === "lambda" && node.children.length === 2 &&
    node.children[0]!.kind === "Function" && node.children[0]!.name === "tuple";
}

function parseApplyTransformer(p: P): Ast | null {
  let withOpenBracket = false;
  if (p.kind() === T.OpeningRoundBracket) {
    p.i++;
    withOpenBracket = true;
  }
  const start = p.i;
  let lambda = parseExpression(p);
  if (lambda) {
    let fn: Ast | null = lambda.kind === "Function" ? lambda : null;
    if (!fn || fn.name !== "lambda") {
      // ParserExpression also takes an operator after lambda(...), so read the plain call.
      fn = null;
      p.restore(start);
      const name = parseIdentifier(p);
      const isCall = name !== null && name.name === "lambda" && p.kind() === T.OpeningRoundBracket;
      p.i = start;
      if (isCall) {
        lambda = parseFunction(p);
        if (lambda) fn = lambda;
      }
      if (fn && (fn.params || fn.has("nulls") || fn.has("window"))) fn = null;
    }
    if (fn && fn.name === "lambda") {
      if (!isLambdaFunction(fn))
        p.fail("Lambda function definition expects two arguments, first argument must be a tuple of arguments");
      const args = fn.children[0]!.children;
      if (args.length !== 1) p.fail("APPLY column transformer can only accept lambda with one argument");
      if (args[0]!.kind !== "Identifier" && args[0]!.kind !== "TableIdentifier")
        p.fail("lambda argument declarations must be identifiers");
    } else {
      lambda = null;
      p.restore(start);
    }
  }
  if (!lambda) {
    if (!parseIdentifier(p)) return null;
    if (p.kind() === T.OpeningRoundBracket) {
      p.i++;
      if (!parseExpressionList(p, false)) return null;
      if (p.kind() !== T.ClosingRoundBracket) return null;
      p.i++;
    }
  }
  if (withOpenBracket && p.kind() === T.Comma) {
    p.i++;
    if (!parseStringLiteral(p)) return null;
  }
  if (withOpenBracket) {
    if (p.kind() !== T.ClosingRoundBracket) return null;
    p.i++;
  }
  return new Ast("ColumnsTransformer");
}

/** parseColumnsMatcherFromLikePattern: "fail" when LIKE has no pattern after it. */
function parseLikePatternMatcher(p: P, qualified: boolean): Ast | null | "fail" {
  if (!kw(p, "ILIKE") && !kw(p, "LIKE")) return null;
  if (!parseStringLiteral(p)) return "fail";
  return new Ast(qualified ? "QualifiedColumnsRegexpMatcher" : "ColumnsRegexpMatcher");
}

function parseTransformers(p: P, node: Ast, allowed: Transformers = ALL_TRANSFORMERS): Ast {
  while (parseColumnsTransformer(p, allowed)) node.flag("transformers");
  return node;
}

/** ParserAsterisk: * with an optional LIKE pattern and transformers. */
export function parseAsterisk(p: P, allowed: Transformers = ALL_TRANSFORMERS): Ast | null {
  return base(p, "asterisk", () => {
    if (p.kind() !== T.Asterisk) return null;
    p.i++;
    const matcher = parseLikePatternMatcher(p, false);
    if (matcher === "fail") return null;
    return parseTransformers(p, matcher ?? new Ast("Asterisk"), allowed);
  });
}

/** ParserQualifiedAsterisk: t.* or db.t.*. */
export function parseQualifiedAsterisk(p: P): Ast | null {
  return base(p, "qualified asterisk", () => {
    if (!parseCompoundIdentifier(p, false, true)) return null;
    if (p.kind() !== T.Dot) return null;
    p.i++;
    if (p.kind() !== T.Asterisk) return null;
    p.i++;
    const matcher = parseLikePatternMatcher(p, true);
    if (matcher === "fail") return null;
    return parseTransformers(p, matcher ?? new Ast("QualifiedAsterisk"));
  });
}

/** (columns, ...) or ('regexp') after COLUMNS. */
function parseColumnsMatcherBody(p: P, allowed: Transformers, qualified: boolean): Ast | null {
  if (p.kind() !== T.OpeningRoundBracket) return null;
  p.i++;
  const columns = parseList(p, () => parseCompoundIdentifier(p, false, true), undefined, false);
  if (!columns && !parseStringLiteral(p)) return null;
  if (p.kind() !== T.ClosingRoundBracket) return null;
  p.i++;
  const kind = columns
    ? qualified ? "QualifiedColumnsListMatcher" : "ColumnsListMatcher"
    : qualified ? "QualifiedColumnsRegexpMatcher" : "ColumnsRegexpMatcher";
  return parseTransformers(p, new Ast(kind), allowed);
}

/** ParserColumnsMatcher: COLUMNS(a, b) or COLUMNS('regexp'). */
export function parseColumnsMatcher(p: P, allowed: Transformers = ALL_TRANSFORMERS): Ast | null {
  return base(p, "COLUMNS matcher", () => (kw(p, "COLUMNS") ? parseColumnsMatcherBody(p, allowed, false) : null));
}

/** ParserQualifiedColumnsMatcher: t.COLUMNS(...). */
export function parseQualifiedColumnsMatcher(p: P, allowed: Transformers = ALL_TRANSFORMERS): Ast | null {
  return base(p, "qualified COLUMNS matcher", () => {
    const name = parseCompoundIdentifier(p, false, true);
    if (!name) return null;
    const parts = name.parts!;
    if (parts.length === 1 || parts[parts.length - 1] !== "COLUMNS") return null;
    return parseColumnsMatcherBody(p, allowed, true);
  });
}

/** ParserList: elements with a separator, as an ExpressionList. */
export function parseList(
  p: P,
  element: () => Ast | null,
  separator: () => boolean = () => tok(p, T.Comma),
  allowEmpty = true,
  allowTrailing = false,
): Ast | null {
  return base(p, "list of elements", () => {
    const elements: Ast[] = [];
    const ok = listUtil(
      p,
      () => {
        const node = element();
        if (node) elements.push(node);
        return node !== null;
      },
      separator,
      allowEmpty,
      allowTrailing,
    );
    return ok ? list(elements) : null;
  });
}

/** ParserFilterClause: FILTER (WHERE cond) after an aggregate function. */
export function parseFilterClause(p: P, fn: Ast): boolean {
  return (
    base(p, "filter", () => {
      if (!tok(p, T.OpeningRoundBracket)) return null;
      if (!kw(p, "WHERE")) return null;
      const condition = parseExpressionList(p, false);
      if (!condition || condition.children.length !== 1) return null;
      if (!tok(p, T.ClosingRoundBracket)) return null;
      if (fn.name === "count")
        fn.children = fn.children.filter((child) => child.kind !== "Asterisk" && child.kind !== "QualifiedAsterisk");
      fn.name += "If";
      fn.children.push(condition.children[0]!);
      return true;
    }) !== null
  );
}

/** ParserWindowReference: OVER name or OVER (definition). */
export function parseWindowReference(p: P, fn: Ast): boolean {
  return (
    base(p, "window reference", () => {
      if (p.kind() !== T.OpeningRoundBracket) return parseIdentifier(p) !== null;
      return parseWindowDefinition(p) !== null;
    }) !== null
  );
}

/** tryParseFrameDefinition: ROWS|RANGE|GROUPS [BETWEEN] bound [AND bound]. */
function parseFrame(p: P): boolean {
  if (!kw(p, "ROWS") && !kw(p, "GROUPS") && !kw(p, "RANGE")) return true;
  const hasEnd = kw(p, "BETWEEN");
  if (!kw(p, "CURRENT ROW")) {
    let unbounded = false;
    if (kw(p, "UNBOUNDED")) unbounded = true;
    else if (!parseExpression(p)) return false;
    if (kw(p, "PRECEDING")) {
      // A frame start may precede.
    } else if (kw(p, "FOLLOWING")) {
      if (unbounded) p.failOther("Frame start cannot be UNBOUNDED FOLLOWING");
    } else {
      return false;
    }
  }
  if (hasEnd) {
    if (!kw(p, "AND")) return false;
    if (!kw(p, "CURRENT ROW")) {
      let unbounded = false;
      if (kw(p, "UNBOUNDED")) unbounded = true;
      else if (!parseExpression(p)) return false;
      if (kw(p, "PRECEDING")) {
        if (unbounded) p.failOther("Frame end cannot be UNBOUNDED PRECEDING");
      } else if (!kw(p, "FOLLOWING")) {
        return false;
      }
    }
  }
  return true;
}

function parseWindowDefinitionParts(p: P): boolean {
  if (kw(p, "PARTITION BY") && !parseNotEmptyExpressionList(p, false)) return false;
  if (kw(p, "ORDER BY") && !parseOrderByExpressionList(p)) return false;
  return parseFrame(p);
}

/** ParserWindowDefinition: ([parent] [PARTITION BY ...] [ORDER BY ...] [frame]). */
export function parseWindowDefinition(p: P): Ast | null {
  return base(p, "window definition", () => {
    if (!tok(p, T.OpeningRoundBracket)) return null;
    const bodyBegin = p.i;
    if (parseWindowDefinitionParts(p) && tok(p, T.ClosingRoundBracket)) return new Ast("Other");
    p.restore(bodyBegin);
    if (!parseIdentifier(p)) return null;
    if (!parseWindowDefinitionParts(p)) return null;
    if (!tok(p, T.ClosingRoundBracket)) return null;
    return new Ast("Other");
  });
}

/** ParserWindowList: name AS (definition), ... */
export function parseWindowList(p: P): Ast | null {
  return base(p, "WINDOW clause", () => {
    for (;;) {
      if (!parseIdentifier(p)) return null;
      if (!kw(p, "AS")) return null;
      if (!parseWindowDefinition(p)) return null;
      if (!p.quiet(() => tok(p, T.Comma))) break;
    }
    return new Ast("Other");
  });
}

/** ParserIdentifierWithParameters: Engine(args), parsed as a function. */
export function parseIdentifierWithParameters(p: P): Ast | null {
  return base(p, "identifier with parameters", () => {
    const begin = p.i;
    if (!parseIdentifier(p)) return null;
    p.restore(begin);
    return parseFunction(p);
  });
}

/** ParserIdentifierWithOptionalParameters: Engine or Engine(args). */
export function parseIdentifierWithOptionalParameters(p: P): Ast | null {
  return base(p, "identifier with optional parameters", () => {
    const parametric = parseIdentifierWithParameters(p);
    if (parametric) return parametric;
    const name = parseIdentifier(p);
    return name ? func(name.name) : null;
  });
}

/** ParserCodec: (ZSTD(1), Delta) after CODEC. */
export function parseCodec(p: P): Ast | null {
  return base(p, "codec", () => {
    if (p.kind() !== T.OpeningRoundBracket) return null;
    p.i++;
    const codecs = base(p, "codec declaration list", () =>
      parseList(p, () => parseIdentifierWithOptionalParameters(p), undefined, false),
    );
    if (!codecs) return null;
    if (p.kind() !== T.ClosingRoundBracket) return null;
    p.i++;
    return func("CODEC", codecs.children);
  });
}

/** ParserStatisticsType: (tdigest, uniq) after STATISTICS. */
export function parseStatisticsType(p: P): Ast | null {
  return base(p, "statistics", () => {
    if (p.kind() !== T.OpeningRoundBracket) return null;
    p.i++;
    const types = parseList(p, () => parseIdentifierWithOptionalParameters(p), undefined, false);
    if (!types) return null;
    if (p.kind() !== T.ClosingRoundBracket) return null;
    p.i++;
    return func("STATISTICS", types.children);
  });
}

/** ParserCollation: a name like utf8_unicode_ci. */
export function parseCollation(p: P): Ast | null {
  return base(p, "collation", () => {
    const node = parseIdentifier(p, true);
    if (!node) return null;
    const name = node.name;
    const valid = name === "binary" || ["_bin", "_ci", "_cs", "_ks"].some((suffix) => name.endsWith(suffix));
    return valid ? new Ast("Other") : null;
  });
}

/** The text of a literal read by parseLiteralAsText, and what its numbers look like. */
export interface LiteralAsText {
  allNumbers: boolean;
  allIntegers: boolean;
  allNonNegative: boolean;
  hasNull: boolean;
}

const PLAIN_DECIMAL = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function isPlainDecimalNumeral(text: string): boolean {
  return PLAIN_DECIMAL.test(text);
}

function isIntegerNumeral(text: string): boolean {
  return !/[.eE]/.test(text);
}

function isIntegerZeroNumeral(text: string): boolean {
  return isIntegerNumeral(text) && /^0*$/.test(text);
}

const OPENING = new Set([T.OpeningSquareBracket, T.OpeningRoundBracket]);

/** scanCollectionOfLiteralsAsText: an array or tuple of numbers, strings and NULLs. */
function scanCollectionAsText(p: P, literal: LiteralAsText): boolean {
  const outerIsRound = p.kind() === T.OpeningRoundBracket;
  let holdsOwnComma = false;
  let holdsOwnScalar = false;
  let last: T = T.OpeningSquareBracket;
  const stack: T[] = [];
  while (p.valid()) {
    const own = stack.length === 1;
    const kind = p.kind();
    if (OPENING.has(kind)) {
      stack.push(kind);
      if (!OPENING.has(last) && last !== T.Comma) return false;
    } else if (kind === T.ClosingSquareBracket || kind === T.ClosingRoundBracket) {
      if (last === T.Comma || last === T.Minus) return false;
      if (kind === T.ClosingSquareBracket && last === T.OpeningRoundBracket) return false;
      if (kind === T.ClosingRoundBracket && last === T.OpeningSquareBracket) return false;
      const opening = kind === T.ClosingSquareBracket ? T.OpeningSquareBracket : T.OpeningRoundBracket;
      if (stack[stack.length - 1] !== opening) return false;
      stack.pop();
    } else if (kind === T.Comma) {
      if (OPENING.has(last) || last === T.Comma || last === T.Minus) return false;
      if (own) holdsOwnComma = true;
    } else if (kind === T.Number) {
      if (!OPENING.has(last) && last !== T.Comma && last !== T.Minus) return false;
      const text = p.text();
      if (!isPlainDecimalNumeral(text)) return false;
      if (!isIntegerNumeral(text)) literal.allIntegers = false;
      if (own) holdsOwnScalar = true;
      if (last === T.Minus && !isIntegerZeroNumeral(text)) literal.allNonNegative = false;
    } else if (kind === T.StringLiteral || kind === T.Minus) {
      if (!OPENING.has(last) && last !== T.Comma) return false;
      if (kind === T.StringLiteral) {
        literal.allNumbers = false;
        if (own) holdsOwnScalar = true;
      }
    } else if (kind === T.BareWord && p.lower() === "null") {
      if (!OPENING.has(last) && last !== T.Comma) return false;
      literal.hasNull = true;
      if (own) holdsOwnScalar = true;
    } else {
      break;
    }
    last = kind;
    p.i++;
    if (!stack.length) break;
  }
  if (stack.length) return false;
  if (outerIsRound && !holdsOwnComma && holdsOwnScalar) return false;
  return true;
}

/** parseLiteralAsText: a number, or an array or tuple of literals, read as text. */
export function parseLiteralAsText(p: P): LiteralAsText | null {
  const begin = p.i;
  const result: LiteralAsText = { allNumbers: true, allIntegers: true, allNonNegative: true, hasNull: false };
  if (p.kind() === T.Minus) {
    p.i++;
    if (p.kind() !== T.Number || !isPlainDecimalNumeral(p.text())) {
      p.restore(begin);
      return null;
    }
    const text = p.text();
    result.allIntegers = isIntegerNumeral(text);
    if (!isIntegerZeroNumeral(text)) result.allNonNegative = false;
    p.i++;
  } else if (p.kind() === T.Number) {
    const text = p.text();
    if (!isPlainDecimalNumeral(text)) return null;
    result.allIntegers = isIntegerNumeral(text);
    p.i++;
  } else if (OPENING.has(p.kind())) {
    if (!scanCollectionAsText(p, result)) {
      p.restore(begin);
      return null;
    }
  } else {
    return null;
  }
  return result;
}

/** ParserCastOperator: a literal followed by ::Type. */
export function parseCastOperator(p: P): Ast | null {
  return base(p, "CAST operator", () => {
    const value = parseLiteralAsText(p);
    if (!value) return null;
    if (!tok(p, T.DoubleColon)) return null;
    const type = parseDataTypeAsText(p);
    if (type === null) return null;
    if (value.hasNull && !typeReadsLiteralExactly(type, value)) return null;
    return func("CAST", [literal({ t: "String", v: "" }), literal({ t: "String", v: type })]);
  });
}

/** ParserStorageOrderByElement: an expression, without alias, with ASC or DESC if allowed. */
export function parseStorageOrderByElement(p: P, allowOrder: boolean): Ast | null {
  return base(p, "element of storage ORDER BY expression", () => {
    const expr = parseExpression(p);
    if (!expr) return null;
    if (expr.alias) return null;
    if (!allowOrder) return expr;
    if (!kw(p, "DESCENDING") && !kw(p, "DESC")) {
      if (!kw(p, "ASCENDING")) kw(p, "ASC");
    }
    const node = new Ast("Other");
    node.children = [expr];
    return node;
  });
}

/** ParserOrderByElement: expr [ASC|DESC] [NULLS FIRST|LAST] [COLLATE 'x'] [WITH FILL ...]. */
export function parseOrderByElement(p: P): Ast | null {
  return base(p, "element of ORDER BY expression", () => {
    if (!parseExpressionWithOptionalAlias(p, false)) return null;
    if (!kw(p, "DESCENDING") && !kw(p, "DESC")) {
      if (!kw(p, "ASCENDING")) kw(p, "ASC");
    }
    if (kw(p, "NULLS")) {
      if (!kw(p, "FIRST") && !kw(p, "LAST")) return null;
    }
    if (kw(p, "COLLATE") && !parseStringLiteral(p)) return null;
    const node = new Ast("OrderByElement");
    if (kw(p, "WITH FILL")) {
      node.flag("with_fill");
      if (kw(p, "FROM") && !parseExpressionWithOptionalAlias(p, false)) return null;
      if (kw(p, "TO") && !parseExpressionWithOptionalAlias(p, false)) return null;
      if (kw(p, "STEP") && !parseExpressionWithOptionalAlias(p, false)) return null;
      if (kw(p, "STALENESS") && !parseExpressionWithOptionalAlias(p, false)) return null;
    }
    return node;
  });
}

/** ParserInterpolateElement: column [AS expr]. */
export function parseInterpolateElement(p: P): Ast | null {
  return base(p, "element of INTERPOLATE expression", () => {
    if (!parseIdentifier(p)) return null;
    if (kw(p, "AS") && !parseExpression(p)) return null;
    return new Ast("Other");
  });
}

/** ParserFunctionWithKeyValueArguments: SOURCE(CLICKHOUSE(host 'x' port 9000)). */
export function parseFunctionWithKeyValueArguments(p: P, bracketsCanBeOmitted = false): Ast | null {
  return base(p, "function with key-value arguments", () => {
    const name = parseIdentifier(p);
    if (!name) return null;
    let bracket = false;
    if (p.kind() !== T.OpeningRoundBracket) {
      if (!bracketsCanBeOmitted) return null;
    } else {
      p.i++;
      bracket = true;
    }
    const pairs = parseKeyValuePairsList(p);
    if (!pairs) return null;
    if (bracket) {
      if (p.kind() !== T.ClosingRoundBracket) return null;
      p.i++;
    }
    const node = new Ast("FunctionWithKeyValueArguments");
    node.name = name.name.toLowerCase();
    node.children = pairs.children;
    if (bracket) node.flag("brackets");
    return node;
  });
}

/** ParserAssignment: column = expr. */
export function parseAssignment(p: P): Ast | null {
  return base(p, "column assignment", () => {
    if (!parseIdentifier(p)) return null;
    if (!tok(p, T.Equals)) return null;
    if (!parseExpression(p)) return null;
    return new Ast("Other");
  });
}

/** ParserTTLElement: expr [DELETE [WHERE ...] | TO DISK|VOLUME 'x' | GROUP BY ... | RECOMPRESS CODEC(...)]. */
export function parseTTLElement(p: P): Ast | null {
  return base(p, "element of TTL expression", () => {
    if (peekKw(p, "MATERIALIZE TTL") || peekKw(p, "REMOVE TTL") || peekKw(p, "MODIFY TTL")) return null;
    if (!parseExpression(p)) return null;
    let mode: "move" | "group" | "recompress" | "delete";
    if (kw(p, "TO DISK") || kw(p, "TO VOLUME")) mode = "move";
    else if (kw(p, "GROUP BY")) mode = "group";
    else if (kw(p, "RECOMPRESS")) mode = "recompress";
    else {
      kw(p, "DELETE");
      mode = "delete";
    }
    if (mode === "move") {
      kw(p, "IF EXISTS");
      if (!parseStringLiteral(p)) return null;
    } else if (mode === "group") {
      if (!parseExpressionList(p, false)) return null;
      if (kw(p, "SET") && !parseList(p, () => parseAssignment(p))) return null;
    } else if (mode === "delete" && kw(p, "WHERE")) {
      if (!parseExpression(p)) return null;
    } else if (mode === "recompress") {
      if (!kw(p, "CODEC")) return null;
      if (!parseCodec(p)) return null;
    }
    return new Ast("Other");
  });
}

/** Parses an enum-like data type argument list: 'a' = 1 with ParserLeftAssociativeBinaryOperatorList. */
export function parseEnumElement(p: P): Ast | null {
  return parseLeftAssociativeOperators(p, [["=", "equals"]], () => parseLiteral(p));
}

export { peekKwQuiet };
