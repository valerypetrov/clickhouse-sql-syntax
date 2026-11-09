/** A statement as outline() and selectionRanges() read it: its tokens, the roles of its words and its brackets. */
import { type RegionRecorder, type Tok, type Unit } from "../format/index.js";
import type { Role, RoleSpan } from "../parser/index.js";
export declare class Statement {
    /** The significant tokens, as analyze() reads them. */
    readonly sig: Tok[];
    /** The role of each word by its offset; none when the statement does not parse. */
    readonly roles: Map<number, Role>;
    /** For each bracket the index of the one that closes or opens it, paired as analyze() pairs them; -1 for none. */
    readonly match: Int32Array;
    /** How many brackets are open around each token. */
    readonly depth: Int32Array;
    private readonly deepest;
    /** `spans` are the roles of the whole input, sorted by offset. */
    constructor(sql: string, unit: Unit, spans: RoleSpan[]);
    /** The upper-case text of a bare word at `i` that the parse does not read as a name, or "". */
    word(i: number): string;
    /** Whether the word at `i` is a keyword: by its role when the statement parses, else by the keyword list. */
    isKeyword(i: number, keywords: ReadonlySet<string>): boolean;
    /** Runs analyze() with `record`; false when the statement nests too deep for it. */
    analyze(record: RegionRecorder): boolean;
}
//# sourceMappingURL=statement.d.ts.map