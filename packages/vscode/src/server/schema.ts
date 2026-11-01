import { type CompletionSchema, TokenKind as T, tokenize } from "clickhouse-sql-syntax";
import { type Connection, query } from "./client.js";

export interface Column {
  name: string;
  type: string;
}

type Row = Record<string, string>;

/** Databases, tables and columns from the system tables of the server, cached until refresh(). */
export class Schema {
  private readonly cache = new Map<string, Promise<Row[]>>();

  /** `connect` gives undefined when the server check is off; then every list is empty. */
  constructor(private readonly connect: () => Promise<Connection | undefined>) {}

  async databases(): Promise<string[]> {
    const rows = await this.rows("SELECT name FROM system.databases ORDER BY name", {});
    return rows.map((row) => row.name!);
  }

  async tables(database: string): Promise<string[]> {
    const rows = await this.rows("SELECT name FROM system.tables WHERE database = {database:String} ORDER BY name", { database });
    return rows.map((row) => row.name!);
  }

  async columns(database: string, table: string): Promise<Column[]> {
    const rows = await this.rows(
      "SELECT name, type FROM system.columns WHERE database = {database:String} AND table = {table:String} ORDER BY position",
      { database, table },
    );
    return rows.map((row) => ({ name: row.name!, type: row.type! }));
  }

  async clusters(): Promise<string[]> {
    const rows = await this.rows("SELECT DISTINCT cluster FROM system.clusters ORDER BY cluster", {});
    return rows.map((row) => row.cluster!);
  }

  async macros(): Promise<{ name: string; value: string }[]> {
    const rows = await this.rows("SELECT macro, substitution FROM system.macros ORDER BY macro", {});
    return rows.map((row) => ({ name: row.macro!, value: row.substitution! }));
  }

  /**
   * What completion in the statement at `offset` needs: every database, the tables of the current
   * database and of the databases the statement names, the columns of the tables it names, and for
   * an ENGINE the clusters and macros, which are left out when the user may not read them.
   */
  async completion(sql: string, offset: number): Promise<CompletionSchema> {
    const [databases, current] = await Promise.all([this.databases(), this.currentDatabase()]);
    if (databases.length === 0) return {};
    const names = statementNames(sql, offset);
    const listed = databases.filter((database) => database === current || names.has(database));
    const lists = await Promise.all(listed.map(async (database) => (await this.tables(database)).map((name) => ({ database, name }))));
    const tables = lists.flat().map(async (table) => ({
      ...table,
      columns: names.has(table.name) ? await this.columns(table.database, table.name) : [],
    }));
    const engine = [...names].some((name) => name.toLowerCase() === "engine");
    const [clusters, macros] = engine ? await Promise.all([this.clusters().catch(() => undefined), this.macros().catch(() => undefined)]) : [];
    return { databases, tables: await Promise.all(tables), clusters, macros };
  }

  refresh(): void {
    this.cache.clear();
  }

  /** The database of names without one: the database setting, or else the default of the user. */
  private async currentDatabase(): Promise<string | undefined> {
    const rows = await this.rows("SELECT name FROM system.databases WHERE name = currentDatabase()", {});
    return rows[0]?.name;
  }

  private async rows(sql: string, params: Record<string, string>): Promise<Row[]> {
    const connection = await this.connect();
    if (!connection) return [];
    const key = JSON.stringify([sql, params]);
    let rows = this.cache.get(key);
    if (!rows) {
      rows = query(connection, `${sql} FORMAT JSONEachRow`, params).then((body) =>
        body.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row),
      );
      this.cache.set(key, rows);
      // A failure is not kept, so the next call asks again.
      rows.catch(() => this.cache.get(key) === rows && this.cache.delete(key));
    }
    return rows;
  }
}

/** The bare words and quoted identifiers of the statement at `offset`. */
function statementNames(sql: string, offset: number): Set<string> {
  const tokens = tokenize(sql);
  let start = 0;
  let end = tokens.length;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.kind !== T.Semicolon) continue;
    if (tokens[i]!.start >= offset) {
      end = i;
      break;
    }
    start = i + 1;
  }
  const names = new Set<string>();
  for (const token of tokens.slice(start, end)) {
    if (token.kind === T.BareWord) {
      names.add(sql.slice(token.start, token.end));
    } else if (token.kind === T.QuotedIdentifier) {
      names.add(sql.slice(token.start + 1, token.end - 1).replace(/\\(.)/g, "$1").replace(/``|""/g, (pair) => pair[0]!));
    }
  }
  return names;
}
