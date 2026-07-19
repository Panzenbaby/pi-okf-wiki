import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listFiles, pathExists, removeEmptyDirs, resolveArchiveTarget } from "../src/files.ts";

let root: string;

beforeEach(async () => {
  root = join(tmpdir(), `okf-listfiles-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(root, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Create a file (and its parent dirs) under `root` and return its posix relative path. */
async function writeFileRelative(relativePath: string, content: string): Promise<void> {
  const absolutePath = join(root, ...relativePath.split("/"));
  await mkdir(join(absolutePath, ".."), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

describe("listFiles", () => {
  it("returns every file when no skip is provided", async () => {
    await writeFileRelative("top.md", "top");
    await writeFileRelative("keep/inner.md", "keep");
    await writeFileRelative("skipme/inner.md", "skipme");

    const result = await listFiles(root);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const paths = result.data.map((entry) => entry.relativePath).sort();
    expect(paths).toEqual(["keep/inner.md", "skipme/inner.md", "top.md"]);
  });

  it("skips a directory subtree whose name the predicate returns true for", async () => {
    await writeFileRelative("top.md", "top");
    await writeFileRelative("keep/inner.md", "keep");
    await writeFileRelative("skipme/inner.md", "skipme");

    const result = await listFiles(root, (name) => name === "skipme");
    expect(result.success).toBe(true);
    if (!result.success) return;

    const paths = result.data.map((entry) => entry.relativePath).sort();
    expect(paths).toEqual(["keep/inner.md", "top.md"]);
    expect(paths).not.toContain("skipme/inner.md");
  });
});

describe("resolveArchiveTarget", () => {
  let archiveDir: string;

  beforeEach(async () => {
    archiveDir = join(root, "archive");
    await mkdir(archiveDir, { recursive: true });
  });

  it("appends an outermost `.orig` suffix to a `.md` original so it is not a concept per OKF §3.1", async () => {
    const target = await resolveArchiveTarget(archiveDir, "notes/spec.md");
    expect(target).toBe(join(archiveDir, "notes", "spec.md.orig"));
  });

  it("leaves a binary original's extension unchanged (no `.orig`)", async () => {
    const target = await resolveArchiveTarget(archiveDir, "notes/spec.pdf");
    expect(target).toBe(join(archiveDir, "notes", "spec.pdf"));
  });

  it("keeps `.orig` outermost on a `.md` collision (stamp sits before `.orig`)", async () => {
    // Pre-place the plain `.md.orig` so the plain candidate is taken.
    await mkdir(join(archiveDir, "notes"), { recursive: true });
    await writeFile(join(archiveDir, "notes", "spec.md.orig"), "first");
    const target = await resolveArchiveTarget(archiveDir, "notes/spec.md");
    const base = join(archiveDir, "notes");
    // Expect `<stem>.<stamp>.md.orig` — `.orig` stays outermost, so the file
    // never ends in `.md` and remains a non-concept.
    expect(target.startsWith(`${base}/spec.`)).toBe(true);
    expect(target.endsWith(".md.orig")).toBe(true);
    expect(target).not.toMatch(/\.orig\.\d+$/);
  });

  it("uses a plain stamp without `.orig` on a binary collision", async () => {
    await mkdir(join(archiveDir, "notes"), { recursive: true });
    await writeFile(join(archiveDir, "notes", "spec.pdf"), "first");
    const target = await resolveArchiveTarget(archiveDir, "notes/spec.pdf");
    expect(target.startsWith(join(archiveDir, "notes", "spec."))).toBe(true);
    expect(target.endsWith(".pdf")).toBe(true);
    expect(target).not.toContain(".orig");
  });
});

describe("removeEmptyDirs", () => {
  it("removes leaf and nested empty folders but keeps folders that still hold a file", async () => {
    // input/notes/  (still has a file -> kept)
    // input/empty/  (no files -> removed)
    // input/empty/deeper/  (no files -> removed, then `empty` becomes empty -> removed)
    // input/keepfile/child/  (child holds a file -> kept; keepfile kept)
    await writeFileRelative("notes/spec.md", "x");
    await mkdir(join(root, "empty", "deeper"), { recursive: true });
    await writeFileRelative("keepfile/child/a.md", "a");

    const result = await removeEmptyDirs(root);
    expect(result.success).toBe(true);

    // Folder with a file is kept.
    expect(await pathExists(join(root, "notes"))).toBe(true);
    expect(await pathExists(join(root, "keepfile", "child"))).toBe(true);
    // Empty folders are gone.
    expect(await pathExists(join(root, "empty"))).toBe(false);
    // Root itself is never removed.
    expect(await pathExists(root)).toBe(true);
  });

  it("skips directories whose name the predicate returns true for", async () => {
    // A `.okf-extract` dir is empty but skipped, so it survives.
    await mkdir(join(root, ".okf-extract", "inner"), { recursive: true });
    await mkdir(join(root, "reallyempty"), { recursive: true });

    const result = await removeEmptyDirs(root, (name) => name === ".okf-extract");
    expect(result.success).toBe(true);

    expect(await pathExists(join(root, ".okf-extract"))).toBe(true);
    expect(await pathExists(join(root, "reallyempty"))).toBe(false);
  });

  it("returns ok on a missing root (nothing to prune)", async () => {
    const missing = join(root, "does-not-exist");
    const result = await removeEmptyDirs(missing);
    expect(result.success).toBe(true);
  });

  it("propagates a mid-walk read failure with the offending path", async () => {
    // Passing a regular file as the root makes the very first readdir throw
    // ENOTDIR — a genuine read failure (not ENOENT/ENOTEMPTY), which must
    // surface as !success and reference the offending path.
    const fileRoot = join(root, "not-a-dir");
    await writeFile(fileRoot, "i-am-a-file", "utf8");

    const result = await removeEmptyDirs(fileRoot);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain(fileRoot);
  });
});
