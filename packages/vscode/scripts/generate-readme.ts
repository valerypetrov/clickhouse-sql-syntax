// Writes the settings and commands of package.json into README.md; run it after either changes.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS, SETTINGS } from "../src/manifest.js";

export const README_PATH = join(__dirname, "..", "README.md");

/** Where each scope of package.json lets a setting be set. */
const SCOPES: Record<string, string> = {
  "language-overridable": "user or workspace settings, also per language",
  application: "user settings only",
  machine: "user settings only",
};

function settingsText(): string {
  return Object.entries(SETTINGS)
    .map(([key, schema]) => {
      const values = schema.enum ? schema.enum.map((value) => `\`${JSON.stringify(value)}\``).join(", ") : schema.type;
      const limits = [schema.minimum !== undefined && `at least ${schema.minimum}`, schema.maximum !== undefined && `at most ${schema.maximum}`].filter(Boolean);
      const lines = [
        `### \`${key}\``,
        "",
        `Default \`${JSON.stringify(schema.default)}\`; ${values}${limits.length ? `, ${limits.join(" and ")}` : ""}; ${SCOPES[schema.scope]}.`,
        "",
        schema.markdownDescription,
      ];
      if (schema.enum) {
        const descriptions = (schema as { enumDescriptions?: string[] }).enumDescriptions ?? [];
        lines.push("", ...schema.enum.map((value, i) => `- \`${JSON.stringify(value)}\`: ${descriptions[i]}`));
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

function commandsText(): string {
  return COMMANDS.map((c) => `- **${c.category}: ${c.title}** (\`${c.command}\`): ${COMMAND_DOCS[c.command] ?? ""}`).join("\n");
}

/** What each command does, for the README. */
export const COMMAND_DOCS: Record<string, string> = {
  "clickhouseSql.server.setPassword":
    "asks for the password of `clickhouseSql.server.user` at `clickhouseSql.server.url` and keeps it in VS Code's secret storage, for that user at that URL only; an empty password removes it.",
  "clickhouseSql.server.refreshSchema":
    "reads the server's databases, tables and columns again, forgets the results of the server check and checks the open files again.",
};

/** The README with the generated sections in place of the old ones. */
export function readmeText(readme = readFileSync(README_PATH, "utf8")): string {
  return replaceBetween(replaceBetween(readme, "settings", settingsText()), "commands", commandsText());
}

function replaceBetween(text: string, name: string, body: string): string {
  const start = `<!-- ${name}: generated from package.json by scripts/generate-readme.ts -->`;
  const end = `<!-- end of ${name} -->`;
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from < 0 || to < from) throw new Error(`README.md has no ${start} ... ${end} section`);
  return `${text.slice(0, from + start.length)}\n\n${body}\n\n${text.slice(to)}`;
}

if (require.main === module) {
  writeFileSync(README_PATH, readmeText());
  console.log(`Wrote ${README_PATH}`);
}
