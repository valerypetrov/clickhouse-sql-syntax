/**
 * BACKUP and RESTORE: a port of src/Parsers/ParserBackupQuery.cpp.
 */
import { Ast, keep } from "./ast.js";
import { parseCluster, parseDatabaseAndTableName, parsePartition } from "./common.js";
import { parseCompoundIdentifier, parseIdentifier, parseIdentifierWithOptionalParameters } from "./elements.js";
import { parseArray, parseFunction } from "./expression.js";
import { parseExceptDatabases, parseExceptTables } from "./misc.js";
import { parseNameValuePair, parseSetting } from "./set.js";
import { attempt, base, kw, listUtil, lookahead, P, peekKw, T, tok } from "./state.js";

type TableName = { database: string; table: string };

/** BACKUP elements may skip the data of some tables; RESTORE elements may not. */
interface Element {
  database: string;
  table: string;
  exceptDataDatabase: string;
}

function backQuoteIfNeed(name: string): string {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) ? name : "`" + name.replaceAll("\\", "\\\\").replaceAll("`", "\\`") + "`";
}

function qualified(database: string, table: string): string {
  return database ? `${backQuoteIfNeed(database)}.${backQuoteIfNeed(table)}` : backQuoteIfNeed(table);
}

/** PARTITION[S] p, ...; a missing list leaves the keyword read. */
function parsePartitions(p: P): void {
  if (kw(p, "PARTITION") || kw(p, "PARTITIONS")) listUtil(p, () => parsePartition(p) !== null, undefined, false);
}

/** isAtElementStart: the next element of the list rather than another table name. */
function isAtElementStart(p: P): boolean {
  return ["TABLE", "DICTIONARY", "VIEW", "TEMPORARY TABLE", "DATABASE", "ALL"].some((keyword) => peekKw(p, keyword));
}

/** EXCEPT DATA FROM TABLE[S] [db.]t, ...; the names must be in `database` if it is given. */
function parseExceptDataTables(p: P, database?: string): TableName[] | null {
  return attempt(p, () => {
    if (!kw(p, "EXCEPT DATA FROM TABLE") && !kw(p, "EXCEPT DATA FROM TABLES")) return null;
    const tables: TableName[] = [];
    const element = () => {
      if (tables.length && isAtElementStart(p)) return false;
      const name = parseDatabaseAndTableName(p);
      if (!name) return false;
      if (database !== undefined && !name.database) name.database = database;
      if (database !== undefined && name.database !== database)
        p.fail(
          "Database name in EXCEPT DATA FROM TABLE/TABLES clause doesn't match the database name of the " +
            `backup element it is written on: ${name.database} != ${database}`,
        );
      tables.push(name);
      return true;
    };
    return listUtil(p, element, undefined, false) ? tables : null;
  });
}

/** EXCEPT DATA FROM TABLE after a single table, which may only name that table. */
function parseExceptDataFromThisTable(p: P, element: Element, elementHasDatabase: boolean): void {
  const tables = parseExceptDataTables(p);
  if (!tables) return;
  const sorted = [...tables].sort((a, b) => (a.database === b.database ? (a.table < b.table ? -1 : 1) : a.database < b.database ? -1 : 1));
  const reject = (specified: TableName): never =>
    p.fail(
      "EXCEPT DATA FROM TABLE clause of a single-object BACKUP element can only name that element's own " +
        `object ${qualified(element.database, element.table)}, but ${qualified(specified.database, specified.table)} ` +
        "was specified. To exclude the data of another table, back it up as its own element with its own clause " +
        "(BACKUP TABLE t1, TABLE t2 EXCEPT DATA FROM TABLE t2), or exclude it at the database level " +
        "(BACKUP DATABASE db EXCEPT DATA FROM TABLE db.t2)",
    );
  for (const specified of sorted) {
    if (specified.table !== element.table) reject(specified);
    if (!specified.database) continue;
    if (!elementHasDatabase) reject(specified);
    if (element.database) {
      if (specified.database !== element.database) reject(specified);
      continue;
    }
    if (element.exceptDataDatabase && element.exceptDataDatabase !== specified.database) reject(specified);
    element.exceptDataDatabase = specified.database;
  }
}

/** BACKUP takes EXCEPT DATA FROM TABLE here; RESTORE throws on it. */
function parseExceptData(p: P, backup: boolean, readForBackup: () => void): void {
  if (backup) readForBackup();
  else if (peekKw(p, "EXCEPT DATA FROM TABLE") || peekKw(p, "EXCEPT DATA FROM TABLES"))
    p.failOther("EXCEPT DATA FROM TABLE/TABLES clause is only valid for BACKUP queries, not RESTORE");
}

/** One element: TABLE|DICTIONARY|VIEW t [AS t2] [PARTITIONS ...], TEMPORARY TABLE t, DATABASE d or ALL. */
function parseElement(p: P, backup: boolean): boolean {
  return (
    attempt(p, () => {
      if (kw(p, "TABLE") || kw(p, "DICTIONARY") || kw(p, "VIEW")) {
        const name = parseDatabaseAndTableName(p);
        if (!name) return false;
        if (kw(p, "AS") && !parseDatabaseAndTableName(p)) return false;
        parsePartitions(p);
        const element = { ...name, exceptDataDatabase: "" };
        parseExceptData(p, backup, () => parseExceptDataFromThisTable(p, element, true));
        return true;
      }
      if (kw(p, "TEMPORARY TABLE")) {
        const name = parseIdentifier(p);
        if (!name) return false;
        if (kw(p, "AS") && !parseIdentifier(p)) return false;
        const element = { database: "", table: name.name, exceptDataDatabase: "" };
        parseExceptData(p, backup, () => parseExceptDataFromThisTable(p, element, false));
        return true;
      }
      if (kw(p, "DATABASE")) {
        const name = parseIdentifier(p);
        if (!name) return false;
        if (kw(p, "AS") && !parseIdentifier(p)) return false;
        parseExceptTables(p, name.name);
        parseExceptData(p, backup, () => parseExceptDataTables(p, name.name));
        return true;
      }
      if (kw(p, "ALL")) {
        parseExceptDatabases(p);
        parseExceptTables(p);
        parseExceptData(p, backup, () => parseExceptDataTables(p));
        return true;
      }
      return false;
    }) !== null
  );
}

/** parseBackupName: Disk('disk', 'path'), File('path'), S3(...) and so on. */
function parseBackupName(p: P): Ast | null {
  return parseIdentifierWithOptionalParameters(p);
}

/** base_backup = Disk(...) and cluster_host_ids = [[...]] are kept apart from the other settings. */
function parseBaseBackupSetting(p: P): Ast | null {
  return attempt(p, () => (kw(p, "base_backup") && tok(p, T.Equals) ? parseBackupName(p) : null));
}

function parseClusterHostIdsSetting(p: P): boolean {
  return (
    attempt(p, () => {
      if (!kw(p, "cluster_host_ids") || !tok(p, T.Equals)) return false;
      if (parseArray(p)) return true;
      return parseFunction(p)?.name === "array";
    }) !== null
  );
}

/** isDefaultedSetting: name = DEFAULT, looked at without moving. */
function isDefaultedSetting(p: P): boolean {
  return lookahead(p, () => parseCompoundIdentifier(p) !== null && tok(p, T.Equals) && kw(p, "DEFAULT"));
}

interface SettingsList {
  ok: boolean;
  /** A query parameter, or a {name:Type} value: then the list with DEFAULT is not used. */
  parameters: boolean;
  /** The base_backup backup name, which is a child of the query. */
  baseBackup: Ast | null;
}

/** parseSettingsList: settings, where `defaultAware` allows name = DEFAULT and query parameters. */
function parseSettingsList(p: P, defaultAware: boolean): SettingsList {
  let baseBackup: Ast | null = null;
  let resetBaseBackup = false;
  let clusterHostIds = false;
  let parameters = false;
  const setting = () => {
    const defaulted = defaultAware && isDefaultedSetting(p);
    if (!defaulted && !baseBackup && (baseBackup = parseBaseBackupSetting(p))) return true;
    if (!defaulted && !clusterHostIds && parseClusterHostIdsSetting(p)) return (clusterHostIds = true);
    if (!defaultAware) return parseNameValuePair(p);
    if (defaulted && p.lower() === "base_backup") resetBaseBackup = true;
    const kind = parseSetting(p, false);
    if (kind === "parameter" || kind === "substitution") parameters = true;
    return kind !== null;
  };
  const ok = listUtil(p, setting, undefined, false);
  return { ok, parameters, baseBackup: resetBaseBackup ? null : baseBackup };
}

/** SETTINGS ...: read without DEFAULT first, and with it when that reads further; returns the base backup. */
function parseSettings(p: P): Ast | null {
  let baseBackup: Ast | null = null;
  attempt(p, () => {
    if (!kw(p, "SETTINGS")) return false;
    const listBegin = p.i;
    const plain = parseSettingsList(p, false);
    const plainEnd = p.i;
    if (!plain.ok || p.kind() === T.Comma) {
      p.restore(listBegin);
      const withDefault = parseSettingsList(p, true);
      if (withDefault.ok && p.kind() !== T.Comma && !withDefault.parameters) {
        baseBackup = withDefault.baseBackup;
        return true;
      }
      p.restore(plainEnd);
    }
    if (plain.ok) baseBackup = plain.baseBackup;
    return plain.ok;
  });
  return baseBackup;
}

/** ParserBackupQuery: BACKUP elements TO name | RESTORE elements FROM name, with SETTINGS and ASYNC|SYNC. */
export function parseBackupQuery(p: P): Ast | null {
  return base(p, "BACKUP or RESTORE query", () => {
    let backup = true;
    if (!kw(p, "BACKUP")) {
      if (!kw(p, "RESTORE")) return null;
      backup = false;
    }
    const node = new Ast("BackupQuery");
    if (backup && kw(p, "FROM SNAPSHOT")) {
      if (!keep(node, "base_snapshot_name", parseBackupName(p))) return null;
    } else if (!attempt(p, () => listUtil(p, () => parseElement(p, backup), undefined, false))) {
      return null;
    }
    attempt(p, () => kw(p, "ON") && parseCluster(p));
    if (!kw(p, backup ? "TO" : "FROM")) return null;
    if (!keep(node, "backup_name", parseBackupName(p))) return null;
    node.set("base_backup_name", parseSettings(p));
    if (!kw(p, "ASYNC")) kw(p, "SYNC");
    return node;
  });
}
