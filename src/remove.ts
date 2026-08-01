// Concept removal: move concepts out of the wiki into the bundle trash.
//
// Removal is deterministic and never involves the agent — it is a file move
// plus three bookkeeping steps that must not drift apart:
//   1. the concept file moves to `wiki/trash/<rel>.orig` (never deleted),
//   2. links to it in SURVIVING concepts are redirected to that trash path,
//   3. `index.md` is regenerated and `log.md` gets a `Removal` entry.
//
// A directory that loses its last concept disappears with it: its generated
// `index.md` is pruned (it is not knowledge, so it is not kept in the trash)
// and the now-empty directory is removed.

import { join } from "node:path";

import { err, ok, type AppError, type Result } from "./types.ts";
import {
  listFiles,
  moveFile,
  pathExists,
  readTextFile,
  removeEmptyDirs,
  resolveArchiveTarget,
  writeTextFile,
} from "./files.ts";
import {
  appendLogMd,
  conceptIdFromRelativePath,
  isConceptFile,
  loadAllConcepts,
  relativePosix,
  wikiPaths,
  writeAllIndexMd,
  ARCHIVE_DIR,
  TRASH_DIR,
  type ConceptRemoval,
} from "./wiki.ts";
import { compileRemovedConceptRewriter, conceptIdFromLinkTarget } from "./links.ts";

/** A link from a surviving concept to one that is about to be removed. */
export interface IncomingLink {
  readonly fromConceptId: string;
  readonly toConceptId: string;
}

/** What a removal would do, for confirmation before anything is touched. */
export interface RemovalPlan {
  readonly conceptIds: readonly string[];
  /** Directories that will disappear because they lose their last concept. */
  readonly directories: readonly string[];
  readonly incomingLinks: readonly IncomingLink[];
}

export interface RemovalReport {
  readonly removed: readonly ConceptRemoval[];
  readonly removedDirectories: readonly string[];
  /** Concepts whose body links were redirected to the trash. */
  readonly rewrittenConcepts: readonly string[];
}

/** Markdown link destination — same shape as the rewriter matches. */
const LINK_TARGET_RE = /\]\(\s*(<[^>]*>|[^()\s]*)\s*\)/g;

/**
 * Report what removing `target` would affect, without changing anything.
 * `target` is a wiki-relative path, with or without a leading `wiki/`: either
 * a concept file (`project/foo.md`) or a directory (`project`).
 */
export async function planRemoval(
  cwd: string,
  target: string,
): Promise<Result<RemovalPlan>> {
  const paths = wikiPaths(cwd);
  const resolved = await resolveTarget(paths.wiki, target);
  if (!resolved.success) return resolved;

  const concepts = await loadAllConcepts(paths.wiki);
  if (!concepts.success) return concepts;

  const doomed = new Set(resolved.data.conceptIds);
  const incomingLinks: IncomingLink[] = [];
  for (const concept of concepts.data) {
    if (doomed.has(concept.conceptId)) continue;
    for (const toConceptId of linkedConceptIds(concept.body, dirOf(concept.conceptId))) {
      if (!doomed.has(toConceptId)) continue;
      incomingLinks.push({ fromConceptId: concept.conceptId, toConceptId });
    }
  }
  incomingLinks.sort((a, b) =>
    a.fromConceptId.localeCompare(b.fromConceptId) || a.toConceptId.localeCompare(b.toConceptId),
  );

  const survivingIds = new Set(
    concepts.data.map((c) => c.conceptId).filter((id) => !doomed.has(id)),
  );
  const directories = emptiedDirectories(resolved.data.conceptIds, survivingIds);

  return ok({ conceptIds: resolved.data.conceptIds, directories, incomingLinks });
}

/**
 * Remove `target` from the wiki: move its concepts to `wiki/trash/`, redirect
 * incoming links, regenerate `index.md`, and append a `Removal` entry to
 * `log.md`. Originals in `wiki/archive/` are left untouched — they are the
 * ingest sources, not the knowledge, and removing them would make the next
 * `/wiki-update` re-ingest nothing.
 */
export async function removeFromWiki(
  cwd: string,
  target: string,
  date: string = today(),
): Promise<Result<RemovalReport>> {
  const paths = wikiPaths(cwd);
  const resolved = await resolveTarget(paths.wiki, target);
  if (!resolved.success) return resolved;

  const before = await loadAllConcepts(paths.wiki);
  if (!before.success) return before;

  // Move first, then rewrite: a link may only be redirected once its target is
  // known to sit at a collision-resolved trash path.
  const removed: ConceptRemoval[] = [];
  const mapping = new Map<string, string>();
  let moveFailure: AppError | undefined;
  for (const file of resolved.data.files) {
    const trashAbsolute = await resolveArchiveTarget(paths.trash, file.relativePath);
    const moved = await moveFile(file.absolutePath, trashAbsolute);
    if (!moved.success) {
      moveFailure = moved.error;
      break;
    }
    const trashPath = `/${TRASH_DIR}/${relativePosix(paths.trash, trashAbsolute)}`;
    const conceptId = conceptIdFromRelativePath(file.relativePath);
    removed.push({ conceptId, trashPath });
    mapping.set(conceptId, trashPath);
  }
  // A failed move mid-way must not leave the wiki describing a state that is
  // no longer on disk, so the bookkeeping below runs for whatever DID move and
  // the failure is reported afterwards. Bailing out here instead would leave
  // concepts in the trash while `index.md` and the citing concepts still
  // pointed at them.
  if (removed.length === 0) {
    return err<RemovalReport>(
      moveFailure?.message ?? `Nothing to remove for ${target}`,
      { path: moveFailure?.path ?? target },
    );
  }

  const rewritten = await redirectIncomingLinks(paths.wiki, mapping);
  if (!rewritten.success) return rewritten;

  const after = await loadAllConcepts(paths.wiki);
  if (!after.success) return after;

  // Regenerates every index.md and prunes the ones whose directory no longer
  // holds concepts, so the wiki is never left with orphan index entries.
  const indexed = await writeAllIndexMd(paths.wiki, after.data);
  if (!indexed.success) return indexed;

  const pruned = await removeEmptyDirs(paths.wiki, (name, isDirectory) =>
    isDirectory && (name === ARCHIVE_DIR || name === TRASH_DIR),
  );
  if (!pruned.success) return pruned;

  const logged = await appendLogMd(paths.wiki, date, {
    created: [],
    updated: [],
    removed,
  });
  if (!logged.success) return logged;

  const survivingIds = new Set(after.data.map((c) => c.conceptId));
  const candidates = emptiedDirectories(
    removed.map((r) => r.conceptId),
    survivingIds,
  );
  const removedDirectories: string[] = [];
  for (const dir of candidates) {
    if (!(await pathExists(join(paths.wiki, ...dir.split("/"))))) removedDirectories.push(dir);
  }

  if (moveFailure !== undefined) {
    return err<RemovalReport>(moveFailure.message, {
      path: moveFailure.path,
      cause: moveFailure.cause,
    });
  }
  return ok({ removed, removedDirectories, rewrittenConcepts: rewritten.data });
}

/**
 * Rewrite links to removed concepts in every surviving concept. Returns the
 * ids of the concepts that changed. Files without a matching link are not
 * rewritten at all, so their mtime stays put.
 */
async function redirectIncomingLinks(
  wikiRoot: string,
  mapping: ReadonlyMap<string, string>,
): Promise<Result<readonly string[]>> {
  const rewriter = compileRemovedConceptRewriter(mapping);
  if (!rewriter.hasMappings) return ok([]);

  const files = await listFiles(wikiRoot, (name, isDirectory) =>
    isDirectory && (name === ARCHIVE_DIR || name === TRASH_DIR),
  );
  if (!files.success) return files;

  const rewritten: string[] = [];
  for (const file of files.data) {
    if (!isConceptFile(file.relativePath)) continue;
    const content = await readTextFile(file.absolutePath);
    if (!content.success) return content;
    const conceptId = conceptIdFromRelativePath(file.relativePath);
    const result = rewriter.rewrite(content.data, dirOf(conceptId));
    if (!result.changed) continue;
    const written = await writeTextFile(file.absolutePath, result.content);
    if (!written.success) return written;
    rewritten.push(conceptId);
  }
  rewritten.sort();
  return ok(rewritten);
}

interface ResolvedTarget {
  readonly conceptIds: readonly string[];
  readonly files: ReadonlyArray<{ relativePath: string; absolutePath: string }>;
}

/**
 * Validate `target` and expand it to the concept files it covers. A directory
 * expands to every concept below it (recursively); a file to itself.
 */
async function resolveTarget(
  wikiRoot: string,
  target: string,
): Promise<Result<ResolvedTarget>> {
  const relative = normalizeTarget(target);
  if (relative === null) {
    return err<ResolvedTarget>(`Not a path inside the wiki: ${target}`, { path: target });
  }
  const segments = relative.split("/");
  const name = segments[segments.length - 1]!;
  if (name === "index.md" || name === "log.md") {
    return err<ResolvedTarget>(
      `${name} is generated by the wiki and cannot be removed on its own.`,
      { path: target },
    );
  }
  if (segments[0] === ARCHIVE_DIR || segments[0] === TRASH_DIR) {
    return err<ResolvedTarget>(
      `${segments[0]}/ holds no concepts — nothing to remove there.`,
      { path: target },
    );
  }
  const absolute = join(wikiRoot, ...segments);
  if (!(await pathExists(absolute))) {
    return err<ResolvedTarget>(`No such file or directory in the wiki: ${relative}`, {
      path: target,
    });
  }

  if (relative.endsWith(".md")) {
    return ok({
      conceptIds: [conceptIdFromRelativePath(relative)],
      files: [{ relativePath: relative, absolutePath: absolute }],
    });
  }

  const files = await listFiles(absolute);
  if (!files.success) return files;
  const concepts = files.data
    .map((file) => ({
      relativePath: `${relative}/${file.relativePath}`,
      absolutePath: file.absolutePath,
    }))
    .filter((file) => isConceptFile(file.relativePath))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  if (concepts.length === 0) {
    return err<ResolvedTarget>(`${relative} contains no concepts.`, { path: target });
  }
  return ok({
    conceptIds: concepts.map((file) => conceptIdFromRelativePath(file.relativePath)),
    files: concepts,
  });
}

/**
 * Strip an optional `wiki/` prefix and reject anything that is not a plain
 * relative path inside the bundle (absolute paths, `..` escapes, empty).
 */
function normalizeTarget(target: string): string | null {
  let path = target.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (path === "" || path.startsWith("/")) return null;
  if (path === "wiki") return null;
  if (path.startsWith("wiki/")) path = path.slice("wiki/".length);
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return segments.join("/");
}

/**
 * Directories that hold no surviving concept once `removedIds` are gone,
 * innermost first. A parent whose only concepts lived in a removed child
 * counts too, so a nested tree collapses in one go.
 */
function emptiedDirectories(
  removedIds: readonly string[],
  survivingIds: ReadonlySet<string>,
): readonly string[] {
  const candidates = new Set<string>();
  for (const conceptId of removedIds) {
    let dir = dirOf(conceptId);
    while (dir !== "") {
      candidates.add(dir);
      dir = dirOf(dir);
    }
  }
  const surviving = [...survivingIds];
  const emptied = [...candidates].filter(
    (dir) => !surviving.some((id) => id.startsWith(`${dir}/`)),
  );
  // Innermost first so a caller can delete/report them in a safe order.
  return emptied.sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/** Concept ids linked from `body`, resolved relative to `sourceDir`. */
function linkedConceptIds(body: string, sourceDir: string): readonly string[] {
  const ids: string[] = [];
  for (const match of body.matchAll(LINK_TARGET_RE)) {
    const conceptId = conceptIdFromLinkTarget(match[1]!, sourceDir);
    if (conceptId !== null) ids.push(conceptId);
  }
  return ids;
}

function dirOf(conceptId: string): string {
  const index = conceptId.lastIndexOf("/");
  return index === -1 ? "" : conceptId.slice(0, index);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
