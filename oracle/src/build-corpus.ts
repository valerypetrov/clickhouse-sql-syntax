// Builds the labelled corpus in fixtures/: statements of the ClickHouse tests plus mutated copies,
// each labelled by a real ClickHouse binary. Run it with `npm run corpus -w oracle -- --help`.
import { parseArgs } from "node:util";

import { type ClassifyResult, classify } from "./clickhouse.js";
import { type Entry, writeCorpus } from "./corpus.js";
import { type Extracted, expectsSyntaxError, extractCorpus, sha1 } from "./extract.js";
import { mutateAll } from "./mutate.js";
import { CACHE_DIR, CORPUS_FILE, SOURCE_NOTE, integerOption } from "./paths.js";

const USAGE = `Usage: npm run corpus -w oracle -- --clickhouse <binary> --corpus <tests/queries/0_stateless>

Options:
  --out <file>          where to write the corpus (default: ${CORPUS_FILE})
  --limit <n>           statements taken from the tests, invalid ones first (default: 20000)
  --mutations <n>       mutated copies of valid statements (default: 5000)
  --max-length <n>      leave out longer statements (default: 10000)
  --format-check <n>    valid statements to confirm with clickhouse format (default: 200)
  --jobs <n>            parallel ClickHouse processes, 1 to 4 (default: 4)`;

const { values } = parseArgs({
  options: {
    clickhouse: { type: "string" },
    corpus: { type: "string" },
    out: { type: "string", default: CORPUS_FILE },
    limit: { type: "string", default: "20000" },
    mutations: { type: "string", default: "5000" },
    "max-length": { type: "string", default: "10000" },
    "format-check": { type: "string", default: "200" },
    jobs: { type: "string", default: "4" },
    help: { type: "boolean", default: false },
  },
});
if (values.help || !values.clickhouse || !values.corpus) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 2);
}
const limit = integerOption(values.limit, "--limit", 1);
const jobs = Math.min(4, integerOption(values.jobs, "--jobs", 1));
const log = (line: string): void => console.error(line);
const classifyOptions = {
  clickhouse: values.clickhouse,
  cacheDir: CACHE_DIR,
  formatCheck: integerOption(values["format-check"], "--format-check"),
  jobs,
  log,
};

const extracted = extractCorpus(values.corpus, { maxLength: integerOption(values["max-length"], "--max-length", 1) });
log(`${extracted.files} files, ${extracted.skippedFiles.length} in other dialects or for XRay skipped, ${extracted.total} statements, ${extracted.statements.length} unique`);

async function label(sqls: string[]): Promise<ClassifyResult> {
  const result = await classify(sqls, classifyOptions);
  const reasons = new Map<string, number>();
  for (const reason of result.excluded.values()) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  for (const [reason, n] of reasons) log(`left out ${n}: ${reason}`);
  return result;
}

const labelled = await label(extracted.statements.map((s) => s.sql));

// A fixed order that does not depend on file names, so that a sample covers all of the tests.
function hashOrder(items: Extracted[], salt: string): Extracted[] {
  return items
    .map((item) => ({ item, key: sha1(salt + item.sql) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ item }) => item);
}

// Every invalid statement and every expected syntax error, then valid ones in hash order.
const known = extracted.statements.filter((s) => labelled.verdicts.has(s.sql));
const isValid = (s: Extracted): boolean => labelled.verdicts.get(s.sql)!.valid;
const first = known.filter((s) => !isValid(s) || expectsSyntaxError(s.hints));
const rest = hashOrder(known.filter((s) => isValid(s) && !expectsSyntaxError(s.hints)), "");
const chosen = [...first, ...rest].slice(0, limit);

const sources = hashOrder(chosen.filter(isValid), "mutate:");
const mutated = mutateAll(
  sources.map((s) => s.sql),
  integerOption(values.mutations, "--mutations"),
  new Set(extracted.statements.map((s) => s.sql)),
);
const mutatedLabels = await label(mutated.map((m) => m.sql));
const sourceOf = new Map(chosen.map((s) => [s.sql, s]));

const entries: Entry[] = [];
for (const s of chosen) {
  entries.push({ sql: s.sql, file: s.file, line: s.line, ...(s.hints.length > 0 ? { hints: s.hints } : {}), ...labelled.verdicts.get(s.sql)! });
}
let mutations = 0;
for (const m of mutated) {
  const verdict = mutatedLabels.verdicts.get(m.sql);
  if (!verdict) continue;
  const source = sourceOf.get(m.source)!;
  entries.push({ sql: m.sql, file: source.file, line: source.line, mutation: m.mutation, ...verdict });
  mutations++;
}
entries.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.mutation ?? "").localeCompare(b.mutation ?? "")));

writeCorpus(values.out, {
  header: {
    clickhouse: labelled.info.version,
    gitHash: labelled.info.gitHash,
    source: "tests/queries/0_stateless/*.sql of ClickHouse",
    note: SOURCE_NOTE,
    statements: entries.length - mutations,
    mutations,
  },
  entries,
});

const invalid = entries.filter((e) => !e.valid);
const surprises = chosen.filter((s) => expectsSyntaxError(s.hints) && isValid(s));
log(`wrote ${values.out}: ${entries.length} entries (${entries.length - mutations} from the tests, ${mutations} mutated), ${invalid.length} invalid`);
log(`confirmed ${labelled.formatChecked} valid statements with clickhouse format`);
if (surprises.length > 0) {
  log(`${surprises.length} statements marked clientError SYNTAX_ERROR are valid for ClickHouse, for example:`);
  for (const s of surprises.slice(0, 5)) log(`  ${s.file}:${s.line}: ${s.sql.replace(/\s+/g, " ").slice(0, 100)}`);
}
