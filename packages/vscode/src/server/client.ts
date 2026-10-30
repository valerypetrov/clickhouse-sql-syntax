/** Where and as whom to reach the server. */
export interface Connection {
  url: string;
  user: string;
  password: string;
  database: string;
  timeoutMs: number;
}

/** An error that the server gave for a query. */
export class QueryError extends Error {
  constructor(
    readonly code: number,
    /** The error name, such as UNKNOWN_IDENTIFIER. */
    readonly codeName: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

/** The server cannot be reached, or does not let the user in. */
export class ConnectionError extends Error {}

// UNKNOWN_USER, WRONG_PASSWORD, REQUIRED_PASSWORD, IP_ADDRESS_NOT_ALLOWED, AUTHENTICATION_FAILED.
const ACCOUNT_ERRORS = new Set([192, 193, 194, 195, 516]);
const READONLY = 164;
const SETTING_CONSTRAINT_VIOLATION = 452;
const UNKNOWN_DATABASE = 81;
/** The longest a query runs on the server, in seconds, unless the timeout is shorter. */
const MAX_EXECUTION_TIME = 2;
// Caps on each query, as EXPLAIN QUERY TREE runs scalar subqueries and folds constants.
const LIMITS = {
  max_rows_to_read: "10000000",
  max_bytes_to_read: "1000000000",
  max_result_rows: "1000000",
  max_memory_usage: "1000000000",
  timeout_overflow_mode: "throw",
  // A request given up, as when the text changes, stops on the server too.
  cancel_http_readonly_queries_on_client_close: "1",
};

/**
 * Sends one query with readonly=1 and the limits over the HTTP interface and returns the body of the reply.
 * Throws ConnectionError, QueryError, or the reason of `signal` when that cancels it.
 */
export async function query(
  connection: Connection,
  sql: string,
  params: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<string> {
  let url: URL;
  try {
    url = new URL(connection.url);
  } catch {
    throw new ConnectionError(`The server URL is not valid: ${connection.url}`);
  }
  url.searchParams.set("readonly", "1");
  url.searchParams.set("max_execution_time", String(Math.min(MAX_EXECUTION_TIME, connection.timeoutMs / 1000)));
  for (const [name, value] of Object.entries(LIMITS)) url.searchParams.set(name, value);
  if (connection.database) url.searchParams.set("database", connection.database);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(`param_${name}`, escaped(value));

  const timeout = AbortSignal.timeout(connection.timeoutMs);
  let response: Response;
  let body: string;
  try {
    response = await fetch(url, {
      method: "POST",
      // Basic authentication, as header values cannot carry every character of a password.
      headers: { Authorization: `Basic ${Buffer.from(`${connection.user}:${connection.password}`).toString("base64")}` },
      body: sql,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    body = await response.text();
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (timeout.aborted) throw new ConnectionError(`${url.origin} did not answer in ${connection.timeoutMs} ms`);
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    throw new ConnectionError(`Cannot connect to ${url.origin}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (response.ok) return body;

  const code = Number(response.headers.get("X-ClickHouse-Exception-Code") ?? /^Code: (\d+)\./.exec(body)?.[1]);
  if (!code) throw new ConnectionError(`${url.origin} answered HTTP ${response.status} ${response.statusText}`);
  const { message, codeName } = parseError(body);
  // Problems of the account and the settings, not of the query: the user may not set a setting of the URL.
  const setting = /^(?:Cannot modify '(\w+)'|Setting (\w+) )/.exec(message);
  const name = setting?.[1] ?? setting?.[2];
  const refused =
    (code === READONLY || code === SETTING_CONSTRAINT_VIOLATION) && !!name && url.searchParams.has(name) && !sql.includes(name);
  const noDatabase = code === UNKNOWN_DATABASE && /^Database `?(.*?)`? does not exist/.exec(message)?.[1] === connection.database;
  if (ACCOUNT_ERRORS.has(code) || refused || noDatabase) throw new ConnectionError(message);
  throw new QueryError(code, codeName, message);
}

const ESCAPES: Record<string, string> = { "\\": "\\\\", "\t": "\\t", "\n": "\\n", "\r": "\\r" };

/** A value as the escaped text that the server reads query parameters from, as in TabSeparated. */
function escaped(value: string): string {
  return value.replace(/[\\\t\n\r]/g, (c) => ESCAPES[c]!);
}

/** The first line of a ClickHouse error, without "Code: N. DB::Exception: ", the error name and the version. */
export function parseError(body: string): { message: string; codeName: string | undefined } {
  // Official builds give "(version 26.10.2.103 (official build))", with brackets inside.
  let message = body.split("\n")[0]!.replace(/^Code: \d+\. DB::Exception: /, "").replace(/ \(version [^()]*(?:\([^()]*\))?\)$/, "");
  const name = / \(([A-Z][A-Z0-9_]*)\)$/.exec(message);
  if (name) message = message.slice(0, name.index);
  return { message, codeName: name?.[1] };
}
