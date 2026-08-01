// index.md and log.md generation.
//
// Per OKF §6, an `index.md` MAY appear in any directory to support
// progressive disclosure — it enumerates THAT directory's direct contents
// (concepts + child subdirectories), not a recursive dump of the whole tree.
// We therefore generate one `index.md` per qualifying directory (root + every
// directory that contains a concept, directly or transitively), each listing
// only its own direct concepts and its immediate child subdirectories.
// `archive/` is never indexed (it holds raw originals, not knowledge — see
// `src/wiki/paths.ts`).
//
// Per OKF §11, the bundle-root `index.md` is the ONLY `index.md` permitted to
// carry frontmatter, where it MAY declare the targeted OKF version. We always
// emit `okf_version: "0.1"` there so the bundle is self-describing.

import { join } from "node:path";
import { ok, type Concept, type Result } from "../types.ts";
import { listFiles, readTextFile, removeFile, writeTextFile } from "../files.ts";
import { ARCHIVE_DIR, TRASH_DIR } from "./paths.ts";
import type { WikiDiff } from "./concepts.ts";

/** OKF spec version this bundle targets (§11). Declared in root `index.md` frontmatter. */
export const OKF_VERSION = "0.1";

/** Bundle directories that hold raw files, not knowledge — never indexed. */
const UNINDEXED_DIRS: readonly string[] = [ARCHIVE_DIR, TRASH_DIR];

/**
 * Compute every directory that should get an `index.md`: the root plus every
 * directory on the path to a concept (so a parent of nested-only concepts is
 * still indexed for progressive disclosure). `archive/` is excluded.
 * The root (`""`) is ALWAYS included so an empty wiki still gets a root index.
 */
export function computeIndexDirs(concepts: readonly Concept[]): Set<string> {
  const dirs = new Set<string>();
  dirs.add(""); // root always
  for (const concept of concepts) {
    let cur = dirOf(concept.conceptId);
    if (isUnindexedPath(cur)) continue;
    while (true) {
      dirs.add(cur);
      if (cur === "") break;
      cur = parentDir(cur);
    }
  }
  return dirs;
}

/** Directory of a concept id: `""` for root, `tables` for `tables/orders`. */
function dirOf(conceptId: string): string {
  const idx = conceptId.lastIndexOf("/");
  return idx === -1 ? "" : conceptId.slice(0, idx);
}

/** Parent directory: `""` for root or a top-level dir; `tables` for `tables/sales`. */
function parentDir(dir: string): string {
  if (dir === "") return "";
  const idx = dir.lastIndexOf("/");
  return idx === -1 ? "" : dir.slice(0, idx);
}

/** Last path segment for headings/links: `Wiki` for root, `sales` for `tables/sales`. */
function basename(dir: string): string {
  if (dir === "") return "Wiki";
  const idx = dir.lastIndexOf("/");
  return idx === -1 ? dir : dir.slice(idx + 1);
}

function isUnindexedPath(p: string): boolean {
  return UNINDEXED_DIRS.some((dir) => p === dir || p.startsWith(`${dir}/`));
}

/** Immediate child directories (one level deeper) of `dir`, sorted. */
function childSubdirs(dir: string, indexDirs: Set<string>): string[] {
  const children: string[] = [];
  for (const candidate of indexDirs) {
    if (candidate === "") continue; // root is never a child
    // parentDir(candidate) === dir already implies candidate !== dir.
    if (parentDir(candidate) === dir) children.push(candidate);
  }
  return children.sort();
}

/** Concepts directly in `dir` (not nested deeper). */
function directConcepts(
  dir: string,
  concepts: readonly Concept[],
): Concept[] {
  return concepts.filter((concept) => dirOf(concept.conceptId) === dir);
}

/**
 * Render the `index.md` body for a single directory: subdirectories first
 * (bare `* [name/](name/)` links — no fabricated description), then direct
 * concepts (alphabetical by concept id) with title + description. The root
 * directory is just the `""` instance of this same format (§6).
 */
export function generateDirIndexMd(
  dir: string,
  concepts: readonly Concept[],
  indexDirs: Set<string>,
): string {
  const lines: string[] = [`# ${basename(dir)} Index`, ""];

  const subs = childSubdirs(dir, indexDirs);
  for (const sub of subs) {
    lines.push(`* [${basename(sub)}/](${basename(sub)}/)`);
  }
  if (subs.length > 0) lines.push("");

  // NOTE: childSubdirs + directConcepts each scan the full set per directory,
  // so writeAllIndexMd is O(dirs * n). Fine for current local-wiki scale; if
  // it ever matters, pre-group concepts into a Map<dir, Concept[]> once.
  const direct = directConcepts(dir, concepts)
    .slice()
    .sort((a, b) => a.conceptId.localeCompare(b.conceptId));
  for (const concept of direct) {
    // Relative URL from this directory to the concept file.
    const slug = dir === "" ? concept.conceptId : concept.conceptId.slice(dir.length + 1);
    // Title falls back to the slug (the filename), matching §4.1 "consumers
    // MAY derive a title from the filename" — keeps link text and href
    // symmetric within a per-directory index.
    const title = concept.frontmatter.title ?? slug;
    const link = `${slug}.md`;
    const description = concept.frontmatter.description;
    lines.push(description ? `* [${title}](${link}) - ${description}` : `* [${title}](${link})`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Render the ROOT `index.md`: the per-dir format for `""`, prefixed with the
 * `okf_version` frontmatter block (§11 — the only `index.md` allowed frontmatter).
 */
export function generateRootIndexMd(
  concepts: readonly Concept[],
  indexDirs: Set<string>,
): string {
  const body = generateDirIndexMd("", concepts, indexDirs);
  return `---\nokf_version: "${OKF_VERSION}"\n---\n\n${body}`;
}

/**
 * Write the root `index.md` (always) plus one `index.md` per qualifying
 * subdirectory, and prune orphan `index.md` files in directories that no
 * longer qualify (e.g. after a concept was removed and its directory became
 * empty of concepts). Pruning is best-effort: an individual unlink failure is
 * skipped (the orphan stays, which §5.3 tolerates). The root `index.md` is
 * never pruned (`""` is always in `indexDirs`).
 */
export async function writeAllIndexMd(
  wikiRoot: string,
  concepts: readonly Concept[],
): Promise<Result<void>> {
  const indexDirs = computeIndexDirs(concepts);

  const pruned = await pruneOrphanIndexMd(wikiRoot, indexDirs);
  if (!pruned.success) return pruned;

  const rootContent = generateRootIndexMd(concepts, indexDirs);
  const rootWrite = await writeTextFile(join(wikiRoot, "index.md"), rootContent);
  if (!rootWrite.success) return rootWrite;

  for (const dir of indexDirs) {
    if (dir === "") continue; // root already written
    const content = generateDirIndexMd(dir, concepts, indexDirs);
    const segments = dir.split("/");
    const write = await writeTextFile(join(wikiRoot, ...segments, "index.md"), content);
    if (!write.success) return write;
  }
  return ok(undefined);
}

/**
 * Delete every `index.md` under `wikiRoot` whose directory is not in
 * `indexDirs` (orphan indexes left from directories that lost their concepts).
 * Best-effort: unlink failures are skipped, not fatal. The root `index.md`
 * (directory `""`) is always retained since `""` ∈ `indexDirs`.
 */
async function pruneOrphanIndexMd(
  wikiRoot: string,
  indexDirs: Set<string>,
): Promise<Result<void>> {
  const files = await listFiles(wikiRoot);
  if (!files.success) return files;
  for (const file of files.data) {
    const segments = file.relativePath.split("/");
    if (segments[segments.length - 1] !== "index.md") continue;
    const dir = segments.length === 1 ? "" : segments.slice(0, -1).join("/");
    if (indexDirs.has(dir)) continue; // still qualifies — keep
    // Orphan: best-effort removal. A failure leaves the file (§5.3 tolerates).
    const removed = await removeFile(file.absolutePath);
    if (!removed.success) continue;
  }
  return ok(undefined);
}

export async function appendLogMd(
  wikiRoot: string,
  date: string,
  diff: WikiDiff,
): Promise<Result<void>> {
  const logPath = join(wikiRoot, "log.md");
  const existing = await readTextFile(logPath);
  const header = `${LOG_TITLE}\n\n`;
  const entry = buildLogEntry(date, diff);
  if (!existing.success) return writeTextFile(logPath, header + entry);
  // Strip our own title if present, then re-add it above the new entry. A log
  // whose first line is something else (hand-edited, or written by an older
  // version) keeps its content below instead of swallowing the entry: a
  // silently dropped audit line is worse than an unexpected heading.
  const previous = existing.data.replace(new RegExp(`^${LOG_TITLE}\\s*\\n*`), "");
  return writeTextFile(logPath, header + entry + previous);
}

/** First line of `log.md`. Also the anchor `appendLogMd` splices new entries after. */
const LOG_TITLE = "# Wiki Update Log";

function buildLogEntry(date: string, diff: WikiDiff): string {
  const lines: string[] = [`## ${date}`, ""];
  for (const conceptId of diff.created) {
    lines.push(`* **Creation**: Added [${conceptId}](/${conceptId}.md).`);
  }
  for (const conceptId of diff.updated) {
    lines.push(`* **Update**: Updated [${conceptId}](/${conceptId}.md).`);
  }
  // The link points into the trash, not at the (now gone) concept path, so the
  // log stays clickable. Earlier Creation/Update entries are left alone — they
  // record what was true at the time.
  for (const removal of diff.removed ?? []) {
    lines.push(`* **Removal**: Removed [${removal.conceptId}](${removal.trashPath}).`);
  }
  const removedCount = diff.removed?.length ?? 0;
  if (diff.created.length === 0 && diff.updated.length === 0 && removedCount === 0) {
    lines.push("* **No-op**: No concepts changed.");
  }
  // Trailing blank line so the next `## <date>` block is separated from this
  // entry's list and renders as its own section.
  lines.push("", "");
  return lines.join("\n");
}