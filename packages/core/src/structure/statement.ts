/** A statement of the input as outline() reads it: its tokens, the roles of its words and its brackets. */
import { analyze, type RegionRecorder, type Tok, type Unit, unitTokens } from "../format/index.js";
import type { Role, RoleSpan } from "../parser/index.js";
import { TokenKind as T } from "../types.js";

// Brackets nested deeper than ClickHouse parses would take analyze() past the stack.
const MAX_DEPTH = 1000;

const OPENERS = new Set([T.OpeningRoundBracket, T.OpeningSquareBracket, T.OpeningCurlyBrace]);
const CLOSERS = new Set([T.ClosingRoundBracket, T.ClosingSquareBracket, T.ClosingCurlyBrace]);

export class Statement {
  /** The significant tokens, as analyze() reads them. */
  readonly sig: Tok[];
  /** The role of each word by its offset; none when the statement does not parse. */
  readonly roles: Map<number, Role>;
  /** For each bracket the index of the one that closes or opens it, paired as analyze() pairs them; -1 for none. */
  readonly match: Int32Array;
  /** How many brackets are open around each token. */
  readonly depth: Int32Array;
  private readonly deepest: number;

  /** `spans` are the roles of the whole input, sorted by offset. */
  constructor(sql: string, unit: Unit, spans: RoleSpan[]) {
    this.roles = rolesIn(spans, unit.statement!.start, unit.statement!.end);
    this.sig = unitTokens(sql, unit, this.roles);
    const n = this.sig.length;
    this.match = new Int32Array(n).fill(-1);
    this.depth = new Int32Array(n);
    const open: number[] = [];
    let deepest = 0;
    for (let i = 0; i < n; i++) {
      this.depth[i] = open.length;
      const kind = this.sig[i]!.kind;
      if (OPENERS.has(kind)) {
        open.push(i);
        deepest = Math.max(deepest, open.length);
      } else if (CLOSERS.has(kind) && open.length) {
        const opener = open.pop()!;
        this.match[opener] = i;
        this.match[i] = opener;
        this.depth[i] = open.length;
      }
    }
    this.deepest = deepest;
  }

  /** The upper-case text of a bare word at `i` that the parse does not read as a name, or "". */
  word(i: number): string {
    const token = this.sig[i];
    return token?.kind === T.BareWord ? token.up : "";
  }

  /** Whether the word at `i` is a keyword: by its role when the statement parses, else by the keyword list. */
  isKeyword(i: number, keywords: ReadonlySet<string>): boolean {
    const word = this.word(i);
    if (!word || this.sig[i - 1]?.kind === T.Dot || this.sig[i + 1]?.kind === T.Dot) return false;
    return this.roles.size > 0 ? this.roles.get(this.sig[i]!.start) === "keyword" : keywords.has(word);
  }

  /** Runs analyze() with `record`; false when the statement nests too deep for it. */
  analyze(record: RegionRecorder): boolean {
    if (this.deepest > MAX_DEPTH) return false;
    try {
      analyze(this.sig, record);
      return true;
    } catch (error) {
      // How deep the stack goes depends on the caller.
      if (error instanceof RangeError) return false;
      throw error;
    }
  }
}

/** The roles of the words from `start` up to `end`, out of spans sorted by offset. */
function rolesIn(spans: RoleSpan[], start: number, end: number): Map<number, Role> {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid]!.start < start) lo = mid + 1;
    else hi = mid;
  }
  const roles = new Map<number, Role>();
  for (let i = lo; i < spans.length && spans[i]!.start < end; i++) roles.set(spans[i]!.start, spans[i]!.role);
  return roles;
}
