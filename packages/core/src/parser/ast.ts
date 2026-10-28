/**
 * A light syntax tree. The checker builds only what ClickHouse's parser looks at
 * when it decides whether a query is valid, not a full AST.
 */

/** A literal value, typed like ClickHouse's Field. */
export type Lit =
  | { t: "Null" }
  | { t: "Bool"; v: boolean }
  | { t: "UInt64" | "Int64" | "Float64"; v: number }
  | { t: "String"; v: string }
  | { t: "Array" | "Tuple" | "Map"; v: Lit[] };

/** The node type, named after ClickHouse's AST classes: Function, Literal, SelectQuery, ... */
export type AstKind = string;

export class Ast {
  children: Ast[] = [];
  name = "";
  alias = "";

  /** Identifier parts; a query parameter part is an empty string. */
  parts?: string[];
  /** Literal value. */
  value?: Lit;
  /** Function parameters, as in quantile(0.5)(x). */
  params?: Ast[];
  /** Where the inline data of an INSERT starts, as an offset into the text. */
  data?: number;
  /** Named fields of statement and clause nodes. */
  fields?: Record<string, Ast | undefined>;
  flags?: Set<string>;

  constructor(public kind: AstKind) {}

  set(name: string, value: Ast | undefined | null): this {
    if (value) (this.fields ??= {})[name] = value;
    return this;
  }

  get(name: string): Ast | undefined {
    return this.fields?.[name];
  }

  flag(name: string, on = true): this {
    if (on) (this.flags ??= new Set()).add(name);
    else this.flags?.delete(name);
    return this;
  }

  has(name: string): boolean {
    return this.flags?.has(name) ?? false;
  }
}

/** Nodes that can carry an alias, like ClickHouse's ASTWithAlias. */
export function canHaveAlias(node: Ast): boolean {
  switch (node.kind) {
    case "Identifier":
    case "TableIdentifier":
    case "Literal":
    case "Function":
    case "Subquery":
    case "QueryParameter":
      return true;
    default:
      return false;
  }
}

export function identifier(parts: string[]): Ast {
  const node = new Ast("Identifier");
  node.parts = parts;
  node.name = parts.join(".");
  return node;
}

export function literal(value: Lit): Ast {
  const node = new Ast("Literal");
  node.value = value;
  return node;
}

export function func(name: string, args: Ast[] = []): Ast {
  const node = new Ast("Function");
  node.name = name;
  node.children = args;
  return node;
}

export function list(children: Ast[] = []): Ast {
  const node = new Ast("ExpressionList");
  node.children = children;
  return node;
}

export function isIdentifier(node: Ast | undefined | null): node is Ast {
  return node?.kind === "Identifier" || node?.kind === "TableIdentifier";
}

/** The name of a plain identifier, or undefined; like tryGetIdentifierName. */
export function identifierName(node: Ast | undefined | null): string | undefined {
  return isIdentifier(node) ? node.name : undefined;
}

/** True if the identifier is a {name:Identifier} query parameter or has one in its parts. */
export function isParam(node: Ast): boolean {
  return node.parts?.some((part) => part === "") ?? false;
}

export function functionName(node: Ast | undefined | null): string | undefined {
  return node?.kind === "Function" ? node.name : undefined;
}

export function stringValue(node: Ast | undefined | null): string | undefined {
  return node?.kind === "Literal" && node.value?.t === "String" ? node.value.v : undefined;
}
