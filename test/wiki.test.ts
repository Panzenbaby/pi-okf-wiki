import { describe, expect, it } from "vitest";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

import {
  conceptIdFromRelativePath,
  isConceptFile,
} from "../src/wiki/paths.ts";
import { diffSnapshots } from "../src/wiki/concepts.ts";
import { pathExists } from "../src/files.ts";
import type { Concept, Frontmatter, WikiSnapshot } from "../src/types.ts";
import {
  computeIndexDirs,
  generateDirIndexMd,
  generateRootIndexMd,
  writeAllIndexMd,
} from "../src/wiki/index-log.ts";
import { tokenize } from "../src/wiki/retrieval.ts";

const frontmatter = (
  overrides: Partial<Frontmatter> = {},
): Frontmatter => ({
  type: "table",
  title: undefined,
  description: undefined,
  resource: undefined,
  tags: [],
  timestamp: undefined,
  status: undefined,
  supersedes: [],
  generated: undefined,
  verified: [],
  sources: [],
  staleAfter: undefined,
  raw: {},
  ...overrides,
});

const concept = (
  conceptId: string,
  overrides: Partial<Frontmatter> = {},
): Concept => ({
  conceptId,
  absolutePath: `/wiki/${conceptId}.md`,
  frontmatter: frontmatter(overrides),
  body: "",
});

describe("conceptIdFromRelativePath", () => {
  it("strips the .md suffix", () => {
    expect(conceptIdFromRelativePath("tables/orders.md")).toBe("tables/orders");
  });

  it("leaves the path unchanged when there is no .md suffix", () => {
    expect(conceptIdFromRelativePath("tables/orders")).toBe("tables/orders");
  });
});

describe("isConceptFile", () => {
  it("accepts a regular .md file", () => {
    expect(isConceptFile("tables/orders.md")).toBe(true);
  });

  it("rejects non-markdown files", () => {
    expect(isConceptFile("tables/orders.txt")).toBe(false);
    expect(isConceptFile("tables/orders")).toBe(false);
  });

  it("rejects reserved filenames (index.md, log.md) in any directory", () => {
    expect(isConceptFile("index.md")).toBe(false);
    expect(isConceptFile("log.md")).toBe(false);
    expect(isConceptFile("sub/index.md")).toBe(false);
    expect(isConceptFile("sub/log.md")).toBe(false);
  });
});

describe("diffSnapshots", () => {
  const snapshot = (entries: ReadonlyArray<[string, string]>): WikiSnapshot => ({
    entries: new Map(entries),
  });

  it("reports created concept ids (only in `after`)", () => {
    const before = snapshot([["a", "h1"]]);
    const after = snapshot([
      ["a", "h1"],
      ["b", "h2"],
    ]);
    expect(diffSnapshots(before, after)).toEqual({
      created: ["b"],
      updated: [],
    });
  });

  it("reports updated concept ids (hash changed)", () => {
    const before = snapshot([["a", "h1"]]);
    const after = snapshot([["a", "h2"]]);
    expect(diffSnapshots(before, after)).toEqual({
      created: [],
      updated: ["a"],
    });
  });

  it("does not report unchanged concept ids", () => {
    const before = snapshot([["a", "h1"]]);
    const after = snapshot([["a", "h1"]]);
    expect(diffSnapshots(before, after)).toEqual({
      created: [],
      updated: [],
    });
  });

  it("drops concept ids that disappeared from `after` (not in either list)", () => {
    const before = snapshot([
      ["a", "h1"],
      ["b", "h2"],
    ]);
    const after = snapshot([["a", "h1"]]);
    expect(diffSnapshots(before, after)).toEqual({
      created: [],
      updated: [],
    });
  });

  it("sorts created and updated lists", () => {
    const before = snapshot([
      ["a", "h1"],
      ["c", "h3"],
    ]);
    const after = snapshot([
      ["a", "hX"],
      ["b", "h2"],
      ["c", "h3"],
      ["d", "h4"],
    ]);
    expect(diffSnapshots(before, after)).toEqual({
      created: ["b", "d"],
      updated: ["a"],
    });
  });
});

describe("tokenize", () => {
  it("lowercases, splits on non-alphanumeric runs, dedupes", () => {
    expect(tokenize("Tables Orders TABLES")).toEqual(["tables", "orders"]);
  });

  it("drops tokens shorter than 3 characters", () => {
    expect(tokenize("a ab abc d")).toEqual(["abc"]);
  });

  it("preserves German umlauts and ß (Unicode \\p{L} covers them)", () => {
    expect(tokenize("Größe Maßstraße")).toEqual(["größe", "maßstraße"]);
  });

  it("does not filter stopwords — downweighting happens via IDF in the retriever, not in the tokenizer", () => {
    // No hardcoded stopword list is maintained: "the" (length 3) passes
    // through tokenize. Common terms are downweighted at scoring time by
    // IDF computed from the corpus, keeping retrieval language-independent.
    expect(tokenize("the quick brown fox")).toEqual([
      "the",
      "quick",
      "brown",
      "fox",
    ]);
  });
});

describe("computeIndexDirs", () => {
  it("always includes the root, plus every dir on the path to a concept", () => {
    const dirs = computeIndexDirs([
      concept("tables/orders"),
      concept("tables/sales/items/leaf"),
      concept("readme"),
    ]);
    expect(dirs.has("")).toBe(true); // root always
    expect(dirs.has("tables")).toBe(true);
    expect(dirs.has("tables/sales")).toBe(true); // parent of nested-only concept
    expect(dirs.has("tables/sales/items")).toBe(true); // dir containing the leaf
  });

  it("excludes the archive/ subtree", () => {
    const dirs = computeIndexDirs([concept("archive/notes/spec")]);
    expect(dirs.has("archive")).toBe(false);
    expect(dirs.has("archive/notes")).toBe(false);
    // root still present
    expect(dirs.has("")).toBe(true);
  });
});

describe("generateRootIndexMd", () => {
  it("declares okf_version in the root index frontmatter (§11)", () => {
    const markdown = generateRootIndexMd(
      [concept("tables/orders")],
      computeIndexDirs([concept("tables/orders")]),
    );
    expect(markdown.startsWith('---\nokf_version: "0.2"\n---\n')).toBe(true);
    expect(markdown).toContain("# Wiki Index");
  });

  it("lists top-level subdirectory links and root-level concepts, subdirs first", () => {
    const concepts = [
      concept("readme"),
      concept("tables/orders"),
      concept("tables/items"),
    ];
    const markdown = generateRootIndexMd(concepts, computeIndexDirs(concepts));
    // Root-level concept linked with its full relative path from the root.
    expect(markdown).toContain("* [readme](readme.md)");
    // Top-level subdir linked bare (no fabricated description).
    expect(markdown).toContain("* [tables/](tables/)");
    // Subdir link appears before root-level concept lines that follow it.
    const tablesLinkIdx = markdown.indexOf("* [tables/](tables/)");
    const readmeIdx = markdown.indexOf("* [readme](readme.md)");
    expect(tablesLinkIdx).toBeLessThan(readmeIdx);
    // Nested concepts are NOT listed in the root index (progressive disclosure).
    expect(markdown).not.toContain("orders.md");
  });
});

describe("generateDirIndexMd", () => {
  it("lists direct concepts (relative to this dir) and child subdirs, subdirs first", () => {
    const concepts = [
      concept("tables/orders"),
      concept("tables/items"),
      concept("tables/sales/leads"),
    ];
    const dirs = computeIndexDirs(concepts);
    const markdown = generateDirIndexMd("tables", concepts, dirs);
    expect(markdown).toContain("# tables Index");
    // Child subdir linked bare, relative to this dir.
    expect(markdown).toContain("* [sales/](sales/)");
    // Direct concepts linked by slug relative to this dir; title falls back
    // to the slug (filename), so text and href stay symmetric.
    expect(markdown).toContain("* [items](items.md)");
    expect(markdown).toContain("* [orders](orders.md)");
    // Nested concept not listed here (it is in tables/sales/index.md).
    expect(markdown).not.toContain("leads");
    // Subdirs before direct concepts.
    expect(markdown.indexOf("* [sales/](sales/)")).toBeLessThan(
      markdown.indexOf("* [items](items.md)"),
    );
  });

  it("uses title and description in the link line, falling back to conceptId", () => {
    const concepts = [
      concept("tables/orders", {
        title: "Orders Table",
        description: "All orders",
      }),
    ];
    const markdown = generateDirIndexMd("tables", concepts, computeIndexDirs(concepts));
    expect(markdown).toContain("* [Orders Table](orders.md) - All orders");
  });

  it("omits the description suffix when description is missing", () => {
    const concepts = [concept("readme")];
    const markdown = generateDirIndexMd("", concepts, computeIndexDirs(concepts));
    expect(markdown).toContain("* [readme](readme.md)");
    expect(markdown).not.toContain("* [readme](readme.md) -");
  });

  it("has no frontmatter for a non-root directory (§11 — only root may carry frontmatter)", () => {
    const concepts = [concept("tables/orders")];
    const markdown = generateDirIndexMd("tables", concepts, computeIndexDirs(concepts));
    expect(markdown.startsWith("---")).toBe(false);
  });
});

describe("writeAllIndexMd (filesystem)", () => {
  let wikiRoot: string;

  beforeEach(async () => {
    wikiRoot = join(
      tmpdir(),
      `okf-idx-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(wikiRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(wikiRoot, { recursive: true, force: true });
  });

  async function writeConceptFile(rel: string): Promise<void> {
    const abs = join(wikiRoot, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, `---\ntype: t\ntitle: ${rel}\n---\n\nbody\n`, "utf8");
  }

  it("writes root index.md plus one index.md per qualifying subdirectory", async () => {
    await writeConceptFile("tables/orders.md");
    await writeConceptFile("tables/sales/leads.md");
    await writeConceptFile("readme.md");

    const result = await writeAllIndexMd(wikiRoot, [
      concept("tables/orders"),
      concept("tables/sales/leads"),
      concept("readme"),
    ]);
    expect(result.success).toBe(true);

    expect(await pathExists(join(wikiRoot, "index.md"))).toBe(true);
    expect(await pathExists(join(wikiRoot, "tables", "index.md"))).toBe(true);
    expect(await pathExists(join(wikiRoot, "tables", "sales", "index.md"))).toBe(true);
    // A directory with only nested concepts (tables/sales has only leads,
    // no deeper) still gets its own index; there is no tables/sales/leads dir.
  });

  it("declares okf_version only in the root index.md, never in a subdirectory index", async () => {
    await writeConceptFile("tables/orders.md");
    const result = await writeAllIndexMd(wikiRoot, [concept("tables/orders")]);
    expect(result.success).toBe(true);

    const rootContent = await readFile(join(wikiRoot, "index.md"), "utf8");
    expect(rootContent.startsWith('---\nokf_version: "0.2"\n---\n')).toBe(true);
    const subContent = await readFile(join(wikiRoot, "tables", "index.md"), "utf8");
    expect(subContent.startsWith("---")).toBe(false);
  });

  it("prunes orphan index.md files in directories that no longer qualify", async () => {
    // First run: tables/ holds a concept -> gets an index.md.
    await writeConceptFile("tables/orders.md");
    let result = await writeAllIndexMd(wikiRoot, [concept("tables/orders")]);
    expect(result.success).toBe(true);
    expect(await pathExists(join(wikiRoot, "tables", "index.md"))).toBe(true);

    // Simulate the concept being gone (e.g. user deleted it) so tables/ no
    // longer qualifies. writeAllIndexMd must prune the orphan tables/index.md.
    await unlink(join(wikiRoot, "tables", "orders.md"));
    result = await writeAllIndexMd(wikiRoot, []);
    expect(result.success).toBe(true);

    expect(await pathExists(join(wikiRoot, "tables", "index.md"))).toBe(false);
    // Root index.md is always retained.
    expect(await pathExists(join(wikiRoot, "index.md"))).toBe(true);
  });
});