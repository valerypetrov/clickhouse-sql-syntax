/**
 * The settings that each place of a statement takes, from the generated catalog: the settings of queries, of
 * MergeTree, of the other engines, of databases, of BACKUP and RESTORE, of EXPLAIN and of columns.
 */
import { OPTION_SETTINGS, type OptionSettings, SETTING_LISTS } from "../generated/engine-settings.js";
import { MERGE_TREE_SETTINGS } from "../generated/merge-tree-settings.js";
import { COLUMN_SETTING_MESSAGE, COLUMN_SETTINGS, EXPLAIN_SETTINGS } from "../generated/options.js";
import { SETTINGS, type SettingInfo } from "../generated/settings.js";

/** What a list of settings belongs to, as the parser marks it. */
export type SettingsContext =
  | "query"
  | "set"
  | "profile"
  | "storage"
  | "database"
  | "column"
  | "column reset"
  | "projection"
  | "alter"
  | "reset"
  | "alter database"
  | "refresh"
  | "explain"
  | "backup"
  | "restore"
  | "dictionary"
  | "table function"
  | "distributed";

/** The settings a place takes and how ClickHouse treats other names there. */
export interface SettingsScope {
  /** The settings to offer, without the obsolete ones, each with what it is a setting of and its rank, own ones first. */
  offered: readonly { info: SettingInfo; label: string; rank: number }[];
  /** The setting a name stands for there, obsolete ones included. */
  find(name: string): SettingInfo | undefined;
  /** ClickHouse's message for a name it does not take, with {} for the name; none when it is not known to refuse them. */
  unknown?: string;
  /** ClickHouse's message when no SETTINGS are allowed at all. */
  unsupported?: string;
  /** What the settings are of, for the detail of a suggestion, such as "Kafka setting". */
  label: string;
}

const byName = (settings: readonly SettingInfo[]) => new Map(settings.map((s) => [s.name, s]));
const querySettings = byName(SETTINGS);
const mergeTreeSettings = byName(MERGE_TREE_SETTINGS);
const listsByName = new Map(SETTING_LISTS.map((l) => [l.name, l.settings]));
const explainDefault = (bool: boolean | undefined) => (bool ? "Bool" : "Int64");

/** The setting of queries named `name`. */
export function querySetting(name: string): SettingInfo | undefined {
  return querySettings.get(name);
}

/** Settings of several sets; those of queries, when a place takes them besides its own, are labelled and ranked apart. */
function scope(sets: readonly (readonly SettingInfo[])[], label: string, unknown?: string, unsupported?: string): SettingsScope {
  const maps = sets.map(byName);
  const offered: { info: SettingInfo; label: string; rank: number }[] = [];
  const seen = new Set<string>();
  for (const set of sets) {
    const ofQueries = set === SETTINGS && sets.length > 1;
    const ofMergeTree = set === MERGE_TREE_SETTINGS && sets[0] !== MERGE_TREE_SETTINGS;
    for (const s of set)
      if (!s.obsolete && !seen.has(s.name)) {
        seen.add(s.name);
        offered.push({ info: s, label: ofQueries ? "setting" : ofMergeTree ? "MergeTree setting" : label, rank: ofQueries ? 1 : 0 });
      }
  }
  return {
    offered,
    find: (name) => {
      for (const map of maps) {
        const found = map.get(name);
        if (found) return found;
      }
      return undefined;
    },
    unknown,
    unsupported,
    label,
  };
}

const cache = new Map<string, SettingsScope>();
const cached = (key: string, make: () => SettingsScope) => {
  let found = cache.get(key);
  if (!found) cache.set(key, (found = make()));
  return found;
};

/** The settings of an engine, or of BACKUP, RESTORE or a refresh, by the generated entry for it. */
function optionScope(option: OptionSettings | undefined, label: string, checked = true): SettingsScope {
  if (!option) return scope([], label);
  const own = (option.lists ?? []).map((name) => listsByName.get(name) ?? []);
  // Names of other lists or of MergeTree that it takes too.
  const extra = (option.names ?? []).map((name) => mergeTreeSettings.get(name) ?? SETTING_LISTS.flatMap((l) => l.settings).find((s) => s.name === name) ?? { name, type: "String" });
  const sets = [...own, extra, ...(option.mergeTree ? [MERGE_TREE_SETTINGS] : []), ...(option.query ? [SETTINGS] : [])];
  return scope(sets, label, checked ? option.unknown : undefined, option.unsupported);
}

function findOption(context: OptionSettings["context"], engine?: string): OptionSettings | undefined {
  return OPTION_SETTINGS.find((o) => o.context === context && (engine === undefined || o.engine === engine));
}

/** Every setting that some engine takes in ALTER ... MODIFY SETTING, of MergeTree first. */
function alterScope(): SettingsScope {
  const lists = OPTION_SETTINGS.filter((o) => o.context === "table").flatMap((o) => o.lists ?? []);
  const sets = [MERGE_TREE_SETTINGS, ...[...new Set(lists)].map((name) => listsByName.get(name) ?? [])];
  return scope(sets, "table setting", "Unknown setting '{}'.");
}

/**
 * The settings of a place: `engine` is the engine of a storage or database, `kind` the kind of an EXPLAIN.
 * A storage without an engine takes those of MergeTree, the default engine, but its other names are not checked.
 */
export function settingsScope(context: SettingsContext, engine?: string, kind?: string): SettingsScope {
  switch (context) {
    case "query":
    case "set":
    case "profile":
    case "dictionary":
      return cached("query", () => scope([SETTINGS], "setting", "Unknown setting '{}'."));
    case "storage": {
      if (engine === undefined) return cached("storage", () => scope([MERGE_TREE_SETTINGS, SETTINGS], "MergeTree setting"));
      return cached(`storage ${engine}`, () => {
        const option = findOption("table", engine);
        return optionScope(option, /MergeTree$/.test(engine) ? "MergeTree setting" : `${engine} setting`);
      });
    }
    case "database":
      return cached(`database ${engine ?? ""}`, () => optionScope(findOption("database", engine ?? "Atomic"), `${engine ?? "database"} setting`, engine !== undefined));
    case "column":
    case "column reset":
      return cached("column", () =>
        scope([COLUMN_SETTINGS.map((name) => mergeTreeSettings.get(name)!).filter(Boolean)], "column setting", COLUMN_SETTING_MESSAGE),
      );
    case "projection":
      return cached("projection", () => scope([MERGE_TREE_SETTINGS], "MergeTree setting"));
    case "alter":
    case "reset":
      return cached("alter", alterScope);
    case "alter database":
      return cached("alter database", () => optionScope(findOption("database", "Replicated"), "database setting", false));
    case "refresh":
      return cached("refresh", () => optionScope(findOption("refresh"), "refresh setting", false));
    case "backup":
      return cached("backup", () => optionScope(findOption("backup"), "BACKUP setting"));
    case "restore":
      return cached("restore", () => optionScope(findOption("restore"), "RESTORE setting"));
    case "explain": {
      const name = kind ?? "PLAN";
      return cached(`explain ${name}`, () => {
        const explain = EXPLAIN_SETTINGS.find((e) => e.kind === name);
        if (!explain) return scope([], `EXPLAIN ${name} setting`);
        const settings = explain.settings.map((s) => ({ name: s.name, type: explainDefault(s.bool), description: s.description }));
        const unknown = explain.unknown.replace("{list}", explain.settings.map((s) => s.name).join(", "));
        return scope([settings], `EXPLAIN ${name} setting`, unknown);
      });
    }
    default:
      return cached("other", () => scope([SETTINGS], "setting"));
  }
}

/** The EXPLAIN settings of a kind, with ClickHouse's messages for wrong values. */
export function explainSettings(kind: string) {
  return EXPLAIN_SETTINGS.find((e) => e.kind === kind);
}
