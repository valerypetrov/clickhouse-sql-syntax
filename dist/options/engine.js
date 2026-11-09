/**
 * CREATE TABLE without ENGINE after SET default_table_engine = 'None', which ClickHouse refuses with ENGINE_REQUIRED.
 */
import { stringLiteralValue } from "../parser/index.js";
import { TokenKind as T } from "../types.js";
export const ENGINE_REQUIRED = "Table engine is not specified in CREATE query.";
const wordOf = (sql, token) => (token?.kind === T.BareWord ? sql.slice(token.start, token.end).toLowerCase() : undefined);
/** For a SET statement that sets default_table_engine: whether it sets it to None; undefined for any other statement. */
export function setsNoEngine(sql, tokens) {
    if (wordOf(sql, tokens[0]) !== "set")
        return undefined;
    let found;
    for (let i = 1; i + 2 < tokens.length; i++)
        if (wordOf(sql, tokens[i]) === "default_table_engine" && tokens[i + 1].kind === T.Equals) {
            const value = tokens[i + 2];
            found = value.kind === T.StringLiteral && stringLiteralValue(sql.slice(value.start, value.end)) === "None";
        }
    return found;
}
// The clauses of CREATE TABLE that come after its engine.
const AFTER_ENGINE = new Set(["partition", "primary", "order", "sample", "ttl", "settings", "comment", "empty", "as"]);
/** The table name of a CREATE TABLE that needs an engine and has none, with the fix that adds ENGINE = MergeTree. */
export function missingEngine(sql, tokens, isKeyword) {
    let i = 0;
    const w = (j) => wordOf(sql, tokens[j]);
    if (w(0) === "create" && w(1) === "or" && w(2) === "replace")
        i = 3;
    else if (w(0) === "create" || w(0) === "replace")
        i = 1;
    else
        return undefined;
    if (w(i) !== "table")
        return undefined;
    i++;
    if (w(i) === "if" && w(i + 1) === "not" && w(i + 2) === "exists")
        i += 3;
    const name = tokens[i];
    if (!name)
        return undefined;
    let depth = 0;
    let at;
    let columns = false;
    let ordered = false;
    for (let j = i + 1; j < tokens.length; j++) {
        const token = tokens[j];
        if (token.kind === T.OpeningRoundBracket) {
            if (depth++ === 0 && !at)
                columns = true;
            continue;
        }
        if (token.kind === T.ClosingRoundBracket)
            depth--;
        if (depth > 0 || !isKeyword(token))
            continue;
        const keyword = w(j);
        if (keyword === "engine")
            return undefined;
        // AS another table or table function takes its engine, and CLONE AS too.
        if (keyword === "as" && !at && !["select", "with"].includes(w(j + 1) ?? "") && tokens[j + 1]?.kind !== T.OpeningRoundBracket)
            return undefined;
        if (keyword === "order" || keyword === "primary")
            ordered = true;
        if (keyword && AFTER_ENGINE.has(keyword))
            at ??= token;
        // The SELECT after AS makes the columns, and its clauses are not the table's.
        if (keyword === "as") {
            columns = true;
            break;
        }
    }
    if (!columns)
        return undefined;
    const engine = `ENGINE = MergeTree${ordered ? "" : " ORDER BY tuple()"}`;
    const last = tokens[tokens.length - 1];
    const edit = at ? { start: at.start, end: at.start, newText: `${engine} ` } : { start: last.end, end: last.end, newText: ` ${engine}` };
    return { name, fix: { title: `Add ${engine}`, edits: [edit], preferred: true } };
}
//# sourceMappingURL=engine.js.map