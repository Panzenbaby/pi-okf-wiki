import { describe, expect, it } from "vitest";

import {
  conceptIdFromRelativePath,
  isConceptFile,
} from "../wiki/paths.ts";
import { diffSnapshots } from "../wiki/concepts.ts";
import type { Concept, Frontmatter, WikiSnapshot } from "../types.ts";
import { generateIndexMd } from "../wiki/index-log.ts";
import { tokenize } from "../wiki/retrieval.ts";

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

  it("drops English stopwords", () => {
    // "the" is an English stopword and must be filtered out.
    expect(tokenize("the quick brown fox")).toEqual(["quick", "brown", "fox"]);
  });

  it("drops German stopwords", () => {
    // "der", "die", "und" are German stopwords and must be filtered out.
    expect(tokenize("der tisch die stühle und bänke")).toEqual([
      "tisch",
      "stühle",
      "bänke",
    ]);
  });

  it("preserves German umlauts and ß (the split regex includes äöüß)", () => {
    expect(tokenize("Größe Maßstraße")).toEqual(["größe", "maßstraße"]);
  });

  it("returns an empty array when only stopwords / short tokens remain", () => {
    expect(tokenize("the a an of to in")).toEqual([]);
  });
});

describe("generateIndexMd", () => {
  const frontmatter = (
    overrides: Partial<Frontmatter> = {},
  ): Frontmatter => ({
    type: "table",
    title: undefined,
    description: undefined,
    resource: undefined,
    tags: [],
    timestamp: undefined,
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

  it("groups concepts by directory and sorts them", () => {
    const markdown = generateIndexMd([
      concept("tables/orders"),
      concept("tables/items"),
      concept("readme"),
    ]);
    expect(markdown).toContain("# Wiki Index");
    // root group uses "(root)"
    expect(markdown).toContain("## (root)");
    // directory group uses the dir name
    expect(markdown).toContain("## tables");
    // within a group, concepts are sorted by conceptId
    const tablesSection = markdown.split("## tables")[1];
    expect(tablesSection.indexOf("items")).toBeLessThan(
      tablesSection.indexOf("orders"),
    );
  });

  it("uses title and description in the link line, falling back to conceptId", () => {
    const markdown = generateIndexMd([
      concept("tables/orders", {
        title: "Orders Table",
        description: "All orders",
      }),
    ]);
    expect(markdown).toContain("* [Orders Table](tables/orders.md) - All orders");
  });

  it("omits the description suffix when description is missing", () => {
    const markdown = generateIndexMd([concept("readme")]);
    // title falls back to conceptId; no " - " suffix
    expect(markdown).toContain("* [readme](readme.md)");
    expect(markdown).not.toContain("* [readme](readme.md) -");
  });
});