import * as assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { ConnectionError, query, QueryError } from "../../src/server/client.js";

describe("query", () => {
  let url = "";
  let params = new URLSearchParams();
  /** The error the server gives for every query, if any. */
  let error: [code: number, message: string] | undefined;
  const server = createServer(async (request, response) => {
    for await (const _ of request);
    params = new URL(request.url!, "http://server").searchParams;
    if (!error) return void response.end("ok");
    response.writeHead(500, { "X-ClickHouse-Exception-Code": String(error[0]) });
    response.end(`Code: ${error[0]}. DB::Exception: ${error[1]} (version 26.11.1.1)\n`);
  });
  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/?max_execution_time=100`;
  });
  after(() => server.close());
  const connection = (timeoutMs = 5000) => ({ url, user: "u", password: "", database: "", timeoutMs });

  test("sends readonly=1 and limits, with a time limit no longer than the timeout", async () => {
    error = undefined;
    await query(connection(), "SELECT 1");
    assert.deepEqual(Object.fromEntries(params), {
      max_execution_time: "2",
      readonly: "1",
      max_rows_to_read: "10000000",
      max_bytes_to_read: "1000000000",
      max_result_rows: "1000000",
      max_memory_usage: "1000000000",
      timeout_overflow_mode: "throw",
      cancel_http_readonly_queries_on_client_close: "1",
    });
    await query(connection(1500), "SELECT 1");
    assert.equal(params.get("max_execution_time"), "1.5");
  });

  test("a setting of the URL that the user may not change is a problem of the connection", async () => {
    const answers: [number, string, string, string][] = [
      [164, "Cannot modify 'max_execution_time' setting in readonly mode. (READONLY)", "SELECT 1", "ConnectionError"],
      [164, "Cannot modify 'readonly' setting in readonly mode. (READONLY)", "SELECT 1", "ConnectionError"],
      [452, "Setting max_memory_usage shouldn't be greater than 500000000. (SETTING_CONSTRAINT_VIOLATION)", "SELECT 1", "ConnectionError"],
      // Settings that the query itself changes.
      [164, "Cannot modify 'max_execution_time' setting in readonly mode. (READONLY)", "SELECT 1 SETTINGS max_execution_time = 5", "QueryError"],
      [164, "Cannot modify 'max_threads' setting in readonly mode. (READONLY)", "SELECT 1 SETTINGS max_threads = 1", "QueryError"],
      [164, "u: Cannot execute query in readonly mode. (READONLY)", "SELECT * FROM url('x')", "QueryError"],
    ];
    for (const [code, message, sql, expected] of answers) {
      error = [code, message];
      await assert.rejects(query(connection(), sql), (thrown) => {
        assert.ok(thrown instanceof ConnectionError || thrown instanceof QueryError);
        assert.equal(thrown.constructor.name, expected, `${message} for ${sql}`);
        return true;
      });
    }
  });
});
