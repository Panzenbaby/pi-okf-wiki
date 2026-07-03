// Wiki helpers: paths, concept loading, snapshot/diff, index.md & log.md
// generation, structure preview for the agent, and grep-style retrieval.

import { join, relative as nodeRelative } from "node:path";
import {
  err,
  ok,
  type Concept,
  type Frontmatter,
  type Result,
  type WikiSnapshot,
} from "./types.ts";
import { parseDocument } from "./frontmatter.ts";
import {
  hashContent,
  listFiles,
  pathExists,
  readTextFile,
  writeTextFile,
} from "./files.ts";

export interface WikiPaths {
  readonly root: string; // ctx.cwd
  readonly input: string;
  readonly archive: string;
  readonly wiki: string;
}

export function wikiPaths(cwd: string): WikiPaths {
  return {
    root: cwd,
    input: join(cwd, "input"),
    archive: join(cwd, "archive"),
    wiki: join(cwd, "wiki"),
  };
}

const RESERVED = new Set(["index.md", "log.md"]);
const TERM_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for",
  "is", "are", "was", "were", "be", "been", "with", "as", "by", "at",
  "from", "that", "this", "these", "those", "it", "its", "der", "die",
  "das", "ein", "eine", "und", "oder", "von", "zu", "mit", "auf", "ist",
  "war", "im", "für", "wie", "was", "wer", "wenn", "dass", "auch", "nicht",
]);

export function isConceptFile(relativePath: string): boolean {
  if (!relativePath.endsWith(".md")) return false;
  const segments = relativePath.split("/");
  if (segments.length === 0) return false;
  return !RESERVED.has(segments[segments.length - 1]);
}

export function conceptIdFromRelativePath(relativePath: string): string {
  return relativePath.endsWith(".md")
    ? relativePath.slice(0, -3)
    : relativePath;
}

export async function loadConcept(
  absolutePath: string,
  wikiRoot: string,
): Promise<Result<Concept>> {
  const content = await readTextFile(absolutePath);
  if (!content.success) return content;
  const parsed = parseDocument(content.data);
  if (!parsed.frontmatter) {
    return err<Concept>(`Missing frontmatter in ${absolutePath}`, {
      path: absolutePath,
    });
  }
  const relativePath = relativePosix(wikiRoot, absolutePath);
  return ok({
    conceptId: conceptIdFromRelativePath(relativePath),
    absolutePath,
    frontmatter: parsed.frontmatter,
    body: parsed.body,
  });
}

export async function loadAllConcepts(
  wikiRoot: string,
): Promise<Result<readonly Concept[]>> {
  if (!(await pathExists(wikiRoot))) return ok([]);
  const files = await listFiles(wikiRoot);
  if (!files.success) return files;
  const concepts: Concept[] = [];
  for (const file of files.data) {
    if (!isConceptFile(file.relativePath)) continue;
    const concept = await loadConcept(file.absolutePath, wikiRoot);
    if (concept.success) concepts.push(concept.data);
  }
  return ok(concepts);
}

export async function snapshotWiki(
  wikiRoot: string,
): Promise<Result<WikiSnapshot>> {
  if (!(await pathExists(wikiRoot))) return ok({ entries: new Map() });
  const files = await listFiles(wikiRoot);
  if (!files.success) return files;
  const entries = new Map<string, string>();
  for (const file of files.data) {
    if (!isConceptFile(file.relativePath)) continue;
    const content = await readTextFile(file.absolutePath);
    if (!content.success) continue;
    entries.set(
      conceptIdFromRelativePath(file.relativePath),
      hashContent(content.data),
    );
  }
  return ok({ entries });
}

export interface WikiDiff {
  readonly created: readonly string[];
  readonly updated: readonly string[];
}

export function diffSnapshots(before: WikiSnapshot, after: WikiSnapshot): WikiDiff {
  const created: string[] = [];
  const updated: string[] = [];
  for (const [conceptId, hash] of after.entries) {
    const previous = before.entries.get(conceptId);
    if (previous === undefined) created.push(conceptId);
    else if (previous !== hash) updated.push(conceptId);
  }
  created.sort();
  updated.sort();
  return { created, updated };
}

/** A compact preview of the existing wiki structure to guide the agent. */
export interface StructurePreview {
  readonly directories: readonly string[];
  readonly types: ReadonlyArray<{ type: string; count: number }>;
  readonly sampleConceptIds: readonly string[];
}

export function buildStructurePreview(concepts: readonly Concept[]): StructurePreview {
  const directories = new Set<string>();
  const typeCounts = new Map<string, number>();
  for (const concept of concepts) {
    const dir = concept.conceptId.includes("/")
      ? concept.conceptId.slice(0, concept.conceptId.lastIndexOf("/"))
      : "";
    if (dir !== "") directories.add(dir);
    const type = concept.frontmatter.type ?? "(untyped)";
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
  }
  const types = [...typeCounts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
  const sampleConceptIds = concepts
    .slice()
    .sort((a, b) => a.conceptId.localeCompare(b.conceptId))
    .slice(0, 30)
    .map((c) => c.conceptId);
  return {
    directories: [...directories].sort(),
    types,
    sampleConceptIds,
  };
}

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

export interface RetrievedConcept {
  readonly conceptId: string;
  readonly content: string;
  readonly score: number;
}

/** Simple term-frequency retrieval over the wiki for `/wiki-query`. */
export function retrieveConcepts(
  concepts: readonly Concept[],
  question: string,
  limit: number,
): readonly RetrievedConcept[] {
  const terms = tokenize(question);
  if (terms.length === 0) return [];
  const scored: RetrievedConcept[] = [];
  for (const concept of concepts) {
    const haystack = `${concept.frontmatter.title ?? ""} ${
      concept.frontmatter.description ?? ""
    } ${concept.frontmatter.tags.join(" ")} ${concept.body}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      const occurrences = haystack.split(term).length - 1;
      score += occurrences;
    }
    if (score > 0) {
      scored.push({
        conceptId: concept.conceptId,
        score,
        content: renderConceptForPrompt(concept),
      });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function renderConceptForPrompt(concept: Concept): string {
  const fm = concept.frontmatter;
  const meta = [
    `type: ${fm.type ?? "(untyped)"}`,
    fm.title ? `title: ${fm.title}` : null,
    fm.description ? `description: ${fm.description}` : null,
    fm.tags.length > 0 ? `tags: [${fm.tags.join(", ")}]` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  return `### ${concept.conceptId}\n\n${meta}\n\n${concept.body.trim()}`;
}

export function tokenize(text: string): readonly string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9äöüß]+/i)
        .filter((token) => token.length > 2)
        .filter((token) => !TERM_STOPWORDS.has(token)),
    ),
  ];
}

export function renderWikiTree(concepts: readonly Concept[]): string {
  if (concepts.length === 0) return "(empty)";
  return concepts
    .map((concept) => `wiki/${concept.conceptId}.md`)
    .sort()
    .join("\n");
}

function relativePosix(from: string, to: string): string {
  return nodeRelative(from, to).split(/[/\\]/).join("/");
}

export function displayTitle(frontmatter: Frontmatter, conceptId: string): string {
  return frontmatter.title ?? conceptId;
}