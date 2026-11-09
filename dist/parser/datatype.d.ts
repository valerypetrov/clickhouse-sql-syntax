/**
 * Data types: a port of src/Parsers/ParserDataType.cpp.
 * The result is a DataType node with the type name and its arguments as children.
 */
import { Ast } from "./ast.js";
import { type LiteralAsText } from "./elements.js";
import { P } from "./state.js";
/** IParserNameTypePair: name Type. */
export declare function parseNameTypePair(p: P): Ast | null;
/** ParserDataType: a type name with optional arguments, including the SQL-standard multi-word names. */
export declare function parseDataType(p: P): Ast | null;
/** parseDataTypeAsText: the type as written, or null if there is no type here. */
export declare function parseDataTypeAsText(p: P): string | null;
/** typeReadsLiteralExactly: whether a cast of this literal to the type goes as text. */
export declare function typeReadsLiteralExactly(typeText: string, value: LiteralAsText): boolean;
//# sourceMappingURL=datatype.d.ts.map