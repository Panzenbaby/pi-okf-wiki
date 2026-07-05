// Filesystem helpers wrapped in Result<T>. No exceptions leak to callers.

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
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

/**
 * Resolve a collision-free archive destination for `relativePath` under
 * `archiveDir` (relativePath uses posix "/" separators).
 *
 * Naming scheme (history-preserving, common case unchanged):
 *   1. `archive/<rel>`                      if free
 *   2. `archive/<stem>.<YYYY-MM-DD-HHMM><ext>` if the plain name is taken
 *   3. `archive/<stem>.<YYYY-MM-DD-HHMM>.<N><ext>` with N=1,2,… if the
 *      timestamped name is also taken (e.g. two runs in the same minute)
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
  const stamp = archiveTimestamp();

  const baseDir = join(archiveDir, ...dirParts);
  const candidate = (name: string): string => join(baseDir, name);

  const plain = candidate(fileName);
  if (!(await pathExists(plain))) return plain;

  const stamped = candidate(`${stem}.${stamp}${ext}`);
  if (!(await pathExists(stamped))) return stamped;

  let n = 1;
  while (true) {
    const counted = candidate(`${stem}.${stamp}.${n}${ext}`);
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

/** Recursively list all files under `root`, skipping the `archive` folder. */
export async function listFiles(root: string): Promise<Result<readonly FileEntry[]>> {
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
      if (entry.isDirectory()) {
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