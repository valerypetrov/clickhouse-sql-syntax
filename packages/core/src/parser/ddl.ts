/**
 * Smaller DDL statements: functions, workloads, resources, named collections, handlers, indexes,
 * hypothetical objects and COPY. Ports of the ClickHouse parsers with the same names.
 */
import { Ast } from "./ast.js";
import { parseCluster, parseDatabaseAndTableAsAST } from "./common.js";
import { parseProjectionDeclarationBody } from "./create.js";
import { parseDataType, parseNameTypePair } from "./datatype.js";
import {
  parseCompoundIdentifier,
  parseIdentifier,
  parseList,
  parseLiteral,
  parseStringLiteral,
  parseUnsignedInteger,
} from "./elements.js";
import {
  parseExpression,
  parseExpressionWithOptionalAlias,
  parseExpressionWithOptionalArguments,
  parseOrderByExpressionList,
} from "./expression.js";
import { parseQuery } from "./query.js";
import { parseNameValuePair, parseNameValuePairs } from "./set.js";
import { attempt, base, kw, listUtil, P, T, tok, tokQuiet } from "./state.js";

/** [ON CLUSTER c]. */
function parseOnCluster(p: P): boolean {
  return !kw(p, "ON") || parseCluster(p);
}

/** DROP <what> [IF EXISTS] name [ON CLUSTER c], the shape of several DROP statements. */
function parseDropNamed(p: P, what: string): boolean {
  if (!kw(p, "DROP") || !kw(p, what)) return false;
  kw(p, "IF EXISTS");
  return parseIdentifier(p) !== null && parseOnCluster(p);
}

/** ParserNameTypePairList or ParserTypeList inside ARGUMENTS (...). */
function parseFunctionArguments(p: P): boolean {
  if (!tok(p, T.OpeningRoundBracket)) return false;
  if (tok(p, T.ClosingRoundBracket)) return true;
  const arguments_ =
    base(p, "name and type pair list", () => parseList(p, () => parseNameTypePair(p), undefined, false)) ??
    base(p, "type list", () => parseList(p, () => parseDataType(p), undefined, false));
  return arguments_ !== null && tok(p, T.ClosingRoundBracket);
}

/** ARGUMENTS (...) RETURNS Type ENGINE = name(key = value, ...) AS 'code' of a function with a driver. */
function parseFunctionWithDriver(p: P): boolean | null {
  const saved = p.i;
  let consumed = false;
  if (kw(p, "ARGUMENTS")) {
    if (!parseFunctionArguments(p)) return false;
    consumed = true;
  }
  if (kw(p, "RETURNS")) {
    if (!parseDataType(p)) return false;
    consumed = true;
  }
  if (kw(p, "ENGINE")) {
    tok(p, T.Equals);
    if (!parseIdentifier(p)) return false;
    if (tok(p, T.OpeningRoundBracket) && !tok(p, T.ClosingRoundBracket)) {
      do {
        if (!parseIdentifier(p)) return false;
        if (!tok(p, T.Equals)) return false;
        if (!parseLiteral(p)) return false;
      } while (tok(p, T.Comma));
      if (!tok(p, T.ClosingRoundBracket)) return false;
    }
    return kw(p, "AS") && parseStringLiteral(p) !== null;
  }
  if (consumed) return false;
  p.restore(saved);
  return null;
}

/** The clauses of CREATE FUNCTION f LANGUAGE WASM, in any order, then SETTINGS. */
function parseWasmFunction(p: P): boolean {
  const language = parseIdentifier(p);
  if (!language || language.name !== "WASM") return false;
  const pending = new Set(["ABI", "ARGUMENTS", "RETURNS", "FROM", "SHA256_HASH", "DETERMINISTIC"]);
  const clause = (keyword: string): boolean => pending.has(keyword) && kw(p, keyword) && pending.delete(keyword);
  for (;;) {
    if (clause("ABI")) {
      if (!parseIdentifier(p)) return false;
    } else if (clause("ARGUMENTS")) {
      if (!parseFunctionArguments(p)) return false;
    } else if (clause("RETURNS")) {
      if (!parseDataType(p)) return false;
    } else if (clause("FROM")) {
      if (!parseStringLiteral(p)) return false;
      if (tok(p, T.DoubleColon) && !parseStringLiteral(p)) return false;
    } else if (clause("SHA256_HASH")) {
      if (!parseStringLiteral(p)) return false;
    } else if (!clause("DETERMINISTIC")) {
      break;
    }
  }
  // ARGUMENTS, RETURNS and FROM are required: a missing one is what the parser expects next.
  for (const required of ["ARGUMENTS", "RETURNS", "FROM"]) if (pending.has(required)) return kw(p, required);
  if (kw(p, "SETTINGS")) return parseNameValuePairs(p);
  return true;
}

/** ParserCreateFunctionQuery: AS lambda, a function with a driver, or LANGUAGE WASM. */
export function parseCreateFunctionQuery(p: P): Ast | null {
  return base(p, "CREATE FUNCTION query", () => {
    let attach = false;
    if (!kw(p, "CREATE")) {
      if (!kw(p, "ATTACH")) return null;
      attach = true;
    }
    const replace = kw(p, "OR REPLACE");
    if (!kw(p, "FUNCTION")) return null;
    if (!replace) kw(p, "IF NOT EXISTS");
    if (!parseIdentifier(p)) return null;
    if (!parseOnCluster(p)) return null;
    const driver = parseFunctionWithDriver(p);
    if (driver !== null) return driver ? new Ast("CreateFunctionQuery") : null;
    if (attach) return null;
    if (kw(p, "AS")) return parseExpression(p) ? new Ast("CreateFunctionQuery") : null;
    if (kw(p, "LANGUAGE")) return parseWasmFunction(p) ? new Ast("CreateFunctionQuery") : null;
    return null;
  });
}

/** ParserDropFunctionQuery. */
export function parseDropFunctionQuery(p: P): Ast | null {
  return base(p, "DROP FUNCTION query", () => (parseDropNamed(p, "FUNCTION") ? new Ast("DropFunctionQuery") : null));
}

/** name = literal [FOR resource] in the SETTINGS of a workload. */
function parseWorkloadSetting(p: P): boolean {
  if (!parseIdentifier(p)) return false;
  if (!tok(p, T.Equals)) return false;
  if (!parseLiteral(p)) return false;
  return !kw(p, "FOR") || parseIdentifier(p) !== null;
}

/** ParserCreateWorkloadQuery: CREATE [OR REPLACE] WORKLOAD [IF NOT EXISTS] w [ON CLUSTER c] [IN parent] [SETTINGS ...]. */
export function parseCreateWorkloadQuery(p: P): Ast | null {
  return base(p, "CREATE WORKLOAD query", () => {
    if (!kw(p, "CREATE")) return null;
    const replace = kw(p, "OR REPLACE");
    if (!kw(p, "WORKLOAD")) return null;
    if (!replace) kw(p, "IF NOT EXISTS");
    if (!parseIdentifier(p)) return null;
    if (!parseOnCluster(p)) return null;
    if (kw(p, "IN") && !parseIdentifier(p)) return null;
    attempt(p, () => kw(p, "SETTINGS") && listUtil(p, () => parseWorkloadSetting(p), undefined, false));
    return new Ast("CreateWorkloadQuery");
  });
}

/** ParserDropWorkloadQuery. */
export function parseDropWorkloadQuery(p: P): Ast | null {
  return base(p, "DROP WORKLOAD query", () => (parseDropNamed(p, "WORKLOAD") ? new Ast("DropWorkloadQuery") : null));
}

/** One operation of CREATE RESOURCE and its cost unit: WRITE DISK d, READ ANY DISK, MASTER THREAD, ... */
function parseResourceOperation(p: P): string | null {
  if (kw(p, "WRITE") || kw(p, "READ")) {
    if (kw(p, "ANY")) return kw(p, "DISK") ? "io" : null;
    return kw(p, "DISK") && parseIdentifier(p) ? "io" : null;
  }
  if (kw(p, "MASTER THREAD") || kw(p, "WORKER THREAD")) return "cpu";
  if (kw(p, "QUERY")) return "query";
  if (kw(p, "MEMORY RESERVATION")) return "memory";
  return null;
}

/** ParserCreateResourceQuery: CREATE [OR REPLACE] RESOURCE [IF NOT EXISTS] r [ON CLUSTER c] (operations). */
export function parseCreateResourceQuery(p: P): Ast | null {
  return base(p, "CREATE RESOURCE query", () => {
    if (!kw(p, "CREATE")) return null;
    const replace = kw(p, "OR REPLACE");
    if (!kw(p, "RESOURCE")) return null;
    if (!replace) kw(p, "IF NOT EXISTS");
    if (!parseIdentifier(p)) return null;
    if (!parseOnCluster(p)) return null;
    const operations = attempt(p, () => {
      if (!tok(p, T.OpeningRoundBracket)) return false;
      let unit = "";
      const operation = () => {
        const current = parseResourceOperation(p);
        if (!current) return false;
        if (unit && unit !== current) p.failOther("Resource definition could not mix CPU and IO operations.");
        unit = current;
        return true;
      };
      return listUtil(p, operation, undefined, false) && tok(p, T.ClosingRoundBracket);
    });
    return operations ? new Ast("CreateResourceQuery") : null;
  });
}

/** ParserDropResourceQuery. */
export function parseDropResourceQuery(p: P): Ast | null {
  return base(p, "DROP RESOURCE query", () => (parseDropNamed(p, "RESOURCE") ? new Ast("DropResourceQuery") : null));
}

/** ParserDropNamedCollectionQuery. */
export function parseDropNamedCollectionQuery(p: P): Ast | null {
  return base(p, "DROP NAMED COLLECTION query", () =>
    parseDropNamed(p, "NAMED COLLECTION") ? new Ast("DropNamedCollectionQuery") : null,
  );
}

/** ParserAlterNamedCollectionQuery: ALTER NAMED COLLECTION n [ON CLUSTER c] [SET k = v [[NOT] OVERRIDABLE], ...] [DELETE k, ...]. */
export function parseAlterNamedCollectionQuery(p: P): Ast | null {
  return base(p, "Alter NAMED COLLECTION query", () => {
    if (!kw(p, "ALTER") || !kw(p, "NAMED COLLECTION")) return null;
    kw(p, "IF EXISTS");
    if (!parseIdentifier(p)) return null;
    if (!parseOnCluster(p)) return null;
    if (kw(p, "SET")) {
      let count = 0;
      for (;;) {
        if (count && !tokQuiet(p, T.Comma)) break;
        if (!parseNameValuePair(p)) return null;
        if (!kw(p, "NOT OVERRIDABLE")) kw(p, "OVERRIDABLE");
        count++;
      }
    }
    if (kw(p, "DELETE")) {
      let count = 0;
      for (;;) {
        if (count && !tokQuiet(p, T.Comma)) break;
        if (!parseIdentifier(p)) return null;
        count++;
      }
    }
    return new Ast("AlterNamedCollectionQuery");
  });
}

const HANDLER_METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);

/** ParserCreateHandlerQuery: CREATE|ALTER HANDLER name [PROTOCOL p|ANY] URL [PREFIX|REGEXP] 'path' [METHODS (...)] [TYPE t] [AS query]. */
export function parseCreateHandlerQuery(p: P): Ast | null {
  return base(p, "CREATE HANDLER query", () => {
    let alter = false;
    if (!kw(p, "CREATE")) {
      if (!kw(p, "ALTER")) return null;
      alter = true;
    }
    if (!kw(p, "HANDLER")) return null;
    if (!alter) kw(p, "IF NOT EXISTS");
    if (!parseIdentifier(p)) return null;
    if (!parseOnCluster(p)) return null;
    if (kw(p, "PROTOCOL") && !kw(p, "ANY") && !parseIdentifier(p)) return null;
    let url = false;
    if (kw(p, "URL")) {
      if (!kw(p, "PREFIX")) kw(p, "REGEXP");
      if (!parseStringLiteral(p)) return null;
      url = true;
    }
    if (kw(p, "METHODS")) {
      if (!tok(p, T.OpeningRoundBracket)) return null;
      do {
        const method = parseIdentifier(p);
        if (!method || !HANDLER_METHODS.has(method.name.toUpperCase())) return null;
      } while (tok(p, T.Comma));
      if (!tok(p, T.ClosingRoundBracket)) return null;
    }
    if (kw(p, "TYPE") && !parseIdentifier(p)) return null;
    if (kw(p, "AS") && !parseQuery(p)) {
      if (!tok(p, T.OpeningRoundBracket)) return null;
      if (!parseQuery(p)) return null;
      if (!tok(p, T.ClosingRoundBracket)) return null;
    }
    if (!alter && !url) return null;
    return new Ast("CreateHandlerQuery");
  });
}

/** ParserDropHandlerQuery. */
export function parseDropHandlerQuery(p: P): Ast | null {
  return base(p, "DROP HANDLER query", () => (parseDropNamed(p, "HANDLER") ? new Ast("DropHandlerQuery") : null));
}

/** ParserCreateIndexDeclaration: (expr [ASC|DESC], ...) or expr, then [TYPE type(args)] [GRANULARITY n]. */
function parseCreateIndexDeclaration(p: P): Ast | null {
  return base(p, "index declaration in create index", () => {
    if (tok(p, T.OpeningRoundBracket)) {
      if (!parseOrderByExpressionList(p)) return null;
      if (!tok(p, T.ClosingRoundBracket)) return null;
    } else if (!parseExpression(p)) {
      return null;
    }
    if (kw(p, "TYPE") && !parseExpressionWithOptionalArguments(p)) return null;
    if (kw(p, "GRANULARITY") && !parseUnsignedInteger(p)) return null;
    return new Ast("IndexDeclaration");
  });
}

/** ParserCreateIndexQuery: CREATE [UNIQUE] INDEX [IF NOT EXISTS] name ON [db.]table [ON CLUSTER c] declaration. */
export function parseCreateIndexQuery(p: P): Ast | null {
  return base(p, "CREATE INDEX query", () => {
    if (!kw(p, "CREATE")) return null;
    kw(p, "UNIQUE");
    if (!kw(p, "INDEX")) return null;
    kw(p, "IF NOT EXISTS");
    if (!parseIdentifier(p)) return null;
    if (!kw(p, "ON")) return null;
    if (!parseDatabaseAndTableAsAST(p)) return null;
    if (!parseOnCluster(p)) return null;
    return parseCreateIndexDeclaration(p) ? new Ast("CreateIndexQuery") : null;
  });
}

/** ParserDropIndexQuery: DROP INDEX [IF EXISTS] name ON [db.]table [ON CLUSTER c]. */
export function parseDropIndexQuery(p: P): Ast | null {
  return base(p, "DROP INDEX query", () => {
    if (!kw(p, "DROP") || !kw(p, "INDEX")) return null;
    kw(p, "IF EXISTS");
    if (!parseIdentifier(p)) return null;
    if (!kw(p, "ON")) return null;
    if (!parseDatabaseAndTableAsAST(p)) return null;
    return parseOnCluster(p) ? new Ast("DropIndexQuery") : null;
  });
}

/** ParserHypotheticalObjectQuery: CREATE|DROP HYPOTHETICAL INDEX|PROJECTION ..., DROP ALL HYPOTHETICAL INDEXES|PROJECTIONS. */
export function parseHypotheticalObjectQuery(p: P): Ast | null {
  return base(p, "HYPOTHETICAL INDEX query", () => {
    const node = new Ast("HypotheticalObjectQuery");
    if (kw(p, "CREATE")) {
      if (!kw(p, "HYPOTHETICAL")) return null;
      let projection = false;
      if (kw(p, "PROJECTION")) projection = true;
      else if (!kw(p, "INDEX")) return null;
      kw(p, "IF NOT EXISTS");
      if (!parseIdentifier(p)) return null;
      if (!kw(p, "ON")) return null;
      if (!parseDatabaseAndTableAsAST(p)) return null;
      if (projection) return parseProjectionDeclarationBody(p) ? node : null;
      return parseCreateIndexDeclaration(p) ? node : null;
    }
    if (!kw(p, "DROP")) return null;
    if (kw(p, "ALL")) {
      if (!kw(p, "HYPOTHETICAL")) return null;
      return kw(p, "INDEXES") || kw(p, "PROJECTIONS") ? node : null;
    }
    if (!kw(p, "HYPOTHETICAL")) return null;
    if (!kw(p, "INDEX") && !kw(p, "PROJECTION")) return null;
    kw(p, "IF EXISTS");
    if (!parseIdentifier(p)) return null;
    if (!kw(p, "ON")) return null;
    return parseDatabaseAndTableAsAST(p) ? node : null;
  });
}

/**
 * ParserCopyQuery::parseOptions: the target, then options that are never a syntax error.
 * An unsupported target makes the query run to the end of the input.
 */
function parseCopyOptions(p: P, copyTo: boolean): boolean {
  let target = "";
  if (p.kind() === T.StringLiteral) {
    p.i++;
  } else {
    const name = parseIdentifier(p);
    if (!name) return false;
    target = name.name.toLowerCase();
  }
  if (target !== (copyTo ? "stdout" : "stdin")) {
    while (!p.isEnd()) p.i++;
    return true;
  }
  // The options are read word by word; only FORMAT without a name stops before the end.
  let pending = "";
  let depth = 0;
  while (!p.isEnd() && p.kind() !== T.Semicolon) {
    const kind = p.kind();
    if (kind === T.BareWord) {
      const word = p.lower();
      const next = p.toks[p.i + 1];
      const escapePrefix = word === "e" && next?.kind === T.StringLiteral && next.start === p.tok().end;
      const truthWord = ["true", "on", "false", "off"].includes(word);
      if (["delimiter", "null", "quote"].includes(pending) && !escapePrefix && word !== "as") {
        pending = "";
      } else if (pending === "header" && depth > 0 && !truthWord) {
        pending = "";
      } else if (word === "format") {
        p.i++;
        if (p.isEnd() || p.kind() !== T.BareWord) return true;
        pending = "";
      } else if (["delimiter", "null", "quote", "header"].includes(word)) {
        pending = word;
      } else if (!escapePrefix && word !== "with" && word !== "as") {
        pending = "";
      }
    } else if (kind === T.StringLiteral || kind === T.Number) {
      pending = "";
    } else if (kind === T.OpeningRoundBracket) {
      depth++;
    } else if (kind === T.ClosingRoundBracket && depth > 0) {
      depth--;
    }
    p.i++;
  }
  return true;
}

/** ParserCopyQuery: COPY table [(columns)] TO|FROM target, or COPY (query) TO target. */
export function parseCopyQuery(p: P): Ast | null {
  return base(p, "COPY query", () => {
    if (!kw(p, "COPY")) return null;
    const saved = p.i;
    if (!tok(p, T.OpeningRoundBracket)) {
      if (!parseCompoundIdentifier(p)) return null;
      if (tok(p, T.OpeningRoundBracket)) {
        if (!parseList(p, () => parseIdentifier(p), undefined, false)) return null;
        if (!tok(p, T.ClosingRoundBracket)) return null;
      }
      if (kw(p, "TO")) return parseCopyOptions(p, true) ? new Ast("CopyQuery") : null;
      if (kw(p, "FROM")) return parseCopyOptions(p, false) ? new Ast("CopyQuery") : null;
      return null;
    }
    p.restore(saved);
    const source = parseIdentifier(p) ?? parseExpressionWithOptionalAlias(p, false);
    if (!source || source.alias) return null;
    if (!kw(p, "TO")) return null;
    return parseCopyOptions(p, true) ? new Ast("CopyQuery") : null;
  });
}
