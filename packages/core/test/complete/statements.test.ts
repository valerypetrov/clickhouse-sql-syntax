import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { keywordDocumentation, SYSTEM_COMMANDS } from "../../src/index.js";
import { ACCESS_DOCS, SYSTEM_DOCS } from "../../src/generated/statements.js";

/** The words the documentation covers and its first line, for the word `word` of the SQL. */
function at(sql: string, word: string): [string, string] | undefined {
  const found = keywordDocumentation(sql, sql.indexOf(word) + 1);
  return found && [sql.slice(found.start, found.end), found.documentation.split("\n")[0]!];
}

describe("keywordDocumentation()", () => {
  test("documents a SYSTEM command on each of its words", () => {
    assert.deepEqual(at("SYSTEM FLUSH LOGS query_log", "LOGS"), ["SYSTEM FLUSH LOGS", "**SYSTEM FLUSH LOGS**"]);
    assert.deepEqual(at("system flush logs", "system"), ["system flush logs", "**SYSTEM FLUSH LOGS**"]);
    assert.deepEqual(at("SYSTEM DROP DNS CACHE", "CACHE"), ["SYSTEM DROP DNS CACHE", "**SYSTEM CLEAR|DROP DNS CACHE**"]);
    assert.deepEqual(at("SYSTEM RELOAD DICTIONARY ON CLUSTER c d", "RELOAD"), ["SYSTEM RELOAD DICTIONARY", "**SYSTEM RELOAD DICTIONARY**"]);
    assert.equal(at("SYSTEM STOP MERGES db.t", "db"), undefined);
  });

  test("takes the longest command, and the forms that only the syntax of a section names", () => {
    assert.deepEqual(at("SYSTEM STOP TTL MERGES", "STOP"), ["SYSTEM STOP TTL MERGES", "**SYSTEM STOP TTL MERGES**"]);
    assert.deepEqual(at("SYSTEM STOP db.t", "STOP"), ["SYSTEM STOP", "**SYSTEM STOP**"]);
    assert.deepEqual(at("SYSTEM DISABLE ALL FAILPOINTS", "ALL"), ["SYSTEM DISABLE ALL FAILPOINTS", "**SYSTEM ENABLE|DISABLE FAILPOINT**"]);
  });

  test("documents the clauses of access statements, and the statement for the other keywords", () => {
    assert.deepEqual(at("CREATE USER u VALID UNTIL '2030-01-01'", "UNTIL"), ["VALID UNTIL", "**CREATE USER: VALID UNTIL Clause**"]);
    assert.deepEqual(at("CREATE USER u HOST ANY", "HOST"), ["HOST", "**CREATE USER: User Host**"]);
    assert.deepEqual(at("CREATE USER u IDENTIFIED BY 'p'", "IDENTIFIED"), ["IDENTIFIED", "**CREATE USER: Identification**"]);
    assert.deepEqual(at("CREATE POLICY p ON t USING 1 TO r", "TO"), ["TO", "**CREATE ROW POLICY: TO Clause**"]);
    assert.deepEqual(at("ALTER ROW POLICY p ON t RENAME TO q", "TO"), ["RENAME TO", "**ALTER ROW POLICY**"]);
    assert.deepEqual(at("CREATE QUOTA q ON CLUSTER c", "CLUSTER"), ["ON CLUSTER", "**CREATE QUOTA**"]);
    assert.deepEqual(at("ALTER PROFILE p ADD SETTINGS max_threads = 1", "ADD"), ["ADD", "**ALTER SETTINGS PROFILE: Incremental form: `ADD` / `MODIFY` / `DROP`**"]);
    assert.deepEqual(at("CREATE ROLE r SETTINGS max_threads = 1", "SETTINGS"), ["SETTINGS", "**CREATE ROLE**"]);
    assert.deepEqual(at("CREATE QUOTA q KEYED BY user_name", "KEYED"), ["KEYED", "**CREATE QUOTA**"]);
  });

  test("only for the words that the parser reads as keywords", () => {
    assert.equal(at("CREATE USER host HOST ANY", "host"), undefined);
    assert.equal(at("CREATE ROW POLICY p ON t USING a = 1", "a ="), undefined);
    assert.equal(at("SELECT 1", "SELECT"), undefined);
    assert.equal(at("CREATE TABLE t (a Int) ENGINE = Memory", "TABLE"), undefined);
  });
});

describe("the generated documentation", () => {
  test("has the pages of the five kinds of access entities, CREATE and ALTER", () => {
    assert.deepEqual(ACCESS_DOCS.map((d) => d.statement).sort(), [
      "ALTER QUOTA", "ALTER ROLE", "ALTER ROW POLICY", "ALTER SETTINGS PROFILE", "ALTER USER",
      "CREATE QUOTA", "CREATE ROLE", "CREATE ROW POLICY", "CREATE SETTINGS PROFILE", "CREATE USER",
    ]);
    for (const d of ACCESS_DOCS) assert.match(d.markdown, /```sql\n(?:CREATE|ALTER|-- )/, d.statement);
  });

  test("names SYSTEM commands that ClickHouse's parser has, or the first words of them", () => {
    const commands = SYSTEM_COMMANDS.map((c) => c.replace(/_/g, " "));
    // Words after a command that its syntax takes, and the per-table forms of Managing Background Activity.
    const unknown = SYSTEM_DOCS.flatMap((d) => d.keywords).filter((k) => !commands.some((c) => c === k || c.startsWith(`${k} `)));
    assert.deepEqual(unknown, [
      "CLEAR QUERY CACHE TAG", "INSTRUMENT ADD FUNCTION HANDLER", "INSTRUMENT ADD FUNCTION HANDLER ARGUMENTS", "INSTRUMENT REMOVE ID",
      "INSTRUMENT REMOVE ALL", "UNFREEZE WITH NAME", "REFRESH ALL BACKGROUND",
    ]);
    assert.ok(SYSTEM_DOCS.flatMap((d) => d.keywords).length > 100);
  });
});
