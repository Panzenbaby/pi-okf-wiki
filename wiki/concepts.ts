// Concept loading, snapshot, and diff.

import {
  err,
  ok,
  type Concept,
  type Result,
  type WikiSnapshot,
} from "../types.ts";
import { parseDocument } from "../frontmatter.ts";
import {
  hashContent,
  listFiles,
  pathExists,
  readTextFile,
} from "../files.ts";
import {
  conceptIdFromRelativePath,
  isConceptFile,
  relativePosix,
} from "./paths.ts";

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