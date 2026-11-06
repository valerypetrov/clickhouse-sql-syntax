import manifest from "../package.json";

/** The JSON schema of one setting, as package.json declares it. */
export interface SettingSchema {
  type: "string" | "integer" | "boolean";
  default: string | number | boolean;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  pattern?: string;
  patternErrorMessage?: string;
  scope: string;
  markdownDescription: string;
}

/** The settings that package.json declares, by their full names. */
export const SETTINGS = manifest.contributes.configuration.properties as Record<string, SettingSchema>;

/** The commands that package.json declares. */
export const COMMANDS: readonly { command: string; title: string; category?: string }[] = manifest.contributes.commands;

/** Why `value` does not fit the declared schema of the setting `key`, or undefined when it fits. */
export function invalidValue(key: string, value: unknown): string | undefined {
  const schema = SETTINGS[key];
  if (!schema) return `${key} is not a setting of ClickHouse SQL`;
  const shown = JSON.stringify(value);
  if (schema.type === "boolean") return typeof value === "boolean" ? undefined : `${key} must be true or false, not ${shown}`;
  if (schema.type === "integer") {
    const low = schema.minimum ?? -Infinity;
    const high = schema.maximum ?? Infinity;
    if (typeof value === "number" && Number.isInteger(value) && value >= low && value <= high) return undefined;
    const range = Number.isFinite(high) ? `from ${low} to ${high}` : `of at least ${low}`;
    return `${key} must be a whole number ${range}, not ${shown}`;
  }
  if (typeof value !== "string") return `${key} must be a string, not ${shown}`;
  if (schema.enum && !schema.enum.includes(value)) return `${key} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}, not ${shown}`;
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) return `${key} is ${shown}: ${schema.patternErrorMessage}`;
  return undefined;
}
