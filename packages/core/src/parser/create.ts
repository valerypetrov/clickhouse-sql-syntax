/**
 * CREATE and ATTACH of tables, databases, views, dictionaries and named collections: a port of
 * ParserCreateQuery.cpp, ParserDictionary.cpp, ParserDictionaryAttributeDeclaration.cpp,
 * ParserViewTargets.cpp, ParserRefreshStrategy.cpp and ParserProjectionSelectQuery.cpp.
 */
import { parseUserNameWithHost } from "./access.js";
import { Ast, canHaveAlias, func, keep, list, stringValue } from "./ast.js";
import { intervalSeconds, parseCluster, parseTimeInterval } from "./common.js";
import { parseDataType } from "./datatype.js";
import {
  parseArrayOfLiterals,
  parseCodec,
  parseCollation,
  parseCompoundIdentifier,
  parseFunctionWithKeyValueArguments,
  parseIdentifier,
  parseIdentifierWithOptionalParameters,
  parseList,
  parseLiteral,
  parseStatisticsType,
  parseStorageOrderByElement,
  parseStringLiteral,
  parseUnsignedInteger,
} from "./elements.js";
import {
  parseAliasesExpressionList,
  parseExpression,
  parseExpressionWithOptionalAlias,
  parseExpressionWithOptionalArguments,
  parseFunction,
  parseKeyValuePairsList,
  parseNotEmptyExpressionList,
  parseStorageOrderByExpressionList,
  parseTTLExpressionList,
} from "./expression.js";
import { parseSelectWithUnionQuery } from "./select.js";
import { parseNameValuePairs, parseSetQuery } from "./set.js";
import { base, kw, listUtil, P, peekKw, T, tok } from "./state.js";

const UUID_TEXT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;
const NIL_UUID = /^0{8}-?0{4}-?0{4}-?0{4}-?0{12}$/;

/** parseFromString<UUID> of a string literal; a bad value is not a syntax error. */
function uuidOf(p: P, literal: Ast, at: number): string {
  const text = stringValue(literal) ?? "";
  if (!UUID_TEXT.test(text)) p.failOther(`Cannot parse uuid ${text}`, at);
  return text;
}

/** The UUID of TO INNER UUID, which must be one and not the Nil UUID. */
function rejectNilInnerUuid(p: P, uuid: { literal: Ast; at: number }): void {
  if (NIL_UUID.test(uuidOf(p, uuid.literal, uuid.at))) p.failOther("TO INNER UUID cannot use a Nil UUID", uuid.at);
}

function rejectNilUuid(p: P, attach: boolean, table: Ast): void {
  const uuid = table.get("uuid");
  if (attach && uuid && NIL_UUID.test(stringValue(uuid) ?? "")) p.failOther("ATTACH queries cannot use a Nil UUID");
}

/** parseComment: COMMENT 'text', or nothing; COMMENT without a string is left unread. */
function parseComment(p: P): boolean {
  const begin = p.i;
  if (!kw(p, "COMMENT")) return false;
  if (parseStringLiteral(p)) return true;
  p.restore(begin);
  return false;
}

/** ParserSQLSecurity: DEFINER = user and SQL SECURITY DEFINER|INVOKER|NONE, in either order. */
export function parseSQLSecurity(p: P): Ast | null {
  return base(p, "sql security", () => {
    let definer = false;
    let type = "";
    for (;;) {
      if (!definer && kw(p, "DEFINER")) {
        tok(p, T.Equals);
        if (!kw(p, "CURRENT_USER") && !parseUserNameWithHost(p, false)) return null;
        definer = true;
        continue;
      }
      if (!type && kw(p, "SQL SECURITY")) {
        if (kw(p, "DEFINER")) type = "DEFINER";
        else if (kw(p, "INVOKER")) type = "INVOKER";
        else if (kw(p, "NONE")) type = "NONE";
        else return null;
        continue;
      }
      break;
    }
    if (!type && !definer) return null;
    return new Ast("SQLSecurity");
  });
}

export interface ColumnOptions {
  requireType?: boolean;
  allowNullModifiers?: boolean;
  checkKeywordsAfterName?: boolean;
  /** ParserCompoundColumnDeclaration: the name may be a.b. */
  compoundName?: boolean;
  /** enableCheckTypeKeyword: the type follows TYPE. */
  checkTypeKeyword?: boolean;
}

/** IParserColumnDeclaration: name [Type] [NULL] [DEFAULT|MATERIALIZED|ALIAS|EPHEMERAL expr] [modifiers]. */
export function parseColumnDeclaration(p: P, options: ColumnOptions = {}): Ast | null {
  const requireType = options.requireType ?? true;
  const allowNull = options.allowNullModifiers ?? false;
  return base(p, "column declaration", () => {
    const name = options.compoundName ? parseCompoundIdentifier(p) : parseIdentifier(p);
    if (!name) return null;
    const node = new Ast("ColumnDeclaration");
    node.name = name.name;

    if (
      !requireType &&
      (peekKw(p, "REMOVE") || peekKw(p, "MODIFY SETTING") || peekKw(p, "RESET SETTING") || peekKw(p, "ADD ENUM VALUES"))
    ) {
      return options.checkKeywordsAfterName ? node : null;
    }

    let type: Ast | null = null;
    let nullModifier: boolean | undefined;
    let defaultExpression: Ast | null = null;
    let collation = false;
    const nullFollows = (): boolean => {
      if (!allowNull) return false;
      if (peekKw(p, "NULL")) return true;
      const before = p.i;
      const result = kw(p, "NOT") && peekKw(p, "NULL");
      p.restore(before);
      return result;
    };
    if (
      !nullFollows() &&
      !peekKw(p, "DEFAULT") &&
      !peekKw(p, "MATERIALIZED") &&
      !peekKw(p, "EPHEMERAL") &&
      !peekKw(p, "ALIAS") &&
      !peekKw(p, "AUTO_INCREMENT") &&
      !peekKw(p, "TTL") &&
      !peekKw(p, "PRIMARY KEY") &&
      (requireType ||
        (!peekKw(p, "COMMENT") && !peekKw(p, "CODEC") && !peekKw(p, "STATISTICS") && !peekKw(p, "SETTINGS")))
    ) {
      if (options.checkTypeKeyword && !kw(p, "TYPE")) return null;
      type = parseDataType(p);
      if (!type) return null;
      if (kw(p, "COLLATE")) {
        if (!parseCollation(p)) return null;
        collation = true;
      }
    }

    const parseNullModifier = (): boolean => {
      if (kw(p, "NOT")) {
        if (!kw(p, "NULL")) return false;
        nullModifier = false;
      } else if (kw(p, "NULL")) {
        nullModifier = true;
      }
      return true;
    };
    if (allowNull && !parseNullModifier()) return null;

    let isComment = false;
    if (!collation && kw(p, "COLLATE")) {
      if (!parseCollation(p)) return null;
      collation = true;
    }
    let defaultSpecifier = true;
    if (kw(p, "DEFAULT") || kw(p, "MATERIALIZED") || kw(p, "ALIAS")) {
      defaultExpression = parseExpression(p);
      if (!defaultExpression) return null;
    } else if (kw(p, "EPHEMERAL")) {
      if (kw(p, "COMMENT")) isComment = true;
      if (!isComment) defaultExpression = parseExpression(p);
      if (!defaultExpression && type) defaultExpression = func("defaultValueOfTypeName");
      if (!defaultExpression && !type) return null;
    } else if (kw(p, "AUTO_INCREMENT")) {
      type ??= new Ast("DataType");
    } else {
      defaultSpecifier = false;
    }
    if (defaultExpression && !canHaveAlias(defaultExpression)) return null;
    if (requireType && !type && !defaultExpression) return null;

    if (!isComment && (type || defaultExpression) && allowNull && nullModifier === undefined) {
      if (!parseNullModifier()) return null;
    }
    let comment = false;
    if (isComment) {
      if (!parseStringLiteral(p)) return null;
      comment = true;
    }

    // The remaining modifiers come in any order, each at most once.
    let codec: Ast | null = null;
    let statistics: Ast | null = null;
    let ttl: Ast | null = null;
    let primaryKey = false;
    let settings = false;
    for (;;) {
      if (!comment && kw(p, "COMMENT")) {
        if (!parseStringLiteral(p)) return null;
        comment = true;
      } else if (!codec && kw(p, "CODEC")) {
        codec = parseCodec(p);
        if (!codec) return null;
      } else if (!statistics && kw(p, "STATISTICS")) {
        statistics = parseStatisticsType(p);
        if (!statistics) return null;
      } else if (!ttl && kw(p, "TTL")) {
        ttl = parseExpression(p);
        if (!ttl) return null;
      } else if (!collation && kw(p, "COLLATE")) {
        if (!parseCollation(p)) return null;
        collation = true;
      } else if (!primaryKey && kw(p, "PRIMARY KEY")) {
        primaryKey = true;
      } else if (!settings && peekKw(p, "SETTINGS")) {
        const before = p.i;
        kw(p, "SETTINGS");
        if (!tok(p, T.OpeningRoundBracket)) {
          p.restore(before);
          break;
        }
        if (!parseSetQuery(p, true, false)) return null;
        if (!tok(p, T.ClosingRoundBracket)) return null;
        settings = true;
      } else {
        break;
      }
    }
    if (type) node.set("type", type);
    if (defaultExpression) node.set("default", defaultExpression);
    node.set("codec", codec).set("statistics", statistics).set("ttl", ttl);
    if (defaultSpecifier) node.flag("default_specifier");
    if (nullModifier !== undefined) node.flag("null_modifier");
    // Like ASTColumnDeclaration::hasChildren(): any part besides the name and the flags.
    if (type || defaultExpression || comment || codec || statistics || ttl || settings || collation) node.flag("children");
    if (comment) node.flag("comment");
    if (codec) node.flag("codec");
    if (statistics) node.flag("statistics");
    if (ttl) node.flag("ttl");
    if (settings) node.flag("settings");
    if (primaryKey) node.flag("primary_key");
    return node;
  });
}

/** ParserColumnDeclarationList. */
export function parseColumnDeclarationList(p: P, options: ColumnOptions = { allowNullModifiers: true }): Ast | null {
  return base(p, "column declaration list", () =>
    parseList(p, () => parseColumnDeclaration(p, options), undefined, false),
  );
}

/** ParserNameList: a list of [db.]table names. */
export function parseNameList(p: P): Ast | null {
  return base(p, "name list", () => parseList(p, () => parseCompoundIdentifier(p, true, true), undefined, false));
}

const CODEC_FAMILIES = new Set(
  [
    "Default", "NONE", "Multiple", "LZ4", "LZ4HC", "ZSTD", "ZSTD_QAT", "DEFLATE_QPL", "ZXC", "GDeflate", "Delta",
    "DoubleDelta", "Gorilla", "FPC", "T64", "GCD", "ALP", "PCO", "SZ3", "Quantized", "AES_128_GCM_SIV",
    "AES_256_GCM_SIV",
  ].map((name) => name.toLowerCase()),
);

/** isCompressionCodec: CODEC(...) made of known codec names only. */
function isCompressionCodec(codec: Ast): boolean {
  return (
    codec.children.length > 0 &&
    codec.children.every((element) => element.kind === "Function" && CODEC_FAMILIES.has(element.name.toLowerCase()))
  );
}

/** ParserCodecDeclaration: CODEC column (codecs); `codec Nullable(String)` is a column instead. */
function parseCodecDeclaration(p: P): Ast | null {
  return base(p, "codec declaration", () => {
    if (!kw(p, "CODEC")) return null;
    const name = parseCompoundIdentifier(p);
    if (!name) return null;
    const codec = parseCodec(p);
    if (!codec) return null;
    if (!name.name.includes(".") && !isCompressionCodec(codec)) return null;
    return new Ast("CodecDeclaration").set("codec", codec);
  });
}

/** ParserIndexDeclaration: name expr TYPE type(args) [GRANULARITY n]. */
export function parseIndexDeclaration(p: P): Ast | null {
  return base(p, "index declaration", () => {
    if (!parseIdentifier(p)) return null;
    const expr = parseExpression(p);
    if (!expr) return null;
    if (!kw(p, "TYPE")) return null;
    const type = parseExpressionWithOptionalArguments(p);
    if (!type) return null;
    if (kw(p, "GRANULARITY") && !parseUnsignedInteger(p)) return null;
    return new Ast("IndexDeclaration").set("expr", expr).set("type", type);
  });
}

/** ParserStatisticsDeclaration: columns TYPE types. */
export function parseStatisticsDeclaration(p: P): Ast | null {
  return base(p, "statistics declaration", () => {
    if (!parseList(p, () => parseIdentifier(p), undefined, false)) return null;
    if (!kw(p, "TYPE")) return null;
    const types = parseList(p, () => parseExpressionWithOptionalArguments(p), undefined, false);
    if (!types) return null;
    return new Ast("StatisticsDeclaration").set("types", types);
  });
}

/** ParserStatisticsDeclarationWithoutTypes: columns. */
export function parseStatisticsDeclarationWithoutTypes(p: P): Ast | null {
  return base(p, "statistics declaration", () =>
    parseList(p, () => parseIdentifier(p), undefined, false) ? new Ast("StatisticsDeclaration") : null,
  );
}

/** ParserConstraintDeclaration: name CHECK|ASSUME expr. */
export function parseConstraintDeclaration(p: P): Ast | null {
  return base(p, "constraint declaration", () => {
    if (!parseIdentifier(p)) return null;
    if (!kw(p, "CHECK") && !kw(p, "ASSUME")) return null;
    const expr = parseExpression(p);
    return expr ? new Ast("ConstraintDeclaration").set("expr", expr) : null;
  });
}

/** ParserProjectionSelectQuery: [WITH ...] SELECT ... [WHERE ...] [GROUP BY ...] [ORDER BY ...]. */
function parseProjectionSelectQuery(p: P): Ast | null {
  return base(p, "PROJECTION SELECT query", () => {
    const node = new Ast("ProjectionSelectQuery");
    if (kw(p, "WITH") && !keep(node, "with", parseNotEmptyExpressionList(p, false))) return null;
    if (!kw(p, "SELECT")) return null;
    if (!keep(node, "select", parseNotEmptyExpressionList(p, true))) return null;
    if (kw(p, "WHERE") && !keep(node, "where", parseExpressionWithOptionalAlias(p, false))) return null;
    if (kw(p, "GROUP BY") && !keep(node, "group_by", parseList(p, () => parseExpression(p)))) return null;
    if (kw(p, "ORDER BY")) {
      const keys = parseStorageOrderByExpressionList(p, false);
      if (!keys) return null;
      // One key is the ORDER BY itself, more are a tuple of them.
      node.set("order_by", keys.children.length === 1 ? keys.children[0]! : func("tuple", keys.children));
    }
    return node;
  });
}

/** parseProjectionDeclarationBody: (SELECT ...) or INDEX exprs TYPE type, then [WITH SETTINGS (...)]. */
export function parseProjectionDeclarationBody(p: P, node: Ast): boolean {
  if (tok(p, T.OpeningRoundBracket)) {
    if (!keep(node, "query", parseProjectionSelectQuery(p))) return false;
    if (!tok(p, T.ClosingRoundBracket)) return false;
  } else if (kw(p, "INDEX")) {
    if (!keep(node, "index", parseNotEmptyExpressionList(p, false))) return false;
    if (!kw(p, "TYPE")) return false;
    if (!keep(node, "type", parseExpressionWithOptionalArguments(p))) return false;
  } else {
    return false;
  }
  if (kw(p, "WITH SETTINGS")) {
    if (!tok(p, T.OpeningRoundBracket)) return false;
    if (!parseSetQuery(p, true)) return false;
    if (!tok(p, T.ClosingRoundBracket)) return false;
  }
  return true;
}

/** ParserProjectionDeclaration: name (SELECT ...). */
export function parseProjectionDeclaration(p: P): Ast | null {
  return base(p, "projection declaration", () => {
    if (!parseIdentifier(p)) return null;
    const node = new Ast("ProjectionDeclaration");
    return parseProjectionDeclarationBody(p, node) ? node : null;
  });
}

/** ParserForeignKeyDeclaration: (cols) REFERENCES t (cols) [ON DELETE|UPDATE action]..., which is ignored. */
function parseForeignKeyDeclaration(p: P): Ast | null {
  return base(p, "foreign key declaration", () => {
    if (!parseExpression(p)) return null;
    if (!kw(p, "REFERENCES")) return null;
    if (!parseCompoundIdentifier(p, true, true)) return null;
    if (!parseExpression(p)) return null;
    while (kw(p, "ON")) {
      if (!kw(p, "DELETE") && !kw(p, "UPDATE")) return null;
      if (!kw(p, "RESTRICT") && !kw(p, "CASCADE") && !kw(p, "SET NULL") && !kw(p, "NO ACTION") && !kw(p, "SET DEFAULT"))
        return null;
    }
    return new Ast("ForeignKeyDeclaration");
  });
}

/** ParserTablePropertyDeclaration: a column, an INDEX, CONSTRAINT, PROJECTION, PRIMARY KEY, FOREIGN KEY or CODEC. */
function parseTablePropertyDeclaration(p: P): Ast | null {
  return base(p, "table property (column, index, constraint) declaration", () => {
    if (kw(p, "INDEX")) return parseIndexDeclaration(p);
    if (kw(p, "CONSTRAINT")) return parseConstraintDeclaration(p);
    if (kw(p, "PROJECTION")) return parseProjectionDeclaration(p);
    if (kw(p, "PRIMARY KEY")) {
      const key = parseExpression(p);
      return key ? new Ast("PrimaryKey").set("key", key) : null;
    }
    if (kw(p, "FOREIGN KEY")) return parseForeignKeyDeclaration(p);
    return parseCodecDeclaration(p) ?? parseColumnDeclaration(p, { allowNullModifiers: true });
  });
}

/** ParserTablePropertiesDeclarationList: the (...) of CREATE TABLE, sorted into columns, indices and the rest. */
export function parseTablePropertiesDeclarationList(p: P): Ast | null {
  return base(p, "columns or indices declaration list", () => {
    const elements = parseList(p, () => parseTablePropertyDeclaration(p), undefined, false);
    if (!elements) return null;
    const columns = new Ast("Columns");
    const codecs: Ast[] = [];
    const indices: Ast[] = [];
    const constraints: Ast[] = [];
    const projections: Ast[] = [];
    for (const element of elements.children) {
      switch (element.kind) {
        case "ColumnDeclaration":
          if (element.has("primary_key")) columns.flag("primary_key_from_columns");
          columns.children.push(element);
          break;
        case "CodecDeclaration":
          codecs.push(element);
          break;
        case "IndexDeclaration":
          indices.push(element);
          break;
        case "ForeignKeyDeclaration":
          break;
        case "ConstraintDeclaration":
          columns.flag("constraints");
          constraints.push(element);
          break;
        case "ProjectionDeclaration":
          columns.flag("projections");
          projections.push(element);
          break;
        case "PrimaryKey": {
          const key = element.get("key")!;
          if (key.kind !== "Identifier" && key.kind !== "Function") return null;
          if (columns.has("primary_key")) return null;
          columns.flag("primary_key").set("primary_key", key);
          break;
        }
        default:
          return null;
      }
    }
    // The other declarations go to lists of their own, as in ASTColumns.
    for (const [name, declarations] of Object.entries({ codecs, indices, constraints, projections }))
      if (declarations.length) columns.set(name, list(declarations));
    return columns;
  });
}

/** ParserStorageOrderByClause: ORDER BY expr [ASC|DESC], or (a DESC, b). */
function parseStorageOrderByClause(p: P): Ast | null {
  return base(p, "storage order by clause", () => {
    // ClickHouse keeps the ASC|DESC wrapper of a key only when it is DESC.
    const element = parseStorageOrderByElement(p, true);
    if (element) return element.has("desc") ? element : element.children[0]!;
    if (p.kind() === T.BareWord && p.text() === "tuple") p.i++;
    if (!tok(p, T.OpeningRoundBracket)) return null;
    const keys = parseStorageOrderByExpressionList(p, true)?.children ?? [];
    if (!tok(p, T.ClosingRoundBracket)) return null;
    // In a list, the wrappers go only when no key is DESC.
    return func("tuple", keys.some((key) => key.has("desc")) ? keys : keys.map((key) => key.children[0]!));
  });
}

/** ParserStorage: [ENGINE = name(args)] [PARTITION BY ...] [PRIMARY KEY ...] [ORDER BY ...] ... [SETTINGS ...]. */
export function parseStorage(p: P): Ast | null {
  return base(p, "storage definition", () => {
    const node = new Ast("Storage");
    let storageLike = false;
    if (kw(p, "ENGINE")) {
      tok(p, T.Equals);
      const name = p.i;
      const engine = parseIdentifierWithOptionalParameters(p);
      if (!engine) return null;
      p.mark(name, "engine", name + 1);
      node.set("engine", engine);
      storageLike = true;
    }
    const clauses: [string, string, () => Ast | null][] = [
      ["partition_by", "PARTITION BY", () => parseExpression(p)],
      ["primary_key", "PRIMARY KEY", () => parseExpression(p)],
      ["order_by", "ORDER BY", () => parseStorageOrderByClause(p)],
      ["unique_key", "UNIQUE KEY", () => parseExpression(p)],
      ["sample_by", "SAMPLE BY", () => parseExpression(p)],
      ["ttl", "TTL", () => parseTTLExpressionList(p)],
    ];
    loop: for (;;) {
      for (const [field, keyword, parse] of clauses) {
        if (!node.has(field) && kw(p, keyword)) {
          if (!keep(node, field, parse())) return null;
          node.flag(field);
          storageLike = true;
          continue loop;
        }
      }
      if (kw(p, "SETTINGS")) {
        if (!parseSetQuery(p, true)) return null;
        storageLike = true;
      }
      break;
    }
    return storageLike ? node : null;
  });
}

/** One target of ParserViewTargets, such as TAGS INNER UUID '...' or DATA db.table; `node` keeps its parts. */
function parseViewTarget(p: P, keyword: string, targets: Map<string, Set<string>>, kind: string, node: Ast): boolean {
  const current = p.i;
  if (!kw(p, keyword)) return false;
  let target = targets.get(kind);
  if (!target) targets.set(kind, (target = new Set()));
  if (!target.has("uuid") && kw(p, "INNER UUID")) {
    const literal = parseStringLiteral(p);
    if (!literal) {
      p.restore(current);
      return false;
    }
    uuidOf(p, literal, p.i - 1);
    target.add("uuid");
    return true;
  }
  if (!target.has("columns") && kw(p, "INNER COLUMNS")) {
    let columns: Ast | null = null;
    if (tok(p, T.OpeningRoundBracket) && (columns = parseTablePropertiesDeclarationList(p)) && tok(p, T.ClosingRoundBracket)) {
      if (["constraints", "projections", "primary_key", "primary_key_from_columns"].some((flag) => columns!.has(flag)))
        p.failOther("Only columns and indexes are supported in INNER COLUMNS");
      target.add("columns");
      node.set(`${kind}_columns`, columns);
      return true;
    }
    p.restore(current);
    return false;
  }
  if (!target.has("engine")) {
    kw(p, "INNER");
    const storage = parseStorage(p);
    if (storage) {
      target.add("engine");
      node.set(`${kind}_engine`, storage);
      return true;
    }
  }
  if (!target.has("table") && parseCompoundIdentifier(p, true, true)) {
    target.add("table");
    return true;
  }
  p.restore(current);
  return false;
}

/** ParserViewTargets for the inner tables of a TimeSeries table. */
function parseTimeSeriesTargets(p: P): Ast | null {
  return base(p, "ViewTargets", () => {
    const targets = new Map<string, Set<string>>();
    const keywords: [string, string][] = [
      ["samples", "SAMPLES"],
      ["samples", "DATA"],
      ["recent_samples", "RECENT SAMPLES"],
      ["tags", "TAGS"],
      ["time_ranges", "TIME RANGES"],
      ["metric_families", "METRIC FAMILIES"],
      ["metric_families", "METRICS"],
    ];
    const node = new Ast("ViewTargets");
    let parsedAny = false;
    for (;;) {
      let parsed = false;
      for (const [kind, keyword] of keywords) if (parseViewTarget(p, keyword, targets, kind, node)) parsed = true;
      if (!parsed) break;
      parsedAny = true;
    }
    return parsedAny ? node : null;
  });
}

/** ParserCreateTableQuery: CREATE|ATTACH|REPLACE [TEMPORARY] TABLE ... */
export function parseCreateTableQuery(p: P): Ast | null {
  return base(p, "CREATE TABLE or ATTACH TABLE query", () => {
    let attach = false;
    let replace = false;
    if (kw(p, "CREATE")) {
      if (kw(p, "OR REPLACE")) replace = true;
    } else if (kw(p, "ATTACH")) {
      attach = true;
    } else if (kw(p, "REPLACE")) {
      replace = true;
    } else {
      return null;
    }
    const temporary = kw(p, "TEMPORARY");
    if (!kw(p, "TABLE")) return null;
    if (!replace) kw(p, "IF NOT EXISTS");
    const table = parseCompoundIdentifier(p, true, true);
    if (!table) return null;
    let innerUuid: { literal: Ast; at: number } | null = null;
    if (kw(p, "TO INNER UUID")) {
      const at = p.i;
      const literal = parseStringLiteral(p);
      if (!literal) return null;
      innerUuid = { literal, at };
    }
    let fromPath = false;
    if (attach) {
      if (kw(p, "FROM")) {
        if (!parseStringLiteral(p)) return null;
        fromPath = true;
      } else if (kw(p, "AS")) {
        kw(p, "NOT");
        if (!kw(p, "REPLICATED")) return null;
      }
    }
    if (kw(p, "ON") && !parseCluster(p)) return null;
    rejectNilUuid(p, attach, table);

    // ATTACH TABLE t on its own takes the definition from the stored metadata.
    if (attach && !fromPath && (!p.valid() || p.kind() === T.Semicolon)) {
      if (innerUuid)
        p.failOther(
          "ATTACH applies the table definition from stored metadata, so a 'TO INNER UUID' clause " +
            "cannot be specified in the query itself",
        );
      return new Ast("CreateQuery");
    }

    let storage: Ast | null = null;
    let targets: Ast | null = null;
    const parseStorageAndTargets = (): boolean => {
      storage = parseStorage(p);
      if (!storage) return false;
      if (storage.get("engine")?.name === "TimeSeries") targets = parseTimeSeriesTargets(p);
      return true;
    };
    let empty = false;
    let clone = false;
    const parseEmptyOrClone = (): void => {
      if (empty || clone) return;
      if (kw(p, "EMPTY")) empty = true;
      else if (kw(p, "CLONE")) clone = true;
    };

    let columns: Ast | null = null;
    let comment = false;
    let sqlSecurity = false;
    let select: Ast | null = null;
    let asTable = false;
    let asTableFunction: Ast | null = null;
    if (tok(p, T.OpeningRoundBracket)) {
      columns = parseTablePropertiesDeclarationList(p);
      if (!columns) return null;
      tok(p, T.Comma);
      if (!tok(p, T.ClosingRoundBracket)) return null;
      const hasStorage = parseStorageAndTargets();
      parseEmptyOrClone();
      sqlSecurity = parseSQLSecurity(p) !== null;
      comment = parseComment(p);
      parseEmptyOrClone();
      // AS is required after EMPTY or CLONE.
      const hasAs = kw(p, "AS");
      if ((empty || clone) && !hasAs) return null;
      if ((hasStorage || temporary) && hasAs) {
        select = parseSelectWithUnionQuery(p);
        if (!select) return null;
      }
      if (!hasStorage && !temporary && hasAs) {
        asTableFunction = parseFunction(p, true, true);
        if (!asTableFunction) return null;
      }
    } else {
      parseStorageAndTargets();
      parseEmptyOrClone();
      sqlSecurity = parseSQLSecurity(p) !== null;
      comment = parseComment(p);
      parseEmptyOrClone();
      const hasAs = kw(p, "AS");
      if ((empty || clone) && !hasAs) return null;
      if (hasAs) {
        select = parseSelectWithUnionQuery(p);
        if (!select && !storage) asTableFunction = parseFunction(p, true, true);
        if (!select && !asTableFunction) {
          if (!parseIdentifier(p)) return null;
          if (tok(p, T.Dot) && !parseIdentifier(p)) return null;
          asTable = true;
          if (!storage) parseStorageAndTargets();
        }
      }
    }

    if (select || asTable || asTableFunction) {
      const beforeComment = p.i;
      if (parseComment(p) && comment)
        p.fail("Comment for a table cannot be specified both before and after AS; please use only one", beforeComment);
    } else if (!comment) {
      parseComment(p);
    }
    if (sqlSecurity && (asTable || asTableFunction)) return null;

    const columnsPrimaryKey = columns?.has("primary_key") || columns?.has("primary_key_from_columns");
    if (asTableFunction && columnsPrimaryKey)
      p.fail("PRIMARY KEY is not allowed in the column list of a table created from a table function");
    const storageNode = storage as Ast | null;
    let storagePrimaryKey = storageNode?.has("primary_key") ?? false;
    for (const flag of ["primary_key", "primary_key_from_columns"]) {
      if (!columns?.has(flag)) continue;
      if (storagePrimaryKey) p.failOther("Multiple primary keys are not allowed.");
      storagePrimaryKey = true;
    }
    if (innerUuid) {
      const engine = storageNode?.get("engine")?.name;
      if (engine !== "SharedSet" && engine !== "SharedJoin")
        p.failOther(`Storage engine ${engine ?? "(no engine)"} does not support inner UUID`);
      if (targets) p.failOther("targets are already defined");
      rejectNilInnerUuid(p, innerUuid);
    }
    return new Ast("CreateQuery")
      .set("columns", columns)
      .set("storage", storageNode)
      .set("as_table_function", asTableFunction)
      .set("select", select)
      .set("targets", targets);
  });
}

/** ParserTableOverrideDeclaration: TABLE OVERRIDE name (COLUMNS (...) PARTITION BY ... ...). */
export function parseTableOverrideDeclaration(p: P, standalone = true): Ast | null {
  return base(p, "table override declaration", () => {
    if (standalone) {
      if (!kw(p, "TABLE OVERRIDE")) return null;
      if (!parseIdentifier(p)) return null;
      if (!tok(p, T.OpeningRoundBracket)) return null;
    }
    const seen = new Set<string>();
    const clauses: [string, () => Ast | null][] = [
      ["PARTITION BY", () => parseExpression(p)],
      ["PRIMARY KEY", () => parseExpression(p)],
      ["ORDER BY", () => parseExpression(p)],
      ["SAMPLE BY", () => parseExpression(p)],
      ["TTL", () => parseTTLExpressionList(p)],
    ];
    const node = new Ast("TableOverride");
    const storage = new Ast("Storage");
    loop: for (;;) {
      if (!seen.has("COLUMNS") && kw(p, "COLUMNS")) {
        if (!tok(p, T.OpeningRoundBracket)) return null;
        if (!keep(node, "columns", parseTablePropertiesDeclarationList(p))) return null;
        if (!tok(p, T.ClosingRoundBracket)) return null;
        seen.add("COLUMNS");
      }
      for (const [keyword, parse] of clauses) {
        if (!seen.has(keyword) && kw(p, keyword)) {
          if (!keep(storage, keyword, parse())) return null;
          seen.add(keyword);
          continue loop;
        }
      }
      break;
    }
    if (standalone && !tok(p, T.ClosingRoundBracket)) return null;
    return node.set("storage", storage);
  });
}

/** ParserTableOverridesDeclarationList: TABLE OVERRIDE ..., TABLE OVERRIDE ..., possibly none. */
function parseTableOverridesDeclarationList(p: P): Ast | null {
  return base(p, "table overrides declaration list", () => {
    const node = new Ast("TableOverrideList");
    const element = (): boolean => {
      const override = parseTableOverrideDeclaration(p);
      if (override) node.children.push(override);
      return override !== null;
    };
    return listUtil(p, element, undefined, true) ? node : null;
  });
}

/** ParserCreateDatabaseQuery: CREATE|ATTACH DATABASE [IF NOT EXISTS] db [UUID '...'] [ON CLUSTER c] [ENGINE ...]. */
function parseCreateDatabaseQuery(p: P): Ast | null {
  return base(p, "CREATE DATABASE query", () => {
    let attach = false;
    if (!kw(p, "CREATE")) {
      if (!kw(p, "ATTACH")) return null;
      attach = true;
    }
    if (!kw(p, "DATABASE")) return null;
    kw(p, "IF NOT EXISTS");
    if (!parseIdentifier(p, true)) return null;
    let uuid = "";
    if (kw(p, "UUID")) {
      const literal = parseStringLiteral(p);
      if (!literal) return null;
      uuid = uuidOf(p, literal, p.i - 1);
    }
    if (kw(p, "ON") && !parseCluster(p)) return null;
    const storage = parseStorage(p);
    parseComment(p);
    const overrides = parseTableOverridesDeclarationList(p);
    if (!overrides) return null;
    if (attach && uuid && NIL_UUID.test(uuid)) p.failOther("ATTACH queries cannot use a Nil UUID");
    return new Ast("CreateQuery").set("storage", storage).set("table_overrides", overrides);
  });
}

/** ParserRefreshStrategy: AFTER|EVERY interval [OFFSET ...] [RANDOMIZE FOR ...] [DEPENDS ON ...] [SETTINGS ...] [APPEND]. */
export function parseRefreshStrategy(p: P): Ast | null {
  return base(p, "refresh strategy", () => {
    let scheduled = false;
    if (kw(p, "AFTER")) {
      if (!parseTimeInterval(p, true, true)) return null;
      scheduled = true;
    } else if (kw(p, "EVERY")) {
      const period = parseTimeInterval(p, false, false);
      if (!period) return null;
      scheduled = true;
      if (kw(p, "OFFSET")) {
        const offset = parseTimeInterval(p, true, true);
        if (!offset) return null;
        if (intervalSeconds(offset, true) >= intervalSeconds(period, false))
          p.failOther("OFFSET must be less than the period", p.i - 1);
      }
    }
    if (kw(p, "RANDOMIZE FOR") && !parseTimeInterval(p, true, true)) return null;
    let dependencies = false;
    if (kw(p, "DEPENDS ON")) {
      if (!parseList(p, () => parseCompoundIdentifier(p, true, false), undefined, false)) return null;
      dependencies = true;
    }
    if (!scheduled && !dependencies) return null;
    if (kw(p, "SETTINGS") && !parseSetQuery(p, true)) return null;
    if (kw(p, "APPEND")) kw(p, "INCREMENTAL");
    return new Ast("RefreshStrategy");
  });
}

/** ParserCreateViewQuery: CREATE [OR REPLACE] [MATERIALIZED|TEMPORARY] VIEW ... AS SELECT ... */
function parseCreateViewQuery(p: P): Ast | null {
  return base(p, "CREATE VIEW query", () => {
    let attach = false;
    if (!kw(p, "CREATE")) {
      if (!kw(p, "ATTACH")) return null;
      attach = true;
    }
    const replace = kw(p, "OR REPLACE");
    let sqlSecurity = parseSQLSecurity(p) !== null;
    const materialized = kw(p, "MATERIALIZED");
    if (!replace && !materialized) kw(p, "TEMPORARY");
    if (!kw(p, "VIEW")) return null;
    if (!replace) kw(p, "IF NOT EXISTS");
    const table = parseCompoundIdentifier(p, true, true);
    if (!table) return null;
    if (kw(p, "ON") && !parseCluster(p)) return null;
    let refresh = false;
    if (kw(p, "REFRESH")) {
      if (!materialized) return null;
      if (!parseRefreshStrategy(p)) return null;
      refresh = true;
    }
    let toTable = false;
    let innerUuid: { literal: Ast; at: number } | null = null;
    if (materialized && kw(p, "TO INNER UUID")) {
      const at = p.i;
      const literal = parseStringLiteral(p);
      if (!literal) return null;
      innerUuid = { literal, at };
    } else if (materialized && kw(p, "TO")) {
      if (!parseCompoundIdentifier(p, true, true)) return null;
      toTable = true;
    }

    let columns: Ast | null = null;
    if (tok(p, T.OpeningRoundBracket)) {
      let aliases = false;
      columns = parseTablePropertiesDeclarationList(p);
      if (!columns) {
        if (!parseAliasesExpressionList(p)) return null;
        aliases = true;
      } else {
        if (!tok(p, T.ClosingRoundBracket)) return null;
        if (tok(p, T.OpeningRoundBracket)) {
          aliases = true;
          if (!parseAliasesExpressionList(p)) return null;
        }
      }
      if (aliases && !tok(p, T.ClosingRoundBracket)) return null;
    }

    let populate = false;
    let empty = false;
    const parsePopulateOrEmpty = (): void => {
      if (kw(p, "POPULATE")) populate = true;
      else if (kw(p, "EMPTY")) {
        if (toTable && !refresh)
          p.fail("When creating a materialized view you can't declare both 'TO [db].[table]' and 'EMPTY'", p.i - 1);
        empty = true;
      }
    };
    let storage: Ast | null = null;
    if (materialized) {
      if (!toTable) {
        storage = parseStorage(p);
        parsePopulateOrEmpty();
        if (kw(p, "TO"))
          p.fail("When creating a materialized view you can't declare both 'ENGINE' and 'TO [db].[table]'", p.i - 1);
      } else {
        const storageAt = p.i;
        if (parseStorage(p))
          p.fail("When creating a materialized view you can't declare both 'TO [db].[table]' and 'ENGINE'", storageAt);
        parsePopulateOrEmpty();
      }
    }
    if (!sqlSecurity) sqlSecurity = parseSQLSecurity(p) !== null;
    if (materialized && !populate && !empty) parsePopulateOrEmpty();
    const comment = parseComment(p);
    if (materialized && !populate && !empty) parsePopulateOrEmpty();
    if (populate && refresh)
      p.fail(
        "When creating a refreshable materialized view you can't declare 'POPULATE': " +
          "the first refresh fills the view (declare 'EMPTY' to skip it)",
      );
    if (!kw(p, "AS")) return null;
    const select = parseSelectWithUnionQuery(p);
    if (!select) return null;
    const beforeComment = p.i;
    if (parseComment(p) && comment)
      p.fail("Comment for a view cannot be specified both before and after AS SELECT; please use only one", beforeComment);

    rejectNilUuid(p, attach, table);
    const columnsPrimaryKey = columns?.has("primary_key") || columns?.has("primary_key_from_columns");
    if (columnsPrimaryKey) {
      if (!materialized) p.fail("PRIMARY KEY is not allowed in the column list of a view");
      if (toTable) p.fail("When creating a materialized view you can't declare both 'TO [db].[table]' and 'PRIMARY KEY'");
    }
    let storagePrimaryKey = storage?.has("primary_key") ?? false;
    for (const flag of ["primary_key", "primary_key_from_columns"]) {
      if (!columns?.has(flag)) continue;
      if (storagePrimaryKey) p.failOther("Multiple primary keys are not allowed.");
      storagePrimaryKey = true;
    }
    if (innerUuid) rejectNilInnerUuid(p, innerUuid);
    // The engine of a materialized view is a target of the view, and a PRIMARY KEY of the columns moves into it.
    const primaryKey = columns?.get("primary_key");
    if (primaryKey) storage = (storage ?? new Ast("Storage")).set("primary_key", primaryKey);
    const targets = storage ? new Ast("ViewTargets").set("engine", storage) : null;
    return new Ast("CreateQuery").set("columns", columns).set("select", select).set("targets", targets);
  });
}

/** ParserDictionaryAttributeDeclaration: name Type [DEFAULT x] [EXPRESSION e] [HIERARCHICAL] [INJECTIVE] ... */
function parseDictionaryAttributeDeclaration(p: P): Ast | null {
  return base(p, "attribute declaration", () => {
    if (!parseIdentifier(p)) return null;
    const node = new Ast("DictionaryAttributeDeclaration");
    if (!keep(node, "type", parseDataType(p))) return null;
    const seen = new Set<string>();
    for (;;) {
      if (!seen.has("DEFAULT") && kw(p, "DEFAULT")) {
        if (!keep(node, "default", parseLiteral(p) ?? parseArrayOfLiterals(p))) return null;
        seen.add("DEFAULT");
        continue;
      }
      if (!seen.has("EXPRESSION") && kw(p, "EXPRESSION")) {
        if (!keep(node, "expression", parseExpression(p))) return null;
        seen.add("EXPRESSION");
        continue;
      }
      const flag = ["HIERARCHICAL", "BIDIRECTIONAL", "INJECTIVE", "IS_OBJECT_ID"].find(
        (keyword) => !seen.has(keyword) && kw(p, keyword),
      );
      if (!flag) break;
      seen.add(flag);
    }
    return node;
  });
}

function isUInt64Literal(node: Ast | undefined): boolean {
  return node?.kind === "Literal" && node.value?.t === "UInt64";
}

/** ParserDictionaryLifetime: LIFETIME(300) or LIFETIME(MIN 0 MAX 300). */
function parseDictionaryLifetime(p: P): Ast | null {
  return base(p, "lifetime definition", () => {
    const value = parseLiteral(p);
    if (value) return isUInt64Literal(value) ? new Ast("Other") : null;
    const pairs = parseKeyValuePairsList(p);
    if (!pairs || pairs.children.length !== 2) return null;
    let max = false;
    for (const pair of pairs.children) {
      if (!isUInt64Literal(pair.children[0])) return null;
      if (pair.name === "max") max = true;
      else if (pair.name !== "min") return null;
    }
    return max ? new Ast("Other") : null;
  });
}

/** ParserDictionaryRange: RANGE(MIN a MAX b). */
function parseDictionaryRange(p: P): Ast | null {
  return base(p, "range definition", () => {
    const pairs = parseKeyValuePairsList(p);
    if (!pairs || pairs.children.length !== 2) return null;
    const names = new Set<string>();
    for (const pair of pairs.children) {
      if (pair.children[0]?.kind !== "Identifier") return null;
      if (pair.name !== "min" && pair.name !== "max") return null;
      names.add(pair.name);
    }
    return names.size === 2 ? new Ast("Other") : null;
  });
}

/** ParserDictionaryLayout: LAYOUT(HASHED()) or LAYOUT(HASHED); parameters need brackets. */
function parseDictionaryLayout(p: P): Ast | null {
  return base(p, "layout definition", () => {
    const layout = parseFunctionWithKeyValueArguments(p, true);
    if (!layout) return null;
    if (layout.children.length && !layout.has("brackets")) return null;
    return layout;
  });
}

/** ParserDictionarySettings: name = value, ... */
function parseDictionarySettings(p: P): Ast | null {
  return base(p, "settings definition", () => (parseNameValuePairs(p) ? new Ast("Other") : null));
}

/** ParserDictionary: [PRIMARY KEY ...] SOURCE(...) LIFETIME(...) LAYOUT(...) [RANGE(...)] [SETTINGS(...)]. */
function parseDictionary(p: P): Ast | null {
  return base(p, "dictionary definition", () => {
    if (kw(p, "PRIMARY KEY")) {
      const open = tok(p, T.OpeningRoundBracket);
      if (!parseList(p, () => parseIdentifier(p), undefined, false)) return null;
      if (open && !tok(p, T.ClosingRoundBracket)) return null;
    }
    const node = new Ast("Dictionary");
    const sections: [string, () => Ast | null][] = [
      ["SOURCE", () => parseFunctionWithKeyValueArguments(p)],
      ["LIFETIME", () => parseDictionaryLifetime(p)],
      ["LAYOUT", () => parseDictionaryLayout(p)],
      ["RANGE", () => parseDictionaryRange(p)],
      ["SETTINGS", () => parseDictionarySettings(p)],
    ];
    const seen = new Set<string>();
    loop: for (;;) {
      for (const [keyword, parse] of sections) {
        if (!seen.has(keyword) && kw(p, keyword)) {
          if (!tok(p, T.OpeningRoundBracket)) return null;
          if (!keep(node, keyword, parse())) return null;
          if (!tok(p, T.ClosingRoundBracket)) return null;
          seen.add(keyword);
          continue loop;
        }
      }
      break;
    }
    return node;
  });
}

/** ParserCreateDictionaryQuery: CREATE [OR REPLACE] | ATTACH | REPLACE DICTIONARY ... (attributes) definition. */
function parseCreateDictionaryQuery(p: P): Ast | null {
  return base(p, "CREATE DICTIONARY", () => {
    let attach = false;
    if (kw(p, "CREATE")) kw(p, "OR REPLACE");
    else if (kw(p, "ATTACH")) attach = true;
    else if (!kw(p, "REPLACE")) return null;
    if (!kw(p, "DICTIONARY")) return null;
    kw(p, "IF NOT EXISTS");
    const name = parseCompoundIdentifier(p, true, true);
    if (!name) return null;
    if (kw(p, "ON") && !parseCluster(p)) return null;
    const node = new Ast("CreateQuery");
    if (!attach) {
      if (!tok(p, T.OpeningRoundBracket)) return null;
      const attributes = base(p, "attribute declaration list", () =>
        parseList(p, () => parseDictionaryAttributeDeclaration(p), undefined, false),
      );
      if (!keep(node, "attributes", attributes)) return null;
      tok(p, T.Comma);
      if (!tok(p, T.ClosingRoundBracket)) return null;
      if (!keep(node, "dictionary", parseDictionary(p))) return null;
    }
    parseComment(p);
    rejectNilUuid(p, attach, name);
    return node;
  });
}

/** ParserCreateNamedCollectionQuery: CREATE [OR REPLACE] NAMED COLLECTION [IF NOT EXISTS] name [ON CLUSTER c] AS key = value, ... */
export function parseCreateNamedCollectionQuery(p: P): Ast | null {
  return base(p, "CREATE NAMED COLLECTION", () => {
    if (!kw(p, "CREATE")) return null;
    const replace = kw(p, "OR REPLACE");
    if (!kw(p, "NAMED COLLECTION")) return null;
    if (!replace) kw(p, "IF NOT EXISTS");
    if (!parseIdentifier(p)) return null;
    if (kw(p, "ON") && !parseCluster(p)) return null;
    if (!kw(p, "AS")) return null;
    const overridable = () => {
      if (!kw(p, "NOT OVERRIDABLE")) kw(p, "OVERRIDABLE");
    };
    return parseNameValuePairs(p, overridable) ? new Ast("CreateNamedCollectionQuery") : null;
  });
}

/** ParserCreateQuery: a table, database, view or dictionary. */
export function parseCreateQuery(p: P): Ast | null {
  return base(
    p,
    "CREATE TABLE or ATTACH TABLE query",
    () => parseCreateTableQuery(p) ?? parseCreateDatabaseQuery(p) ?? parseCreateViewQuery(p) ?? parseCreateDictionaryQuery(p),
  );
}
