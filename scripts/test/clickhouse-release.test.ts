import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { COMBINATORS } from "../../packages/core/src/generated/combinators.js";
import { DATA_TYPES } from "../../packages/core/src/generated/data-types.js";
import { FORMATS } from "../../packages/core/src/generated/formats.js";
import { FUNCTIONS } from "../../packages/core/src/generated/functions.js";
import { KEYWORDS } from "../../packages/core/src/generated/keywords.js";
import { PRIVILEGES } from "../../packages/core/src/generated/privileges.js";
import { SETTINGS } from "../../packages/core/src/generated/settings.js";
import { TABLE_ENGINES } from "../../packages/core/src/generated/table-engines.js";
import { TABLE_FUNCTIONS } from "../../packages/core/src/generated/table-functions.js";
import { TIME_ZONES } from "../../packages/core/src/generated/time-zones.js";
import { type VersionFile, compareVersions, isNewer, listChanges, namesOf, pullRequestBody, stableReleases } from "../clickhouse-release.js";

const release = (tag_name: string, extra: { draft?: boolean; prerelease?: boolean } = {}) => ({
  tag_name,
  draft: extra.draft ?? false,
  prerelease: extra.prerelease ?? false,
  assets: [],
});

test("picks the stable and LTS releases, newest version first, whatever order GitHub lists them in", () => {
  const releases = stableReleases([
    release("v26.3.60.2-lts"),
    release("v26.10.2.103-stable"),
    release("v26.11.1.5-testing"),
    release("v26.11.1.1-new"),
    release("v26.11.2.1-stable", { prerelease: true }),
    release("v26.11.2.2-stable", { draft: true }),
    release("v26.9.25.15-stable"),
  ]);
  assert.deepEqual(releases.map((r) => r.version), ["26.10.2.103", "26.9.25.15", "26.3.60.2"]);
  assert.ok(compareVersions("26.10.2.103", "26.9.25.15") > 0);
});

test("a release is new when its line is newer, or it is the first release of the line of a master build", () => {
  const master: VersionFile = { version: "26.11.1.1", gitHash: "", tag: null, testTag: "v26.10.2.103-stable" };
  assert.equal(isNewer("26.10.2.103", master), false);
  assert.equal(isNewer("26.11.2.5", master), true);
  assert.equal(isNewer("27.1.2.1", master), true);
  const released: VersionFile = { version: "26.11.2.5", gitHash: "", tag: "v26.11.2.5-stable", testTag: "v26.11.2.5-stable" };
  assert.equal(isNewer("26.11.3.9", released), false);
  assert.equal(isNewer("26.12.2.1", released), true);
});

test("reads every name of every generated list", () => {
  const read = (file: string): string => readFileSync(join(import.meta.dirname, "../../packages/core/src/generated", file), "utf8");
  const names = (list: readonly ({ name: string } | string)[]): string[] => list.map((x) => (typeof x === "string" ? x : x.name));
  assert.deepEqual(namesOf(read), {
    keywords: names(KEYWORDS),
    functions: names(FUNCTIONS),
    settings: names(SETTINGS),
    "data types": names(DATA_TYPES),
    "table engines": names(TABLE_ENGINES),
    formats: names(FORMATS),
    "table functions": names(TABLE_FUNCTIONS),
    combinators: names(COMBINATORS),
    privileges: names(PRIVILEGES),
    "time zones": names(TIME_ZONES),
  });
});

test("the pull request lists the changes, the failed steps and the new syntax", () => {
  const changes = listChanges({ keywords: ["A", "B"], formats: ["CSV"] }, { keywords: ["B", "C"], formats: ["CSV"] });
  assert.deepEqual(changes, [
    { list: "keywords", count: 2, added: ["C"], removed: ["A"] },
    { list: "formats", count: 1, added: [], removed: [] },
  ]);
  const metrics = { statements: 10, verdictAgreement: 0.9, validAcceptedRate: 0.8, invalidRejectedRate: 1, positionMatch: 1, messageMatch: 1 };
  const falsePositives = [
    { file: "a.sql", line: 1, sql: "CREATE TABLE t (j JSON(SHARED 4))", start: 23, message: "Expected one of: ..." },
    { file: "b.sql", line: 2, sql: "CREATE TABLE u (j JSON(SHARED 8))", start: 23, message: "Expected one of: ..." },
  ];
  const body = pullRequestBody({
    release: { tag: "v26.11.2.5-stable", version: "26.11.2.5", assets: [] },
    previous: { version: "26.10.2.103", gitHash: "c6428ebcc39f", tag: "v26.10.2.103-stable", testTag: "v26.10.2.103-stable" },
    changes,
    live: { clickhouse: "26.11.2.5", metrics, falsePositives, versionGaps: [] },
    results: [
      { name: "npm test", ok: true, seconds: 60, reasons: [] },
      { name: "VS Code stress tests", ok: false, seconds: 300, reasons: ["at the end: 61 ms"] },
    ],
    parsers: " src/Parsers/ParserDataType.cpp | 12 ++++++++----",
  });
  assert.match(body, /instead of v26\.10\.2\.103-stable/);
  assert.match(body, /a draft, as 1 of 2 steps .* failed:\n- VS Code stress tests\n {2}- at the end: 61 ms\n/);
  assert.match(body, /\| keywords \| 2 \| 1 \| 1 \|/);
  assert.match(body, /- New keywords: `C`\n- Removed keywords: `A`/);
  assert.match(body, /\| all tests of 26\.11\.2\.5 \| 10 \| 90\.00% \| 80\.00% \|/);
  assert.match(body, /- CREATE TABLE, at `SHARED`: 2\n {2}- `a\.sql:1`: `CREATE TABLE t \(j JSON\(SHARED 4\)\)`/);
  assert.match(body, /<summary>Changes in <code>src\/Parsers<\/code> since v26\.10\.2\.103-stable: .*ParserDataType\.cpp/s);
});
