/**
 * The names ClickHouse knows, from the generated catalog, with their documentation as Markdown.
 */
import { COMBINATORS, type CombinatorInfo } from "../generated/combinators.js";
import { FORMATS, type FormatInfo } from "../generated/formats.js";
import { type Argument, FUNCTIONS, type FunctionInfo } from "../generated/functions.js";
import { SETTINGS, type SettingInfo } from "../generated/settings.js";
import { TABLE_ENGINES, type TableEngineInfo } from "../generated/table-engines.js";
import { TABLE_FUNCTIONS, type TableFunctionInfo } from "../generated/table-functions.js";
import type { CompletionKind, Description } from "../types.js";

const functionsByName = new Map(FUNCTIONS.map((f) => [f.name, f]));
const functionsByLowerName = new Map(FUNCTIONS.filter((f) => f.caseInsensitive).map((f) => [f.name.toLowerCase(), f]));

/** The aggregate functions, the names that take combinators. */
export const AGGREGATES = FUNCTIONS.filter((f) => f.aggregate);

/** A function by the name a query uses, in any case for case-insensitive ones. */
export function findFunction(name: string): FunctionInfo | undefined {
  return functionsByName.get(name) ?? functionsByLowerName.get(name.toLowerCase());
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
  return info.description ?? "";
}

export function combinatorDocumentation(info: CombinatorInfo): string {
  return paragraphs(info.syntax && fenced(info.syntax), info.description);
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
        arguments: target.arguments,
        parameters: target.parameters,
      };
    }
    case "setting": {
      const info = SETTINGS.find((s) => s.name === name);
      return info && { name: info.name, kind, documentation: settingDocumentation(info) };
    }
    case "table function": {
      const info = TABLE_FUNCTIONS.find((f) => f.name === name);
      return info && { name: info.name, kind, documentation: tableFunctionDocumentation(info) };
    }
    case "table engine": {
      const info = TABLE_ENGINES.find((e) => e.name === name);
      return info && { name: info.name, kind, documentation: engineDocumentation(info), syntax: info.syntax };
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
