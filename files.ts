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