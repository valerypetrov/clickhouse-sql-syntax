/**
 * Data types: a port of src/Parsers/ParserDataType.cpp.
 * The result is a DataType node with the type name and its arguments as children.
 */
import { Ast } from "./ast.js";
import {
  parseCompoundIdentifier,
  parseEnumElement,
  parseIdentifier,
  parseLiteral,
  parseNumber,
  parseStringLiteral,
  parseUnsignedInteger,
  type LiteralAsText,
} from "./elements.js";
import { parseFunction, subParser } from "./expression.js";
import { stringLiteralValue } from "./literals.js";
import { base, Expected, isWordChar, kw, kwQuiet, lookahead, P, T, tok } from "./state.js";

const INTEGER_TYPE_NAMES = new Set([
  "INT8", "INT16", "INT32", "INT64", "INT128", "INT256", "UINT8", "UINT16", "UINT32", "UINT64", "UINT128",
  "UINT256", "TINYINT", "SMALLINT", "MEDIUMINT", "INT", "INTEGER", "BIGINT", "INT1",
]);

/** Words that a column declaration reads before the type, so they cannot be type names. */
const NOT_TYPE_NAMES = new Set([
  "NOT", "NULL", "DEFAULT", "MATERIALIZED", "EPHEMERAL", "ALIAS", "AUTO", "PRIMARY", "TTL", "COMMENT", "CODEC",
  "SETTINGS", "STATISTICS",
]);

/** parseEnumValues: 'a' = 1, 'b' = -2 with every value explicit; false falls back to the generic parser. */
function parseEnumValues(p: P): boolean {
  let first = true;
  let count = 0;
  for (;;) {
    if (!first) {
      if (p.kind() !== T.Comma) break;
      p.i++;
    }
    first = false;
    if (p.kind() !== T.StringLiteral) {
      p.expect("string literal for enum element name");
      return false;
    }
    const firstChar = p.text()[0];
    if (firstChar === "b" || firstChar === "B" || firstChar === "x" || firstChar === "X") {
      if (!parseStringLiteral(p)) return false;
    } else {
      if (stringLiteralValue(p.text()) === undefined) return false;
      p.i++;
    }
    if (p.kind() !== T.Equals) return false;
    p.i++;
    if (p.kind() === T.Minus) p.i++;
    if (p.kind() !== T.Number) {
      p.expect("number for enum element value");
      return false;
    }
    const text = p.text();
    if (!/^\+?\d+$/.test(text)) return false;
    if (BigInt(text) > 2n ** 63n - 1n) return false;
    p.i++;
    count++;
  }
  return count > 0;
}

/** Dynamic(max_types=N). */
function parseDynamicArgument(p: P): Ast | null {
  return base(p, "Dynamic data type optional argument", () => {
    if (!parseIdentifier(p)) return null;
    if (p.kind() !== T.Equals) {
      p.expect("equals operator");
      return null;
    }
    p.i++;
    return parseNumber(p) ? new Ast("Other") : null;
  });
}

/** JSON(max_dynamic_paths=N, a.b UInt32, SKIP a.c, SKIP REGEXP 'x', SHARED a.d Type). */
function parseObjectArgument(p: P): Ast | null {
  return base(p, "JSON data type optional argument", () => {
    if (kwQuiet(p, "SKIP")) {
      if (kwQuiet(p, "REGEXP")) return parseStringLiteral(p) ? new Ast("Other") : null;
      return parseCompoundIdentifier(p) ? new Ast("Other") : null;
    }
    const begin = p.i;
    const hasIdentifier = parseCompoundIdentifier(p) !== null;
    const afterIdentifier = p.i;
    const hasType = hasIdentifier && parseDataType(p) !== null;
    const afterType = p.i;
    const plainPath = hasType && (p.kind() === T.Comma || p.kind() === T.ClosingRoundBracket);
    let shared = false;
    if (!plainPath) {
      p.restore(begin);
      if (kwQuiet(p, "SHARED") && parseCompoundIdentifier(p) && parseDataType(p)) shared = true;
    }
    if (!shared && !plainPath) {
      if (!hasIdentifier) return null;
      p.restore(afterIdentifier);
      if (p.kind() === T.Equals) {
        p.i++;
        return parseNumber(p) ? new Ast("Other") : null;
      }
      if (!hasType) return null;
      p.i = afterType;
    }
    return new Ast("Other");
  });
}

/** IParserNameTypePair: name Type. */
export function parseNameTypePair(p: P): Ast | null {
  return base(p, "name and type pair", () => {
    if (!parseIdentifier(p)) return null;
    const type = parseDataType(p);
    if (!type) return null;
    const node = new Ast("Other");
    node.children = [type];
    return node;
  });
}

/** ParserDataType: a type name with optional arguments, including the SQL-standard multi-word names. */
export function parseDataType(p: P): Ast | null {
  return base(p, "data type", () => {
    const name = parseIdentifier(p);
    if (!name) return null;
    let typeName = name.name;
    if (!typeName || /^[0-9]/.test(typeName) || ![...typeName].every((c) => isWordChar(c) || c === "$")) {
      p.expect("type name");
      return null;
    }
    const upper = typeName.toUpperCase();
    if (NOT_TYPE_NAMES.has(upper)) {
      p.expect("type name");
      return null;
    }
    let suffix = "";
    if (upper === "NATIONAL") {
      for (const word of ["CHARACTER LARGE OBJECT", "CHARACTER VARYING", "CHAR VARYING", "CHARACTER", "CHAR"]) {
        if (kwQuiet(p, word)) {
          suffix = word;
          break;
        }
      }
    } else if (upper === "BINARY" || upper === "CHARACTER" || upper === "CHAR" || upper === "NCHAR") {
      if (kwQuiet(p, "LARGE OBJECT")) suffix = "LARGE OBJECT";
      else if (kwQuiet(p, "VARYING")) suffix = "VARYING";
    } else if (upper === "DOUBLE") {
      if (kwQuiet(p, "PRECISION")) suffix = "PRECISION";
    } else if (INTEGER_TYPE_NAMES.has(upper)) {
      // MySQL compatibility: INT(11) UNSIGNED.
      if (kw(p, "SIGNED")) suffix = "SIGNED";
      else if (kw(p, "UNSIGNED")) suffix = "UNSIGNED";
      else if (p.kind() === T.OpeningRoundBracket) {
        p.i++;
        if (p.kind() === T.Number) p.i++;
        if (p.kind() !== T.ClosingRoundBracket) return null;
        p.i++;
        if (kw(p, "SIGNED")) suffix = "SIGNED";
        else if (kw(p, "UNSIGNED")) suffix = "UNSIGNED";
      }
    }
    if (suffix) typeName = upper + " " + suffix;
    if (p.kind() === T.OpeningRoundBracket) {
      if (upper === "ARRAY") typeName = "Array";
      else if (upper === "MAP") typeName = "Map";
    }

    // A trailing comma inside a type, as in Tuple(Int, String,).
    if (p.kind() === T.Comma && lookahead(p, () => (p.i++, tok(p, T.ClosingRoundBracket)), new Expected())) p.i++;

    const node = new Ast("DataType");
    node.name = typeName;

    if ((upper === "ENUM" || upper === "ENUM8" || upper === "ENUM16") && p.kind() === T.OpeningRoundBracket) {
      const saved = p.i;
      p.i++;
      if (parseEnumValues(p) && p.kind() === T.ClosingRoundBracket) {
        p.i++;
        return node;
      }
      p.restore(saved);
    }

    // Tuple(...) has a fast path that is authoritative except for the empty Tuple().
    if (typeName === "Tuple" && p.kind() === T.OpeningRoundBracket && p.kindAt(p.i + 1) !== T.ClosingRoundBracket) {
      p.i++;
      let first = true;
      for (;;) {
        if (!first) {
          if (p.kind() === T.Comma) p.i++;
          else break;
        }
        first = false;
        const element = p.i;
        const named = parseIdentifier(p) !== null && parseDataType(p);
        if (named) {
          node.children.push(named);
          continue;
        }
        p.restore(element);
        const type = parseDataType(p);
        if (!type) break;
        node.children.push(type);
      }
      if (p.kind() === T.ClosingRoundBracket && node.children.length) {
        p.i++;
        return node;
      }
      return null;
    }

    if (p.kind() !== T.OpeningRoundBracket) return node;
    p.i++;

    let argNum = 0;
    let haveVersion = false;
    for (;;) {
      if (argNum > 0) {
        if (p.kind() === T.Comma) p.i++;
        else break;
      }
      let arg: Ast | null = null;
      if (typeName === "Dynamic") {
        arg = parseDynamicArgument(p);
      } else if (typeName.toLowerCase() === "json") {
        arg = parseObjectArgument(p);
      } else if (typeName === "Nested") {
        arg = parseNameTypePair(p);
      } else if (typeName === "Tuple") {
        arg = parseNameTypePair(p) ?? parseDataType(p);
      } else if (typeName === "AggregateFunction" || typeName === "SimpleAggregateFunction") {
        if (argNum === 0 && typeName === "AggregateFunction") {
          const version = parseUnsignedInteger(p);
          if (version) {
            haveVersion = true;
            node.children.push(version);
            argNum++;
            continue;
          }
        }
        if (argNum === (haveVersion ? 1 : 0)) arg = parseFunction(p) ?? parseIdentifier(p);
        else arg = parseDataType(p);
      } else {
        arg = parseEnumElement(p) ?? parseLiteral(p) ?? parseDataType(p);
      }
      if (!arg) break;
      node.children.push(arg);
      argNum++;
    }
    if (p.kind() !== T.ClosingRoundBracket) return null;
    p.i++;
    return node;
  });
}

/** parseDataTypeAsText: the type as written, or null if there is no type here. */
export function parseDataTypeAsText(p: P): string | null {
  const begin = p.i;
  if (!parseDataType(p)) return null;
  const first = p.toks[begin]!;
  const last = p.toks[p.i - 1]!;
  return p.sql.slice(first.start, last.end);
}

/** Types that read a literal written as text more precisely than a numeric literal carries it. */
function numeralReader(type: Ast, nullable: { value: boolean }): "none" | "decimal" | "signed" | "unsigned" {
  if (type.kind !== "DataType") return "none";
  const name = type.name.toUpperCase();
  if (name === "NULLABLE" || name === "ARRAY" || name === "LOWCARDINALITY") {
    if (type.children.length !== 1) return "none";
    if (name === "NULLABLE") nullable.value = true;
    return numeralReader(type.children[0]!, nullable);
  }
  if (["DECIMAL", "DECIMAL32", "DECIMAL64", "DECIMAL128", "DECIMAL256", "DEC", "NUMERIC", "FIXED"].includes(name))
    return "decimal";
  if (name === "INT128" || name === "INT256") return "signed";
  if (name === "UINT128" || name === "UINT256") return "unsigned";
  return "none";
}

/** typeReadsLiteralExactly: whether a cast of this literal to the type goes as text. */
export function typeReadsLiteralExactly(typeText: string, value: LiteralAsText): boolean {
  const sub = subParser(typeText);
  const type = sub.quiet(() => parseDataType(sub));
  if (!type || !sub.isEnd()) return false;
  const nullable = { value: false };
  const reader = numeralReader(type, nullable);
  if (value.hasNull && !nullable.value) return false;
  switch (reader) {
    case "none":
      return false;
    case "decimal":
      return value.allNumbers;
    case "signed":
      return value.allNumbers && value.allIntegers;
    case "unsigned":
      return value.allNumbers && value.allIntegers && value.allNonNegative;
  }
}
