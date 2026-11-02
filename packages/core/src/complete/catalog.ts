/**
 * The names ClickHouse knows, from the generated catalog, with their documentation as Markdown.
 */
import { COMBINATORS, type CombinatorInfo } from "../generated/combinators.js";
import { FORMATS, type FormatInfo } from "../generated/formats.js";
import { type Argument, FUNCTIONS, type FunctionInfo } from "../generated/functions.js";
import { SETTINGS, type SettingInfo } from "../generated/settings.js";
import { TABLE_ENGINES, type TableEngineInfo } from "../generated/table-engines.js";
import { TABLE_FUNCTIONS, type TableFunctionInfo } from "../generated/table-functions.js";
import type { ArgumentInfo, CompletionKind, Description } from "../types.js";
import { engineSignature, parameterDescription } from "./engines.js";
import { argumentKind } from "./kinds.js";

const tableFunctionsByName = new Map(TABLE_FUNCTIONS.map((f) => [f.name, f]));

/** A table function by its registered name. */
export function findTableFunction(name: string): TableFunctionInfo | undefined {
  return tableFunctionsByName.get(name);
}

const functionsByName = new Map(FUNCTIONS.map((f) => [f.name, f]));
const functionsByLowerName = new Map(FUNCTIONS.filter((f) => f.caseInsensitive).map((f) => [f.name.toLowerCase(), f]));

/** The aggregate functions, the names that take combinators. */
export const AGGREGATES = FUNCTIONS.filter((f) => f.aggregate);

/** A function by the name a query uses, in any case for case-insensitive ones. */
export function findFunction(name: string): FunctionInfo | undefined {
  const direct = functionsByName.get(name) ?? functionsByLowerName.get(name.toLowerCase());
  if (direct) return direct;
  if (name.length > 256) return undefined;
  const cached = combinedFunctions.get(name);
  if (cached) return cached;
  for (const combinator of suffixes) {
    if (!name.endsWith(combinator.name)) continue;
    const base = findFunction(name.slice(0, -combinator.name.length));
    if (!base?.aggregate) continue;
    const target = base.aliasTo ? (findFunction(base.aliasTo) ?? base) : base;
    const info = combinedFunction(name, target, combinator);
    combinedFunctions.set(name, info);
    return info;
  }
  return undefined;
}

const combinedFunctions = new Map<string, FunctionInfo>();
const suffixes = [...COMBINATORS].sort((a, b) => b.name.length - a.name.length);

/** Apply a suffix to the arguments of its nested aggregate. */
function combinedFunction(name: string, base: FunctionInfo, combinator: CombinatorInfo): FunctionInfo {
  let args = [...(base.arguments ?? [])];
  let parameters = [...(base.parameters ?? [])];
  let syntax = (base.syntax ?? `${base.name}(${args.map((a) => a.name).join(", ")})`).replaceAll(base.name, name);
  const append = (arg: Argument) => {
    args.push(arg);
    syntax = syntax.split("\n").map((line) => {
      const close = line.lastIndexOf(")");
      return line.slice(0, close) + (line[close - 1] === "(" ? "" : ", ") + arg.name + line.slice(close);
    }).join("\n");
  };
  switch (combinator.name) {
    case "If": append({ name: "condition", description: "Only aggregate rows where this condition is true.", types: ["UInt8"] }); break;
    case "ArgMin":
    case "ArgMax": append({ name: "key", description: "Comparable expression selecting the rows to aggregate." }); break;
    case "Resample": {
      const resampling = ["start", "end", "step"].map((name) => ({ name, description: `Resampling ${name}.`, types: ["Int64", "UInt64"] }));
      syntax = syntax.split("\n").map((line) => {
        const at = /\)\s*\(/.test(line) ? line.indexOf(")") : line.indexOf("(");
        const names = resampling.map((a) => a.name).join(", ");
        return /\)\s*\(/.test(line) ? line.slice(0, at) + `, ${names}` + line.slice(at)
          : line.slice(0, at) + `(${names})` + line.slice(at);
      }).join("\n");
      parameters = [...parameters, ...resampling];
      append({ name: "resampling_key", description: "Numeric expression assigning each row to an interval.", types: ["Int64", "UInt64"] });
      break;
    }
    case "Merge":
      args = [{ name: "state", description: "Intermediate aggregate state.", types: ["AggregateFunction"] }];
      syntax = `${name}(state)`;
      parameters = [];
      break;
    case "Map": {
      append({ name: "key", description: "Key used to group the nested aggregate's arguments." });
      const mapSyntax = `${name}${parameters.length ? `(${parameters.map((a) => a.name).join(", ")})` : ""}(map)`;
      syntax = `${mapSyntax}\n${syntax}`;
      args = [{ name: "map", description: "Map whose values are aggregated by key.", types: ["Map"] }, ...args];
      break;
    }
    case "Array":
    case "ForEach":
    case "Tuple":
      args = args.map((a) => ({ ...a, description: `${combinator.name === "Tuple" ? "Tuple" : "Array"} of values for ${a.name}.`, types: [combinator.name === "Tuple" ? "Tuple" : "Array"] }));
      break;
  }
  return { name, aggregate: true, syntax, arguments: args, parameters, description: [base.description, combinator.description].filter(Boolean).join("\n\n") };
}

function fenced(code: string): string {
  return `\`\`\`sql\n${code}\n\`\`\``;
}

function argumentLines(title: string, list: readonly Argument[] | undefined): string {
  if (!list?.length) return "";
  return `**${title}**\n\n${list.map((a) => `- \`${a.name}\` — ${a.description}`).join("\n")}`;
}

function paragraphs(...parts: (string | undefined)[]): string {
  return parts.filter((part) => part).join("\n\n");
}

const functionDocs = new Map<FunctionInfo, string>();

/** The syntax, description, arguments and result of a function; an alias shows its target. */
export function functionDocumentation(info: FunctionInfo): string {
  let docs = functionDocs.get(info);
  if (docs === undefined) {
    const target = info.aliasTo ? (findFunction(info.aliasTo) ?? info) : info;
    docs = paragraphs(
      target.syntax && fenced(target.syntax),
      info.aliasTo && `Alias of \`${info.aliasTo}\`.`,
      target.description,
      argumentLines("Parameters", target.parameters),
      argumentLines("Arguments", target.arguments),
      target.returns && `**Returns** ${target.returns}`,
    );
    functionDocs.set(info, docs);
  }
  return docs;
}

export function settingDocumentation(info: SettingInfo): string {
  const value = info.default === undefined ? `\`${info.type}\`` : `\`${info.type}\`, default \`${info.default}\``;
  return paragraphs(value, info.aliasTo && `Alias of \`${info.aliasTo}\`.`, info.description);
}

export function engineDocumentation(info: TableEngineInfo): string {
  return paragraphs(info.syntax && fenced(info.syntax), info.description);
}

export function formatDetail(info: FormatInfo): string {
  if (info.input && info.output) return "input and output format";
  return info.input ? "input format" : "output format";
}

export function formatDocumentation(info: FormatInfo): string {
  return paragraphs(info.description, `An ${formatDetail(info)}.`);
}

export function tableFunctionDocumentation(info: TableFunctionInfo): string {
  return paragraphs(info.syntax && fenced(info.syntax), info.description, argumentLines("Arguments", info.arguments));
}

export function combinatorDocumentation(info: CombinatorInfo): string {
  return paragraphs(info.syntax && fenced(info.syntax), info.description);
}

/** The documented arguments of a function, each with the kind that its documentation tells. */
function withKinds(info: FunctionInfo, list: readonly Argument[] | undefined): ArgumentInfo[] | undefined {
  return list?.map((arg) => {
    const kind = argumentKind(info, arg);
    return kind ? { ...arg, kind } : arg;
  });
}

const DESCRIBED: CompletionKind[] = ["function", "setting", "table function", "table engine", "format", "combinator"];

/** What the documentation of ClickHouse says about a name: as a `kind` of name, or as the first kind that has it. */
export function describe(name: string, kind?: CompletionKind): Description | undefined {
  if (kind) return describeAs(name, kind);
  for (const k of DESCRIBED) {
    const found = describeAs(name, k);
    if (found) return found;
  }
  return undefined;
}

function describeAs(name: string, kind: CompletionKind): Description | undefined {
  switch (kind) {
    case "function": {
      const info = findFunction(name);
      if (!info) return undefined;
      const target = info.aliasTo ? (findFunction(info.aliasTo) ?? info) : info;
      return {
        name: info.name,
        kind,
        documentation: functionDocumentation(info),
        syntax: target.syntax,
        arguments: withKinds(target, target.arguments),
        parameters: withKinds(target, target.parameters),
      };
    }
    case "setting": {
      const info = SETTINGS.find((s) => s.name === name);
      return info && { name: info.name, kind, documentation: settingDocumentation(info) };
    }
    case "table function": {
      const info = TABLE_FUNCTIONS.find((f) => f.name === name);
      return info && { name: info.name, kind, documentation: tableFunctionDocumentation(info), syntax: info.syntax, arguments: withKinds(info, info.arguments) };
    }
    case "table engine": {
      const info = TABLE_ENGINES.find((e) => e.name === name);
      if (!info) return undefined;
      // The call and its parameters for signature help, where the syntax reads as one.
      const signature = engineSignature(info);
      const syntax = signature?.label ?? info.syntax;
      const args = signature?.parameters.map((p) => ({ name: p.name, description: parameterDescription(p) }));
      return { name: info.name, kind, documentation: engineDocumentation(info), syntax, arguments: args };
    }
    case "format": {
      const info = FORMATS.find((f) => f.name === name);
      return info && { name: info.name, kind, documentation: formatDocumentation(info) };
    }
    case "combinator": {
      const info = COMBINATORS.find((c) => c.name === name);
      return info && { name: info.name, kind, documentation: combinatorDocumentation(info), syntax: info.syntax };
    }
    default:
      return undefined;
  }
}
