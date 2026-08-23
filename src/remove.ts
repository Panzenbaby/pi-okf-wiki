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
import { collectConceptReferences, compileRemovedConceptRewriter } from "./links.ts";

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
  /** Concepts whose references were redirected to the trash. */
  readonly rewrittenConcepts: readonly string[];
}

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
  const seen = new Set<string>();
  const incomingLinks: IncomingLink[] = [];
  for (const concept of concepts.data) {
    if (doomed.has(concept.conceptId)) continue;
    // The raw file, not `concept.body`: the rewriter also redirects
    // frontmatter `resource:` values, and the dialog must not understate what
    // the removal will touch.
    const content = await readTextFile(concept.absolutePath);
    if (!content.success) return content;
    for (const toConceptId of collectConceptReferences(
      content.data,
      dirOf(concept.conceptId),
    )) {
      if (!doomed.has(toConceptId)) continue;
      // A concept may cite the same target several times (body and
      // frontmatter alike); the dialog lists relationships, not occurrences.
      const key = `${concept.conceptId}\u0000${toConceptId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      incomingLinks.push({ fromConceptId: concept.conceptId, toConceptId });
    }
  }
  incomingLinks.sort((a, b) =>
    a.fromConceptId.localeCompare(b.fromConceptId) || a.toConceptId.localeCompare(b.toConceptId),
  );

  const survivingIds = new Set(
    concepts.data.map((c) => c.conceptId).filter((id) => !doomed.has(id)),
  );
  const candidates = emptiedDirectories(resolved.data.conceptIds, survivingIds);
  // A directory only disappears if nothing else is left in it. Files that are
  // not concepts (images, a `references/` folder) are never moved, so they
  // keep their directory alive — promising otherwise would make the
  // confirmation dialog lie.
  const directories: string[] = [];
  for (const dir of candidates) {
    const empty = await holdsOnlyDoomedFiles(paths.wiki, dir, doomed);
    if (!empty.success) return empty;
    if (empty.data) directories.push(dir);
  }

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

  const pruned = await removeEmptyDirs(paths.wiki);
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

  const files = await listFiles(wikiRoot);
  if (!files.success) return files;

  const rewritten: string[] = [];
  for (const file of files.data) {
    // Anchored at the bundle root on purpose: a concept directory legitimately
    // named `project/trash/` is ordinary knowledge and must still be rewritten.
    if (isRawFilePath(file.relativePath)) continue;
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
  // Case-insensitive: on APFS/NTFS `Archive/foo` reaches the same directory,
  // so an exact compare would let it through to a confusing later error.
  if (isRawFilePath(relative)) {
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

/**
 * Would `dir` be left empty? True when every file below it is either one of
 * the concepts being removed or a generated `index.md` (which is pruned with
 * the directory, not kept).
 */
async function holdsOnlyDoomedFiles(
  wikiRoot: string,
  dir: string,
  doomed: ReadonlySet<string>,
): Promise<Result<boolean>> {
  const files = await listFiles(join(wikiRoot, ...dir.split("/")));
  if (!files.success) return files;
  for (const file of files.data) {
    const relativePath = `${dir}/${file.relativePath}`;
    const name = file.relativePath.split("/").pop()!;
    if (name === "index.md") continue;
    if (doomed.has(conceptIdFromRelativePath(relativePath))) continue;
    return ok(false);
  }
  return ok(true);
}

/** Is this bundle-relative path inside `archive/` or `trash/` — the two
 *  top-level directories that hold raw files rather than concepts? */
function isRawFilePath(relativePath: string): boolean {
  const top = relativePath.split("/")[0]!.toLowerCase();
  return top === ARCHIVE_DIR || top === TRASH_DIR;
}

function dirOf(conceptId: string): string {
  const index = conceptId.lastIndexOf("/");
  return index === -1 ? "" : conceptId.slice(0, index);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
