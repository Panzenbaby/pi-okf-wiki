// index.md and log.md generation.

import { join } from "node:path";
import type { Concept, Result } from "../types.ts";
import { readTextFile, writeTextFile } from "../files.ts";
import type { WikiDiff } from "./concepts.ts";

/** Generate the root index.md from all concepts, grouped by directory. */
export function generateIndexMd(concepts: readonly Concept[]): string {
  const groups = new Map<string, Concept[]>();
  for (const concept of concepts) {
    const dir = concept.conceptId.includes("/")
      ? concept.conceptId.slice(0, concept.conceptId.lastIndexOf("/"))
      : ".";
    const bucket = groups.get(dir) ?? [];
    bucket.push(concept);
    groups.set(dir, bucket);
  }
  const lines: string[] = ["# Wiki Index", ""];
  for (const dir of [...groups.keys()].sort()) {
    lines.push(`## ${dir === "." ? "(root)" : dir}`, "");
    for (const concept of groups.get(dir)!.sort((a, b) =>
      a.conceptId.localeCompare(b.conceptId),
    )) {
      const title = concept.frontmatter.title ?? concept.conceptId;
      const description = concept.frontmatter.description ?? "";
      const link = `${concept.conceptId}.md`;
      const suffix = description ? ` - ${description}` : "";
      lines.push(`* [${title}](${link})${suffix}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export async function writeIndexMd(
  wikiRoot: string,
  concepts: readonly Concept[],
): Promise<Result<void>> {
  const content = generateIndexMd(concepts);
  return writeTextFile(join(wikiRoot, "index.md"), content);
}

export async function appendLogMd(
  wikiRoot: string,
  date: string,
  diff: WikiDiff,
): Promise<Result<void>> {
  const logPath = join(wikiRoot, "log.md");
  const existing = await readTextFile(logPath);
  const header = "# Wiki Update Log\n\n";
  const entry = buildLogEntry(date, diff);
  const body = existing.success
    ? existing.data.replace(/^# Wiki Update Log\s*\n*/, header + entry)
    : header + entry;
  return writeTextFile(logPath, body);
}

function buildLogEntry(date: string, diff: WikiDiff): string {
  const lines: string[] = [`## ${date}`, ""];
  for (const conceptId of diff.created) {
    lines.push(`* **Creation**: Added [${conceptId}](/${conceptId}.md).`);
  }
  for (const conceptId of diff.updated) {
    lines.push(`* **Update**: Updated [${conceptId}](/${conceptId}.md).`);
  }
  if (diff.created.length === 0 && diff.updated.length === 0) {
    lines.push("* **No-op**: No concepts changed.");
  }
  lines.push("");
  return lines.join("\n");
}