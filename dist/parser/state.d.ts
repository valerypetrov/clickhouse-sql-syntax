/**
 * The parser state: a port of IParser::Pos, Tokens and Expected from ClickHouse.
 * A parser function takes a P and returns a node, or null and leaves p.i where it was.
 */
import { TokenKind as T, type Token } from "../types.js";
import type { NameMarks } from "./names.js";
import type { Role, Roles } from "./roles.js";
export { T };
/** ClickHouse's max_parser_depth and max_parser_backtracks defaults. */
export declare const MAX_PARSER_DEPTH = 1000;
export declare const MAX_PARSER_BACKTRACKS = 1000000;
/** Backtracks shared by all statements of one check() call: about a second of work. */
export declare class Budget {
    backtracks: number;
    /** Tokens parsed again, as after a backtrack; only the keyword probes of complete() limit them. */
    tokens: number;
}
/** Thrown when a check() call has used up its Budget. */
export declare class OutOfBudget extends Error {
}
/**
 * What the parser could accept at the rightmost position it reached, like ClickHouse's Expected.
 * ClickHouse compares the descriptions by pointer, so `ids` keeps what tells two equal texts apart.
 */
export declare class Expected {
    /** Token index of the position, -1 when nothing was added yet. */
    pos: number;
    variants: string[];
    ids: string[];
    add(pos: number, description: string, id?: string): void;
    /** expected.variants.clear(): keeps the position. */
    clearVariants(): void;
    copy(): Expected;
    assign(other: Expected): void;
}
/** An exception the parser throws instead of returning false, which ends the whole parse. */
export declare class ParseError extends Error {
    readonly tokenIndex: number;
    /** True for ClickHouse's SYNTAX_ERROR code, false for other codes such as BAD_ARGUMENTS. */
    readonly syntax: boolean;
    constructor(message: string, tokenIndex: number, 
    /** True for ClickHouse's SYNTAX_ERROR code, false for other codes such as BAD_ARGUMENTS. */
    syntax?: boolean);
}
export declare class P {
    readonly toks: Token[];
    readonly sql: string;
    readonly budget?: Budget | undefined;
    /** Current token index; it may run past the last token like a C++ iterator. */
    i: number;
    /** Rightmost token index looked at, like Tokens::max(). */
    maxIndex: number;
    e: Expected;
    depth: number;
    backtracks: number;
    /** Where the roles of consumed words go, when someone asked for them. */
    roles?: Roles;
    /** Where the names analysis marks go, along with the roles. */
    names?: NameMarks;
    readonly last: number;
    private readonly lowered;
    constructor(toks: Token[], sql: string, start?: number, budget?: Budget | undefined);
    /** The token at index i, recording that the parser looked at it. */
    at(i: number): Token;
    tok(): Token;
    kind(): T;
    kindAt(i: number): T;
    textAt(i: number): string;
    text(): string;
    lowerAt(i: number): string;
    lower(): string;
    /** Neither the end nor an error token: TokenIterator::isValid(). */
    validAt(i: number): boolean;
    valid(): boolean;
    isEnd(i?: number): boolean;
    /** Is the token a bare word equal to `word`, given in lower case? */
    isWord(word: string, i?: number): boolean;
    /** Token index as a position for Expected, clamped like the C++ token stream. */
    posOf(i: number): number;
    /** expected.add(pos, description). */
    expect(description: string, i?: number, id?: string): void;
    /** Moves back to an earlier position, counting backtracks as ClickHouse does. */
    restore(i: number): void;
    /** The tokens from `from` up to `to` have `role`. */
    mark(from: number, role: Role, to?: number): void;
    increaseDepth(): void;
    /** Runs `body` with its own Expected, so that what it adds is thrown away. */
    quiet<R>(body: () => R, expected?: Expected): R;
    fail(message: string, i?: number): never;
    /** An exception with a code other than SYNTAX_ERROR. */
    failOther(message: string, i?: number): never;
}
type Result<R> = R | null | undefined | false;
/**
 * IParserBase::parse: names the parser in Expected, counts the depth and
 * moves back to the start when the body fails.
 */
export declare function base<R>(p: P, name: string, body: () => Result<R>): R | null;
/** Runs `body` and moves back if it fails, like IParser::check or a saved Pos. */
export declare function attempt<R>(p: P, body: () => Result<R>): R | null;
/**
 * Runs `body` on a copy of the position, like a C++ Pos passed by value: the position,
 * depth and backtrack count come back afterwards. With `expected`, Expected is left alone too.
 */
export declare function lookahead<R>(p: P, body: () => R, expected?: Expected): R;
/**
 * ParserKeyword(keyword).ignore(pos, expected). An `id` tells this keyword apart from another
 * one with the same text, as two keyword strings at different addresses are in ClickHouse.
 */
export declare function kw(p: P, keyword: string, id?: string): boolean;
/** ParserKeyword(keyword).checkWithoutMoving(pos, expected). */
export declare function peekKw(p: P, keyword: string): boolean;
/** ParserKeyword(keyword).checkWithoutMoving(pos, stub): looks ahead without touching Expected. */
export declare function peekKwQuiet(p: P, keyword: string): boolean;
/** ParserKeyword(keyword).ignore(pos), with a throwaway Expected. */
export declare function kwQuiet(p: P, keyword: string): boolean;
/** ParserToken(kind).ignore(pos, expected). */
export declare function tok(p: P, kind: T): boolean;
/** ParserToken(kind).ignore(pos), with a throwaway Expected. */
export declare function tokQuiet(p: P, kind: T): boolean;
/** ParserTokenSequence(kinds).ignore(pos, expected). */
export declare function tokSeq(p: P, kinds: T[]): boolean;
/**
 * ParserList::parseUtil: elements with separators. A separator not followed
 * by an element is left unparsed unless trailing separators are allowed.
 */
export declare function listUtil(p: P, element: () => unknown, separator?: () => boolean, allowEmpty?: boolean, allowTrailing?: boolean): boolean;
/** Case-insensitive ASCII comparison. */
export declare function equalsIgnoreCase(a: string, b: string): boolean;
export declare function isWordChar(c: string): boolean;
export declare function isDigit(c: string | undefined): boolean;
//# sourceMappingURL=state.d.ts.map