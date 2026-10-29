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

  refresh(): void {
    this.cache.clear();
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
