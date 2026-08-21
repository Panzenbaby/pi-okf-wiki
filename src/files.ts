// Filesystem helpers wrapped in Result<T>. No exceptions leak to callers.

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { copyFile as copyFileFn, mkdir, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { err, ok, type Result } from "./types.ts";

export async function ensureDir(path: string): Promise<Result<void>> {
  try {
    await mkdir(path, { recursive: true });
    return ok(undefined);
  } catch (error) {
    return err<void>(`Failed to create directory ${path}`, {
      path,
      cause: errorMessage(error),
    });
  }
}

export async function readTextFile(path: string): Promise<Result<string>> {
  try {
    const content = await readFile(path, "utf8");
    return ok(content);
  } catch (error) {
    return err<string>(`Failed to read file ${path}`, {
      path,
      cause: errorMessage(error),
    });
  }
}

export async function writeTextFile(
  path: string,
  content: string,
): Promise<Result<void>> {
  try {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content, "utf8");
    return ok(undefined);
  } catch (error) {
    return err<void>(`Failed to write file ${path}`, {
      path,
      cause: errorMessage(error),
    });
  }
}

export async function moveFile(
  source: string,
  destination: string,
): Promise<Result<void>> {
  try {
    await mkdir(join(destination, ".."), { recursive: true });
    await rename(source, destination);
    return ok(undefined);
  } catch (error) {
    return err<void>(`Failed to move ${source} -> ${destination}`, {
      path: source,
      cause: errorMessage(error),
    });
  }
}

/** Recursively remove a directory tree (no error if it does not exist). */
export async function removeDir(path: string): Promise<Result<void>> {
  try {
    await rm(path, { recursive: true, force: true });
    return ok(undefined);
  } catch (error) {
    return err<void>(`Failed to remove directory ${path}`, {
      path,
      cause: errorMessage(error),
    });
  }
}

/** Copy a file, creating destination parent directories. */
export async function copyFile(
  source: string,
  destination: string,
): Promise<Result<void>> {
  try {
    await mkdir(join(destination, ".."), { recursive: true });
    await copyFileFn(source, destination);
    return ok(undefined);
  } catch (error) {
    return err<void>(`Failed to copy ${source} -> ${destination}`, {
      path: source,
      cause: errorMessage(error),
    });
  }
}

/** Remove a single file. No error if it does not exist (idempotent). */
export async function removeFile(path: string): Promise<Result<void>> {
  try {
    await unlink(path);
    return ok(undefined);
  } catch (error) {
    if (isNotFound(error)) return ok(undefined);
    return err<void>(`Failed to remove file ${path}`, {
      path,
      cause: errorMessage(error),
    });
  }
}

/**
 * Resolve a collision-free archive destination for `relativePath` under
 * `archiveDir` (relativePath uses posix "/" separators).
 *
 * Naming scheme (history-preserving, common case unchanged):
 *   1. `archive/<rel><origSuffix>`                      if free
 *   2. `archive/<stem>.<YYYY-MM-DD-HHMM><ext><origSuffix>` if the plain name is taken
 *   3. `archive/<stem>.<YYYY-MM-DD-HHMM>.<N><ext><origSuffix>` with N=1,2,… if the
 *      timestamped name is also taken (e.g. two runs in the same minute)
 *
 * `<origSuffix>` is `.orig` iff the original `relativePath` is a `.md` file,
 * empty otherwise. The `.orig` is the OUTERMOST suffix (always last, after any
 * collision stamp) so the archived file never ends in `.md` — it is therefore
 * not a concept document per OKF §3.1 and the bundle stays §11-conformant
 * (archived `.md` originals typically carry no OKF frontmatter). Binary
 * originals (pdf, docx, …) keep their real extension unchanged so handlers
 * can open them by extension.
 *
 * Existing archive files are NEVER overwritten — every version is kept. The
 * check-then-rename window is tiny and this runs single-user/local, so the
 * residual TOCTOU race is acceptable; callers move with `mv -n` (no-clobber)
 * as a final safety net.
 */
export async function resolveArchiveTarget(
  archiveDir: string,
  relativePath: string,
): Promise<string> {
  const parts = relativePath.split("/");
  const fileName = parts[parts.length - 1] ?? relativePath;
  const dirParts = parts.slice(0, -1);
  // Split stem/ext on the LAST dot. A leading-dot hidden file (e.g. ".md")
  // has its only dot at index 0 -> treated as stem with no extension.
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  // `.orig` only for `.md` originals, outermost so the result never ends in `.md`.
  const origSuffix = fileName.endsWith(".md") ? ".orig" : "";
  const stamp = archiveTimestamp();

  const baseDir = join(archiveDir, ...dirParts);
  const candidate = (name: string): string => join(baseDir, name);

  const plain = candidate(`${fileName}${origSuffix}`);
  if (!(await pathExists(plain))) return plain;

  const stamped = candidate(`${stem}.${stamp}${ext}${origSuffix}`);
  if (!(await pathExists(stamped))) return stamped;

  let n = 1;
  while (true) {
    const counted = candidate(`${stem}.${stamp}.${n}${ext}${origSuffix}`);
    if (!(await pathExists(counted))) return counted;
  n++;
  }
}

/** `YYYY-MM-DD-HHMM` (UTC, filesystem-safe — no colons). */
function archiveTimestamp(): string {
  return new Date().toISOString().slice(0, 16).replace("T", "-").replace(":", "");
}

export interface FileEntry {
  readonly relativePath: string; // relative to root, with extension, posix separators
  readonly absolutePath: string;
  readonly isDirectory: boolean;
}

/**
 * Recursively list all files under `root`.
 *
 * This walker is generic and domain-agnostic: by default it skips nothing.
 * Callers that need to exclude a directory subtree (e.g. an extraction temp
 * dir staged inside `input/`) pass a `skip` predicate; when `skip` returns
 * `true` for a directory entry, that entry and its whole subtree are omitted.
 * When `skip` is omitted, every file under `root` is returned.
 */
export async function listFiles(
  root: string,
  skip?: (entryName: string, isDirectory: boolean) => boolean,
): Promise<Result<readonly FileEntry[]>> {
  const collected: FileEntry[] = [];
  const walk = async (dir: string): Promise<Result<void>> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      return err<void>(`Failed to read directory ${dir}`, {
        path: dir,
        cause: errorMessage(error),
      });
    }
    for (const entry of entries) {
      const absolutePath = join(dir, entry.name);
      const isDirectory = entry.isDirectory();
      if (skip !== undefined && skip(entry.name, isDirectory)) continue;
      if (isDirectory) {
        const sub = await walk(absolutePath);
        if (!sub.success) return sub;
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = relative(root, absolutePath).split(sep).join("/");
      collected.push({ relativePath, absolutePath, isDirectory: false });
    }
    return ok(undefined);
  };
  const result = await walk(root);
  if (!result.success) return result;
  return ok(collected);
}

/**
 * Recursively remove empty directories under `root` (post-order). The root
 * itself is never removed. Directories listed in `skip` (by base name) are
 * pruned — neither removed nor descended into — so a residual temp dir is
 * left untouched if the caller has not cleaned it yet. The `skip` signature
 * matches {@link listFiles} for consistency across the file walkers.
 *
 * Used after an ingest run: the agent moves originals from `input/` to the
 * archive, leaving their parent folders behind. This prunes those now-empty
 * folders so `input/` is clean for the next run.
 *
 * Errors are mapped to `Result`:
 *  - `ENOTEMPTY` on the final `rmdir` is NOT an error — it just means a
 *    child appeared between the post-order visit and the remove; the folder
 *    is left in place.
 *  - `ENOENT` mid-walk (the dir vanished, e.g. a concurrent process removed
 *    it) is treated the same way: nothing to prune, move on.
 *  - Genuine read/remove failures surface as `err` with the offending path.
 */
export async function removeEmptyDirs(
  root: string,
  skip?: (entryName: string, isDirectory: boolean) => boolean,
): Promise<Result<void>> {
  const walk = async (dir: string): Promise<Result<void>> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return ok(undefined);
      return err<void>(`Failed to read directory ${dir}`, {
        path: dir,
        cause: errorMessage(error),
      });
    }
    for (const entry of entries) {
      const isDirectory = entry.isDirectory();
      if (skip !== undefined && skip(entry.name, isDirectory)) continue;
      if (!isDirectory) continue;
      const sub = await walk(join(dir, entry.name));
      if (!sub.success) return sub;
    }
    if (dir === root) return ok(undefined);
    try {
      await rmdir(dir);
    } catch (error) {
      // Non-empty or already gone: neither is a failure for our purpose.
      if (isNotEmpty(error) || isNotFound(error)) return ok(undefined);
      return err<void>(`Failed to remove empty directory ${dir}`, {
        path: dir,
        cause: errorMessage(error),
      });
    }
    return ok(undefined);
  };
  return walk(root);
}

function isNotFound(error: unknown): boolean {
  return isErrorWithCode(error, "ENOENT");
}

function isNotEmpty(error: unknown): boolean {
  return isErrorWithCode(error, "ENOTEMPTY");
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === code;
}

/**
 * Well-known OS / file-manager metadata files that have nothing to do with the
 * documents being ingested. They are silently dropped so they don't show up as
 * "unsupported file type" in the summary and — more importantly — so they
 * don't keep their parent folder non-empty, which would block
 * {@link removeEmptyDirs} from leaving `input/` truly clean.
 */
const JUNK_FILE_NAMES = new Set([
  ".DS_Store", // macOS Finder
  "Thumbs.db", // Windows Explorer
  "ehthumbs.db", // Windows Explorer (media)
  "ehthumbs_vista.db",
  "desktop.ini", // Windows folder customisation
]);

function isJunkFileName(name: string): boolean {
  if (JUNK_FILE_NAMES.has(name)) return true;
  // AppleDouble resource-fork sidecars created by macOS on non-HFS volumes,
  // e.g. `._spec.pdf` next to `spec.pdf`. Always safe to drop.
  return name.startsWith("._") && name.length > 2;
}

/**
 * Recursively delete OS-metadata junk files under `root` (the well-known set
 * in {@link JUNK_FILE_NAMES} plus AppleDouble `._*` sidecars). Directories
 * listed in `skip` (by base name) are pruned — neither descended into — so a
 * residual extraction temp dir is left untouched.
 *
 * Best-effort: a per-file unlink failure (e.g. permission) does NOT abort the
 * walk — the file is skipped and the run continues. The returned count is the
 * number of files actually removed. A genuine `readdir` failure (the tree
 * can't be walked at all) surfaces as `err` with the offending path; in that
 * case no count is returned.
 */
export async function removeJunkFiles(
  root: string,
  skip?: (entryName: string, isDirectory: boolean) => boolean,
): Promise<Result<number>> {
  const walk = async (dir: string): Promise<Result<number>> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return ok(0);
      return err<number>(`Failed to read directory ${dir}`, {
        path: dir,
        cause: errorMessage(error),
      });
    }
    let removed = 0;
    for (const entry of entries) {
      const isDirectory = entry.isDirectory();
      // `skip` applies to DIRECTORY entries only — it prunes subtrees (e.g.
      // the `.okf-extract` temp dir). A regular file that happens to share the
      // skipped name is still subject to junk removal.
      if (isDirectory && skip !== undefined && skip(entry.name, isDirectory)) continue;
      const absolutePath = join(dir, entry.name);
      if (isDirectory) {
        const sub = await walk(absolutePath);
        if (!sub.success) return sub;
        removed += sub.data;
        continue;
      }
      // NOTE: `entry.isFile()` is false for symlinks (Dirent reflects the
      // entry type, not the resolved target), so a symlink named `.DS_Store`
      // or `._foo` is NOT cleaned here. Intentional — we don't follow or
      // chase symlinks — documented so it isn't read as a bug later.
      if (!entry.isFile() || !isJunkFileName(entry.name)) continue;
      try {
        await unlink(absolutePath);
        removed++;
      } catch (error) {
        // ENOENT: raced away, nothing to remove — fine. Any other unlink
        // failure is non-fatal for best-effort junk cleanup: skip the file,
        // keep the partial count, and move on. The next run retries.
        if (isNotFound(error)) continue;
      }
    }
    return ok(removed);
  };
  return walk(root);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function hashContent(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}