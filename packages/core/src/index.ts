import { check } from "./parser/index.js";
import { complete, describe } from "./complete/index.js";
import { format, split } from "./format/index.js";
import { highlight } from "./highlight/index.js";
import { tokenize } from "./lexer/index.js";
import { foldingRanges, outline, selectionRanges } from "./structure/index.js";
import type { ClickHouseSqlSyntax } from "./types.js";

export * from "./types.js";
export { DATA_TYPES, type DataTypeName } from "./generated/data-types.js";
export { KEYWORDS } from "./generated/keywords.js";
export { SYSTEM_COMMANDS } from "./highlight/index.js";
export { checkWithRoles, ParseCache, roles, type Role, type RoleSpan } from "./parser/index.js";
export type { Unit } from "./format/index.js";
export { check, complete, describe, foldingRanges, format, highlight, outline, selectionRanges, split, tokenize };

// Typed against the interface, so an implementation that drifts from the API fails to compile.
const api: ClickHouseSqlSyntax = { tokenize, highlight, check, format, complete, describe, foldingRanges, outline, selectionRanges };
export default api;
