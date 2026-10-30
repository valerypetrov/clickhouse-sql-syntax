/**
 * SYSTEM queries: a port of src/Parsers/ParserSystemQuery.cpp.
 */
import { Ast, type Lit } from "./ast.js";
import { parseCluster, parseDatabaseAndTableAsAST, parseDatabaseAsAST } from "./common.js";
import {
  parseIdentifier,
  parseIdentifierWithOptionalParameters,
  parseList,
  parseLiteral,
  parseStringLiteral,
  parseSubquery,
  parseUnsignedInteger,
} from "./elements.js";
import { parseSetQuery } from "./set.js";
import { base, kw, P, peekKw, T, tok, tokQuiet } from "./state.js";

/** ASTSystemQuery::Type in enum order without the background verbs, as typeToString spells them. */
const TYPES = [
  "UNKNOWN", "SHUTDOWN", "KILL", "SUSPEND", "CLEAR DNS CACHE", "CLEAR CONNECTIONS CACHE", "PREWARM MARK CACHE",
  "PREWARM PRIMARY INDEX CACHE", "CLEAR MARK CACHE", "CLEAR PRIMARY INDEX CACHE", "CLEAR STATISTICS CACHE",
  "CLEAR UNCOMPRESSED CACHE", "CLEAR INDEX MARK CACHE", "CLEAR INDEX UNCOMPRESSED CACHE",
  "CLEAR VECTOR SIMILARITY INDEX CACHE", "CLEAR TEXT INDEX TOKENS CACHE", "CLEAR TEXT INDEX HEADER CACHE",
  "CLEAR TEXT INDEX POSTINGS CACHE", "CLEAR TEXT INDEX CACHES", "CLEAR COLUMNS CACHE", "CLEAR MMAP CACHE",
  "CLEAR QUERY CONDITION CACHE", "CLEAR ENCRYPTION HEADERS CACHE", "CLEAR QUERY CACHE",
  "CLEAR COMPILED EXPRESSION CACHE", "CLEAR ICEBERG METADATA CACHE", "CLEAR PAIMON METADATA CACHE",
  "CLEAR PARQUET METADATA CACHE", "CLEAR POINT IN POLYGON CACHE", "CLEAR FILESYSTEM CACHE",
  "CLEAR DISTRIBUTED CACHE", "CLEAR DISK METADATA CACHE", "CLEAR PAGE CACHE", "CLEAR SCHEMA CACHE",
  "CLEAR FORMAT SCHEMA CACHE", "CLEAR AVRO SCHEMA CACHE", "CLEAR S3 CLIENT CACHE", "CLEAR TIME SERIES CACHES",
  "STOP LISTEN", "START LISTEN", "RESTART REPLICAS", "RESTART REPLICA", "RESTORE REPLICA",
  "RESTORE DATABASE REPLICA", "WAIT LOADING PARTS", "WAIT QUERY RUNNER", "DROP REPLICA", "DROP DATABASE REPLICA",
  "DROP CATALOG REPLICA", "JEMALLOC PURGE", "JEMALLOC ENABLE PROFILE", "JEMALLOC DISABLE PROFILE",
  "JEMALLOC FLUSH PROFILE", "SYNC REPLICA", "SYNC DATABASE REPLICA", "SYNC TRANSACTION LOG", "SYNC FILE CACHE",
  "REPLICA READY", "REPLICA UNREADY", "RELOAD DICTIONARY", "RELOAD DICTIONARIES", "UNLOAD DICTIONARY",
  "UNLOAD DICTIONARIES", "RELOAD FUNCTION", "RELOAD FUNCTIONS", "RELOAD EMBEDDED DICTIONARIES", "RELOAD CONFIG",
  "RELOAD USERS", "RELOAD ASYNCHRONOUS METRICS", "RELOAD DELTA KERNEL TRACING", "RESTART DISK", "STOP MERGES",
  "START MERGES", "STOP TTL MERGES", "START TTL MERGES", "STOP FETCHES", "START FETCHES", "STOP MOVES",
  "START MOVES", "STOP REPLICATED SENDS", "START REPLICATED SENDS", "STOP REPLICATION QUEUES",
  "START REPLICATION QUEUES", "STOP REPLICATED DDL QUERIES", "START REPLICATED DDL QUERIES", "FLUSH LOGS",
  "FLUSH DISTRIBUTED", "FLUSH ASYNC INSERT QUEUE", "FLUSH OBJECT STORAGE QUEUE", "STOP DISTRIBUTED SENDS",
  "START DISTRIBUTED SENDS", "START THREAD FUZZER", "STOP THREAD FUZZER", "UNFREEZE", "ENABLE FAILPOINT",
  "DISABLE FAILPOINT", "DISABLE ALL FAILPOINTS", "ALLOCATE MEMORY", "FREE MEMORY", "WAIT FAILPOINT",
  "NOTIFY FAILPOINT", "SYNC FILESYSTEM CACHE", "STOP PULLING REPLICATION LOG", "START PULLING REPLICATION LOG",
  "STOP CLEANUP", "START CLEANUP", "SCHEDULE MERGE", "SYNC MERGES", "RESET COVERAGE", "SET COVERAGE TEST",
  "REFRESH VIEW", "WAIT VIEW", "START VIEW", "START VIEWS", "START REPLICATED VIEW", "STOP VIEW", "STOP VIEWS",
  "STOP REPLICATED VIEW", "PAUSE VIEW", "PAUSE VIEWS", "CANCEL VIEW", "TEST VIEW", "LOAD PRIMARY KEY",
  "UNLOAD PRIMARY KEY", "STOP VIRTUAL PARTS UPDATE", "START VIRTUAL PARTS UPDATE", "STOP REDUCE BLOCKING PARTS",
  "START REDUCE BLOCKING PARTS", "UNLOCK SNAPSHOT", "RECONNECT ZOOKEEPER", "WAIT BLOBS CLEANUP", "INSTRUMENT ADD",
  "INSTRUMENT REMOVE", "RESET DDL WORKER", "RESET FILELOG", "STOP ALL BACKGROUND", "START ALL BACKGROUND",
  "PAUSE ALL BACKGROUND", "CANCEL ALL BACKGROUND", "REFRESH ALL BACKGROUND", "END",
];

/** DROP ... CACHE, the old spelling of CLEAR ... CACHE. */
const CACHE_ALIASES = [
  "DNS CACHE", "CONNECTIONS CACHE", "MARK CACHE", "PRIMARY INDEX CACHE", "STATISTICS CACHE", "UNCOMPRESSED CACHE",
  "INDEX MARK CACHE", "INDEX UNCOMPRESSED CACHE", "VECTOR SIMILARITY INDEX CACHE", "TEXT INDEX TOKENS CACHE",
  "TEXT INDEX HEADER CACHE", "TEXT INDEX POSTINGS CACHE", "TEXT INDEX CACHES", "COLUMNS CACHE", "MMAP CACHE",
  "QUERY CONDITION CACHE", "ENCRYPTION HEADERS CACHE", "QUERY CACHE", "COMPILED EXPRESSION CACHE",
  "ICEBERG METADATA CACHE", "PAIMON METADATA CACHE", "PARQUET METADATA CACHE", "POINT IN POLYGON CACHE",
  "FILESYSTEM CACHE", "DISTRIBUTED CACHE", "DISK METADATA CACHE", "PAGE CACHE", "SCHEMA CACHE",
  "FORMAT SCHEMA CACHE", "AVRO SCHEMA CACHE", "TIME SERIES CACHES", "S3 CLIENT CACHE",
];

/** STOP, START, PAUSE, CANCEL and REFRESH of a refreshable view, tried last. */
const BACKGROUND_VERBS = ["STOP", "START", "PAUSE", "CANCEL", "REFRESH"];

/** ServerType::Type as serverTypeToString spells it, for START|STOP LISTEN. */
const SERVER_TYPES = [
  "TCP WITH PROXY", "TCP SECURE", "TCP SSH", "TCP", "HTTP", "HTTPS", "MYSQL", "GRPC", "ARROW FLIGHT", "POSTGRESQL",
  "PROMETHEUS", "CUSTOM", "INTERSERVER HTTP", "INTERSERVER HTTPS", "QUERIES ALL", "QUERIES DEFAULT", "QUERIES CUSTOM",
  "CLOUD", "ICEBERG REST CATALOG", "END",
];

/** Field::safeGet on a literal of the wrong type, which is not a syntax error. */
function requireLiteralType(p: P, literal: Ast, type: Lit["t"]): void {
  const actual = literal.value!.t;
  if (actual !== type) p.failOther(`Bad get: has ${actual}, requested ${type}`, p.i - 1);
}

/** [ON CLUSTER c]. */
function parseOnCluster(p: P): boolean {
  return !kw(p, "ON") || parseCluster(p);
}

/** parseQueryWithOnClusterAndMaybeTable: ON CLUSTER before or after an optional [db.]table or 'db.table'. */
function parseOnClusterAndMaybeTable(p: P, requireTable: boolean, allowStringLiteral: boolean): boolean {
  let onCluster = false;
  if (kw(p, "ON")) {
    if (!parseCluster(p)) return false;
    onCluster = true;
  }
  let table = allowStringLiteral && parseStringLiteral(p) !== null;
  if (!table) table = parseDatabaseAndTableAsAST(p);
  if (!table && requireTable) return false;
  return onCluster || parseOnCluster(p);
}

/** parseQueryWithOnClusterAndTarget: a function or disk name, as an identifier or a string. */
function parseOnClusterAndTarget(p: P): boolean {
  let onCluster = false;
  if (kw(p, "ON")) {
    if (!parseCluster(p)) return false;
    onCluster = true;
  }
  if (!parseStringLiteral(p) && !parseIdentifier(p)) return false;
  return onCluster || parseOnCluster(p);
}

/** SYSTEM DROP [DATABASE] REPLICA 'name' [FROM SHARD 's'] [FROM DATABASE d | TABLE t | ZKPATH 'path']. */
function parseDropReplica(p: P, database: boolean): boolean {
  if (!parseOnCluster(p)) return false;
  if (!parseStringLiteral(p)) return false;
  if (kw(p, "FROM SHARD") && !parseStringLiteral(p)) return false;
  if (!kw(p, "FROM")) return true;
  if (kw(p, "DATABASE")) {
    if (!parseIdentifier(p)) return false;
  } else if (!database && kw(p, "TABLE")) {
    parseDatabaseAndTableAsAST(p);
  } else if (kw(p, "ZKPATH")) {
    const path = parseStringLiteral(p);
    if (!path) return false;
    const text = path.value!.t === "String" ? path.value!.v : "";
    if (/^\/*$/.test(text.replace(/^[^/]*:(?=\/)/, "")))
      p.failOther("ZooKeeper path in DROP REPLICA is empty or refers to the root", p.i - 1);
  } else {
    return false;
  }
  if (database) kw(p, "WITH TABLES");
  return true;
}

/** One server type of START|STOP LISTEN; END is never a valid one. */
function parseServerType(p: P): string | null {
  const type = SERVER_TYPES.find((name) => kw(p, name));
  if (!type || type === "END") return null;
  if (type === "CUSTOM" && !parseStringLiteral(p)) return null;
  return type;
}

function parseListen(p: P): boolean {
  if (!parseOnCluster(p)) return false;
  const type = parseServerType(p);
  if (!type) return false;
  if (kw(p, "EXCEPT")) {
    if (type !== "QUERIES ALL" && type !== "QUERIES DEFAULT" && type !== "QUERIES CUSTOM") return false;
    let count = 0;
    for (;;) {
      if (count && !tok(p, T.Comma)) break;
      if (!parseServerType(p)) return false;
      count++;
    }
  }
  return true;
}

/** SYSTEM FLUSH LOGS|ASYNC INSERT QUEUE [ON CLUSTER c] [[db.]table, ...]. */
function parseFlushTables(p: P): boolean {
  if (peekKw(p, "ON") && !parseOnCluster(p)) return false;
  let count = 0;
  do {
    if (!parseIdentifier(p, true)) {
      if (!count) break;
      return false;
    }
    if (tokQuiet(p, T.Dot) && !parseIdentifier(p, true)) return false;
    count++;
  } while (tok(p, T.Comma));
  return true;
}

/** SYSTEM STOP|START MERGES [ON CLUSTER c] [ON VOLUME policy.volume | [db.]table]. */
function parseMerges(p: P): boolean {
  const parseVolume = () => parseIdentifier(p) !== null && tok(p, T.Dot) && parseIdentifier(p) !== null;
  let volume = false;
  if (kw(p, "ON VOLUME")) {
    if (!parseVolume()) return false;
    volume = true;
  } else {
    if (!parseOnCluster(p)) return false;
    if (kw(p, "ON VOLUME")) {
      if (!parseVolume()) return false;
      volume = true;
    }
  }
  if (!volume) parseDatabaseAndTableAsAST(p);
  return true;
}

/** SYSTEM INSTRUMENT ADD|REMOVE as the official builds parse it, which have XRay; others take only ON CLUSTER. */
function parseInstrument(p: P, add: boolean): boolean {
  if (!add) {
    if (parseSubquery(p)) return true;
    const point = parseLiteral(p);
    if (point) {
      if (point.value!.t === "String" || point.value!.t === "UInt64") return true;
      p.expect("String or UInt64 literal for instrumentation point");
      return false;
    }
    const all = parseIdentifier(p);
    if (all) {
      if (all.name.toLowerCase() === "all") return true;
      p.expect("ALL");
      return false;
    }
    p.expect("instrumentation point: subquery, literal, or ALL");
    return false;
  }
  const name = parseLiteral(p);
  if (!name) {
    p.expect("function name (string literal)");
    return false;
  }
  requireLiteralType(p, name, "String");
  const handler = parseIdentifier(p);
  if (!handler) {
    p.expect("handler name (LOG, SLEEP, or PROFILE)");
    return false;
  }
  if (handler.name.toLowerCase() === "profile") return true;
  const entry = parseIdentifier(p);
  if (!entry || !["entry", "exit"].includes(entry.name.toLowerCase())) {
    p.expect("entry type (ENTRY or EXIT)");
    return false;
  }
  let count = 0;
  for (let argument = parseLiteral(p); argument; argument = parseLiteral(p)) {
    const value = argument.value!;
    if (value.t === "UInt64" && BigInt(p.textAt(p.i - 1).replaceAll("_", "")) > 2n ** 63n - 1n) {
      p.expect("integer literal not exceeding Int64 maximum");
      return false;
    }
    if (!["String", "Int64", "UInt64", "Float64"].includes(value.t)) {
      p.expect("string, integer, or float literal argument");
      return false;
    }
    count++;
  }
  if (!count) {
    p.expect("at least one argument (string, integer, or float literal)");
    return false;
  }
  return true;
}

/** What follows the type of a SYSTEM query. */
function parseSystemBody(p: P, type: string): boolean {
  switch (type) {
    case "RELOAD DICTIONARY":
    case "UNLOAD DICTIONARY":
      return parseOnClusterAndMaybeTable(p, true, true);
    case "RELOAD FUNCTION":
    case "RESTART DISK":
    case "CLEAR DISK METADATA CACHE":
    case "WAIT BLOBS CLEANUP":
      return parseOnClusterAndTarget(p);
    case "DROP REPLICA":
      return parseDropReplica(p, false);
    case "DROP DATABASE REPLICA":
      return parseDropReplica(p, true);
    case "DROP CATALOG REPLICA":
      return parseStringLiteral(p) !== null;
    case "ALLOCATE MEMORY":
      return parseUnsignedInteger(p) !== null;
    case "ENABLE FAILPOINT":
    case "DISABLE FAILPOINT":
    case "NOTIFY FAILPOINT":
    case "RELOAD DELTA KERNEL TRACING":
      return parseIdentifier(p) !== null;
    case "DISABLE ALL FAILPOINTS":
      return true;
    case "WAIT FAILPOINT":
      if (!parseIdentifier(p)) return false;
      if (!kw(p, "PAUSE")) kw(p, "RESUME");
      return true;
    case "SET COVERAGE TEST":
      parseStringLiteral(p);
      return true;
    case "RESTART REPLICA":
    case "SYNC REPLICA":
    case "WAIT LOADING PARTS":
    case "WAIT QUERY RUNNER":
    case "PREWARM MARK CACHE":
    case "PREWARM PRIMARY INDEX CACHE":
    case "CLEAR TIME SERIES CACHES":
      if (!parseOnCluster(p)) return false;
      if (!parseDatabaseAndTableAsAST(p)) return false;
      if (type === "SYNC REPLICA") {
        kw(p, "IF EXISTS");
        if (kw(p, "STRICT")) {
          // SYNC REPLICA t STRICT.
        } else if (kw(p, "LIGHTWEIGHT")) {
          if (kw(p, "FROM")) {
            do {
              if (!parseStringLiteral(p)) return false;
            } while (tok(p, T.Comma));
          }
        } else {
          kw(p, "PULL");
        }
      }
      return true;
    case "SYNC DATABASE REPLICA":
      if (!parseOnCluster(p)) return false;
      if (!parseDatabaseAsAST(p)) return false;
      kw(p, "STRICT");
      return true;
    case "STOP DISTRIBUTED SENDS":
    case "START DISTRIBUTED SENDS":
    case "LOAD PRIMARY KEY":
    case "UNLOAD PRIMARY KEY":
      return parseOnClusterAndMaybeTable(p, false, false);
    case "FLUSH OBJECT STORAGE QUEUE":
      return parseOnClusterAndMaybeTable(p, true, false) && kw(p, "PATH") && parseStringLiteral(p) !== null;
    case "RESET FILELOG":
      if (!parseOnClusterAndMaybeTable(p, true, false)) return false;
      if (kw(p, "FILE")) {
        if (!parseStringLiteral(p)) return false;
        if (kw(p, "OFFSET")) return parseUnsignedInteger(p) !== null;
        if (kw(p, "TO")) return kw(p, "END");
      }
      return true;
    case "FLUSH DISTRIBUTED":
      if (!parseOnClusterAndMaybeTable(p, true, false)) return false;
      return !kw(p, "SETTINGS") || parseSetQuery(p, true) !== null;
    case "RESTORE REPLICA":
      return parseOnClusterAndMaybeTable(p, true, false);
    case "RESTORE DATABASE REPLICA":
      return parseOnCluster(p) && parseDatabaseAsAST(p);
    case "STOP MERGES":
    case "START MERGES":
      return parseMerges(p);
    case "STOP TTL MERGES":
    case "START TTL MERGES":
    case "STOP MOVES":
    case "START MOVES":
    case "STOP FETCHES":
    case "START FETCHES":
    case "STOP REPLICATED SENDS":
    case "START REPLICATED SENDS":
    case "STOP REPLICATION QUEUES":
    case "START REPLICATION QUEUES":
    case "STOP PULLING REPLICATION LOG":
    case "START PULLING REPLICATION LOG":
    case "STOP CLEANUP":
    case "START CLEANUP":
    case "STOP VIRTUAL PARTS UPDATE":
    case "START VIRTUAL PARTS UPDATE":
    case "STOP REDUCE BLOCKING PARTS":
    case "START REDUCE BLOCKING PARTS":
    case "SYNC MERGES":
      if (!parseOnCluster(p)) return false;
      parseDatabaseAndTableAsAST(p);
      return true;
    case "SCHEDULE MERGE":
      if (!parseOnCluster(p)) return false;
      if (!parseDatabaseAndTableAsAST(p)) return false;
      if (!kw(p, "PARTS")) return false;
      return parseList(p, () => parseStringLiteral(p), undefined, false) !== null;
    case "REFRESH VIEW":
    case "WAIT VIEW":
    case "START VIEW":
    case "START REPLICATED VIEW":
    case "STOP VIEW":
    case "STOP REPLICATED VIEW":
    case "PAUSE VIEW":
    case "CANCEL VIEW":
    case "STOP":
    case "START":
    case "PAUSE":
    case "CANCEL":
    case "REFRESH":
      return parseDatabaseAndTableAsAST(p);
    case "START VIEWS":
    case "STOP VIEWS":
    case "PAUSE VIEWS":
    case "FREE MEMORY":
    case "STOP ALL BACKGROUND":
    case "START ALL BACKGROUND":
    case "PAUSE ALL BACKGROUND":
    case "CANCEL ALL BACKGROUND":
    case "REFRESH ALL BACKGROUND":
      return true;
    case "TEST VIEW":
      if (!parseDatabaseAndTableAsAST(p)) return false;
      if (kw(p, "UNSET FAKE TIME")) return true;
      return kw(p, "SET FAKE TIME") && parseStringLiteral(p) !== null;
    case "SUSPEND":
      return parseOnCluster(p) && kw(p, "FOR") && parseUnsignedInteger(p) !== null && kw(p, "SECOND");
    case "CLEAR QUERY CACHE": {
      if (kw(p, "TAG")) {
        const tag = parseLiteral(p);
        if (tag) requireLiteralType(p, tag, "String");
      }
      return parseOnCluster(p);
    }
    case "CLEAR FILESYSTEM CACHE": {
      const name = parseLiteral(p);
      if (name) {
        requireLiteralType(p, name, "String");
        if (kw(p, "KEY") && parseIdentifier(p) && kw(p, "OFFSET")) {
          const offset = parseLiteral(p);
          if (offset) requireLiteralType(p, offset, "UInt64");
        }
      }
      return parseOnCluster(p);
    }
    case "CLEAR DISTRIBUTED CACHE": {
      if (!kw(p, "CONNECTIONS")) {
        const server = parseLiteral(p);
        if (server) requireLiteralType(p, server, "String");
      }
      return parseOnCluster(p);
    }
    case "SYNC FILESYSTEM CACHE": {
      const name = parseLiteral(p);
      if (name) requireLiteralType(p, name, "String");
      return parseOnCluster(p);
    }
    case "CLEAR SCHEMA CACHE":
      return !kw(p, "FOR") || ["FILE", "S3", "HDFS", "URL", "AZURE"].some((storage) => kw(p, storage));
    case "CLEAR FORMAT SCHEMA CACHE":
      return !kw(p, "FOR") || kw(p, "Protobuf") || kw(p, "Files");
    case "UNFREEZE":
      return kw(p, "WITH NAME") && parseStringLiteral(p) !== null;
    case "UNLOCK SNAPSHOT":
      if (!parseStringLiteral(p)) return false;
      if (kw(p, "FROM")) parseIdentifierWithOptionalParameters(p);
      return true;
    case "START LISTEN":
    case "STOP LISTEN":
      return parseListen(p);
    case "FLUSH ASYNC INSERT QUEUE":
    case "FLUSH LOGS":
      return parseFlushTables(p);
    case "INSTRUMENT ADD":
      return parseInstrument(p, true);
    case "INSTRUMENT REMOVE":
      return parseInstrument(p, false);
    default:
      return parseOnCluster(p);
  }
}

/** ParserSystemQuery. */
export function parseSystemQuery(p: P): Ast | null {
  return base(p, "SYSTEM query", () => {
    if (!kw(p, "SYSTEM")) return null;
    let type = TYPES.find((name) => kw(p, name));
    if (!type) {
      const alias = CACHE_ALIASES.find((name) => kw(p, `DROP ${name}`));
      if (alias) type = `CLEAR ${alias}`;
    }
    type ??= BACKGROUND_VERBS.find((name) => kw(p, name));
    if (!type || type === "UNKNOWN" || type === "END") return null;
    return parseSystemBody(p, type) ? new Ast("SystemQuery") : null;
  });
}
