/**
 * The documentation of options as Markdown: settings with their type, default and values, and codecs, index types,
 * statistics types and database engines.
 */
import { CODECS, DATABASE_ENGINES, INDEX_TYPES, STATISTICS_TYPES } from "../generated/options.js";
import type { SettingInfo } from "../generated/settings.js";

function paragraphs(...parts: (string | undefined | false)[]): string {
  return parts.filter((part) => part).join("\n\n");
}

const fenced = (code: string) => `\`\`\`sql\n${code}\n\`\`\``;

/** The type, default, values and description of a setting. */
export function settingDocumentation(info: SettingInfo): string {
  const value = info.default === undefined || info.default === "" ? `\`${info.type}\`` : `\`${info.type}\`, default \`${info.default}\``;
  const values = !!info.values?.length && `${info.multi ? "A comma-separated list of" : "One of"}: ${info.values.map((v) => `\`${v}\``).join(", ")}.`;
  return paragraphs(value, info.aliasTo && `Alias of \`${info.aliasTo}\`.`, info.obsolete && "Obsolete: ClickHouse takes it and ignores it.", info.description, values);
}

export type OptionKind = "codec" | "index type" | "statistics type" | "database engine";

/** What a value of a parameter rule allows, for the documentation of a codec or index type. */
function parameterSummary(rule: (typeof CODECS)[number]["rule"]): string | undefined {
  if (!rule || rule.max > 10) return undefined;
  if (rule.max === 0) return "Takes no parameters.";
  return rule.min === rule.max ? `Takes ${rule.max} parameter${rule.max === 1 ? "" : "s"}.` : `Takes ${rule.min} to ${rule.max} parameters.`;
}

/** The documentation of a codec, index type, statistics type or database engine. */
export function optionDocumentation(kind: OptionKind, name: string): string | undefined {
  const lower = name.toLowerCase();
  switch (kind) {
    case "codec": {
      const c = CODECS.find((x) => x.name.toLowerCase() === lower);
      if (!c) return undefined;
      const tier = c.tier && `${c.tier}${c.setting ? `: needs \`${c.setting} = 1\`` : ""}.`;
      return paragraphs(fenced(`CODEC(${c.name}${c.rule && c.rule.max > 0 && c.rule.max < 10 ? "(...)" : ""})`), c.description, parameterSummary(c.rule), tier, c.type && `Applies to columns such as \`${c.type}\`.`);
    }
    case "index type": {
      const t = INDEX_TYPES.find((x) => x.name.toLowerCase() === lower);
      return t && paragraphs(t.syntax && fenced(t.syntax), t.description);
    }
    case "statistics type": {
      const t = STATISTICS_TYPES.find((x) => x.name.toLowerCase() === lower);
      return t && paragraphs(fenced(`column Type STATISTICS(${t.name})`), t.description);
    }
    case "database engine": {
      const e = DATABASE_ENGINES.find((x) => x.name.toLowerCase() === lower);
      return e && paragraphs(e.syntax && fenced(e.syntax), e.description);
    }
  }
}
