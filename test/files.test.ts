import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listFiles } from "../src/files.ts";

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