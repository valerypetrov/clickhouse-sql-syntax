import { check } from "./parser/index.js";
import { checkOptions } from "./options/index.js";
import { complete, describe, engineArgument, functionArgument } from "./complete/index.js";
import { format, split } from "./format/index.js";
import { highlight } from "./highlight/index.js";
import { tokenize } from "./lexer/index.js";
import { foldingRanges, outline, selectionRanges } from "./structure/index.js";
import { definition, objectDefinitions, objectReferences, objects, prepareRename, references, rename } from "./names/index.js";
import type { ClickHouseSqlSyntax } from "./types.js";

export * from "./types.js";
export { DATA_TYPES, type DataTypeName } from "./generated/data-types.js";
export { KEYWORDS } from "./generated/keywords.js";
export { SYSTEM_COMMANDS } from "./highlight/index.js";
export { checkWithRoles, ParseCache, roles, type Role, type RoleSpan } from "./parser/index.js";
export type { Unit } from "./format/index.js";
export {
  check, checkOptions, complete, definition, describe, engineArgument, foldingRanges, format, functionArgument, highlight, objectDefinitions,
  objectReferences, objects, outline, prepareRename, references, rename, selectionRanges, split, tokenize,
};

// Typed against the interface, so an implementation that drifts from the API fails to compile.
const api: ClickHouseSqlSyntax = {
  tokenize, highlight, check, checkOptions, format, complete, describe, foldingRanges, outline, selectionRanges, definition, references,
  prepareRename, rename, objects, objectReferences, objectDefinitions,
};
export default api;
