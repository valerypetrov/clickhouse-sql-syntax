import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

import type { Verdict } from "./clickhouse.js";

/** One labelled statement of the corpus. */
export interface Entry extends Verdict {
  sql: string;
  /** Test file the statement comes from, and its line there. */
  file: string;
  line: number;
  /** Test hints such as "clientError SYNTAX_ERROR". */
  hints?: string[];
  /** Set when the statement is a mutated copy of the one at file:line. */
  mutation?: string;
}

export interface CorpusHeader {
  /** ClickHouse build that labelled the corpus. */
  clickhouse: string;
  gitHash: string;
  /** Where the statements come from. */
  source: string;
  note: string;
  statements: number;
  mutations: number;
}

export interface Corpus {
  header: CorpusHeader;
  entries: Entry[];
}

/** Reads a corpus: gzipped JSON lines, a header first and then one entry per line. */
export function readCorpus(path: string): Corpus {
  const lines = gunzipSync(readFileSync(path)).toString("utf8").split("\n").filter(Boolean);
  const [header, ...entries] = lines.map((line) => JSON.parse(line) as unknown);
  return { header: header as CorpusHeader, entries: entries as Entry[] };
}

export function writeCorpus(path: string, corpus: Corpus): void {
  const lines = [corpus.header, ...corpus.entries].map((value) => JSON.stringify(value));
  writeFileSync(path, gzipSync(lines.join("\n") + "\n", { level: 9 }));
}
