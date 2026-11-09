/**
 * The parser state: a port of IParser::Pos, Tokens and Expected from ClickHouse.
 * A parser function takes a P and returns a node, or null and leaves p.i where it was.
 */
import { TokenKind as T, isErrorKind } from "../types.js";
export { T };
/** ClickHouse's max_parser_depth and max_parser_backtracks defaults. */
export const MAX_PARSER_DEPTH = 1000;
export const MAX_PARSER_BACKTRACKS = 1_000_000;
/** Backtracks shared by all statements of one check() call: about a second of work. */
export class Budget {
    backtracks = 2 * MAX_PARSER_BACKTRACKS;
    /** Tokens parsed again, as after a backtrack; only the keyword probes of complete() limit them. */
    tokens = Infinity;
}
/** Thrown when a check() call has used up its Budget. */
export class OutOfBudget extends Error {
}
/**
 * What the parser could accept at the rightmost position it reached, like ClickHouse's Expected.
 * ClickHouse compares the descriptions by pointer, so `ids` keeps what tells two equal texts apart.
 */
export class Expected {
    /** Token index of the position, -1 when nothing was added yet. */
    pos = -1;
    variants = [];
    ids = [];
    add(pos, description, id = description) {
        if (this.pos < 0 || pos > this.pos) {
            this.variants = [description];
            this.ids = [id];
            this.pos = pos;
        }
        else if (pos === this.pos && !this.ids.includes(id)) {
            this.variants.push(description);
            this.ids.push(id);
        }
    }
    /** expected.variants.clear(): keeps the position. */
    clearVariants() {
        this.variants = [];
        this.ids = [];
    }
    copy() {
        const result = new Expected();
        result.assign(this);
        return result;
    }
    assign(other) {
        this.pos = other.pos;
        this.variants = [...other.variants];
        this.ids = [...other.ids];
    }
}
/** An exception the parser throws instead of returning false, which ends the whole parse. */
export class ParseError extends Error {
    tokenIndex;
    syntax;
    constructor(message, tokenIndex, 
    /** True for ClickHouse's SYNTAX_ERROR code, false for other codes such as BAD_ARGUMENTS. */
    syntax = true) {
        super(message);
        this.tokenIndex = tokenIndex;
        this.syntax = syntax;
    }
}
export class P {
    toks;
    sql;
    budget;
    /** Current token index; it may run past the last token like a C++ iterator. */
    i;
    /** Rightmost token index looked at, like Tokens::max(). */
    maxIndex;
    e = new Expected();
    depth = 0;
    backtracks = 0;
    /** Where the roles of consumed words go, when someone asked for them. */
    roles;
    /** Where the names analysis marks go, along with the roles. */
    names;
    last;
    lowered = [];
    constructor(toks, sql, start = 0, budget) {
        this.toks = toks;
        this.sql = sql;
        this.budget = budget;
        this.last = toks.length - 1;
        this.i = start;
        this.maxIndex = start;
    }
    /** The token at index i, recording that the parser looked at it. */
    at(i) {
        const index = i < this.last ? i : this.last;
        if (index > this.maxIndex)
            this.maxIndex = index;
        return this.toks[index];
    }
    tok() {
        return this.at(this.i);
    }
    kind() {
        return this.at(this.i).kind;
    }
    kindAt(i) {
        return this.at(i).kind;
    }
    textAt(i) {
        const token = this.at(i);
        return this.sql.slice(token.start, token.end);
    }
    text() {
        return this.textAt(this.i);
    }
    lowerAt(i) {
        const index = i < this.last ? i : this.last;
        this.at(index);
        let value = this.lowered[index];
        if (value === undefined) {
            value = this.textAt(index).toLowerCase();
            this.lowered[index] = value;
        }
        return value;
    }
    lower() {
        return this.lowerAt(this.i);
    }
    /** Neither the end nor an error token: TokenIterator::isValid(). */
    validAt(i) {
        const kind = this.kindAt(i);
        return kind !== T.EndOfStream && !isErrorKind(kind);
    }
    valid() {
        return this.validAt(this.i);
    }
    isEnd(i = this.i) {
        return this.kindAt(i) === T.EndOfStream;
    }
    /** Is the token a bare word equal to `word`, given in lower case? */
    isWord(word, i = this.i) {
        return this.kindAt(i) === T.BareWord && this.lowerAt(i) === word;
    }
    /** Token index as a position for Expected, clamped like the C++ token stream. */
    posOf(i) {
        this.at(i);
        return i < this.last ? i : this.last;
    }
    /** expected.add(pos, description). */
    expect(description, i = this.i, id = description) {
        this.e.add(this.posOf(i), description, id);
    }
    /** Moves back to an earlier position, counting backtracks as ClickHouse does. */
    restore(i) {
        if (i < this.i) {
            this.backtracks++;
            if (this.backtracks > MAX_PARSER_BACKTRACKS)
                throw new ParseError(`Maximum amount of backtracking (${MAX_PARSER_BACKTRACKS}) exceeded in the parser. ` +
                    "Consider rising max_parser_backtracks parameter.", this.i, false);
            if (this.budget && (--this.budget.backtracks < 0 || (this.budget.tokens -= this.i - i) < 0))
                throw new OutOfBudget();
        }
        this.i = i;
        this.roles?.rewind(i);
        this.names?.rewind(i);
    }
    /** The tokens from `from` up to `to` have `role`. */
    mark(from, role, to = this.i) {
        this.roles?.mark(from, to, role);
    }
    increaseDepth() {
        this.depth++;
        if (this.depth > MAX_PARSER_DEPTH)
            throw new ParseError(`Maximum parse depth (${MAX_PARSER_DEPTH}) exceeded. Consider rising max_parser_depth parameter.`, this.i, false);
    }
    /** Runs `body` with its own Expected, so that what it adds is thrown away. */
    quiet(body, expected = new Expected()) {
        const saved = this.e;
        this.e = expected;
        try {
            return body();
        }
        finally {
            this.e = saved;
        }
    }
    fail(message, i = this.i) {
        throw new ParseError(message, i);
    }
    /** An exception with a code other than SYNTAX_ERROR. */
    failOther(message, i = this.i) {
        throw new ParseError(message, i, false);
    }
}
/**
 * IParserBase::parse: names the parser in Expected, counts the depth and
 * moves back to the start when the body fails.
 */
export function base(p, name, body) {
    p.expect(name);
    const begin = p.i;
    const depth = p.depth;
    p.increaseDepth();
    const result = body();
    p.depth = depth;
    if (result === null || result === undefined || result === false) {
        p.restore(begin);
        return null;
    }
    // IParserBase::parse reads the token after a successful parse, which counts as looking at it.
    p.at(p.i);
    return result;
}
/** Runs `body` and moves back if it fails, like IParser::check or a saved Pos. */
export function attempt(p, body) {
    const begin = p.i;
    const depth = p.depth;
    const result = body();
    if (result === null || result === undefined || result === false) {
        p.restore(begin);
        p.depth = depth;
        return null;
    }
    return result;
}
/**
 * Runs `body` on a copy of the position, like a C++ Pos passed by value: the position,
 * depth and backtrack count come back afterwards. With `expected`, Expected is left alone too.
 */
export function lookahead(p, body, expected) {
    const { i, depth, backtracks } = p;
    try {
        return expected ? p.quiet(body, expected) : body();
    }
    finally {
        p.i = i;
        p.depth = depth;
        p.backtracks = backtracks;
        p.roles?.rewind(i);
        p.names?.rewind(i);
    }
}
const keywordInfo = new Map();
function infoOf(keyword) {
    let info = keywordInfo.get(keyword);
    if (!info) {
        const words = keyword.split(" ");
        const descriptions = words.map((_, index) => words.slice(index).join(" "));
        info = {
            lowerWords: words.map((word) => word.toLowerCase()),
            descriptions,
            // The tail of a keyword is a pointer into the middle of the keyword string.
            ids: descriptions.map((text, index) => (index === 0 ? text : `${keyword}@${index}`)),
        };
        keywordInfo.set(keyword, info);
    }
    return info;
}
/**
 * ParserKeyword(keyword).ignore(pos, expected). An `id` tells this keyword apart from another
 * one with the same text, as two keyword strings at different addresses are in ClickHouse.
 */
export function kw(p, keyword, id) {
    const info = infoOf(keyword);
    const ids = id === undefined ? info.ids : info.ids.map((_, w) => (w === 0 ? id : `${id}@${w}`));
    p.expect(keyword, p.i, ids[0]);
    if (p.depth + 1 > MAX_PARSER_DEPTH)
        p.increaseDepth();
    const begin = p.i;
    if (p.kind() !== T.BareWord)
        return false;
    for (let w = 0; w < info.lowerWords.length; w++) {
        p.expect(info.descriptions[w], p.i, ids[w]);
        if (p.kind() !== T.BareWord || p.lower() !== info.lowerWords[w]) {
            p.restore(begin);
            return false;
        }
        p.i++;
    }
    p.mark(begin, "keyword");
    p.at(p.i);
    return true;
}
/** ParserKeyword(keyword).checkWithoutMoving(pos, expected). */
export function peekKw(p, keyword) {
    const begin = p.i;
    const ok = kw(p, keyword);
    p.i = begin;
    p.roles?.rewind(begin);
    p.names?.rewind(begin);
    return ok;
}
/** ParserKeyword(keyword).checkWithoutMoving(pos, stub): looks ahead without touching Expected. */
export function peekKwQuiet(p, keyword) {
    return p.quiet(() => peekKw(p, keyword));
}
/** ParserKeyword(keyword).ignore(pos), with a throwaway Expected. */
export function kwQuiet(p, keyword) {
    return p.quiet(() => kw(p, keyword));
}
/** ParserToken(kind).ignore(pos, expected). */
export function tok(p, kind) {
    p.expect("token");
    if (p.depth + 1 > MAX_PARSER_DEPTH)
        p.increaseDepth();
    if (p.kind() !== kind) {
        p.expect(kind);
        return false;
    }
    p.i++;
    p.at(p.i);
    return true;
}
/** ParserToken(kind).ignore(pos), with a throwaway Expected. */
export function tokQuiet(p, kind) {
    return p.quiet(() => tok(p, kind));
}
/** ParserTokenSequence(kinds).ignore(pos, expected). */
export function tokSeq(p, kinds) {
    return (base(p, "token sequence", () => {
        for (const kind of kinds) {
            if (p.kind() !== kind) {
                p.expect(kind);
                return false;
            }
            p.i++;
        }
        return true;
    }) !== null);
}
/**
 * ParserList::parseUtil: elements with separators. A separator not followed
 * by an element is left unparsed unless trailing separators are allowed.
 */
export function listUtil(p, element, separator = () => tok(p, T.Comma), allowEmpty = true, allowTrailing = false) {
    let begin = p.i;
    if (!element()) {
        p.restore(begin);
        return allowEmpty;
    }
    for (;;) {
        begin = p.i;
        if (!separator()) {
            p.restore(begin);
            return true;
        }
        const afterSeparator = p.i;
        if (!element()) {
            p.restore(allowTrailing ? afterSeparator : begin);
            return true;
        }
    }
}
/** Case-insensitive ASCII comparison. */
export function equalsIgnoreCase(a, b) {
    return a.length === b.length && a.toLowerCase() === b.toLowerCase();
}
export function isWordChar(c) {
    return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_";
}
export function isDigit(c) {
    return c !== undefined && c >= "0" && c <= "9";
}
//# sourceMappingURL=state.js.map