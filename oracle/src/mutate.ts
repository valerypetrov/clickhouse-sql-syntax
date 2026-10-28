import { createHash } from "node:crypto";

import { type Lexeme, isSignificant, lex } from "./lexer.js";

export const MUTATIONS = [
  "drop-close",
  "drop-open",
  "swap-keywords",
  "truncate",
  "drop-token",
  "duplicate-token",
  "keyword-typo",
  "extra-comma",
] as const;

export type Mutation = (typeof MUTATIONS)[number];

// Clause keywords that are worth moving around or misspelling.
const KEYWORDS = new Set([
  "ADD", "ALL", "ALTER", "AND", "ANY", "ARRAY", "AS", "ASC", "ATTACH", "BETWEEN", "BY", "CASE", "CAST", "CLUSTER",
  "COLUMN", "CREATE", "CROSS", "DATABASE", "DEFAULT", "DELETE", "DESC", "DESCRIBE", "DETACH", "DICTIONARY",
  "DISTINCT", "DROP", "ELSE", "END", "ENGINE", "EXISTS", "EXPLAIN", "FINAL", "FORMAT", "FROM", "FULL", "FUNCTION",
  "GLOBAL", "GROUP", "HAVING", "IF", "ILIKE", "IN", "INDEX", "INNER", "INSERT", "INTERVAL", "INTO", "IS", "JOIN",
  "KEY", "LEFT", "LIKE", "LIMIT", "MATERIALIZED", "MODIFY", "NOT", "NULL", "OFFSET", "ON", "OPTIMIZE", "OR",
  "ORDER", "OUTER", "OVER", "PARTITION", "PREWHERE", "PRIMARY", "RENAME", "RIGHT", "SAMPLE", "SELECT", "SET",
  "SETTINGS", "SHOW", "SYSTEM", "TABLE", "THEN", "TO", "TRUNCATE", "TTL", "UNION", "USING", "VALUES", "VIEW",
  "WHEN", "WHERE", "WINDOW", "WITH",
]);

// A small seeded generator (mulberry32), so that the same statement always mutates the same way.
function random(seed: string): () => number {
  let state = createHash("sha1").update(seed).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(items: readonly T[], next: () => number): T | undefined {
  return items.length === 0 ? undefined : items[Math.floor(next() * items.length)];
}

function replace(sql: string, start: number, end: number, by: string): string {
  return sql.slice(0, start) + by + sql.slice(end);
}

/** Applies one mutation to `sql`, or returns undefined when it does not apply. */
export function mutate(sql: string, mutation: Mutation, seed: string): string | undefined {
  const next = random(`${seed}:${mutation}`);
  const tokens = lex(sql).filter(isSignificant);
  const text = (t: Lexeme): string => sql.slice(t.start, t.end);
  const keywords = tokens.filter((t) => t.kind === "word" && KEYWORDS.has(text(t).toUpperCase()));

  switch (mutation) {
    case "drop-close": {
      const t = pick(tokens.filter((t) => t.kind === "close"), next);
      return t && replace(sql, t.start, t.end, "");
    }
    case "drop-open": {
      const t = pick(tokens.filter((t) => t.kind === "open"), next);
      return t && replace(sql, t.start, t.end, "");
    }
    case "swap-keywords": {
      if (keywords.length < 2) return undefined;
      const i = Math.floor(next() * (keywords.length - 1));
      const [a, b] = [keywords[i]!, keywords[i + 1]!];
      if (text(a).toUpperCase() === text(b).toUpperCase()) return undefined;
      return sql.slice(0, a.start) + text(b) + sql.slice(a.end, b.start) + text(a) + sql.slice(b.end);
    }
    case "truncate": {
      if (tokens.length < 2) return undefined;
      const keep = 1 + Math.floor(next() * (tokens.length - 1));
      return sql.slice(0, tokens[keep - 1]!.end);
    }
    case "drop-token": {
      if (tokens.length < 2) return undefined;
      const t = pick(tokens, next)!;
      return replace(sql, t.start, t.end, "");
    }
    case "duplicate-token": {
      const t = pick(tokens, next);
      return t && replace(sql, t.start, t.end, `${text(t)} ${text(t)}`);
    }
    case "keyword-typo": {
      const t = pick(keywords.filter((t) => t.end - t.start >= 4), next);
      if (!t) return undefined;
      const word = text(t);
      const i = Math.floor(next() * (word.length - 1));
      // Either swap two neighbouring letters or drop one.
      const typo = next() < 0.5 ? word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2) : word.slice(0, i) + word.slice(i + 1);
      return typo.toUpperCase() === word.toUpperCase() ? undefined : replace(sql, t.start, t.end, typo);
    }
    case "extra-comma": {
      const t = pick(tokens, next);
      return t && replace(sql, t.end, t.end, ",");
    }
  }
}

/**
 * Mutates statements in turn until `count` new texts exist. The text of each statement picks its
 * mutation, so that the same statement mutates the same way in every run.
 */
export function mutateAll(
  sources: readonly string[],
  count: number,
  known: ReadonlySet<string>,
): { sql: string; source: string; mutation: Mutation }[] {
  const result: { sql: string; source: string; mutation: Mutation }[] = [];
  const seen = new Set(known);
  for (let i = 0; i < sources.length && result.length < count; i++) {
    const source = sources[i]!;
    const first = Math.floor(random(source)() * MUTATIONS.length);
    for (let k = 0; k < MUTATIONS.length; k++) {
      const mutation = MUTATIONS[(first + k) % MUTATIONS.length]!;
      const sql = mutate(source, mutation, source)?.trim();
      if (sql && !seen.has(sql)) {
        seen.add(sql);
        result.push({ sql, source, mutation });
        break;
      }
    }
  }
  return result;
}
