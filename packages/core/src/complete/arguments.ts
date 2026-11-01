/**
 * Suggestions for the argument at the cursor in `ENGINE = Name(...)`, by what each parameter there takes.
 */
import { FORMATS } from "../generated/formats.js";
import { type CompletionCandidate, type CompletionSchema, TokenKind as T } from "../types.js";
import { findFunction, formatDetail, formatDocumentation, functionDocumentation } from "./catalog.js";
import { COMPRESSION, type EngineCall, JOIN_KINDS, kindOf, type ParameterKind, parameterAt, STRICTNESS } from "./engines.js";
import { type DeclaredColumn, databases, named } from "./schema.js";

/** A suggestion and its tier: the lower, the earlier. */
export interface Ranked {
  tier: number;
  candidate: CompletionCandidate;
}

export interface EngineContext {
  sql: string;
  call: EngineCall;
  /** The columns of the table the statement makes. */
  columns: DeclaredColumn[];
  /** The names in the sorting, primary and partition keys of the statement. */
  keys: Set<string>;
  schema: CompletionSchema;
  /** Whether keywords are written in lower case, after a prefix in lower case. */
  lower: boolean;
}

const BEST = -3;
const GOOD = -2;
const ALSO = -1;

const INTEGER = /^U?Int(8|16|32|64|128|256)$/;
const NUMERIC = /^(U?Int(8|16|32|64|128|256)|B?Float(16|32|64)|Decimal(32|64|128|256)?)$/;
/** The version types of the documentation, then the other ones that ClickHouse takes. */
const VERSION = /^(UInt(8|16|32|64|128|256)|Date|DateTime|DateTime64)$/;
const OTHER_VERSION = /^(Int(8|16|32|64|128|256)|B?Float(16|32|64)|Bool|Date32|Time|Time64)$/;
/** The types that ClickHouse takes as a sharding key besides integers: those that integers represent. */
const OTHER_SHARDING = /^(Bool|Date|Date32|DateTime|Time|Enum|Enum8|Enum16|IPv4)$/;

/** The tier of a column for a parameter of the kind, or undefined when ClickHouse does not take its type there. */
function columnTier(kind: ParameterKind, column: DeclaredColumn, keys: Set<string>): number | undefined {
  const type = column.family ?? "";
  const inner = type === "LowCardinality" ? (column.inner ?? "") : "";
  switch (kind) {
    case "sign":
      return type === "Int8" ? GOOD : undefined;
    case "is_deleted":
      return type === "UInt8" || type === "Bool" ? GOOD : undefined;
    case "version":
      if (VERSION.test(type)) return GOOD;
      return OTHER_VERSION.test(type) || VERSION.test(inner) || OTHER_VERSION.test(inner) ? ALSO : undefined;
    case "sharding key":
      if (INTEGER.test(type)) return GOOD;
      return OTHER_SHARDING.test(type) || INTEGER.test(inner) || OTHER_SHARDING.test(inner) ? ALSO : undefined;
    case "columns":
      if (keys.has(column.name)) return undefined;
      return NUMERIC.test(type) || NUMERIC.test(column.inner ?? "") ? GOOD : ALSO;
    case "key":
      return GOOD;
    default:
      return undefined;
  }
}

/** The documentation of a value that uses macros: what the server makes of them, when it is known. */
function macroNote(text: string, schema: CompletionSchema): string | undefined {
  if (!schema.macros) return undefined;
  const lines = [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))]
    .filter((name) => !["database", "table", "uuid"].includes(name))
    .map((name) => {
      const macro = schema.macros!.find((m) => m.name === name);
      return macro ? `\`{${name}}\` is \`${macro.value}\` on the server.` : `\`{${name}}\` is not a macro of the server.`;
    });
  return lines.length ? lines.join("\n\n") : undefined;
}

function value(label: string, detail: string, schema: CompletionSchema): CompletionCandidate {
  const documentation = macroNote(label, schema);
  return documentation ? { label, kind: "value", detail, documentation } : { label, kind: "value", detail };
}

function functionCandidate(name: string): CompletionCandidate {
  const info = findFunction(name)!;
  return { label: info.name, kind: "function", detail: info.category, documentation: functionDocumentation(info) };
}

const PATHS: [string, string][] = [
  ["'/clickhouse/tables/{shard}/{database}/{table}'", "ZooKeeper path"],
  ["'/clickhouse/tables/{uuid}/{shard}'", "ZooKeeper path, default_replica_path of the server"],
];
const REPLICA = "'{replica}'";

/** The suggestions for the argument at the cursor, by what each parameter there takes. */
export function engineCandidates(context: EngineContext): Ranked[] {
  const { sql, call, columns, keys, schema, lower } = context;
  const out: Ranked[] = [];
  const add = (tier: number, candidate: CompletionCandidate) => out.push({ tier, candidate });
  const keyword = (word: string) => add(BEST, { label: lower ? word.toLowerCase() : word, kind: "keyword" });
  const used = new Set(call.args.map((arg) => arg.value));
  // With `name = value`, the name tells what the value is.
  const byName = call.current.length === 2 && call.current[0]!.kind === T.BareWord && call.current[1]!.kind === T.Equals;
  const parameters = byName
    ? [{ name: sql.slice(call.current[0]!.start, call.current[0]!.end), quoted: false, keyword: false, named: false }]
    : call.current.length === 0
      ? call.parameters
      : [];

  for (const param of parameters) {
    const kind = kindOf(param);
    switch (kind) {
      case "zoo path": {
        // The path and the replica name at once, where the replica name comes next.
        const replica = call.lists.some((list) => {
          const next = parameterAt(list, call.args.length + 1);
          return next !== undefined && kindOf(next) === "replica";
        });
        for (const [path, detail] of PATHS) {
          add(GOOD, value(path, detail, schema));
          if (replica) add(BEST, value(`${path}, ${REPLICA}`, "ZooKeeper path and replica name", schema));
        }
        break;
      }
      case "replica":
        add(GOOD, value(REPLICA, "replica name", schema));
        break;
      case "sign":
      case "version":
      case "is_deleted":
      case "columns":
      case "sharding key":
      case "key":
        for (const column of columns) {
          const tier = used.has(column.name) ? undefined : columnTier(kind, column, keys);
          if (tier !== undefined) add(tier, named({ label: column.name, kind: "column", detail: column.type || undefined }));
        }
        if (kind === "sharding key") add(GOOD, functionCandidate("rand"));
        break;
      case "format":
        for (const info of FORMATS)
          add(GOOD, { label: info.name, kind: "format", detail: formatDetail(info), documentation: formatDocumentation(info), insertText: `'${info.name}'` });
        break;
      case "compression":
        for (const method of COMPRESSION) add(GOOD, { label: method, kind: "value", detail: "compression", insertText: `'${method}'` });
        break;
      case "keyword":
        keyword(param.name);
        break;
      case "strictness":
        STRICTNESS.forEach(keyword);
        break;
      case "join kind": {
        const strictness = call.args[call.args.length - 1]?.value?.toUpperCase() ?? "";
        (JOIN_KINDS[strictness] ?? JOIN_KINDS.ALL!).forEach(keyword);
        break;
      }
      case "cluster":
        for (const cluster of schema.clusters ?? []) add(GOOD, named({ label: cluster, kind: "value", detail: "cluster" }));
        add(GOOD, value("'{cluster}'", "cluster macro", schema));
        break;
      case "database":
        for (const database of databases(schema)) add(GOOD, named({ label: database, kind: "database" }));
        add(GOOD, functionCandidate("currentDatabase"));
        break;
      case "table": {
        // After a database argument, the tables of that database.
        const database = call.args.find((arg, j) => call.lists.some((list) => kindOf(parameterAt(list, j)!) === "database"))?.value;
        for (const table of schema.tables ?? [])
          if (database === undefined || table.database === database) add(GOOD, named({ label: table.name, kind: "table", detail: table.database }));
        break;
      }
    }
  }
  return out;
}
