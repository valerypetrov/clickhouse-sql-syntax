/**
 * The queries, tables, aliases, lambdas and identifiers that a successful parse read, for names analysis,
 * whose marks past the position are dropped when the parser moves back, as the roles are.
 */
import type { Ast } from "./ast.js";
import type { P } from "./state.js";

export type NameMarkKind =
  /** A SELECT; `part` is its select list. */
  | "query"
  /** SELECTs joined by UNION and the like; the flag "pipe" marks pipe operators. */
  | "union"
  /** A WITH element: a CTE named `name` (flag "cte") with column names `part`, or an expression (flag "expr"). */
  | "with"
  /** A table expression; the flag tells its source, `alias` its alias and `part` its column names. */
  | "table"
  /** A join after the first table; the flag is its kind, `part` its USING list or ON condition. */
  | "join"
  /** An ARRAY JOIN; `part` is its list. */
  | "arrayjoin"
  /** An aliased expression `part` named `name`; the flag tells what the expression is. */
  | "alias"
  /** A lambda with the parameters `part`. */
  | "lambda"
  /** An identifier read as an expression. */
  | "ref"
  /** The name of a function call. */
  | "call"
  /** *, t.*, COLUMNS(...) with the qualifier `name`; the flag "transformers" marks EXCEPT, REPLACE or APPLY. */
  | "matcher"
  /** The INTERPOLATE list. */
  | "interpolate"
  /** Something names analysis does not follow, such as a subquery of EXPLAIN. */
  | "opaque";

/** A mark with the offsets of its first and last token, from where its statement begins; ranges are [start, end). */
export interface NameMark {
  kind: NameMarkKind;
  start: number;
  end: number;
  name?: [number, number];
  part?: [number, number];
  alias?: [number, number];
  flag?: string;
}

/** Token ranges are inclusive [first, last] while parsing. */
type Range = [number, number];

interface Pending {
  /** The token index of the last token, which a move back to it or before drops. */
  key: number;
  kind: NameMarkKind;
  range: Range;
  name?: Range;
  part?: Range;
  alias?: Range;
  flag?: string;
}

export class NameMarks {
  private readonly marks: Pending[] = [];

  constructor(private readonly p: P) {}

  /** A mark over the tokens `first` to `last`; marks stay sorted by their last token. */
  add(kind: NameMarkKind, first: number, last: number, extra: Omit<Pending, "key" | "kind" | "range"> = {}): void {
    if (last < first) return;
    this.rewind(this.p.i);
    const mark: Pending = { key: last, kind, range: [first, last], ...extra };
    let i = this.marks.length;
    while (i > 0 && this.marks[i - 1]!.key > last) i--;
    this.marks.splice(i, 0, mark);
  }

  /** The parser moved back to token `i`. */
  rewind(i: number): void {
    while (this.marks.length && this.marks[this.marks.length - 1]!.key >= i) this.marks.pop();
  }

  /** The marks before the parser position, with offsets from `base`. */
  list(base: number): NameMark[] {
    this.rewind(this.p.i);
    const toks = this.p.toks;
    const offsets = ([first, last]: Range): [number, number] => [toks[first]!.start - base, toks[last]!.end - base];
    return this.marks.map((mark) => {
      const [start, end] = offsets(mark.range);
      const result: NameMark = { kind: mark.kind, start, end };
      if (mark.name) result.name = offsets(mark.name);
      if (mark.part) result.part = offsets(mark.part);
      if (mark.alias) result.alias = offsets(mark.alias);
      if (mark.flag) result.flag = mark.flag;
      return result;
    });
  }
}

/** What an aliased node is, as the flag of its alias mark. */
export function aliasKind(node: Ast): string {
  switch (node.kind) {
    case "Identifier":
      if (node.has("param")) return "other";
      return node.parts!.length === 1 ? "identifier" : "compound";
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
