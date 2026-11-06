import * as vscode from "vscode";
import { type ObjectKind, objects, type SqlObject } from "clickhouse-sql-syntax";
import { fileAssociations, setting } from "./settings.js";

const KINDS: Record<ObjectKind, vscode.SymbolKind> = {
  table: vscode.SymbolKind.Struct,
  view: vscode.SymbolKind.Interface,
  "materialized view": vscode.SymbolKind.Interface,
  dictionary: vscode.SymbolKind.Key,
  function: vscode.SymbolKind.Function,
  database: vscode.SymbolKind.Namespace,
};
// Files read at once while the index is built.
const BATCH = 64;

/** The objects that one file makes, with the range of each name. */
export interface FileObjects {
  uri: vscode.Uri;
  objects: SqlObject[];
  ranges: vscode.Range[];
}

/** The objects that the ClickHouse SQL files of the workspace make, read when first asked for and kept up to date. */
export class WorkspaceObjects implements vscode.Disposable {
  private files?: Map<string, FileObjects>;
  /** The files that the glob finds on disk. */
  private onDisk = new Map<string, vscode.Uri>();
  /** The files to read again. */
  private dirty = new Map<string, vscode.Uri>();
  /** The build or refresh under way. */
  private pending?: Promise<void>;
  /** Counts the resets, so that a build that a reset overtook stops. */
  private generation = 0;
  private watcher?: vscode.FileSystemWatcher;
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly languageId: string) {
    const touch = (document: vscode.TextDocument) => {
      if (this.files) this.dirty.set(document.uri.toString(), document.uri);
    };
    this.subscriptions = [
      vscode.workspace.onDidOpenTextDocument(touch),
      vscode.workspace.onDidChangeTextDocument((event) => touch(event.document)),
      vscode.workspace.onDidCloseTextDocument(touch),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("files.associations") || event.affectsConfiguration("clickhouseSql.maxFileSize")) this.reset();
      }),
    ];
  }

  /** Every file's objects, `document` read from its current text. */
  async all(document?: vscode.TextDocument): Promise<Map<string, FileObjects>> {
    while (this.pending || !this.files || this.dirty.size) {
      this.pending ??= (this.files ? this.refresh() : this.build()).finally(() => (this.pending = undefined));
      await this.pending;
    }
    const files = this.files;
    if (!document) return files;
    const current = new Map(files);
    const entry = read(document.uri, document.getText());
    if (entry) current.set(document.uri.toString(), entry);
    else current.delete(document.uri.toString());
    return current;
  }

  /** The files of the index, each with its text, the open ones as they are now. */
  async *texts(token: vscode.CancellationToken): AsyncGenerator<{ uri: vscode.Uri; text: string }> {
    for (const { uri } of (await this.all()).values()) {
      if (token.isCancellationRequested) return;
      const text = openDocument(uri)?.getText() ?? (await readText(uri));
      if (text !== undefined) yield { uri, text };
    }
  }

  private async build(): Promise<void> {
    const generation = this.generation;
    const glob = `{${patterns(this.languageId).join(",")}}`;
    const uris = await vscode.workspace.findFiles(glob);
    if (generation !== this.generation) return;
    this.watcher = vscode.workspace.createFileSystemWatcher(glob);
    const found = (uri: vscode.Uri) => {
      this.onDisk.set(uri.toString(), uri);
      this.dirty.set(uri.toString(), uri);
    };
    this.watcher.onDidCreate(found);
    this.watcher.onDidChange(found);
    this.watcher.onDidDelete((uri) => {
      this.onDisk.delete(uri.toString());
      this.dirty.set(uri.toString(), uri);
    });
    this.files = new Map();
    for (const uri of uris) found(uri);
    for (const document of vscode.workspace.textDocuments) if (document.languageId === this.languageId) this.dirty.set(document.uri.toString(), document.uri);
  }

  private async refresh(): Promise<void> {
    const files = this.files!;
    const uris = [...this.dirty.values()];
    this.dirty.clear();
    for (let i = 0; i < uris.length; i += BATCH) {
      const read = await Promise.all(uris.slice(i, i + BATCH).map((uri) => this.read(uri)));
      // A reset while reading drops what was read.
      if (this.files !== files) return;
      read.forEach((entry, j) => {
        const key = uris[i + j]!.toString();
        if (entry) files.set(key, entry);
        else files.delete(key);
      });
    }
  }

  /** The objects of a file: an open ClickHouse document as it is now, else the file on disk that the glob finds. */
  private async read(uri: vscode.Uri): Promise<FileObjects | undefined> {
    const document = openDocument(uri);
    if (document?.languageId === this.languageId) return read(uri, document.getText());
    if (!this.onDisk.has(uri.toString())) return undefined;
    const text = await readText(uri);
    return text === undefined ? undefined : read(uri, text);
  }

  private reset(): void {
    this.generation++;
    this.watcher?.dispose();
    this.watcher = undefined;
    this.files = undefined;
    this.onDisk.clear();
    this.dirty.clear();
  }

  dispose(): void {
    this.reset();
    this.subscriptions.forEach((subscription) => subscription.dispose());
  }
}

/** Go to Symbol in Workspace: the tables, views, dictionaries, functions and databases that CREATE statements make. */
export function registerWorkspaceSymbols(index: WorkspaceObjects): vscode.Disposable {
  return vscode.languages.registerWorkspaceSymbolProvider({
    async provideWorkspaceSymbols(query) {
      const symbols: vscode.SymbolInformation[] = [];
      for (const file of (await index.all()).values()) {
        file.objects.forEach((object, i) => {
          if (!matches(object.name, query)) return;
          const location = new vscode.Location(file.uri, file.ranges[i]!);
          symbols.push(new vscode.SymbolInformation(object.name, KINDS[object.kind], object.database ?? "", location));
        });
      }
      return symbols;
    },
  });
}

/** The globs of the files that open as ClickHouse SQL: its extensions and the files.associations that name it. */
function patterns(languageId: string): string[] {
  const opted = Object.entries(fileAssociations()).flatMap(([glob, language]) => (language !== languageId ? [] : [glob.includes("/") ? glob : `**/${glob}`]));
  return ["**/*.chsql", "**/*.clickhouse.sql", ...opted];
}

function openDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  const key = uri.toString();
  return vscode.workspace.textDocuments.find((document) => document.uri.toString() === key);
}

/** The text of a file, or nothing when it is gone or longer than clickhouseSql.maxFileSize. */
async function readText(uri: vscode.Uri): Promise<string | undefined> {
  const max = setting<number>("clickhouseSql.maxFileSize");
  try {
    // A character takes at most 3 bytes in UTF-8, so a larger file is too long without reading it.
    if ((await vscode.workspace.fs.stat(uri)).size > 3 * max) return undefined;
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    return text.length > max ? undefined : text;
  } catch {
    return undefined;
  }
}

function read(uri: vscode.Uri, text: string): FileObjects | undefined {
  if (text.length > setting<number>("clickhouseSql.maxFileSize")) return undefined;
  const found = objects(text);
  const position = positions(text);
  return { uri, objects: found, ranges: found.map((object) => new vscode.Range(position(object.nameStart), position(object.nameEnd))) };
}

/** Offsets to positions; a line ends at \n, \r\n or a lone \r, as in VS Code. */
export function positions(text: string): (offset: number) => vscode.Position {
  const starts = [0];
  for (const match of text.matchAll(/\r\n?|\n/g)) starts.push(match.index + match[0].length);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return new vscode.Position(lo, offset - starts[lo]!);
  };
}

/** Whether the characters of `query` appear in `name` in order, ignoring case, as VS Code asks of the provider. */
function matches(name: string, query: string): boolean {
  const lower = name.toLowerCase();
  let at = 0;
  for (const c of query.toLowerCase()) {
    at = lower.indexOf(c, at) + 1;
    if (at === 0) return false;
  }
  return true;
}
