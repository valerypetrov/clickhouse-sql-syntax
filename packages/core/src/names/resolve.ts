/**
 * Name resolution of one statement, walked as src/Analyzer/Resolve/QueryAnalyzer.cpp walks it, where every
 * name records what it resolved to, and one that resolved to different or unknown things is ambiguous.
 */
import { DATA_TYPES } from "../generated/data-types.js";
import { TokenKind as T } from "../types.js";
import { type Alias, type ArrayJoin, type Call, type Join, type Lambda, type Matcher, type Node, nameOf, type Query, type Ref, type Statement, type Table, type Union, type With, type Word } from "./tree.js";

export type DefKind = "alias" | "lambda parameter" | "table alias" | "CTE" | "column" | "query parameter";

/** A name defined in the statement. */
export interface Def {
  id: number;
  kind: DefKind;
  name: string;
  /** Where the name is written as a definition; the first is where it is defined. */
  sites: Word[];
  /** Why renaming it could change the query, when it could. */
  reason?: string;
}

const EXT = { kind: "external" } as const;
const UNKNOWN = { kind: "unknown" } as const;
type Target = Def | typeof EXT | typeof UNKNOWN;
/** What each part of a name resolved to. */
type Alt = Target[];

/** The analysis of a statement: its definitions and what each word resolved to. */
export interface Resolution {
  defs: Def[];
  /** The targets of every word that was resolved, by its start offset. */
  words: Map<number, { word: Word; targets: Set<Target> }>;
  /** Where a definition is written, by start offset. */
  sites: Map<number, Def>;
}

export function isDef(target: Target): target is Def {
  return "id" in target;
}

/** Settings that change how names resolve; ClickHouse's defaults are assumed unless the text sets them. */
export interface ResolveOptions {
  /** prefer_column_name_to_alias may be on: both readings are tried. */
  preferColumnsMaybe?: boolean;
  /** The settings that the statement or SET before it writes, as param_x for the query parameter x. */
  settings?: Set<string>;
}

/** Thrown when the statement takes too long to evaluate. */
class OutOfWork extends Error {}

const NILADIC = new Set([
  "currentdatabase", "database", "schema", "current_database", "current_schema", "currentuser", "user", "current_user",
  "session_user", "now", "current_timestamp", "localtimestamp", "today", "current_date", "curdate", "localtime",
  "currenthandler", "currentrequesturl",
]);

interface Column {
  name: string;
  targets: Set<Target>;
}

/** The columns of a table expression; `unknown` when it may have others, as a table of the database does. */
class Columns {
  readonly byName = new Map<string, Column>();
  constructor(
    readonly list: Column[],
    readonly unknown: boolean,
    /** Some columns are named after expressions, which only a quoted name can match. */
    readonly opaque = false,
    /** A table of ClickHouse, which also has virtual columns such as _table. */
    readonly virtual = false,
    /** The definitions whose names are part of the names of opaque columns. */
    readonly opaqueDefs: Def[] = [],
  ) {
    for (const column of list) if (!this.byName.has(column.name)) this.byName.set(column.name, column);
  }

  /** The column, null when it surely does not exist, undefined when it may. */
  find(name: string): Column | null | undefined {
    const found = this.byName.get(name);
    if (found) return found;
    if (this.unknown || (this.opaque && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) || (this.virtual && name.startsWith("_"))) return undefined;
    return null;
  }

  static unknown(): Columns {
    return new Columns([], true);
  }

  static of(names: string[]): Columns {
    return new Columns(names.map((name) => ({ name, targets: new Set<Target>([EXT]) })), false, false, true);
  }
}

/** Columns of table functions and system tables that ClickHouse defines, by name. */
const KNOWN_TABLES: Record<string, string[]> = {
  numbers: ["number"],
  numbers_mt: ["number"],
  zeros: ["zero"],
  zeros_mt: ["zero"],
  generate_series: ["generate_series"],
  generateseries: ["generate_series"],
  "system.one": ["dummy"],
  "system.numbers": ["number"],
  "system.numbers_mt": ["number"],
  "system.zeros": ["zero"],
  "system.zeros_mt": ["zero"],
};

interface AliasEntry {
  node: Alias;
  def: Def;
  /** Its expression resolved into an ARRAY JOIN column, so the join tree is looked at first. */
  arrayJoin?: boolean;
}

class AliasMaps {
  readonly expr = new Map<string, AliasEntry>();
  readonly lambda = new Map<string, AliasEntry>();
}

let scopeIds = 0;

abstract class Scope {
  readonly id = scopeIds++;
  readonly aliases = new AliasMaps();
  /** Names of the aliased expressions being resolved in this scope. */
  readonly stack: string[] = [];
  /** Counts the changes of its aliases and tables, which change how names resolve in it. */
  version = 0;
  /** The names being looked up in this scope, with how many lookups of each are in process. */
  readonly lookups = new Map<string, number>();
  constructor(readonly parent: Scope | null) {}
}

class QueryScope extends Scope {
  readonly ctes = new Map<string, CteEntry>();
  /** Table aliases of the FROM section. */
  readonly fromAliases = new Map<string, Instance>();
  tree?: JoinTree;
  instances: Instance[] = [];
  /** The recursive CTE table that a member of a recursive CTE sees under the CTE's name. */
  recursive?: { name: string; def: Def; columns: Columns };
  constructor(
    readonly query: Query,
    parent: Scope | null,
  ) {
    super(parent);
  }
}

class LambdaScope extends Scope {
  readonly params = new Map<string, Def>();
  readonly hidden = new Set<string>();
  constructor(
    readonly lambda: Lambda,
    parent: Scope | null,
  ) {
    super(parent);
  }
}

/** Expressions outside any SELECT, as in ALTER UPDATE: only lambda parameters are known there. */
class OuterScope extends Scope {}

interface CteEntry {
  with: With;
  def: Def;
  query: Query;
}

/** The WITH that a SELECT of a union takes from the first SELECT. */
interface Inherited {
  /** The aliases of WITH, and the definitions of the aliases inside them. */
  aliases: { node: Alias; def: Def; defs: Map<string, Def> }[];
  ctes: CteEntry[];
}

interface UnionOptions {
  /** The recursive CTE table that every SELECT sees. */
  recursive?: QueryScope["recursive"];
  /** A recursive CTE, whose table the SELECTs after the first see. */
  recursiveCte?: { name: string; def: Def; columns?: Columns };
  inherited?: Inherited;
}

/** A table expression of a FROM in one evaluation. */
interface Instance {
  table: Table;
  columns: Columns;
  /** Its table name: of a table, of a CTE it reads. */
  tableName?: string;
  database?: string;
  /** What the table name stands for. */
  nameTarget: Target;
  alias?: string;
  aliasDef?: Def;
  inProcess: boolean;
}

type JoinTree =
  | { kind: "leaf"; instance: Instance }
  | { kind: "join"; left: JoinTree; right: JoinTree; join: Join; using?: Map<string, Set<Target>>; inProcess: boolean }
  | { kind: "cross"; items: JoinTree[] }
  | { kind: "array"; left: JoinTree; element: ArrayJoin; columns: Column[]; inProcess: boolean };

interface Ctx {
  aliasScope?: Scope;
  allowAliases: boolean;
  allowJoinTree: boolean;
  /** The aliases of this scope are skipped for this lookup only, not for the parent scopes. */
  skipped?: boolean;
}

const DEFAULT_CTX: Ctx = { allowAliases: true, allowJoinTree: true };

/** What a lookup in the join tree found: definite readings, and whether a table of unknown columns may match. */
interface Found {
  alts: Alt[];
  maybe: boolean;
}

const NOT_FOUND: Found = { alts: [], maybe: false };

/** The syntactic facts of one SELECT. */
interface QueryInfo {
  ctes: With[];
  /** The expressions of WITH, the first of aliasRoots. */
  withRoots: Node[];
  aliasRoots: Node[];
  projection: Node[];
  others: Node[];
  interpolate: Node[];
  from: (Table | Join | ArrayJoin)[];
  exprDefs: Map<string, Def>;
  tableDefs: Map<string, Def>;
  cteDefs: Map<string, Def>;
  arrayJoinDefs: Map<Alias, Def>;
  /** The first evaluation of the query, where its dead parts are evaluated. */
  scope?: QueryScope;
}

interface LambdaInfo {
  params: Map<string, Def>;
  paramRefs: Set<Ref>;
  body: Node[];
  exprDefs: Map<string, Def>;
}

export function resolveStatement(statement: Statement, options: ResolveOptions = {}): Resolution {
  return new Resolver(statement, options).run();
}

class Resolver {
  private readonly defs: Def[] = [];
  private readonly words = new Map<number, { word: Word; targets: Set<Target> }>();
  private readonly sites = new Map<number, Def>();
  private readonly queries = new Map<Query, QueryInfo>();
  private readonly lambdas = new Map<Lambda, LambdaInfo>();
  private readonly columnDefs = new Map<Word, Def>();
  private readonly done = new Set<string>();
  private readonly evaluated = new Set<Node>();
  private readonly ctesInProcess = new Set<Def>();
  private work = 0;
  private readonly maxWork: number;
  private calls?: Set<number>;
  private ranks?: Map<string, number>;
  /** The alias nodes of each alias definition. */
  private readonly aliasNodes = new Map<Def, Alias[]>();
  /** The words of each INTERPOLATE list, whose names it reads in a way that is not followed. */
  private readonly interpolated: Set<string>[] = [];
  /** The lambdas of aliases being applied, as lambdas_in_resolve_process. */
  private readonly lambdasInProcess = new Set<Lambda>();
  /** The queries with GROUP BY. */
  private grouped?: Set<Query>;
  /** Names that a part of the query that is not followed may stand for. */
  private readonly unfollowedNames = new Set<string>();
  /** The identifiers inside lambda(tuple(x), body), which this analysis does not follow. */
  private readonly lambdaFunctionRefs = new Set<Ref>();

  constructor(
    private readonly statement: Statement,
    private readonly options: ResolveOptions,
  ) {
    this.maxWork = 200_000 + 20 * statement.tokens.length;
  }

  run(): Resolution {
    this.defineParameters();
    this.markLambdaFunctions();
    try {
      for (const node of this.statement.nodes) {
        if (node.kind === "query") this.queryInfo(node);
        if (node.kind === "lambda") this.lambdaInfo(node);
      }
      this.schemaColumns();
      const outer = new OuterScope(null);
      for (const root of this.statement.roots) this.evalNode(root, outer);
      this.evalDead(outer);
    } catch (error) {
      if (!(error instanceof OutOfWork) && !(error instanceof RangeError)) throw error;
      // Better nothing than a guess: every name of the statement is ambiguous.
      for (const def of this.defs) def.reason ??= "the query is too complex to follow";
      for (const entry of this.words.values()) entry.targets.add(UNKNOWN);
    }
    this.taintAmbiguous();
    return { defs: this.defs, words: this.words, sites: this.sites };
  }

  /** Whether GROUP BY is a clause of the query itself, not of a query inside it. */
  private hasGroupBy(query: Query): boolean {
    if (!this.grouped) {
      this.grouped = new Set();
      for (const offset of this.statement.groups) {
        let innermost: Query | undefined;
        for (const node of this.statement.nodes) {
          if (node.kind !== "query" || node.start > offset || offset >= node.end) continue;
          if (!innermost || (node.start >= innermost.start && node.end <= innermost.end)) innermost = node;
        }
        if (innermost) this.grouped.add(innermost);
      }
    }
    return this.grouped.has(query);
  }

  /** Whether the call is lambda(tuple(...), ...), which QueryTreeBuilder takes for a lambda. */
  private isLambdaFunction(call: Call): boolean {
    const { tokens, tokenAt } = this.statement;
    if (call.parts.length !== 1 || call.parts[0]!.name !== "lambda") return false;
    const i = tokenAt.get(call.parts[0]!.start)!;
    const tuple = tokens[i + 2];
    return tokens[i + 1]?.kind === T.OpeningRoundBracket && tuple?.kind === T.BareWord && this.textOf(tuple.start, tuple.end) === "tuple" && tokens[i + 3]?.kind === T.OpeningRoundBracket;
  }

  /** The identifiers inside the brackets of lambda(tuple(...), ...) calls. */
  private markLambdaFunctions(): void {
    const ranges = this.callArguments((_, call) => this.isLambdaFunction(call));
    if (!ranges.length) return;
    for (const node of this.statement.nodes) {
      if (node.kind === "ref" && ranges.some(([from, to]) => node.start >= from && node.end <= to)) this.lambdaFunctionRefs.add(node);
    }
  }

  /** The offsets of the brackets of the calls whose name `pick` takes. */
  private callArguments(pick: (name: string, call: Call) => boolean): [number, number][] {
    const { tokens, tokenAt, match } = this.statement;
    const ranges: [number, number][] = [];
    for (const node of this.statement.nodes) {
      if (node.kind !== "call" || node.parts.length !== 1 || !pick(node.parts[0]!.name, node)) continue;
      const i = tokenAt.get(node.parts[0]!.start)! + 1;
      if (tokens[i]?.kind === T.OpeningRoundBracket && match[i]! > i) ranges.push([tokens[i]!.start, tokens[match[i]!]!.end]);
    }
    return ranges;
  }

  // --- Definitions --------------------------------------------------------------------------------

  private newDef(kind: DefKind, name: string, site: Word, reason?: string): Def {
    const def: Def = { id: this.defs.length, kind, name, sites: [site], reason };
    this.defs.push(def);
    this.sites.set(site.start, def);
    return def;
  }

  private addSite(def: Def, site: Word): void {
    def.sites.push(site);
    this.sites.set(site.start, def);
  }

  private taint(def: Def, reason: string): void {
    def.reason ??= reason;
  }

  /** An alias of a level: aliases of the same name there are one name. */
  private defineAlias(alias: Alias, defs: Map<string, Def>): void {
    let def = defs.get(alias.name.name);
    if (def) this.addSite(def, alias.name);
    else defs.set(alias.name.name, (def = this.newDef("alias", alias.name.name, alias.name)));
    const nodes = this.aliasNodes.get(def);
    if (nodes) nodes.push(alias);
    else this.aliasNodes.set(def, [alias]);
  }

  /** Query parameters: one name per statement, defined where it is first written. */
  private defineParameters(): void {
    const byName = new Map<string, Def>();
    for (const { word } of this.statement.parameters) {
      const found = byName.get(word.name);
      if (found) this.record([word], [[found]]);
      else byName.set(word.name, this.newDef("query parameter", word.name, word));
    }
    // SET param_x = ... gives the parameter x its value by its name.
    for (const def of byName.values()) if (this.options.settings?.has(`param_${def.name.toLowerCase()}`)) this.taint(def, `${def.name} is given its value by the setting param_${def.name}`);
  }

  private queryInfo(query: Query): QueryInfo {
    let info = this.queries.get(query);
    if (info) return info;
    info = {
      ctes: [], withRoots: [], aliasRoots: [], projection: [], others: [], interpolate: [], from: [],
      exprDefs: new Map(), tableDefs: new Map(), cteDefs: new Map(), arrayJoinDefs: new Map(),
    };
    this.queries.set(query, info);
    const withExprs: Node[] = [];
    const [projectionStart, projectionEnd] = query.projection ?? [-1, -1];
    for (const child of query.children) {
      switch (child.kind) {
        case "with":
          if (child.name) info.ctes.push(child);
          else withExprs.push(...child.children);
          break;
        case "table":
        case "join":
        case "arrayjoin":
          info.from.push(child);
          break;
        case "interpolate":
          info.interpolate.push(child);
          break;
        case "opaque":
          info.others.push(child);
          break;
        default:
          if (child.start >= projectionStart && child.end <= projectionEnd) info.projection.push(child);
          else info.others.push(child);
      }
    }
    info.withRoots = withExprs;
    info.aliasRoots = [...withExprs, ...info.projection, ...info.others, ...info.interpolate];
    // The aliases of the query level, in the order ClickHouse collects them; the join tree comes last.
    const aliases: Alias[] = [];
    for (const node of info.aliasRoots) collectAliases(node, aliases);
    for (const element of info.from) {
      if (element.kind === "table") this.tableArgs(element).forEach((node) => collectAliases(node, aliases));
      else if (element.kind === "join") {
        const table = element.children.find((child): child is Table => child.kind === "table");
        if (table) this.tableArgs(table).forEach((node) => collectAliases(node, aliases));
        if (element.on) for (const child of element.children) if (child.kind !== "table") collectAliases(child, aliases);
      } else {
        for (const child of element.children) {
          if (child.kind === "alias") {
            for (const inner of child.children) collectAliases(inner, aliases);
            info.arrayJoinDefs.set(child, this.newDef("alias", child.name.name, child.name));
          } else collectAliases(child, aliases);
        }
      }
    }
    for (const alias of aliases) this.defineAlias(alias, info.exprDefs);
    for (const cte of info.ctes) {
      const name = cte.name!;
      const found = info.cteDefs.get(name.name);
      if (found) {
        this.addSite(found, name);
        this.taint(found, `${name.name} is defined more than once`);
      } else info.cteDefs.set(name.name, this.newDef("CTE", name.name, name));
      cte.columns?.forEach((word) => this.columnDefs.set(word, this.newDef("column", word.name, word)));
    }
    for (const table of this.tables(info)) {
      if (table.alias) {
        const found = info.tableDefs.get(table.alias.name);
        if (found) {
          this.addSite(found, table.alias);
          this.taint(found, `${table.alias.name} is defined more than once`);
        } else info.tableDefs.set(table.alias.name, this.newDef("table alias", table.alias.name, table.alias));
      }
      table.columns?.forEach((word) => this.columnDefs.set(word, this.newDef("column", word.name, word)));
    }
    for (const node of info.interpolate) this.taintInterpolate(node);
    return info;
  }

  private lambdaInfo(lambda: Lambda): LambdaInfo {
    let info = this.lambdas.get(lambda);
    if (info) return info;
    info = { params: new Map(), paramRefs: new Set(), body: [], exprDefs: new Map() };
    this.lambdas.set(lambda, info);
    const [from, to] = lambda.paramsRange;
    for (const child of lambda.children) {
      if (child.start >= from && child.end <= to) {
        if (child.kind === "ref" && child.parts.length === 1) {
          info.paramRefs.add(child);
          const word = child.parts[0]!;
          if (!info.params.has(word.name)) info.params.set(word.name, this.newDef("lambda parameter", word.name, word));
        }
      } else {
        info.body.push(child);
      }
    }
    lambda.params = [...info.params.values()].map((def) => def.sites[0]!);
    const aliases: Alias[] = [];
    for (const node of info.body) collectAliases(node, aliases);
    for (const alias of aliases) this.defineAlias(alias, info.exprDefs);
    return info;
  }

  private *tables(info: QueryInfo): Iterable<Table> {
    for (const element of info.from) {
      if (element.kind === "table") yield element;
      else if (element.kind === "join") {
        const table = element.children.find((child): child is Table => child.kind === "table");
        if (table) yield table;
      }
    }
  }

  /** The argument nodes of a table function. */
  private tableArgs(table: Table): Node[] {
    if (table.source !== "function") return [];
    return table.children.filter((child) => !(child.kind === "alias" && table.alias && child.name.start === table.alias.start));
  }

  /** INTERPOLATE reads names in a scope of its own, which this analysis does not follow. */
  private taintInterpolate(node: Node): void {
    const tokens = this.statement.tokens;
    const names = new Set<string>();
    for (const token of tokens) {
      if (token.start < node.start || token.end > node.end) continue;
      const name = nameOf(this.statement.sql, token);
      if (name !== undefined) names.add(name);
    }
    this.interpolated.push(names);
    walk(node, (inner) => {
      if (inner.kind === "ref") this.record(inner.parts, [[UNKNOWN]]);
    });
  }

  /** The top projection aliases of CREATE ... AS SELECT name the columns of what it creates. */
  private schemaColumns(): void {
    const head = this.statement.head;
    const creates = head[0] === "CREATE" || head[0] === "ATTACH" || head[0] === "REPLACE" || head[0] === "ALTER";
    // A table function may write the column names, as file() does with CSVWithNames.
    const writes = head[0] === "INSERT" && this.statement.tokens.slice(0, 6).some((token) => this.textOf(token.start, token.end).toUpperCase() === "FUNCTION");
    if (!creates && !writes) return;
    // The parameters of a parameterized view are how it is called.
    if (creates) for (const def of this.defs) if (def.kind === "query parameter") this.taint(def, `${def.name} is a parameter of what the statement creates`);
    for (const root of this.statement.nodes) {
      if (root.kind !== "union" || enclosingUnion(root)) continue;
      for (const query of firstQueries(root)) {
        const info = this.queryInfo(query);
        for (const item of query.items) {
          if (item.kind !== "alias") continue;
          const def = info.exprDefs.get(item.node.name.name);
          if (def) this.taint(def, writes ? `${def.name} names a column that the statement writes` : `${def.name} names a column of what the statement creates`);
        }
      }
    }
  }

  // --- Memoization --------------------------------------------------------------------------------

  /**
   * What can change how an expression named `name` resolves in `scope`: the scopes up to the root, the
   * aliases being resolved in them that the expression may reach, hidden lambda arguments and CTEs in process.
   */
  private contextKey(scope: Scope, name: string): string {
    const rank = this.rank(name);
    const parts: string[] = [];
    for (let current: Scope | null = scope; current; current = current.parent) {
      const stack = current.stack.filter((item) => this.rank(item) <= rank);
      const lookups = [...current.lookups.keys()].filter((item) => this.rank(item.split(".")[0]!) <= rank);
      parts.push(`${current.id}.${current.version}:${stack.join(",")}:${lookups.join(",")}${current instanceof LambdaScope && current.hidden.size ? `/${[...current.hidden].join(",")}` : ""}`);
    }
    for (const def of this.ctesInProcess) parts.push(`c${def.id}`);
    return parts.join(";");
  }

  /**
   * A rank per name such that an expression of an alias or CTE can only reach names of lower or equal rank:
   * the order of the strongly connected components of the graph of names used in such expressions.
   */
  private rank(name: string): number {
    if (!this.ranks) this.ranks = this.rankNames();
    return this.ranks.get(name) ?? Number.MAX_SAFE_INTEGER;
  }

  private rankNames(): Map<string, number> {
    const edges = new Map<string, Set<string>>();
    const add = (from: string, body: Node): void => {
      let set = edges.get(from);
      if (!set) edges.set(from, (set = new Set()));
      walk(body, (node) => {
        if ((node.kind === "ref" || node.kind === "call") && node.parts.length) set!.add(node.parts[0]!.name);
        if (node.kind === "table" && node.source === "name" && node.name.length === 1) set!.add(node.name[0]!.name);
      });
    };
    for (const node of this.statement.nodes) {
      if (node.kind === "alias") add(node.name.name, node);
      else if (node.kind === "with" && node.name) add(node.name.name, node);
    }
    // Tarjan's algorithm without recursion; components come out sinks first.
    const ranks = new Map<string, number>();
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    let counter = 0;
    let component = 0;
    for (const root of edges.keys()) {
      if (index.has(root)) continue;
      const work: { name: string; next: Iterator<string> }[] = [];
      const enter = (name: string): void => {
        index.set(name, counter);
        low.set(name, counter++);
        stack.push(name);
        onStack.add(name);
        work.push({ name, next: (edges.get(name) ?? new Set<string>()).values() });
      };
      enter(root);
      while (work.length) {
        const frame = work[work.length - 1]!;
        const step = frame.next.next();
        if (!step.done) {
          const next = step.value;
          if (!index.has(next)) enter(next);
          else if (onStack.has(next)) low.set(frame.name, Math.min(low.get(frame.name)!, index.get(next)!));
          continue;
        }
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1]!.name;
          low.set(parent, Math.min(low.get(parent)!, low.get(frame.name)!));
        }
        if (low.get(frame.name) === index.get(frame.name)) {
          let member: string;
          do {
            member = stack.pop()!;
            onStack.delete(member);
            ranks.set(member, component);
          } while (member !== frame.name);
          component++;
        }
      }
    }
    return ranks;
  }

  // --- Recording ----------------------------------------------------------------------------------

  private record(parts: Word[], alts: Alt[]): void {
    parts.forEach((word, i) => {
      let entry = this.words.get(word.start);
      if (!entry) this.words.set(word.start, (entry = { word, targets: new Set() }));
      for (const alt of alts) entry.targets.add(alt[i] ?? EXT);
    });
  }

  private taintAmbiguous(): void {
    for (const names of this.interpolated) for (const def of this.defs) if (names.has(def.name) && def.kind !== "query parameter") this.taint(def, `${def.name} is used in INTERPOLATE`);
    for (const def of this.defs) if (this.unfollowedNames.has(def.name) && def.kind !== "query parameter") this.taint(def, `${def.name} is used where this analysis does not follow names`);
    // formatRow() writes the names of its arguments into its result.
    for (const [from, to] of this.callArguments((name) => /^formatrow(nonewline)?$/i.test(name))) {
      const reason = (def: Def) => `${def.name} is written into the result by formatRow`;
      for (const { word, targets } of this.words.values()) {
        if (word.start < from || word.end > to) continue;
        for (const target of targets) if (isDef(target)) this.taint(target, reason(target));
      }
      for (const def of this.defs) if (def.sites.some((site) => site.start >= from && site.end <= to)) this.taint(def, reason(def));
    }
    // GROUP BY keys are matched with the other expressions of the query, and a lambda's parameters are part of it.
    for (const node of this.statement.nodes) {
      if (node.kind !== "lambda") continue;
      let owner = ownerOf(node);
      while (owner?.kind === "lambda") owner = ownerOf(owner);
      if (owner && this.hasGroupBy(owner)) for (const def of this.lambdaInfo(node).params.values()) this.taint(def, `${def.name} is a parameter of a lambda in a query with GROUP BY, whose keys must match`);
    }
    // The expressions of the same alias defined twice must stay equal, so the names inside them cannot change.
    for (const [def, nodes] of this.aliasNodes) {
      if (nodes.length < 2) continue;
      for (const node of nodes) for (const inner of this.defs) if (inner !== def && inner.sites.some((site) => site.start >= node.start && site.end <= node.body[1])) this.taint(inner, `${inner.name} is inside an alias defined more than once`);
    }
    const byName = new Map<string, Def[]>();
    for (const def of this.defs) {
      if (def.kind === "query parameter") continue;
      const list = byName.get(def.name);
      if (list) list.push(def);
      else byName.set(def.name, [def]);
    }
    const reason = (def: Def) => `${def.name} is used where ClickHouse may read it as something else`;
    for (const { word, targets } of this.words.values()) {
      if (targets.has(UNKNOWN)) {
        // A name this analysis does not follow may stand for any definition of that name.
        for (const def of byName.get(word.name) ?? []) this.taint(def, reason(def));
      }
      if (targets.size < 2) continue;
      for (const target of targets) if (isDef(target)) this.taint(target, reason(target));
    }
    if (this.statement.nodes.some((node) => node.kind === "ref" && node.unsupported)) {
      // A {name:Identifier} parameter may name anything.
      for (const def of this.defs) if (def.kind !== "query parameter") this.taint(def, `the query has a name given by a query parameter, which may be ${def.name}`);
    }
  }

  private spend(): void {
    if (++this.work > this.maxWork) throw new OutOfWork();
  }

  private textOf(start: number, end: number): string {
    return this.statement.sql.slice(start, end);
  }

  // --- Evaluation ---------------------------------------------------------------------------------

  /** Resolves an expression node in `scope`, as resolveExpressionNode does. */
  private evalNode(node: Node, scope: Scope): void {
    this.spend();
    this.evaluated.add(node);
    switch (node.kind) {
      case "ref":
        this.resolveRef(node, scope, DEFAULT_CTX);
        return;
      case "call":
        this.resolveCall(node, scope);
        return;
      case "alias":
        scope.stack.push(node.name.name);
        for (const child of node.children) this.evalNode(child, scope);
        scope.stack.pop();
        return;
      case "lambda":
        this.evalLambda(node, scope);
        return;
      case "union":
        this.evalUnion(node, scope);
        if (this.isScalar(node)) this.taintTupleNames(node);
        return;
      case "matcher":
        this.resolveMatcher(node, scope);
        return;
      case "query":
        this.evalQuery(node, scope);
        return;
      case "opaque":
      case "interpolate":
      case "with":
      case "table":
      case "join":
      case "arrayjoin":
        for (const child of node.children) this.evalNode(child, scope);
        return;
    }
  }

  private evalLambda(lambda: Lambda, parent: Scope): void {
    const info = this.lambdaInfo(lambda);
    const scope = new LambdaScope(lambda, parent);
    for (const [name, def] of info.params) scope.params.set(name, def);
    for (const ref of info.paramRefs) this.evaluated.add(ref);
    this.collectInto(info.body, info.exprDefs, scope);
    for (const node of info.body) this.evalNode(node, scope);
  }

  /** Fills the alias maps of a scope from the alias nodes under `roots`, first one wins. */
  private collectInto(roots: Node[], defs: Map<string, Def>, scope: Scope): void {
    const aliases: Alias[] = [];
    for (const node of roots) collectAliases(node, aliases);
    for (const alias of aliases) this.addAlias(alias, defs.get(alias.name.name), scope);
  }

  private addAlias(alias: Alias, def: Def | undefined, scope: Scope): void {
    if (!def) return;
    const entry: AliasEntry = { node: alias, def };
    const name = alias.name.name;
    scope.version++;
    if (alias.node === "lambda") {
      if (!scope.aliases.lambda.has(name)) scope.aliases.lambda.set(name, entry);
    } else {
      if (!scope.aliases.expr.has(name)) scope.aliases.expr.set(name, entry);
      if (alias.node === "identifier" && !scope.aliases.lambda.has(name)) scope.aliases.lambda.set(name, entry);
    }
  }

  /**
   * The columns of a union, those of its first SELECT, whose WITH goes to the other SELECTs as ApplyWithGlobalVisitor
   * does, with the name of a recursive CTE bound in the SELECTs after the first.
   */
  private evalUnion(union: Union, parent: Scope, options: UnionOptions = {}): Columns {
    const members = union.children.filter((child): child is Query | Union => child.kind === "query" || child.kind === "union");
    if (union.pipe) {
      // Pipe operators read the output of the previous step, which this analysis does not follow.
      walk(union, (node) => {
        if (node.kind === "ref") this.record(node.parts, [[UNKNOWN]]);
        this.evaluated.add(node);
      });
      this.taintNamesIn(union);
      return Columns.unknown();
    }
    let columns: Columns | undefined;
    let passOn: Inherited | undefined;
    let recursive = options.recursive;
    members.forEach((member, i) => {
      const inherited = i === 0 ? options.inherited : (passOn ?? options.inherited);
      const memberOptions = { recursive, inherited };
      if (member.kind === "query") {
        const result = this.evalQueryWith(member, parent, memberOptions);
        columns ??= result.columns;
        if (i === 0 && members.length > 1) passOn = result.withs;
      } else {
        const result = this.evalUnion(member, parent, memberOptions);
        columns ??= result;
      }
      if (i === 0 && options.recursiveCte) {
        const { name, def } = options.recursiveCte;
        recursive = { name, def, columns: options.recursiveCte.columns ?? columns! };
      }
    });
    for (const child of union.children) if (child.kind !== "query" && child.kind !== "union") this.evalNode(child, parent);
    this.evaluated.add(union);
    return columns ?? Columns.unknown();
  }

  /** The names defined under `node` are not followed, so none can be renamed. */
  private taintNamesIn(node: Node): void {
    for (const def of this.defs) {
      if (def.kind === "query parameter") continue;
      if (def.sites.some((site) => site.start >= node.start && site.end <= node.end)) this.taint(def, `${def.name} is in a part of the query that is not followed`);
    }
  }

  private evalQuery(query: Query, parent: Scope | null): Columns {
    return this.evalQueryWith(query, parent).columns;
  }

  private evalQueryWith(query: Query, parent: Scope | null, options: UnionOptions = {}): { columns: Columns; withs: Inherited } {
    const info = this.queryInfo(query);
    const scope = new QueryScope(query, parent);
    scope.recursive = options.recursive;
    info.scope ??= scope;
    this.evaluated.add(query);
    // 1. The aliases of WITH, of a WITH copied from the first SELECT of the union, of the select list and the other clauses.
    const withs: Inherited = { aliases: [], ctes: [] };
    for (const node of info.withRoots) {
      const aliases: Alias[] = [];
      collectAliases(node, aliases);
      for (const alias of aliases) {
        const def = info.exprDefs.get(alias.name.name);
        this.addAlias(alias, def, scope);
        if (def && node.kind === "alias" && alias === node) withs.aliases.push({ node: alias, def, defs: info.exprDefs });
      }
    }
    const own = new Set(withs.aliases.map((item) => item.node.name.name));
    const hasWith = query.children.some((child) => child.kind === "with");
    for (const item of options.inherited?.aliases ?? []) {
      if (own.has(item.node.name.name)) continue;
      own.add(item.node.name.name);
      const aliases: Alias[] = [];
      collectAliases(item.node, aliases);
      for (const alias of aliases) this.addAlias(alias, item.defs.get(alias.name.name), scope);
      withs.aliases.push(item);
    }
    for (const node of info.aliasRoots.slice(info.withRoots.length)) this.collectNode(node, info, scope);
    // 2. The CTEs, and those of the first SELECT of the union where this one has no WITH.
    for (const cte of info.ctes) {
      const def = info.cteDefs.get(cte.name!.name)!;
      if (!scope.ctes.has(cte.name!.name)) scope.ctes.set(cte.name!.name, { with: cte, def, query });
    }
    if (!hasWith) for (const cte of options.inherited?.ctes ?? []) if (!scope.ctes.has(cte.def.name)) scope.ctes.set(cte.def.name, cte);
    withs.ctes = [...scope.ctes.values()];
    // 3. The join tree.
    scope.tree = this.initJoinTree(info, scope);
    for (const instance of scope.instances) if (instance.alias) scope.fromAliases.set(instance.alias, instance);
    this.resolveJoinTree(scope.tree, info, scope);
    // Column names after FROM, as in FROM t (a, b), rename the columns of the whole FROM.
    if (query.children.some((child) => child.kind === "opaque")) for (const instance of scope.instances) instance.columns = Columns.unknown();
    this.markArrayJoinAliases(scope);
    scope.version++;
    // 4. The select list and the other clauses; WITH expressions only where they are used.
    for (const node of info.projection) this.evalNode(node, scope);
    for (const node of info.others) this.evalNode(node, scope);
    for (const node of info.interpolate) this.evaluated.add(node);
    return { columns: this.columnsOf(query, info, scope), withs };
  }

  private collectNode(node: Node, info: QueryInfo, scope: Scope): void {
    const aliases: Alias[] = [];
    collectAliases(node, aliases);
    for (const alias of aliases) this.addAlias(alias, info.exprDefs.get(alias.name.name), scope);
  }

  // --- The join tree ------------------------------------------------------------------------------

  private initJoinTree(info: QueryInfo, scope: QueryScope): JoinTree | undefined {
    let tree: JoinTree | undefined;
    for (const element of info.from) {
      if (element.kind === "table") {
        tree = { kind: "leaf", instance: this.instance(element, scope) };
      } else if (element.kind === "join") {
        const table = element.children.find((child): child is Table => child.kind === "table");
        if (!table || !tree) return tree;
        const right: JoinTree = { kind: "leaf", instance: this.instance(table, scope) };
        if (element.join === "comma" || element.join === "cross") {
          tree = tree.kind === "cross" ? { kind: "cross", items: [...tree.items, right] } : { kind: "cross", items: [tree, right] };
        } else {
          tree = { kind: "join", left: tree, right, join: element, inProcess: true };
        }
      } else if (tree) {
        tree = { kind: "array", left: tree, element, columns: [], inProcess: true };
      }
    }
    return tree;
  }

  /** A table expression before its source is resolved: the table or CTE that a name stands for. */
  private instance(table: Table, scope: QueryScope): Instance {
    const info = this.queryInfo(scope.query);
    const instance: Instance = { table, columns: Columns.unknown(), nameTarget: EXT, inProcess: true };
    if (table.alias) {
      instance.alias = table.alias.name;
      instance.aliasDef = info.tableDefs.get(table.alias.name);
    }
    scope.instances.push(instance);
    return instance;
  }

  private resolveJoinTree(tree: JoinTree | undefined, info: QueryInfo, scope: QueryScope): void {
    if (!tree) return;
    switch (tree.kind) {
      case "leaf":
        this.resolveTable(tree.instance, scope);
        return;
      case "cross":
        for (const item of tree.items) this.resolveJoinTree(item, info, scope);
        return;
      case "join": {
        this.resolveJoinTree(tree.left, info, scope);
        this.resolveJoinTree(tree.right, info, scope);
        const join = tree.join;
        if (join.natural || join.lateral) this.unknownJoin(tree, join.natural ? "NATURAL JOIN" : "LATERAL JOIN");
        if (join.on) {
          const nodes = join.children.filter((child) => child.kind !== "table");
          for (const node of nodes) this.collectNode(node, info, scope);
          for (const node of nodes) this.evalNode(node, scope);
        } else if (join.using) {
          tree.using = this.resolveUsing(tree, join, scope);
        }
        tree.inProcess = false;
        scope.version++;
        return;
      }
      case "array": {
        this.resolveJoinTree(tree.left, info, scope);
        const element = tree.element;
        this.evaluated.add(element);
        for (const child of element.children) {
          if (child.kind === "alias") for (const inner of child.children) this.collectNode(inner, info, scope);
          else this.collectNode(child, info, scope);
        }
        for (const child of element.children) {
          if (child.kind === "alias") {
            this.evaluated.add(child);
            for (const inner of child.children) this.evalNode(inner, scope);
            tree.columns.push({ name: child.name.name, targets: new Set([info.arrayJoinDefs.get(child)!]) });
          } else if (child.kind === "ref" && child.parts.length) {
            this.evalNode(child, scope);
            const targets = this.words.get(child.parts[child.parts.length - 1]!.start)?.targets ?? new Set<Target>([EXT]);
            tree.columns.push({ name: child.parts[child.parts.length - 1]!.name, targets: new Set(targets) });
            if (child.parts.length > 1) tree.columns.push({ name: child.parts.map((part) => part.name).join("."), targets: new Set([UNKNOWN]) });
          } else {
            this.evalNode(child, scope);
          }
        }
        // A column of the same name as an ARRAY JOIN column is hidden by it, which a new name would undo.
        const names = new Set(tree.columns.map((column) => column.name));
        for (const column of this.treeColumns(tree.left).list) {
          if (!names.has(column.name)) continue;
          for (const target of column.targets) if (isDef(target) && !tree.columns.some((other) => other.targets.has(target))) this.taint(target, `${target.name} is hidden by an ARRAY JOIN of the same name`);
        }
        tree.inProcess = false;
        scope.version++;
        return;
      }
    }
  }

  /** NATURAL and LATERAL joins: every column of their sides may be read through them. */
  private unknownJoin(tree: Extract<JoinTree, { kind: "join" }>, what: string): void {
    for (const side of [tree.left, tree.right]) {
      for (const instance of leaves(side)) {
        for (const column of instance.columns.list) for (const target of column.targets) if (isDef(target)) this.taint(target, `${target.name} is read through a ${what}`);
        instance.columns = new Columns(instance.columns.list.map((column) => ({ name: column.name, targets: new Set([UNKNOWN]) })), true);
      }
    }
  }

  private resolveTable(instance: Instance, scope: QueryScope): void {
    const table = instance.table;
    const info = this.queryInfo(scope.query);
    this.evaluated.add(table);
    switch (table.source) {
      case "name":
        this.resolveTableName(instance, scope);
        break;
      case "function": {
        const name = table.name.map((word) => word.name).join(".").toLowerCase();
        // view(SELECT ...) is analyzed on its own, and its columns are those of the SELECT.
        const view = name === "view" || name === "viewifpermitted" ? table.children.find((child): child is Union => child.kind === "union") : undefined;
        const args = this.tableArgs(table).filter((node) => node !== view);
        for (const node of args) this.collectNode(node, info, scope);
        for (const node of args) this.evalTableArg(node, scope);
        // A SELECT in the arguments of another table function, as in obfuscate(SELECT ...), gives its columns in a way not followed.
        for (const node of args) walk(node, (inner) => inner.kind === "union" && this.taintNamesIn(inner));
        const known = KNOWN_TABLES[name];
        instance.columns = view ? this.evalUnion(view, new OuterScope(null)) : known ? Columns.of(known) : (this.functionColumns(name, table) ?? Columns.unknown());
        this.record(table.name, [table.name.map(() => EXT)]);
        break;
      }
      case "subquery": {
        const union = table.children.find((child): child is Union => child.kind === "union");
        const opaque = table.children.some((child) => child.kind === "opaque");
        if (union && !opaque) instance.columns = this.evalUnion(union, scope);
        else {
          for (const child of table.children) if (child.kind !== "alias") this.evalNode(child, scope);
          instance.columns = Columns.unknown();
        }
        break;
      }
      default:
        // Joined tables in brackets are a subquery of their own, which this analysis does not follow.
        for (const child of table.children) {
          if (child.kind === "alias" && table.alias && child.name.start === table.alias.start) continue;
          walk(child, (node) => {
            this.evaluated.add(node);
            if (node.kind === "ref") this.record(node.parts, [[UNKNOWN]]);
          });
          this.taintNamesIn(child);
        }
        instance.columns = Columns.unknown();
    }
    if (table.columns) instance.columns = this.renamedColumns(table.columns);
    instance.inProcess = false;
    scope.version++;
  }

  /** An identifier argument of a table function stays a name unless it resolves to a constant. */
  private evalTableArg(node: Node, scope: Scope): void {
    if (node.kind !== "ref" || node.unsupported || !node.parts.length) {
      this.evalNode(node, scope);
      return;
    }
    this.evaluated.add(node);
    const alts = this.lookupExpr(node.parts, scope, DEFAULT_CTX);
    // The name is the alias where it stands for a constant, as a literal surely does.
    const constant = alts?.length === 1 && isDef(alts[0]![0]!) && (this.aliasNodes.get(alts[0]![0] as Def) ?? []).every((alias) => alias.node === "literal");
    if (constant) this.record(node.parts, alts);
    else if (alts?.some((alt) => alt.some(isDef))) this.record(node.parts, [...alts, node.parts.map(() => EXT)]);
    else this.record(node.parts, [node.parts.map(() => EXT)]);
  }

  /** Columns named by a column list such as t(a, b) or c(a, b) AS (...). */
  private renamedColumns(words: Word[]): Columns {
    return new Columns(words.map((word) => ({ name: word.name, targets: new Set<Target>([this.columnDefs.get(word)!]) })), false);
  }

  /** The columns that generateRandom('a UInt8, b String') or values('a UInt8', ...) declare. */
  private functionColumns(name: string, table: Table): Columns | undefined {
    if (name !== "generaterandom" && name !== "values") return undefined;
    const tokens = this.statement.tokens;
    const i = this.statement.tokenAt.get(table.name[table.name.length - 1]!.start)!;
    if (tokens[i + 1]?.kind !== "OpeningRoundBracket" || tokens[i + 2]?.kind !== "StringLiteral") return undefined;
    const text = this.textOf(tokens[i + 2]!.start, tokens[i + 2]!.end);
    if (text.includes("\\") || !text.startsWith("'")) return undefined;
    const names = structureNames(text.slice(1, -1));
    return names ? Columns.of(names) : undefined;
  }

  private resolveTableName(instance: Instance, scope: QueryScope): void {
    const table = instance.table;
    const parts = table.name;
    if (parts.length === 0) return;
    const full = parts.map((word) => word.name).join(".");
    if (parts.length === 1) {
      const name = parts[0]!.name;
      // Another table expression of this FROM with this alias.
      const other = table.alias?.name === name ? undefined : scope.fromAliases.get(name);
      if (other && other !== instance) {
        this.record(parts, [[other.aliasDef ?? EXT]]);
        instance.columns = new Columns(other.columns.list.map((column) => ({ name: column.name, targets: new Set([UNKNOWN]) })), true);
        return;
      }
      const recursive = this.recursiveTable(name, scope);
      if (recursive) {
        instance.tableName = name;
        instance.nameTarget = recursive.def;
        instance.columns = recursive.columns;
        this.record(parts, [[recursive.def]]);
        return;
      }
      const cte = this.findCte(name, scope);
      if (cte) {
        instance.tableName = name;
        instance.nameTarget = cte.def;
        this.record(parts, [[cte.def]]);
        instance.columns = this.evalCte(cte, scope);
        return;
      }
    }
    this.record(parts, [parts.map(() => EXT)]);
    instance.tableName = parts[parts.length - 1]!.name;
    if (parts.length === 2) instance.database = parts[0]!.name;
    const known = KNOWN_TABLES[full.toLowerCase()];
    instance.columns = known && parts.length === 2 ? Columns.of(known) : Columns.unknown();
  }

  /** The recursive CTE table that a member of a recursive CTE reads under the CTE's name. */
  private recursiveTable(name: string, scope: Scope): QueryScope["recursive"] {
    for (let current: Scope | null = scope; current; current = current.parent) {
      if (current instanceof QueryScope && current.recursive?.name === name) return current.recursive;
    }
    return undefined;
  }

  private findCte(name: string, scope: Scope): CteEntry | undefined {
    for (let current: Scope | null = scope; current; current = current.parent) {
      if (!(current instanceof QueryScope)) continue;
      const entry = current.ctes.get(name);
      if (entry && !this.ctesInProcess.has(entry.def)) return entry;
    }
    return undefined;
  }

  /** A CTE read at one place: its query resolved with that place as the parent scope. */
  private evalCte(cte: CteEntry, useScope: Scope): Columns {
    const union = cte.with.children.find((child): child is Union => child.kind === "union");
    if (!union) return Columns.unknown();
    this.ctesInProcess.add(cte.def);
    let columns: Columns;
    try {
      columns = cte.query.recursive ? this.evalRecursiveCte(cte, union, useScope) : this.evalUnion(union, useScope);
    } finally {
      this.ctesInProcess.delete(cte.def);
    }
    this.evaluated.add(cte.with);
    return cte.with.columns ? this.renamedColumns(cte.with.columns) : columns;
  }

  private evalRecursiveCte(cte: CteEntry, union: Union, useScope: Scope): Columns {
    // With a column list, as in c (a, b) AS (...), the recursive table has those names.
    const columns = cte.with.columns ? this.renamedColumns(cte.with.columns) : undefined;
    return this.evalUnion(union, useScope, { recursiveCte: { name: cte.def.name, def: cte.def, columns } });
  }

  private resolveUsing(tree: Extract<JoinTree, { kind: "join" }>, join: Join, scope: QueryScope): Map<string, Set<Target>> {
    const using = new Map<string, Set<Target>>();
    for (const child of join.children) {
      if (child.kind === "table") continue;
      this.evaluated.add(child);
      if (child.kind !== "ref" || child.parts.length !== 1) {
        // USING (a AS b) joins a of the left side with b of the right one, which this analysis does not follow.
        walk(child, (node) => {
          if (node.kind === "ref") this.record(node.parts, [[UNKNOWN]]);
          if (node.kind === "alias") this.unfollowedNames.add(node.name.name);
          this.evaluated.add(node);
        });
        continue;
      }
      const parts = child.parts;
      const left = this.lookupTree(parts, tree.left, scope);
      const right = this.lookupTree(parts, tree.right, scope);
      const alts = [...left.alts, ...right.alts];
      if (left.maybe || right.maybe || alts.length === 0) alts.push([EXT]);
      this.record(parts, alts);
      const targets = new Set<Target>(alts.map((alt) => alt[0]!));
      for (const target of targets) if (isDef(target)) this.taint(target, `${target.name} joins tables by name in USING`);
      using.set(parts[0]!.name, targets);
    }
    return using;
  }

  /** Aliases whose expression is an ARRAY JOIN column look at the join tree first. */
  private markArrayJoinAliases(scope: QueryScope): void {
    const names = new Set<string>();
    const visit = (tree: JoinTree | undefined): void => {
      if (tree?.kind === "array") {
        for (const column of tree.columns) names.add(column.name.split(".")[0]!);
        visit(tree.left);
      } else if (tree?.kind === "join") {
        visit(tree.left);
        visit(tree.right);
      } else if (tree?.kind === "cross") tree.items.forEach(visit);
    };
    visit(scope.tree);
    if (!names.size) return;
    for (const entry of scope.aliases.expr.values()) {
      if (entry.node.node !== "identifier") continue;
      const ref = entry.node.children[0];
      if (ref?.kind === "ref" && ref.parts.length === 1 && names.has(ref.parts[0]!.name)) entry.arrayJoin = true;
    }
  }

  // --- Lookups ------------------------------------------------------------------------------------

  private resolveRef(ref: Ref, scope: Scope, ctx: Ctx): void {
    this.evaluated.add(ref);
    if (ref.unsupported || ref.parts.length === 0 || this.lambdaFunctionRefs.has(ref)) {
      this.record(ref.parts, [[UNKNOWN]]);
      return;
    }
    let alts = this.lookupExpr(ref.parts, scope, ctx);
    const unresolved = !alts || alts.every((alt) => alt[0] === EXT);
    if (unresolved && (this.isFunctionArgument(ref) || this.isCompositionOperand(ref)) && ref.parts.length === 1) {
      const fn = this.lookupFunction(ref.parts[0]!, scope, ctx);
      if (fn) alts = [...(alts ?? []), [fn]];
    }
    if (unresolved && this.isInArgument(ref)) {
      const table = this.lookupTableExpr(ref.parts, scope);
      if (table) alts = [...(alts ?? []), table];
    }
    this.record(ref.parts, alts ?? [ref.parts.map(() => EXT)]);
  }

  /** tryResolveIdentifier for an expression: lambda arguments, aliases, the join tree, then the parent scopes. */
  private lookupExpr(parts: Word[], scope: Scope, ctx: Ctx): Alt[] | null {
    this.spend();
    const name = parts[0]!.name;
    if (scope instanceof LambdaScope) {
      const param = scope.params.get(name);
      if (param && !scope.hidden.has(name)) return [[param]];
    }
    // A name looked up again while its lookup in this scope is in process skips the aliases, as
    // identifier_in_lookup_process makes tryResolveIdentifier do; this ends cycles through outer aliases.
    const key = parts.map((part) => part.name).join(".");
    const count = scope.lookups.get(key) ?? 0;
    scope.lookups.set(key, count + 1);
    try {
      return this.lookupExprOnce(parts, scope, count > 0 ? { ...ctx, allowAliases: false, skipped: true } : ctx);
    } finally {
      if (count) scope.lookups.set(key, count);
      else scope.lookups.delete(key);
    }
  }

  private lookupExprOnce(parts: Word[], scope: Scope, ctx: Ctx): Alt[] | null {
    const name = parts[0]!.name;
    const preferColumns = this.options.preferColumnsMaybe;
    const entry = scope.aliases.expr.get(name);
    if (preferColumns || (entry?.arrayJoin && parts.length === 1)) {
      const columnsFirst = this.lookupOrdered(parts, scope, ctx, true);
      if (!preferColumns) return columnsFirst;
      const aliasesFirst = this.lookupOrdered(parts, scope, ctx, false);
      if (!columnsFirst) return aliasesFirst;
      if (!aliasesFirst) return columnsFirst;
      return [...columnsFirst, ...aliasesFirst];
    }
    return this.lookupOrdered(parts, scope, ctx, false);
  }

  private lookupOrdered(parts: Word[], scope: Scope, ctx: Ctx, columnsFirst: boolean): Alt[] | null {
    let found: Found = NOT_FOUND;
    if (columnsFirst) {
      found = this.lookupJoinTreeOf(parts, scope, ctx);
      if (found.alts.length) return found.maybe ? [...found.alts, [EXT]] : found.alts;
      const alias = this.fromAliases(parts, scope, ctx);
      if (alias) return found.maybe ? [[EXT], ...alias] : alias;
    } else {
      const alias = this.fromAliases(parts, scope, ctx);
      // a.b reads a subcolumn of the alias a only where its value has one; otherwise it is looked up further.
      if (alias && parts.length > 1) {
        const further = this.lookupOrdered(parts, scope, { ...ctx, allowAliases: false }, false);
        return further ? [...alias, ...further] : alias;
      }
      if (alias) return alias;
      found = this.lookupJoinTreeOf(parts, scope, ctx);
      if (found.alts.length) return found.maybe ? [...found.alts, [EXT]] : found.alts;
    }
    const parent = this.lookupInParent(parts, scope, ctx.skipped || !ctx.allowAliases ? { ...ctx, allowAliases: true, skipped: false } : ctx);
    if (found.maybe) return parent ? [[EXT], ...parent] : [[EXT]];
    if (parent) return parent;
    return null;
  }

  private lookupJoinTreeOf(parts: Word[], scope: Scope, ctx: Ctx): Found {
    if (!(scope instanceof QueryScope) || !ctx.allowJoinTree || !scope.tree) return NOT_FOUND;
    return this.lookupTree(parts, scope.tree, scope);
  }

  /** tryResolveIdentifierFromAliases: the alias's expression is resolved again where it is used. */
  private fromAliases(parts: Word[], scope: Scope, ctx: Ctx): Alt[] | null {
    if (!ctx.allowAliases) return null;
    const name = parts[0]!.name;
    const entry = scope.aliases.expr.get(name);
    if (!entry) return null;
    if (scope.stack.includes(name)) return null;
    const target = ctx.aliasScope ?? scope;
    const hidden = ctx.aliasScope ? this.hiddenArguments(target, scope) : [];
    const certain = hidden.filter((item) => item.certain);
    const maybe = hidden.filter((item) => !item.certain);
    this.expandAlias(entry, target, ctx, certain);
    if (maybe.length) this.expandAlias(entry, target, ctx, hidden);
    return [[entry.def, ...parts.slice(1).map(() => EXT)]];
  }

  private expandAlias(entry: AliasEntry, scope: Scope, ctx: Ctx, hidden: { scope: LambdaScope; name: string }[]): void {
    const key = `${entry.node.id}|${this.contextKey(scope, entry.node.name.name)}|${hidden.map((item) => `${item.scope.id}.${item.name}`).join(",")}|${ctx.aliasScope ? 1 : 0}`;
    if (this.done.has(key)) return;
    this.done.add(key);
    if (scope.stack.length > 200) throw new OutOfWork();
    this.evaluated.add(entry.node);
    const added = hidden.filter((item) => !item.scope.hidden.has(item.name));
    for (const item of added) item.scope.hidden.add(item.name);
    scope.stack.push(entry.node.name.name);
    try {
      const body = entry.node.children;
      if ((entry.node.node === "identifier" || entry.node.node === "compound") && body.length === 1 && body[0]!.kind === "ref") {
        // An identifier alias keeps the context of the lookup that found it.
        this.resolveRef(body[0]!, scope, { ...DEFAULT_CTX, aliasScope: ctx.aliasScope });
      } else if (entry.node.node !== "lambda") {
        for (const child of body) this.evalNode(child, scope);
      }
    } finally {
      scope.stack.pop();
      for (const item of added) item.scope.hidden.delete(item.name);
    }
  }

  /** hideLambdaArgumentsShadowingAliasExpression: lambda arguments that the alias's expression cannot see. */
  private hiddenArguments(referencing: Scope, aliasScope: Scope): { scope: LambdaScope; name: string; certain: boolean }[] {
    const lambdas = new Set<LambdaScope>();
    for (let current: Scope | null = referencing; current && current !== aliasScope; current = current.parent) {
      if (current instanceof LambdaScope) lambdas.add(current);
    }
    const result: { scope: LambdaScope; name: string; certain: boolean }[] = [];
    for (const lambda of lambdas) {
      for (const name of lambda.params.keys()) {
        const hide = this.hasToHide(name, referencing, lambdas);
        if (hide) result.push({ scope: lambda, name, certain: hide === true });
      }
    }
    return result;
  }

  private hasToHide(name: string, referencing: Scope, toHide: Set<LambdaScope>): boolean | "maybe" {
    for (let current: Scope | null = referencing; current; current = current.parent) {
      if (current instanceof LambdaScope && current.params.has(name) && !toHide.has(current) && !current.hidden.has(name)) return false;
      const binds = this.canBind(name, current);
      if (binds) return binds;
    }
    return NILADIC.has(name.toLowerCase());
  }

  private canBind(name: string, scope: Scope): boolean | "maybe" {
    if (!scope.stack.includes(name) && scope.aliases.expr.has(name)) return true;
    if (!(scope instanceof QueryScope) || !scope.tree) return false;
    const found = this.lookupTree([{ start: -1, end: -1, name, quoted: false }], scope.tree, scope);
    if (found.alts.length) return true;
    return found.maybe ? "maybe" : false;
  }

  /** tryResolveIdentifierInParentScopes. */
  private lookupInParent(parts: Word[], scope: Scope, ctx: Ctx): Alt[] | null {
    const parent = scope.parent;
    if (!parent || parent instanceof OuterScope) return null;
    return this.lookupExpr(parts, parent, { ...ctx, aliasScope: ctx.aliasScope ?? scope });
  }

  /** tryResolveIdentifierFromJoinTreeNode. */
  private lookupTree(parts: Word[], tree: JoinTree, scope: QueryScope): Found {
    switch (tree.kind) {
      case "leaf":
        return tree.instance.inProcess ? NOT_FOUND : this.lookupInstance(parts, tree.instance, scope);
      case "cross": {
        const results = tree.items.map((item) => this.lookupTree(parts, item, scope));
        if (results.length === 2 && joinsCount(scope.tree) === 1) return preferLeft(results[0]!, results[1]!);
        // A name in two of the tables is an error, so where one surely has it the others do not.
        const found = results.filter((result) => result.alts.length);
        if (found.length) return { alts: found.flatMap((result) => result.alts), maybe: found.some((result) => result.maybe) };
        return { alts: [], maybe: results.some((result) => result.maybe) };
      }
      case "join": {
        if (tree.using && !tree.inProcess && parts.length === 1) {
          const targets = tree.using.get(parts[0]!.name);
          if (targets) return { alts: [...targets].map((target) => [target]), maybe: false };
        }
        return preferLeft(this.lookupTree(parts, tree.left, scope), this.lookupTree(parts, tree.right, scope));
      }
      case "array": {
        const left = this.lookupTree(parts, tree.left, scope);
        if (tree.inProcess) return left;
        for (const column of tree.columns) {
          const prefix = column.name.split(".");
          if (prefix.length > parts.length || !prefix.every((part, i) => parts[i]!.name === part)) continue;
          const alt: Alt = parts.map((_, i) => (i < prefix.length ? [...column.targets][0]! : EXT));
          if (column.targets.size > 1) return { alts: [...column.targets].map((target) => parts.map((_, i) => (i < prefix.length ? target : EXT))), maybe: false };
          return { alts: [alt], maybe: false };
        }
        return left;
      }
    }
  }

  /** tryResolveIdentifierFromTableExpression for an expression. */
  private lookupInstance(parts: Word[], instance: Instance, scope: QueryScope): Found {
    const name = parts[0]!.name;
    const columns = instance.columns;
    const full = parts.map((part) => part.name).join(".");
    // A quoted name may be the name of a column made of an expression, such as `plus(x, 1)`.
    if (columns.opaque && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(full)) for (const def of columns.opaqueDefs) this.taint(def, `${def.name} is part of a column name that the query reads`);
    const column = columns.find(full);
    if (parts.length === 1) {
      if (column) return { alts: [...column.targets].map((target) => [target]), maybe: false };
      return { alts: [], maybe: column === undefined };
    }
    // A column whose name is the first part comes before the table name and alias.
    const first = columns.find(name);
    const isQualifier = name === instance.tableName || name === instance.alias;
    if (first) {
      if (isQualifier) return { alts: [parts.map(() => UNKNOWN)], maybe: false };
      return { alts: [...first.targets].map((target) => [target, ...parts.slice(1).map(() => EXT)]), maybe: false };
    }
    if (column) return { alts: [parts.map(() => UNKNOWN)], maybe: false };
    // A table of unknown columns is taken to have none named like a table or alias of the FROM.
    let maybe = false;
    if (first === undefined && !this.isQualifierInScope(name, scope)) maybe = true;
    if (isQualifier) {
      // Where the alias and the table name are the same, the qualifier stays valid as either, so it is the alias.
      const qualifier: Target = name === instance.alias ? (instance.aliasDef ?? EXT) : instance.nameTarget;
      const inner = columns.find(parts.slice(1).map((part) => part.name).join("."));
      const rest = parts.slice(2).map(() => EXT);
      if (parts.length > 2 && inner === null) {
        const second = columns.find(parts[1]!.name);
        if (second) return { alts: [...second.targets].map((target) => [qualifier, target, ...rest]), maybe };
      }
      if (inner) return { alts: [...inner.targets].map((target) => [qualifier, target, ...rest]), maybe };
      const second = columns.find(parts[1]!.name);
      if (second) return { alts: [...second.targets].map((target) => [qualifier, target, ...rest]), maybe };
      return { alts: [[qualifier, EXT, ...rest]], maybe };
    }
    if (parts.length >= 3 && instance.database === name && instance.tableName === parts[1]!.name) {
      const inner = columns.find(parts[2]!.name);
      const targets = inner ? [...inner.targets] : [EXT];
      return { alts: targets.map((target) => [EXT, instance.nameTarget, target, ...parts.slice(3).map(() => EXT)]), maybe };
    }
    return { alts: [], maybe };
  }

  private isQualifierInScope(name: string, scope: QueryScope): boolean {
    return scope.instances.some((instance) => instance.alias === name || instance.tableName === name || instance.database === name);
  }

  /** The table that `x IN t` reads: a table alias of the FROM, a CTE, or a table of the database. */
  private lookupTableExpr(parts: Word[], scope: Scope): Alt | null {
    if (parts.length !== 1) return null;
    const name = parts[0]!.name;
    // Past the first query, only CTEs are looked at, as tryResolveIdentifierInParentScopes does for tables.
    let first = true;
    for (let current: Scope | null = scope; current; current = current.parent) {
      if (!(current instanceof QueryScope)) continue;
      const instance = first ? (current.fromAliases.get(name) ?? current.instances.find((item) => item.tableName === name && !item.inProcess)) : undefined;
      first = false;
      if (instance) return [instance.alias === name ? (instance.aliasDef ?? EXT) : instance.nameTarget];
      const recursive = current.recursive?.name === name ? current.recursive : undefined;
      if (recursive) return [recursive.def];
      const cte = current.ctes.get(name);
      if (cte && !this.ctesInProcess.has(cte.def)) {
        this.evalCte(cte, scope);
        return [cte.def];
      }
    }
    return null;
  }

  /** Whether the identifier is a whole argument of a function call, where a lambda may stand. */
  private isFunctionArgument(ref: Ref): boolean {
    const { tokens, tokenAt, enclosing } = this.statement;
    // The argument may be the identifier with aliases, as in arrayMap(f AS g, ...).
    let node: Ref | Alias = ref;
    while (node.parent?.kind === "alias" && node.parent.body[0] === node.start && node.parent.body[1] === node.end) node = node.parent;
    const first = tokenAt.get(node.start);
    const last = tokenAt.get(node.kind === "alias" ? node.name.start : ref.parts[ref.parts.length - 1]!.start);
    if (first === undefined || last === undefined) return false;
    const before = tokens[first - 1]?.kind;
    const after = tokens[last + 1]?.kind;
    if ((before !== T.OpeningRoundBracket && before !== T.Comma) || (after !== T.ClosingRoundBracket && after !== T.Comma)) return false;
    const open = enclosing[first]!;
    if (open <= 0 || tokens[open]!.kind !== T.OpeningRoundBracket) return false;
    return this.callEnds.has(tokens[open - 1]!.end);
  }

  /** Whether the identifier is an operand of the function composition f | g, where a lambda may stand. */
  private isCompositionOperand(ref: Ref): boolean {
    const { tokens, tokenAt } = this.statement;
    const first = tokenAt.get(ref.start);
    const last = tokenAt.get(ref.parts[ref.parts.length - 1]!.start);
    if (first === undefined || last === undefined) return false;
    return tokens[first - 1]?.kind === T.PipeMark || tokens[last + 1]?.kind === T.PipeMark;
  }

  /** Whether the identifier is the whole right side of IN, where a table may stand. */
  private isInArgument(ref: Ref): boolean {
    const { tokens, tokenAt, match } = this.statement;
    let first = tokenAt.get(ref.start);
    let last = tokenAt.get(ref.parts[ref.parts.length - 1]!.start);
    if (first === undefined || last === undefined || first === 0) return false;
    // x IN (t) reads t as well: brackets around one element are that element.
    while (first > 1 && tokens[first - 1]!.kind === T.OpeningRoundBracket && match[first - 1] === last + 1) {
      first--;
      last++;
    }
    const before = tokens[first - 1]!;
    if (before.kind !== T.BareWord || this.textOf(before.start, before.end).toUpperCase() !== "IN") return false;
    const after = tokens[last + 1]?.kind;
    return after === undefined || after === T.ClosingRoundBracket || after === T.Comma || after === T.Semicolon || after === T.EndOfStream || after === T.BareWord;
  }

  private get callEnds(): Set<number> {
    if (!this.calls) {
      this.calls = new Set();
      for (const node of this.statement.nodes) if (node.kind === "call") this.calls.add(node.end);
    }
    return this.calls;
  }

  /** A subquery in an expression gives a value, unless IN, EXISTS, ANY, ALL or SOME reads it. */
  private isScalar(union: Union): boolean {
    if (!union.parent || union.parent.kind === "table" || union.parent.kind === "with" || union.parent.kind === "opaque") return false;
    const { tokens, tokenAt } = this.statement;
    const first = tokenAt.get(union.start);
    if (first === undefined || first < 2 || tokens[first - 1]!.kind !== T.OpeningRoundBracket) return true;
    const before = tokens[first - 2]!;
    if (before.kind !== T.BareWord) return true;
    return !["IN", "EXISTS", "ANY", "ALL", "SOME"].includes(this.textOf(before.start, before.end).toUpperCase());
  }

  /** A subquery of several columns gives a tuple whose elements its aliases name. */
  private taintTupleNames(union: Union): void {
    for (const query of firstQueries(union)) {
      if (query.items.length < 2 && !query.items.some((item) => item.kind === "matcher")) continue;
      const info = this.queryInfo(query);
      for (const item of query.items) {
        if (item.kind !== "alias") continue;
        const def = info.exprDefs.get(item.node.name.name);
        if (def) this.taint(def, `${def.name} names an element of the tuple that its subquery gives`);
      }
    }
  }

  // --- Functions ----------------------------------------------------------------------------------

  private resolveCall(call: Call, scope: Scope): void {
    this.evaluated.add(call);
    // lambda(tuple(x), body) defines a lambda rather than calling one.
    if (call.parts.length !== 1 || this.isLambdaFunction(call)) {
      this.record(call.parts, [call.parts.map(() => EXT)]);
      return;
    }
    const name = call.parts[0]!.name;
    // A lambda argument may be a lambda passed to a higher-order lambda, or a value, which leaves the function.
    for (let current: Scope | null = scope; current; current = current.parent) {
      if (!(current instanceof LambdaScope)) continue;
      const param = current.params.get(name);
      if (param && !current.hidden.has(name)) {
        this.record(call.parts, [[param], [EXT]]);
        return;
      }
    }
    const def = this.lookupFunction(call.parts[0]!, scope, DEFAULT_CTX);
    this.record(call.parts, [[def ?? EXT]]);
  }

  /** A lambda named by an alias, where a function is called: the lambda is resolved at the call. */
  private lookupFunction(word: Word, scope: Scope, ctx: Ctx): Def | null {
    this.spend();
    const name = word.name;
    for (let current: Scope | null = scope; current; current = current.parent) {
      if (current instanceof OuterScope) return null;
      const entry = current.aliases.lambda.get(name);
      if (!entry || current.stack.includes(name)) continue;
      if (entry.node.node === "lambda") {
        this.applyLambdaAlias(entry, scope);
        return entry.def;
      }
      // An alias of a name, as in WITH f AS g: the name is looked up as a function in turn.
      const ref = entry.node.children[0];
      if (ref?.kind === "ref" && ref.parts.length === 1) {
        current.stack.push(name);
        try {
          const inner = this.lookupFunction(ref.parts[0]!, current, ctx);
          this.record(ref.parts, [[inner ?? EXT]]);
          this.evaluated.add(entry.node);
          this.evaluated.add(ref);
          if (inner) return entry.def;
        } finally {
          current.stack.pop();
        }
      }
      return null;
    }
    return null;
  }

  private applyLambdaAlias(entry: AliasEntry, scope: Scope): void {
    const lambda = entry.node.children.find((child): child is Lambda => child.kind === "lambda");
    this.evaluated.add(entry.node);
    if (!lambda) {
      for (const child of entry.node.children) this.evalNode(child, scope);
      return;
    }
    // A lambda that calls itself is an error in ClickHouse ("Recursive lambda"), so there is nothing to follow.
    if (this.lambdasInProcess.has(lambda)) {
      this.taint(entry.def, `${entry.def.name} is a lambda that calls itself`);
      return;
    }
    const key = `lambda|${lambda.id}|${this.contextKey(scope, entry.node.name.name)}`;
    if (this.done.has(key)) return;
    this.done.add(key);
    this.evaluated.add(lambda);
    this.lambdasInProcess.add(lambda);
    try {
      this.evalLambda(lambda, scope);
    } finally {
      this.lambdasInProcess.delete(lambda);
    }
  }

  // --- Matchers -----------------------------------------------------------------------------------

  private resolveMatcher(matcher: Matcher, scope: Scope): void {
    this.evaluated.add(matcher);
    if (matcher.qualifier) {
      const parts = matcher.qualifier;
      const alts = this.lookupExpr(parts, scope, DEFAULT_CTX);
      if (alts && alts.some((alt) => alt.some(isDef))) this.record(parts, alts);
      else {
        const table = this.qualifiedTable(parts, scope);
        this.record(parts, table ? [table] : [parts.map(() => EXT)]);
      }
    }
    if (matcher.plain) return;
    // COLUMNS, LIKE, EXCEPT, REPLACE and APPLY choose or name columns by their names.
    for (let current: Scope | null = scope; current; current = current.parent) {
      if (!(current instanceof QueryScope)) continue;
      const matched = this.matched(matcher, current);
      for (const column of matched.list) for (const target of column.targets) if (isDef(target)) this.taint(target, `${target.name} is matched by name`);
      // A qualifier the matcher does not resolve may be any table of the query.
      if (matched.unknown && matcher.qualifier && current.tree) for (const column of this.treeColumns(current.tree).list) for (const target of column.targets) if (isDef(target)) this.taint(target, `${target.name} is matched by name`);
      break;
    }
  }

  /** The table expression of a qualified matcher such as t.* or db.t.*. */
  private qualifiedTable(parts: Word[], scope: Scope): Alt | null {
    for (let current: Scope | null = scope; current; current = current.parent) {
      if (!(current instanceof QueryScope)) continue;
      const alts: Alt[] = [];
      for (const instance of current.instances) {
        if (instance.inProcess) continue;
        if (parts.length === 1 && instance.alias === parts[0]!.name) alts.push([instance.aliasDef ?? EXT]);
        else if (parts.length === 1 && instance.tableName === parts[0]!.name) alts.push([instance.nameTarget]);
        else if (parts.length === 2 && instance.database === parts[0]!.name && instance.tableName === parts[1]!.name) alts.push([EXT, instance.nameTarget]);
      }
      if (alts.length === 1) return alts[0]!;
      if (alts.length > 1) return parts.map(() => UNKNOWN);
      if (current === scope) continue;
    }
    return null;
  }

  // --- Columns of a query -------------------------------------------------------------------------

  /** The columns that a SELECT gives the query around it. */
  private columnsOf(query: Query, info: QueryInfo, scope: QueryScope): Columns {
    if (!query.projection) return this.allColumns(scope);
    const list: Column[] = [];
    let unknown = false;
    let opaque = false;
    const opaqueDefs: Def[] = [];
    for (const item of query.items) {
      switch (item.kind) {
        case "alias":
          list.push({ name: item.node.name.name, targets: new Set([info.exprDefs.get(item.node.name.name)!]) });
          break;
        case "ref": {
          const parts = item.node.parts;
          if (item.node.unsupported || !parts.length) {
            unknown = true;
            break;
          }
          const last = this.words.get(parts[parts.length - 1]!.start)?.targets ?? new Set<Target>([EXT]);
          if (parts.length === 1) {
            list.push({ name: parts[0]!.name, targets: new Set(last) });
            break;
          }
          const first = [...(this.words.get(parts[0]!.start)?.targets ?? [EXT])];
          const qualifier = first.every((target) => target === EXT || (isDef(target) && (target.kind === "table alias" || target.kind === "CTE")));
          if (qualifier) list.push({ name: parts[parts.length - 1]!.name, targets: new Set(last) });
          if (!qualifier || first.includes(EXT) || parts.length > 2) {
            // A subcolumn or a compound name: its column name depends on every part.
            list.push({ name: parts.map((part) => part.name).join("."), targets: new Set([UNKNOWN]) });
            if (!qualifier) for (const part of parts) for (const target of this.words.get(part.start)?.targets ?? []) if (isDef(target)) this.taint(target, `${target.name} is part of a column name`);
          }
          break;
        }
        case "matcher": {
          const matched = this.matched(item.node, scope);
          if (!item.node.plain) {
            for (const column of matched.list) for (const target of column.targets) if (isDef(target)) this.taint(target, `${target.name} is matched by name`);
            unknown = true;
            opaque = true;
            break;
          }
          list.push(...matched.list);
          if (matched.unknown) unknown = true;
          if (matched.opaque) opaque = true;
          break;
        }
        default:
          opaque = true;
          for (const { word, targets } of this.words.values()) {
            if (word.start < item.start || word.end > item.end) continue;
            for (const target of targets) if (isDef(target)) opaqueDefs.push(target);
          }
      }
    }
    return new Columns(list, unknown, opaque, false, opaqueDefs);
  }

  /** What `*` gives when there is no select list, as with FROM t alone. */
  private allColumns(scope: QueryScope): Columns {
    if (!scope.tree) return Columns.unknown();
    return this.treeColumns(scope.tree);
  }

  private matched(matcher: Matcher, scope: QueryScope): Columns {
    if (!scope.tree) return Columns.unknown();
    if (!matcher.qualifier) {
      const before = this.statement.tokens[this.statement.tokenAt.get(matcher.start)! - 1];
      if (before?.kind === "Dot") return Columns.unknown();
      return this.treeColumns(scope.tree);
    }
    const target = this.words.get(matcher.qualifier[matcher.qualifier.length - 1]!.start)?.targets;
    const instances = scope.instances.filter((instance) => {
      const name = matcher.qualifier!.map((word) => word.name);
      if (name.length === 1) return instance.alias === name[0] || (!instance.alias && instance.tableName === name[0]) || instance.tableName === name[0];
      return instance.database === name[0] && instance.tableName === name[1];
    });
    if (instances.length !== 1 || !target) return Columns.unknown();
    return instances[0]!.columns;
  }

  /** The columns of a join tree, those of the same name in several tables qualified by their table. */
  private treeColumns(tree: JoinTree): Columns {
    const columns = this.plainTreeColumns(tree);
    return tree.kind === "leaf" ? columns : this.qualifyCollisions(columns, leaves(tree));
  }

  private plainTreeColumns(tree: JoinTree): Columns {
    switch (tree.kind) {
      case "leaf":
        return tree.instance.columns;
      case "cross":
        return merge(tree.items.map((item) => this.plainTreeColumns(item)));
      case "join": {
        const columns = merge([this.plainTreeColumns(tree.left), this.plainTreeColumns(tree.right)]);
        if (!tree.using) return columns;
        // A column of USING is given once.
        return new Columns(columns.list.map((column) => (tree.using!.has(column.name) ? { name: column.name, targets: new Set([UNKNOWN]) } : column)), columns.unknown, columns.opaque);
      }
      case "array": {
        const left = this.plainTreeColumns(tree.left);
        const names = new Set(tree.columns.map((column) => column.name));
        return new Columns([...left.list.filter((column) => !names.has(column.name)), ...tree.columns], left.unknown, left.opaque, false, left.opaqueDefs);
      }
    }
  }

  /**
   * Columns of the same name from several tables get names qualified by their table, such as t2.a, in what
   * `*` gives, so their names and those of the tables are part of the column names.
   */
  private qualifyCollisions(columns: Columns, instances: Instance[]): Columns {
    const counts = new Map<string, number>();
    for (const column of columns.list) counts.set(column.name, (counts.get(column.name) ?? 0) + 1);
    if (![...counts.values()].some((count) => count > 1)) return columns;
    const colliding = [...counts].filter(([, count]) => count > 1).map(([name]) => name);
    const list = columns.list.map((column) => {
      if (counts.get(column.name)! < 2) return column;
      for (const target of column.targets) if (isDef(target) && !target.reason) this.taint(target, `${target.name} is a column name that another table of the join has too`);
      return { name: column.name, targets: new Set<Target>([UNKNOWN]) };
    });
    for (const instance of instances) {
      if (instance.aliasDef && !instance.aliasDef.reason) this.taint(instance.aliasDef, `${instance.aliasDef.name} qualifies column names that two tables of the join have`);
      for (const name of colliding) list.push({ name: `${instance.alias ?? instance.tableName}.${name}`, targets: new Set([UNKNOWN]) });
    }
    return new Columns(list, columns.unknown, columns.opaque, false, columns.opaqueDefs);
  }

  // --- Dead code ----------------------------------------------------------------------------------

  /** Parts that no evaluation reached, as an unused WITH alias or CTE: resolved where they are written. */
  private evalDead(outer: OuterScope): void {
    for (let round = 0; round < 8; round++) {
      let progress = false;
      for (const [query, info] of this.queries) {
        const scope = info.scope;
        if (!scope) continue;
        for (const child of query.children) {
          if (child.kind !== "with" || this.evaluated.has(child)) continue;
          progress = true;
          this.evaluated.add(child);
          if (child.name) {
            const def = info.cteDefs.get(child.name.name)!;
            if (!this.ctesInProcess.has(def)) this.evalCte({ with: child, def, query }, scope);
          } else {
            for (const node of child.children) this.evalDeadNode(node, scope);
          }
        }
      }
      for (const node of this.statement.nodes) {
        if (this.evaluated.has(node) || (node.parent && !this.evaluated.has(node.parent))) continue;
        const owner = ownerOf(node);
        const scope = !owner ? outer : owner.kind === "query" ? this.queryInfo(owner).scope : undefined;
        if (!scope) continue;
        progress = true;
        this.evalDeadNode(node, scope);
      }
      if (!progress) break;
    }
  }

  private evalDeadNode(node: Node, scope: Scope): void {
    if (this.evaluated.has(node)) return;
    if (node.kind === "alias" && node.node === "lambda") {
      this.evaluated.add(node);
      const lambda = node.children.find((child): child is Lambda => child.kind === "lambda");
      if (lambda) {
        this.evaluated.add(lambda);
        this.evalLambda(lambda, scope);
      }
      return;
    }
    if (node.kind === "alias") {
      const entry = scope.aliases.expr.get(node.name.name);
      if (entry?.node === node) {
        this.expandAlias(entry, scope, DEFAULT_CTX, []);
        return;
      }
    }
    this.evalNode(node, scope);
  }
}

/** The alias nodes under `node` at its scope level, in order: QueryExpressionsAliasVisitor. */
function collectAliases(node: Node, out: Alias[]): void {
  if (node.kind === "alias") {
    out.push(node);
    if (node.node === "lambda" || node.node === "subquery") return;
  }
  if (node.kind === "lambda" || node.kind === "union" || node.kind === "query" || node.kind === "table" || node.kind === "opaque") return;
  if (node.kind === "with" && node.name) return;
  for (const child of node.children) collectAliases(child, out);
}

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

/** The query or lambda whose scope a node belongs to. */
function ownerOf(node: Node): Query | Lambda | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (current.kind === "query") return current;
    if (current.kind === "lambda") {
      const [from, to] = current.paramsRange;
      if (node.start >= from && node.end <= to) continue;
      return current;
    }
  }
  return undefined;
}

function enclosingUnion(node: Node): Union | undefined {
  for (let current = node.parent; current; current = current.parent) if (current.kind === "union") return current;
  return undefined;
}

/** The SELECTs whose select list names the columns of a union: the first member, down nested unions. */
function firstQueries(union: Union): Query[] {
  const first = union.children.find((child): child is Query | Union => child.kind === "query" || child.kind === "union");
  if (!first) return [];
  if (first.kind === "query") return [first];
  return firstQueries(first);
}

function leaves(tree: JoinTree): Instance[] {
  switch (tree.kind) {
    case "leaf":
      return [tree.instance];
    case "cross":
      return tree.items.flatMap(leaves);
    case "join":
      return [...leaves(tree.left), ...leaves(tree.right)];
    case "array":
      return leaves(tree.left);
  }
}

/**
 * A name of both sides of a join is the left one's where ClickHouse accepts it (single_join_prefer_left_table,
 * or ON equating the two), so the right side counts only where the left surely has no such column.
 */
function preferLeft(left: Found, right: Found): Found {
  if (left.alts.length) return left;
  if (left.maybe) return { alts: right.alts, maybe: true };
  return right;
}

/** The joins of a FROM as ClickHouse counts them: each JOIN and each comma after the first table. */
function joinsCount(tree: JoinTree | undefined): number {
  switch (tree?.kind) {
    case "join":
      return 1 + joinsCount(tree.left) + joinsCount(tree.right);
    case "cross":
      return tree.items.length - 1 + tree.items.reduce((sum, item) => sum + joinsCount(item), 0);
    case "array":
      return joinsCount(tree.left);
    default:
      return 0;
  }
}

function merge(columns: Columns[]): Columns {
  return new Columns(
    columns.flatMap((item) => item.list), columns.some((item) => item.unknown), columns.some((item) => item.opaque), false,
    columns.flatMap((item) => item.opaqueDefs),
  );
}

/** The column names of a structure such as 'a UInt8, b Nullable(String)', or undefined. */
function structureNames(text: string): string[] | undefined {
  const names: string[] = [];
  let depth = 0;
  let start = 0;
  const parts: string[] = [];
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if ((c === "," && depth === 0) || i === text.length) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  for (const part of parts) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(part);
    if (!match || !isTypeName(match[2]!)) return undefined;
    names.push(match[1]!);
  }
  return names.length ? names : undefined;
}

const TYPE_NAMES = new Map(DATA_TYPES.map((type) => [type.caseInsensitive ? type.name.toLowerCase() : type.name, type]));

/** Whether ClickHouse knows a data type of this name. */
function isTypeName(name: string): boolean {
  return TYPE_NAMES.has(name) || TYPE_NAMES.get(name.toLowerCase())?.caseInsensitive === true;
}
