import type { P } from "./state.js";
/** What a word is to the parser. */
export type Role = "keyword" | "identifier" | "function" | "type" | "engine" | "setting" | "parameter" | "number";
/** A word of a statement that parses, with its role. Offsets are those of the token. */
export interface RoleSpan {
    start: number;
    end: number;
    role: Role;
}
/** Roles by token index. A mark at or after the parser position belongs to an attempt it gave up. */
export declare class Roles {
    private readonly p;
    /** The role of each token from `first` on. */
    private readonly marks;
    private readonly first;
    constructor(p: P);
    /** Tokens from `from` up to `to` have `role`. */
    mark(from: number, to: number, role: Role): void;
    /** The parser moved back to token `i`. */
    rewind(i: number): void;
    /** The words before the parser position that have a role, in order. */
    spans(): RoleSpan[];
}
//# sourceMappingURL=roles.d.ts.map