import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, test } from "node:test";
import { COMMAND_DOCS, README_PATH, readmeText } from "../../scripts/generate-readme.js";
import { COMMANDS, invalidValue, SETTINGS } from "../../src/manifest.js";

const SRC = join(__dirname, "..", "..", "src");

function sources(dir = SRC): { file: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") ? [{ file: relative(SRC, path), text: readFileSync(path, "utf8") }] : [];
  });
}

/** The settings that the code reads: by setting() and userSetting(), and by fromUser() of the server settings. */
function readSettings(): Set<string> {
  const read = new Set<string>();
  for (const { text } of sources()) {
    for (const m of text.matchAll(/\b(?:setting|userSetting)<[^>]*>\("([\w.]+)"/g)) read.add(m[1]!);
    for (const m of text.matchAll(/\bfromUser<[^>]*>\("(\w+)"\)/g)) read.add(`clickhouseSql.server.${m[1]}`);
  }
  return read;
}

describe("package.json", () => {
  test("every setting read in the code is declared, and every declared setting is read", () => {
    const read = readSettings();
    assert.deepEqual([...read].sort(), Object.keys(SETTINGS).sort());
  });

  test("settings are read only through settings.ts, which checks them against package.json", () => {
    const elsewhere = sources().filter(({ file, text }) => file !== "settings.ts" && /\bgetConfiguration\(/.test(text));
    assert.deepEqual(elsewhere.map((s) => s.file), []);
  });

  test("every setting has a scope, a default that fits it, and documentation", () => {
    for (const [key, schema] of Object.entries(SETTINGS)) {
      assert.ok(["language-overridable", "application", "machine"].includes(schema.scope), key);
      assert.equal(invalidValue(key, schema.default), undefined, key);
      assert.ok(schema.markdownDescription.length > 40, key);
      if (schema.enum) assert.equal((schema as { enumDescriptions?: string[] }).enumDescriptions?.length, schema.enum.length, key);
    }
    // A workspace must not choose the server that the SQL of the user goes to.
    for (const key of Object.keys(SETTINGS).filter((k) => k.startsWith("clickhouseSql.server."))) assert.equal(SETTINGS[key]!.scope, "machine", key);
  });

  test("checks values as the settings editor does", () => {
    const cases: [string, unknown, string | undefined][] = [
      ["clickhouseSql.format.keywordCase", "lower", undefined],
      ["clickhouseSql.format.keywordCase", "Upper", 'clickhouseSql.format.keywordCase must be one of "upper", "lower", "preserve", not "Upper"'],
      ["clickhouseSql.maxFileSize", -1, "clickhouseSql.maxFileSize must be a whole number of at least 0, not -1"],
      ["clickhouseSql.maxFileSize", 1.5, "clickhouseSql.maxFileSize must be a whole number of at least 0, not 1.5"],
      ["clickhouseSql.server.enabled", "true", 'clickhouseSql.server.enabled must be true or false, not "true"'],
      ["clickhouseSql.server.url", "https://abc.clickhouse.cloud:8443", undefined],
      ["clickhouseSql.server.url", "http://[::1]:8123/proxy/?x=1", undefined],
      ["clickhouseSql.server.url", "localhost:8123", 'clickhouseSql.server.url is "localhost:8123": An http:// or https:// URL of the HTTP interface, such as http://localhost:8123.'],
      ["clickhouseSql.server.url", "tcp://localhost:9000", 'clickhouseSql.server.url is "tcp://localhost:9000": An http:// or https:// URL of the HTTP interface, such as http://localhost:8123.'],
      ["clickhouseSql.server.url", "http:// localhost", 'clickhouseSql.server.url is "http:// localhost": An http:// or https:// URL of the HTTP interface, such as http://localhost:8123.'],
      ["clickhouseSql.server.timeoutMs", 0, "clickhouseSql.server.timeoutMs must be a whole number from 1 to 2147483647, not 0"],
      // Node.js fires a longer timer at once.
      ["clickhouseSql.server.timeoutMs", 2 ** 31, "clickhouseSql.server.timeoutMs must be a whole number from 1 to 2147483647, not 2147483648"],
      ["clickhouseSql.server.timeoutMs", "5000", 'clickhouseSql.server.timeoutMs must be a whole number from 1 to 2147483647, not "5000"'],
      ["clickhouseSql.server.user", 5, "clickhouseSql.server.user must be a string, not 5"],
    ];
    for (const [key, value, problem] of cases) assert.equal(invalidValue(key, value), problem, `${key} = ${JSON.stringify(value)}`);
  });

  test("every command has a title, a category, a registration and documentation", () => {
    const registered = sources().flatMap(({ text }) => [...text.matchAll(/registerCommand\("([\w.]+)"/g)].map((m) => m[1]!));
    assert.deepEqual(registered.sort(), COMMANDS.map((c) => c.command).sort());
    for (const command of COMMANDS) {
      assert.ok(command.title, command.command);
      assert.equal(command.category, "ClickHouse SQL", command.command);
      assert.ok(COMMAND_DOCS[command.command], command.command);
    }
  });

  test("the README documents the settings and commands of package.json", () => {
    const readme = readFileSync(README_PATH, "utf8");
    assert.equal(readme, readmeText(readme), "run npx tsx scripts/generate-readme.ts in packages/vscode");
  });
});
