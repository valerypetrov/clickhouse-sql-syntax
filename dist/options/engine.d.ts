import { type Fix, type Token } from "../types.js";
export declare const ENGINE_REQUIRED = "Table engine is not specified in CREATE query.";
/** For a SET statement that sets default_table_engine: whether it sets it to None; undefined for any other statement. */
export declare function setsNoEngine(sql: string, tokens: readonly Token[]): boolean | undefined;
/** The table name of a CREATE TABLE that needs an engine and has none, with the fix that adds ENGINE = MergeTree. */
export declare function missingEngine(sql: string, tokens: readonly Token[], isKeyword: (token: Token) => boolean): {
    name: Token;
    fix: Fix;
} | undefined;
//# sourceMappingURL=engine.d.ts.map