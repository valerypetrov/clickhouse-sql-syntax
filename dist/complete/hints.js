/**
 * parameterHints(): the documented parameter that each argument of a call is, for inlay hints.
 */
import { split } from "../format/index.js";
import { checkWithRoles } from "../parser/index.js";
import { isSignificant, TokenKind as T } from "../types.js";
import { engineCall } from "./engines.js";
import { functionCall } from "./functions.js";
import { nameOf } from "./schema.js";
const OPENING = new Set([T.OpeningRoundBracket, T.OpeningSquareBracket, T.OpeningCurlyBrace]);
const CLOSING = new Set([T.ClosingRoundBracket, T.ClosingSquareBracket, T.ClosingCurlyBrace]);
/** The tokens of each argument at the top level of the brackets opened at `open`, as [start, end) indices. */
function argumentSpans(tokens, open) {
    const spans = [];
    let start = open + 1;
    for (let i = open + 1, depth = 0; i < tokens.length; i++) {
        const kind = tokens[i].kind;
        if (OPENING.has(kind))
            depth++;
        else if (CLOSING.has(kind) && depth-- === 0)
            return [...spans, [start, i]];
        else if (kind === T.Comma && depth === 0) {
            spans.push([start, i]);
            start = i + 1;
        }
    }
    return [...spans, [start, tokens.length]];
}
/** The index of the bracket that opens the one that closes at `close`. */
function openingOf(tokens, close) {
    for (let i = close, depth = 0; i >= 0; i--) {
        if (CLOSING.has(tokens[i].kind))
            depth++;
        else if (OPENING.has(tokens[i].kind) && --depth === 0)
            return i;
    }
    return -1;
}
/** Whether the argument is already a name equal to the parameter, as `unit` or `t.unit` for unit. */
function saysIt(sql, tokens, [start, end], name) {
    for (let i = start; i < end; i++)
        if ((end - 1 - i) % 2 === 1 ? tokens[i].kind !== T.Dot : nameOf(sql, tokens[i]) === undefined)
            return false;
    return nameOf(sql, tokens[end - 1])?.toLowerCase() === name.toLowerCase();
}
/**
 * The parameter of each argument of the function, table function and engine calls with two arguments or more, in the
 * statements that parse, where the parser reads the name as a function or an engine.
 */
export function parameterHints(sql, cache) {
    const calls = new Set(checkWithRoles(sql, cache).spans.filter((s) => s.role === "function" || s.role === "engine").map((s) => s.start));
    const hints = [];
    for (const unit of split(sql)) {
        if (!unit.statement)
            continue;
        const statement = unit.tokens.filter((t) => isSignificant(t.kind) && t.kind !== T.Semicolon && t.kind !== T.EndOfStream);
        for (let open = 1; open < statement.length; open++) {
            if (statement[open].kind !== T.OpeningRoundBracket)
                continue;
            // The second brackets of name(parameters)(arguments) follow the first ones.
            const name = statement[open - 1].kind === T.ClosingRoundBracket ? statement[openingOf(statement, open - 1) - 1] : statement[open - 1];
            if (!name || !calls.has(name.start))
                continue;
            const spans = argumentSpans(statement, open);
            if (spans.length < 2)
                continue;
            const found = [];
            for (const span of spans) {
                const first = statement[span[0]];
                if (span[0] === span[1] || !first)
                    continue;
                const before = statement.slice(0, span[0]);
                const engine = engineCall(sql, statement, before);
                // An engine argument written `name = value` already says which it is.
                const names = engine
                    ? statement[span[0] + 1]?.kind === T.Equals ? [] : engine.parameters.map((p) => p.name)
                    : (functionCall(sql, statement, before)?.arguments.map((a) => a.arg.name) ?? []);
                if (names.length === 1 && /^\w+$/.test(names[0]) && !saysIt(sql, statement, span, names[0]))
                    found.push({ offset: first.start, name: names[0] });
            }
            // A parameter that repeats, as the values of tuple(), names no argument in particular.
            hints.push(...found.filter((h) => found.filter((o) => o.name === h.name).length === 1));
        }
    }
    return hints;
}
//# sourceMappingURL=hints.js.map