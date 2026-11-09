/**
 * The role of each word on the path of a successful parse, like the highlights of ClickHouse's
 * Expected. The parser marks what it consumed, and moving back drops the marks past its position.
 */
import { TokenKind as T } from "../types.js";
/** Roles by token index. A mark at or after the parser position belongs to an attempt it gave up. */
export class Roles {
    p;
    /** The role of each token from `first` on. */
    marks = [];
    first;
    constructor(p) {
        this.p = p;
        this.first = p.i;
    }
    /** Tokens from `from` up to `to` have `role`. */
    mark(from, to, role) {
        this.rewind(this.p.i);
        for (let i = from; i < to; i++)
            this.marks[i - this.first] = role;
    }
    /** The parser moved back to token `i`. */
    rewind(i) {
        if (this.marks.length > i - this.first)
            this.marks.length = Math.max(0, i - this.first);
    }
    /** The words before the parser position that have a role, in order. */
    spans() {
        this.rewind(this.p.i);
        const spans = [];
        this.marks.forEach((role, i) => {
            const token = this.p.toks[i + this.first];
            if (role && (token.kind === T.BareWord || token.kind === T.QuotedIdentifier))
                spans.push({ start: token.start, end: token.end, role });
        });
        return spans;
    }
}
//# sourceMappingURL=roles.js.map