// Runs many statements through `clickhouse local` and tells, for each one, whether it ran and with what error.

import { spawnSync } from "node:child_process";

export interface Outcome {
  ok: boolean;
  /** The statement did not finish within the time of its batch, so its verdict is unknown. */
  timedOut?: boolean;
  /** The error code of ClickHouse, when it failed. */
  code?: number;
  message?: string;
}

const MARK = "@@probe ";

/** The code and message of an exception line, without the codes that nested exceptions repeat around it. */
export function exceptionMessage(line: string): { code: number; message: string } | undefined {
  const match = /Code: (\d+)\. DB::Exception: (.*)$/.exec(line);
  if (!match) return undefined;
  let message = match[2]!;
  for (let inner = /^Code: \d+\. DB::Exception: (.*)$/.exec(message); inner; inner = /^Code: \d+\. DB::Exception: (.*)$/.exec(message))
    message = inner[1]!;
  for (let tail = /\.? \((?:version [^)]*|[A-Z_0-9]+)\)\.?$/; tail.test(message); ) message = message.replace(tail, "");
  if (!message.endsWith(".")) message += ".";
  return { code: Number(match[1]), message };
}

/** Each statement after a marker, in one process per `chunk` statements that first runs `setup`; errors follow their marker. */
export function probe(
  clickhouse: string,
  statements: readonly string[],
  options: { setup?: readonly string[]; chunk?: number; timeoutMs?: number } = {},
): Outcome[] {
  const chunk = options.chunk ?? 2000;
  const timeout = options.timeoutMs ?? 60_000;
  const outcomes: Outcome[] = [];
  for (let from = 0; from < statements.length; ) {
    const part = statements.slice(from, from + chunk);
    const query = [...(options.setup ?? []).map((s) => `${s};`), ...part.map((s, i) => `SELECT '${MARK}${i}' FORMAT TSVRaw;\n${s};`)].join("\n");
    // Both streams go to one pipe, so an error comes out after the marker of its statement.
    // exec, so that the timeout kills clickhouse itself and not only the shell.
    const run = spawnSync("/bin/sh", ["-c", 'exec "$0" local --ignore-error --query "$1" 2>&1 </dev/null', clickhouse, query], {
      encoding: "utf8",
      maxBuffer: 1 << 30,
      timeout,
      killSignal: "SIGKILL",
    });
    const timedOut = run.signal === "SIGKILL";
    const results: Outcome[] = part.map(() => ({ ok: true }));
    let current = -1;
    let last: { code: number; message: string } | undefined;
    for (const line of run.stdout.split("\n")) {
      if (line.startsWith(MARK)) current = Number(line.slice(MARK.length));
      else {
        const found = exceptionMessage(line);
        if (found) last = found;
        if (found && current >= 0 && results[current]!.ok) results[current] = { ok: false, ...found };
      }
    }
    if (current === part.length - 1) {
      outcomes.push(...results);
      from += part.length;
      continue;
    }
    // A statement that hangs, or stops the whole run as a syntax error does, gets no verdict; the run goes on after it.
    const stopped = Math.max(current, 0);
    const failed: Outcome = timedOut
      ? { ok: false, timedOut: true, code: -2, message: "Timed out." }
      : { ok: false, code: last?.code ?? -1, message: last?.message ?? "clickhouse local stopped." };
    if (timedOut) console.error(`probe: timed out at: ${part[stopped]!.slice(0, 200)}`);
    outcomes.push(...results.slice(0, stopped), failed);
    from += stopped + 1;
  }
  return outcomes;
}
