import { check } from "./parser/index.js";
import { highlight } from "./highlight/index.js";
import { tokenize } from "./lexer/index.js";
import type { ClickHouseSqlSyntax } from "./types.js";

export * from "./types.js";
export { DATA_TYPES, type DataTypeName } from "./generated/data-types.js";
export { KEYWORDS } from "./generated/keywords.js";
export { check, highlight, tokenize };

// Typed against the interface, so an implementation that drifts from the API fails to compile.
const api: ClickHouseSqlSyntax = { tokenize, highlight, check };
export default api;
