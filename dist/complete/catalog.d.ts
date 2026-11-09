/**
 * The names ClickHouse knows, from the generated catalog, with their documentation as Markdown.
 */
import { type CombinatorInfo } from "../generated/combinators.js";
import { type FormatInfo } from "../generated/formats.js";
import { type FunctionInfo } from "../generated/functions.js";
import { settingDocumentation } from "../options/index.js";
import { type TableEngineInfo } from "../generated/table-engines.js";
import { type TableFunctionInfo } from "../generated/table-functions.js";
import type { CompletionKind, Description } from "../types.js";
/** A table function by its registered name. */
export declare function findTableFunction(name: string): TableFunctionInfo | undefined;
/** The aggregate functions, the names that take combinators. */
export declare const AGGREGATES: FunctionInfo[];
/** A function by the name a query uses, in any case for case-insensitive ones. */
export declare function findFunction(name: string): FunctionInfo | undefined;
/** The syntax, description, arguments and result of a function; an alias shows its target. */
export declare function functionDocumentation(info: FunctionInfo): string;
export { settingDocumentation };
export declare function engineDocumentation(info: TableEngineInfo): string;
export declare function formatDetail(info: FormatInfo): string;
export declare function formatDocumentation(info: FormatInfo): string;
export declare function tableFunctionDocumentation(info: TableFunctionInfo): string;
export declare function combinatorDocumentation(info: CombinatorInfo): string;
/** What the documentation of ClickHouse says about a name: as a `kind` of name, or as the first kind that has it. */
export declare function describe(name: string, kind?: CompletionKind): Description | undefined;
//# sourceMappingURL=catalog.d.ts.map