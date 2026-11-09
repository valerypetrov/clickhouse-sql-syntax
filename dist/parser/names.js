export class NameMarks {
    p;
    marks = [];
    constructor(p) {
        this.p = p;
    }
    /** A mark over the tokens `first` to `last`; marks stay sorted by their last token. */
    add(kind, first, last, extra = {}) {
        if (last < first)
            return;
        this.rewind(this.p.i);
        const mark = { key: last, kind, range: [first, last], ...extra };
        let i = this.marks.length;
        while (i > 0 && this.marks[i - 1].key > last)
            i--;
        this.marks.splice(i, 0, mark);
    }
    /** The parser moved back to token `i`. */
    rewind(i) {
        while (this.marks.length && this.marks[this.marks.length - 1].key >= i)
            this.marks.pop();
    }
    /** The marks before the parser position, with offsets from `base`. */
    list(base) {
        this.rewind(this.p.i);
        const toks = this.p.toks;
        const offsets = ([first, last]) => [toks[first].start - base, toks[last].end - base];
        return this.marks.map((mark) => {
            const [start, end] = offsets(mark.range);
            const result = { kind: mark.kind, start, end };
            if (mark.name)
                result.name = offsets(mark.name);
            if (mark.part)
                result.part = offsets(mark.part);
            if (mark.alias)
                result.alias = offsets(mark.alias);
            if (mark.flag)
                result.flag = mark.flag;
            return result;
        });
    }
}
/** What an aliased node is, as the flag of its alias mark. */
export function aliasKind(node) {
    switch (node.kind) {
        case "Identifier":
            if (node.has("param"))
                return "other";
            return node.parts.length === 1 ? "identifier" : "compound";
        case "Function":
            return node.has("lambda") ? "lambda" : "function";
        case "Subquery":
            return "subquery";
        case "Literal":
            return "literal";
        default:
            return "other";
    }
}
//# sourceMappingURL=names.js.map