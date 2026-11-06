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

  // The server reads a parameter as escaped text: \b in it is a backspace, and a tab ends the value.
  test("sends query parameters as escaped text", async () => {
    error = undefined;
    await query(connection(), "SELECT {t:String}", { t: "a\\b\tc\nd\re" });
    assert.equal(params.get("param_t"), "a\\\\b\\tc\\nd\\re");
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

  test("a problem of the connection names the setting that would fix it", async () => {
    const wrong = async (settings: Partial<ReturnType<typeof connection>>, message: RegExp, setting: string) => {
      await assert.rejects(query({ ...connection(), ...settings }, "SELECT 1"), (thrown) => {
        assert.ok(thrown instanceof ConnectionError);
        assert.match(thrown.message, message);
        assert.equal(thrown.setting, setting);
        return true;
      });
    };
    error = undefined;
    await wrong({ url: "localhost:8123" }, /^clickhouseSql\.server\.url must start with http:\/\/ or https:\/\//, "clickhouseSql.server.url");
    await wrong({ url: "http://" }, /^clickhouseSql\.server\.url is not a URL: http:\/\/$/, "clickhouseSql.server.url");
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    await wrong({ url: `http://127.0.0.1:${port}` }, /^Cannot connect to http:\/\/127\.0\.0\.1:\d+, which clickhouseSql\.server\.url names: /, "clickhouseSql.server.url");
    // The native port of ClickHouse answers HTTP with HTTP 400 and this text, as TCPHandler.cpp writes it.
    const native = createServer((_, response) => {
      response.writeHead(400);
      response.end("Port 9000 is for clickhouse-client program\r\nYou must use port 8123 for HTTP.\r\n");
    });
    await new Promise<void>((resolve) => native.listen(0, "127.0.0.1", resolve));
    await wrong(
      { url: `http://127.0.0.1:${(native.address() as AddressInfo).port}` },
      /answered HTTP 400 Bad Request: Port 9000 is for clickhouse-client program\. Is clickhouseSql\.server\.url the HTTP interface of ClickHouse\?$/,
      "clickhouseSql.server.url",
    );
    native.close();
    const silent = createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    await wrong({ url: `http://127.0.0.1:${(silent.address() as AddressInfo).port}`, timeoutMs: 50 }, /did not answer in 50 ms, the time that clickhouseSql\.server\.timeoutMs allows$/, "clickhouseSql.server.timeoutMs");
    silent.closeAllConnections();
    silent.close();
    error = [516, "u: Authentication failed: password is incorrect, or there is no user with such name. (AUTHENTICATION_FAILED)"];
    await wrong({}, /Authentication failed.* Check clickhouseSql\.server\.user, and the password that the Set Server Password command sets\.$/, "clickhouseSql.server.user");
    error = [81, "Database `nope` does not exist. (UNKNOWN_DATABASE)"];
    await wrong({ database: "nope" }, /does not exist\. It is the database that clickhouseSql\.server\.database names\.$/, "clickhouseSql.server.database");
  });

  // SET param_x = 'a' gives the server the value as written, which it reads as escaped text.
  test("sends the values of SET param_x as written", async () => {
    error = undefined;
    await query(connection(), "SELECT {s:String}", {}, undefined, { s: "a\\tb" });
    assert.equal(params.get("param_s"), "a\\tb");
  });
});
