import { check } from "./parser/index.js";
import { checkOptions } from "./options/index.js";
import { complete, describe, engineArgument, functionArgument, keywordDocumentation, parameterHints } from "./complete/index.js";
import { format, split } from "./format/index.js";
import { highlight } from "./highlight/index.js";
import { tokenize } from "./lexer/index.js";
import { foldingRanges, outline, selectionRanges } from "./structure/index.js";
import { definition, objectDefinitions, objectReferences, objects, prepareRename, references, rename } from "./names/index.js";
export * from "./types.js";
export { DATA_TYPES } from "./generated/data-types.js";
export { KEYWORDS } from "./generated/keywords.js";
export { SYSTEM_COMMANDS } from "./highlight/index.js";
export { messageFixes, nameHints, replaceFixes } from "./options/index.js";
export { checkWithRoles, ParseCache, roles } from "./parser/index.js";
export { check, checkOptions, complete, definition, describe, engineArgument, foldingRanges, format, functionArgument, highlight, keywordDocumentation, objectDefinitions, objectReferences, objects, outline, parameterHints, prepareRename, references, rename, selectionRanges, split, tokenize, };
// Typed against the interface, so an implementation that drifts from the API fails to compile.
const api = {
    tokenize, highlight, check, checkOptions, format, complete, describe, foldingRanges, outline, selectionRanges, definition, references,
    prepareRename, rename, objects, objectReferences, objectDefinitions,
};
export default api;
//# sourceMappingURL=index.js.map