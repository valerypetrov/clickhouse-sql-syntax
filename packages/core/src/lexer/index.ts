import type { Token } from "../types.js";

/** Splits `sql` into tokens the way ClickHouse's Lexer.cpp does. */
export function tokenize(sql: string): Token[] {
  throw new Error("not implemented");
}
