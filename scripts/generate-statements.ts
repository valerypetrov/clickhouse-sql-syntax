// Regenerates the documentation that hover shows for SYSTEM commands and for the clauses of the statements that make
// and change users, roles, quotas, row policies and settings profiles.
// Usage: npx tsx scripts/generate-statements.ts --docs <docs/reference>
//
// The text is the documentation of ClickHouse: statements/system.mdx, and the pages of those statements in
// statements/create and statements/alter.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({ options: { docs: { type: "string" } } });
if (!args.docs) {
  console.error("Usage: npx tsx scripts/generate-statements.ts --docs <docs/reference>");
  process.exit(2);
}
const statements = join(args.docs, "statements");
const out = join(import.meta.dirname, "..", "packages", "core", "src", "generated", "statements.ts");

interface Section {
  level: number;
  heading: string;
  body: string;
}

/** The Markdown of a page as hover shows it: no MDX imports, components or anchors, and links to other pages as text. */
function clean(markdown: string): string {
  return markdown
    .replace(/\{\/\*.*?\*\/\}/g, "")
    .replace(/^import .*$/gm, "")
    .replace(/<[A-Z]\w*\s*\/>/g, "")
    .replace(/<(Note|Tip|Warning)>/g, "**$1**")
    .replace(/<\/(?:Note|Tip|Warning)>/g, "")
    .replace(/\[([^\]]*)\]\((?!https?:)[^)]*\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The page without its front matter, cut at its headings; the text before the first one has level 0. */
function sections(file: string): { title: string; sections: Section[] } {
  const text = readFileSync(join(statements, file), "utf8");
  const title = /^title:\s*'([^']*)'/m.exec(text)?.[1] ?? "";
  const lines = text.replace(/^---\n[\s\S]*?\n---\n/, "").split("\n");
  const found: Section[] = [{ level: 0, heading: "", body: "" }];
  let fenced = false;
  for (const line of lines) {
    if (line.startsWith("```")) fenced = !fenced;
    const heading = fenced ? null : /^(#{2,4}) (.*?)\s*(?:\{#[^}]*\})?\s*$/.exec(line);
    if (heading) found.push({ level: heading[1]!.length, heading: heading[2]!, body: "" });
    else found[found.length - 1]!.body += `${line}\n`;
  }
  return { title, sections: found.map((s) => ({ ...s, body: clean(s.body) })) };
}

/** The commands a line of SYSTEM syntax names: its words in capitals, with `A|B` and `[OPTIONAL]` spelled out. */
function commands(line: string): string[][] {
  let forms: string[][] = [[]];
  for (const word of line.trim().split(/\s+/)) {
    const optional = /^\[([A-Z][A-Z0-9_]*)\]$/.exec(word);
    if (optional) {
      forms = forms.flatMap((f) => [f, [...f, optional[1]!]]);
      continue;
    }
    if (!/^[A-Z][A-Z0-9_]*(?:\|[A-Z][A-Z0-9_]*)*$/.test(word)) break;
    forms = forms.flatMap((f) => word.split("|").map((w) => [...f, w]));
  }
  return forms.filter((f) => f.length > 0);
}

// ---------------------------------------------------------------- SYSTEM

const system = sections("system.mdx").sections;
const systemDocs: { keywords: string[]; markdown: string }[] = [];
const claimed = new Set<string>();
const claim = (key: string) => {
  if (claimed.has(key)) return false;
  claimed.add(key);
  return true;
};
// The headings name the commands first, then the syntax of a section adds the forms that no heading names.
// A heading of a command starts with SYSTEM, as all but SYNC DATABASE REPLICA do; the ones below them are not commands.
const bySection = system.map((s) => {
  if (s.level > 3 || !/^(?:SYSTEM )?[A-Z][A-Z0-9_]*(?:[ |,\[]|$)/.test(s.heading) || /[a-z]/.test(s.heading)) return [];
  return s.heading.split(/,\s*/).flatMap((part) => commands(part.replace(/^SYSTEM /, ""))).map((words) => words.join(" ")).filter(claim);
});
system.forEach((s, i) => {
  if (!bySection[i]!.length) return;
  for (const line of s.body.split("\n")) {
    if (line.startsWith("SYSTEM ")) bySection[i]!.push(...commands(line.slice(7)).map((words) => words.join(" ")).filter(claim));
  }
});
system.forEach((s, i) => {
  if (bySection[i]!.length) systemDocs.push({ keywords: bySection[i]!, markdown: `**${s.heading}**\n\n${s.body}` });
});

// ---------------------------------------------------------------- Access entities

/** Sections that the pages name by their subject rather than by their keywords. */
const NAMED_SECTIONS: Record<string, string> = { Identification: "IDENTIFIED", "User Host": "HOST" };
const PAGES = ["user", "role", "quota", "row-policy", "settings-profile"];

const accessDocs = ["create", "alter"].flatMap((kind) =>
  PAGES.map((page) => {
    const { title, sections: all } = sections(`${kind}/${page}.mdx`);
    // The statement: what comes before the first heading, up to its examples.
    const intro = all[0]!.body.split(/^(?:\*\*Examples?\*\*|Examples?:)\s*$/m)[0]!.trim();
    const clauses = new Map<string, string[]>();
    const add = (keyword: string, markdown: string) => clauses.set(keyword, [...(clauses.get(keyword) ?? []), markdown]);
    for (const s of all) {
      const clause = /^(.*) clause$/i.exec(s.heading)?.[1];
      const keywords = clause ? [clause.toUpperCase()] : NAMED_SECTIONS[s.heading] ? [NAMED_SECTIONS[s.heading]!] : [...s.heading.matchAll(/`([A-Z][A-Z_ ]*)`/g)].map((m) => m[1]!);
      for (const keyword of keywords) add(keyword, `**${title}: ${s.heading}**\n\n${s.body}`);
      // A paragraph that starts with clauses in back quotes is about them, as "`ON CLUSTER` clause allows ...".
      for (const paragraph of s.body.split(/\n\n+/)) {
        const lead = /^((?:`[^`]+`(?:,? and |, )?)+)/.exec(paragraph)?.[1];
        if (!lead) continue;
        for (const m of lead.matchAll(/`([A-Z][A-Z0-9_]*(?: [A-Z][A-Z0-9_]*)*)[` ]/g)) if (!title.startsWith(m[1]!)) add(m[1]!, `**${title}**\n\n${paragraph}`);
      }
    }
    return { statement: title, markdown: `**${title}**\n\n${intro}`, clauses: [...clauses].map(([keyword, parts]) => ({ keywords: [keyword], markdown: parts.join("\n\n") })) };
  }),
);

const json = (value: unknown) => JSON.stringify(value);
writeFileSync(
  out,
  [
    "// Generated by scripts/generate-statements.ts from docs/reference/statements of ClickHouse; do not edit.",
    "export interface KeywordDoc {",
    "  /** The keywords it documents, such as FLUSH LOGS after SYSTEM, or VALID UNTIL in CREATE USER. */",
    "  keywords: readonly string[];",
    "  markdown: string;",
    "}",
    "",
    "export interface AccessStatementDoc {",
    "  /** Such as CREATE USER. */",
    "  statement: string;",
    "  markdown: string;",
    "  clauses: readonly KeywordDoc[];",
    "}",
    "",
    "export const SYSTEM_DOCS: readonly KeywordDoc[] = [",
    ...systemDocs.map((d) => `  ${json(d)},`),
    "];",
    "",
    "export const ACCESS_DOCS: readonly AccessStatementDoc[] = [",
    ...accessDocs.map((d) => `  ${json(d)},`),
    "];",
    "",
  ].join("\n"),
);
console.log(`${claimed.size} SYSTEM commands, ${accessDocs.reduce((n, d) => n + d.clauses.length, 0)} clauses of ${accessDocs.length} statements`);
