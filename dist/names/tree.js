/**
 * The queries, tables, aliases, lambdas and identifiers of one statement, nested as the marks of a successful
 * parse show them, so that the structure never comes from guesses over the tokens.
 */
import { quotedName } from "../parser/index.js";
import { TokenKind as T } from "../types.js";
/** The order of marks with the same range, outermost first. */
const PRIORITY = {
    union: 0, query: 1, with: 2, join: 3, table: 4, arrayjoin: 5, interpolate: 6, opaque: 7, matcher: 8, alias: 9,
    lambda: 10, call: 11, ref: 12, settings: 13, object: 14,
};
/** The statement's tree, from the significant tokens of the whole text and the parse of the statement. */
export function buildStatement(sql, tokens, parsed) {
    const first = lowerBound(tokens, parsed.begin);
    let last = first;
    while (last < tokens.length && tokens[last].start < parsed.end && tokens[last].kind !== T.EndOfStream)
        last++;
    const own = tokens.slice(first, last);
    const tokenAt = new Map();
    own.forEach((token, i) => tokenAt.set(token.start, i));
    const statement = {
        sql,
        begin: parsed.begin,
        end: parsed.end,
        roots: [],
        nodes: [],
        parameters: [],
        settings: [],
        groups: [],
        head: [],
        tokens: own,
        tokenAt,
        match: matchBrackets(own),
        enclosing: enclosingBrackets(own),
    };
    statement.head = own.slice(0, 3).map((token) => sql.slice(token.start, token.end).toUpperCase());
    readSpans(sql, statement, parsed.spans);
    const builder = new Builder(sql, statement);
    try {
        builder.build(parsed.names.map((mark) => moved(mark, parsed.begin)));
    }
    catch (error) {
        if (!(error instanceof Unsupported))
            throw error;
        statement.unsupported = error.message;
        statement.roots = [];
        statement.nodes = [];
    }
    return statement;
}
/** The mark with offsets from the start of the text. */
function moved(mark, by) {
    const move = (range) => range && [range[0] + by, range[1] + by];
    return { ...mark, start: mark.start + by, end: mark.end + by, name: move(mark.name), part: move(mark.part), alias: move(mark.alias) };
}
/** The structure is not one this analysis follows. */
export class Unsupported extends Error {
}
function lowerBound(tokens, offset) {
    let lo = 0;
    let hi = tokens.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (tokens[mid].start < offset)
            lo = mid + 1;
        else
            hi = mid;
    }
    return lo;
}
function matchBrackets(tokens) {
    const match = new Int32Array(tokens.length).fill(-1);
    const stack = [];
    tokens.forEach((token, i) => {
        if (token.kind === T.OpeningRoundBracket || token.kind === T.OpeningSquareBracket || token.kind === T.OpeningCurlyBrace)
            stack.push(i);
        else if (token.kind === T.ClosingRoundBracket || token.kind === T.ClosingSquareBracket || token.kind === T.ClosingCurlyBrace) {
            const open = stack.pop();
            if (open !== undefined) {
                match[open] = i;
                match[i] = open;
            }
        }
    });
    return match;
}
function enclosingBrackets(tokens) {
    const enclosing = new Int32Array(tokens.length).fill(-1);
    const stack = [];
    tokens.forEach((token, i) => {
        if (token.kind === T.ClosingRoundBracket || token.kind === T.ClosingSquareBracket || token.kind === T.ClosingCurlyBrace)
            stack.pop();
        enclosing[i] = stack.length ? stack[stack.length - 1] : -1;
        if (token.kind === T.OpeningRoundBracket || token.kind === T.OpeningSquareBracket || token.kind === T.OpeningCurlyBrace)
            stack.push(i);
    });
    return enclosing;
}
/** The query parameters, the settings and the leading keywords, from the roles of the words. */
function readSpans(sql, statement, spans) {
    const { tokens, tokenAt } = statement;
    for (const span of spans) {
        const text = sql.slice(span.start, span.end);
        if (span.role === "setting")
            statement.settings.push(text.toLowerCase());
        if (span.role === "keyword" && text.toUpperCase() === "GROUP")
            statement.groups.push(span.start);
        if (span.role === "parameter") {
            const i = tokenAt.get(span.start);
            if (i !== undefined && i > 0 && tokens[i - 1].kind === T.OpeningCurlyBrace && tokens[i].kind === T.BareWord && tokens[i + 1]?.kind === T.Colon)
                statement.parameters.push({ word: { start: span.start, end: span.end, name: text, quoted: false } });
        }
    }
}
class Builder {
    sql;
    statement;
    nextId = 0;
    constructor(sql, statement) {
        this.sql = sql;
        this.statement = statement;
    }
    build(marks) {
        // The alias of a table expression is a table alias, which the table mark carries.
        const tableAliases = new Set(marks.flatMap((mark) => (mark.kind === "table" && mark.alias ? [mark.alias[0]] : [])));
        const sorted = marks
            .filter((mark) => mark.kind !== "settings" && mark.kind !== "object" && !(mark.kind === "alias" && tableAliases.has(mark.name[0])))
            .sort((a, b) => a.start - b.start || b.end - a.end || PRIORITY[a.kind] - PRIORITY[b.kind]);
        const stack = [];
        for (const mark of sorted) {
            const node = this.node(mark);
            while (stack.length && stack[stack.length - 1].end <= node.start)
                stack.pop();
            const parent = stack[stack.length - 1];
            if (parent && node.end > parent.end)
                throw new Unsupported("parts that do not nest");
            if (parent) {
                node.parent = parent;
                parent.children.push(node);
            }
            else {
                this.statement.roots.push(node);
            }
            this.statement.nodes.push(node);
            stack.push(node);
        }
        for (const node of this.statement.nodes)
            if (node.kind === "query")
                node.items = this.items(node);
        // WITH before INSERT belongs to the SELECT after it, which the marks do not show.
        if (this.statement.nodes.some((node) => node.kind === "with" && node.parent?.kind !== "query"))
            throw new Unsupported("a WITH before INSERT");
    }
    node(mark) {
        const base = { id: this.nextId++, start: mark.start, end: mark.end, children: [] };
        switch (mark.kind) {
            case "union":
                return { ...base, kind: "union", pipe: mark.flag === "pipe" };
            case "query":
                return { ...base, kind: "query", recursive: mark.flag === "recursive", projection: mark.part, items: [] };
            case "with":
                return {
                    ...base,
                    kind: "with",
                    name: mark.name ? this.word(mark.name[0]) : undefined,
                    columns: mark.part ? this.names(mark.part) : undefined,
                    materialized: mark.flag === "materialized",
                };
            case "table":
                return this.table(base, mark);
            case "join": {
                const flags = (mark.flag ?? "").split(" ");
                return {
                    ...base,
                    kind: "join",
                    join: flags[0],
                    natural: flags.includes("natural"),
                    lateral: flags.includes("lateral"),
                    using: flags.includes("using") ? mark.part : undefined,
                    on: flags.includes("on") ? mark.part : undefined,
                };
            }
            case "arrayjoin":
                return { ...base, kind: "arrayjoin", left: mark.flag === "left", list: mark.part };
            case "alias":
                return { ...base, kind: "alias", name: this.word(mark.name[0]), body: mark.part, node: mark.flag ?? "other" };
            case "lambda":
                return { ...base, kind: "lambda", params: [], paramsRange: mark.part };
            case "ref": {
                const parts = mark.flag === "param" ? null : this.parts(mark.start, mark.end);
                return { ...base, kind: "ref", parts: parts ?? [], unsupported: parts === null };
            }
            case "call":
                return { ...base, kind: "call", parts: this.parts(mark.start, mark.end) ?? [] };
            case "matcher": {
                const qualifier = mark.name ? (this.parts(mark.name[0], mark.name[1]) ?? undefined) : undefined;
                if (mark.name && !qualifier)
                    throw new Unsupported("a matcher whose qualifier is not a plain name");
                const plain = mark.flag === "Asterisk" || mark.flag === "QualifiedAsterisk";
                return { ...base, kind: "matcher", qualifier, plain };
            }
            case "interpolate":
                return { ...base, kind: "interpolate" };
            case "opaque":
            case "settings":
            case "object":
                return { ...base, kind: "opaque" };
        }
    }
    table(base, mark) {
        const source = (mark.flag ?? "name");
        const i = this.index(mark.start);
        const tokens = this.statement.tokens;
        let name = [];
        if (source === "name") {
            // The table name runs up to its alias, UUID, FINAL or SAMPLE.
            let end = i;
            while (end + 2 < tokens.length && tokens[end + 1].kind === T.Dot && isName(tokens[end + 2]))
                end += 2;
            name = this.parts(tokens[i].start, tokens[end].end) ?? [];
        }
        else if (source === "function") {
            let end = i;
            while (end + 2 < tokens.length && tokens[end + 1].kind === T.Dot && isName(tokens[end + 2]))
                end += 2;
            name = this.parts(tokens[i].start, tokens[end].end) ?? [];
        }
        let alias;
        if (mark.alias) {
            const token = tokens[this.index(mark.alias[0])];
            if (!isName(token))
                throw new Unsupported("a table alias given by a query parameter");
            alias = this.word(mark.alias[0]);
        }
        return { ...base, kind: "table", source, name, alias, columns: mark.part ? this.names(mark.part) : undefined };
    }
    /** The select list split at its top-level commas, each item matched with the node that covers it. */
    items(query) {
        if (!query.projection)
            return [];
        const { tokens, match } = this.statement;
        const [from, to] = query.projection;
        const items = [];
        const children = query.children;
        let next = 0;
        let i = this.index(from);
        while (i < tokens.length && tokens[i].start < to) {
            const begin = i;
            while (i < tokens.length && tokens[i].start < to && tokens[i].kind !== T.Comma) {
                i = match[i] > i ? match[i] + 1 : i + 1;
            }
            const start = tokens[begin].start;
            const end = tokens[i - 1].end;
            while (next < children.length && children[next].start < start)
                next++;
            const child = children[next];
            const node = child && child.start === start && child.end === end ? child : undefined;
            if (node?.kind === "alias")
                items.push({ kind: "alias", node, start, end });
            else if (node?.kind === "ref")
                items.push({ kind: "ref", node, start, end });
            else if (node?.kind === "matcher")
                items.push({ kind: "matcher", node, start, end });
            else
                items.push({ kind: "expression", start, end });
            i++;
        }
        return items;
    }
    index(offset) {
        const i = this.statement.tokenAt.get(offset);
        if (i === undefined)
            throw new Unsupported("parts that do not start at a token");
        return i;
    }
    word(offset) {
        const token = this.statement.tokens[this.index(offset)];
        const name = nameOf(this.sql, token);
        if (name === undefined)
            throw new Unsupported("a name given by a query parameter");
        return { start: token.start, end: token.end, name, quoted: token.kind === T.QuotedIdentifier };
    }
    /** The names of a comma-separated list of plain names. */
    names([from, to]) {
        const tokens = this.statement.tokens;
        const words = [];
        for (let i = this.index(from); i < tokens.length && tokens[i].start < to; i++) {
            if (tokens[i].kind === T.Comma)
                continue;
            words.push(this.word(tokens[i].start));
        }
        return words;
    }
    /** The parts of a.b.c from `start` to `end`, or null when they are not plain names joined by dots. */
    parts(start, end) {
        const tokens = this.statement.tokens;
        const words = [];
        let i = this.index(start);
        for (;;) {
            const token = tokens[i];
            if (!token || !isName(token))
                return null;
            const name = nameOf(this.sql, token);
            if (name === undefined)
                return null;
            words.push({ start: token.start, end: token.end, name, quoted: token.kind === T.QuotedIdentifier });
            if (token.end === end)
                return words;
            if (tokens[i + 1]?.kind !== T.Dot)
                return null;
            i += 2;
        }
    }
}
function isName(token) {
    return token.kind === T.BareWord || token.kind === T.QuotedIdentifier;
}
/** The name a word token stands for. */
export function nameOf(sql, token) {
    const text = sql.slice(token.start, token.end);
    if (token.kind === T.BareWord)
        return text;
    if (token.kind === T.QuotedIdentifier)
        return quotedName(text);
    return undefined;
}
//# sourceMappingURL=tree.js.map