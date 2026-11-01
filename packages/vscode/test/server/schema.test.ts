import * as assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { Schema } from "../../src/server/schema.js";

describe("Schema", () => {
  const queries: string[] = [];
  /** The tables whose queries the server refuses, as a user without the grant. */
  let refused: string[] = [];
  const answers: [RegExp, object[]][] = [
    [/currentDatabase\(\)/, [{ name: "default" }]],
    [/FROM system\.databases/, [{ name: "default" }]],
    [/FROM system\.tables/, [{ name: "hits" }]],
    [/FROM system\.columns/, [{ name: "id", type: "UInt64" }]],
    [/FROM system\.clusters/, [{ cluster: "prod" }]],
    [/FROM system\.macros/, [{ macro: "replica", substitution: "r1" }]],
  ];
  const server = createServer(async (request, response) => {
    let sql = "";
    for await (const chunk of request) sql += chunk;
    queries.push(sql);
    if (refused.some((table) => sql.includes(table))) {
      response.writeHead(500, { "X-ClickHouse-Exception-Code": "497" });
      return void response.end("Code: 497. DB::Exception: u: Not enough privileges. (ACCESS_DENIED) (version 26.11.1.1)\n");
    }
    const rows = answers.find(([pattern]) => pattern.test(sql))?.[1] ?? [];
    response.end(rows.map((row) => JSON.stringify(row)).join("\n"));
  });
  let url = "";
  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  after(() => server.close());
  const schema = () => new Schema(async () => ({ url, user: "u", password: "", database: "", timeoutMs: 5000 }));

  test("reads the clusters and macros of the server for a statement with an ENGINE", async () => {
    refused = [];
    const found = await schema().completion("CREATE TABLE t AS hits ENGINE = Distributed(", 44);
    assert.deepEqual(found, {
      databases: ["default"],
      tables: [{ database: "default", name: "hits", columns: [{ name: "id", type: "UInt64" }] }],
      clusters: ["prod"],
      macros: [{ name: "replica", value: "r1" }],
    });
  });

  test("leaves out the clusters and macros elsewhere, and where the user may not read them", async () => {
    refused = [];
    queries.length = 0;
    const select = await schema().completion("SELECT * FROM hits", 18);
    assert.equal(select.clusters, undefined);
    assert.ok(!queries.some((sql) => /system\.(clusters|macros)/.test(sql)));
    refused = ["system.macros"];
    const found = await schema().completion("CREATE TABLE t AS hits ENGINE = Distributed(", 44);
    assert.deepEqual([found.tables?.length, found.clusters, found.macros], [1, ["prod"], undefined]);
  });
});
