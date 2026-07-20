import { describe, expect, it } from "vitest";

import { parseDocument } from "../src/frontmatter.ts";

describe("parseDocument frontmatter", () => {
  it("parses flow-list tags and the recommended scalar fields", () => {
    const doc = parseDocument(
      "---\ntype: table\ntitle: Orders\ntags: [sales, orders]\ntimestamp: 2026-07-03T00:00:00Z\n---\n\nbody\n",
    );
    expect(doc.frontmatter?.type).toBe("table");
    expect(doc.frontmatter?.title).toBe("Orders");
    expect(doc.frontmatter?.tags).toEqual(["sales", "orders"]);
    expect(doc.frontmatter?.timestamp).toBe("2026-07-03T00:00:00Z");
    expect(doc.body.trim()).toBe("body");
  });

  it("parses block-list tags (§4.1 recommended list field)", () => {
    const doc = parseDocument(
      "---\ntype: table\ntags:\n  - sales\n  - orders\n---\n\nbody\n",
    );
    expect(doc.frontmatter?.tags).toEqual(["sales", "orders"]);
  });

  it("strips inline ` #…` comments from block-list items (mirrors flow-list path)", () => {
    const doc = parseDocument(
      "---\ntype: table\ntags:\n  - sales # revenue line\n  - orders\n---\n\nbody\n",
    );
    expect(doc.frontmatter?.tags).toEqual(["sales", "orders"]);
  });

  it("tolerates a bare scalar tag by wrapping it to a single-element list", () => {
    const doc = parseDocument("---\ntype: note\ntags: sales\n---\n\nbody\n");
    expect(doc.frontmatter?.tags).toEqual(["sales"]);
  });

  it("parses status (producer-defined, open string)", () => {
    const doc = parseDocument("---\ntype: note\nstatus: superseded\n---\n\nbody\n");
    expect(doc.frontmatter?.status).toBe("superseded");
  });

  it("parses supersedes as a flow list of bundle-relative paths", () => {
    const doc = parseDocument(
      "---\ntype: note\nsupersedes: [/tables/orders.md, /tables/legacy.md]\n---\n\nbody\n",
    );
    expect(doc.frontmatter?.supersedes).toEqual([
      "/tables/orders.md",
      "/tables/legacy.md",
    ]);
  });

  it("parses supersedes as a block list", () => {
    const doc = parseDocument(
      "---\ntype: note\nsupersedes:\n  - /tables/orders.md\n  - /tables/legacy.md\n---\n\nbody\n",
    );
    expect(doc.frontmatter?.supersedes).toEqual([
      "/tables/orders.md",
      "/tables/legacy.md",
    ]);
  });

  it("tolerates a bare scalar supersedes path by wrapping it to a list", () => {
    const doc = parseDocument(
      "---\ntype: note\nsupersedes: /tables/orders.md\n---\n\nbody\n",
    );
    expect(doc.frontmatter?.supersedes).toEqual(["/tables/orders.md"]);
  });

  it("preserves unknown producer keys in raw (§4.1)", () => {
    const doc = parseDocument(
      "---\ntype: note\ncustom_field: hello\n---\n\nbody\n",
    );
    expect(doc.frontmatter?.raw["custom_field"]).toBe("hello");
  });

  it("returns null frontmatter when the closing fence is missing", () => {
    const doc = parseDocument("---\ntype: note\nbody without close");
    expect(doc.frontmatter).toBeNull();
  });

  it("returns empty tags when the tags key is absent", () => {
    const doc = parseDocument("---\ntype: note\n---\n\nbody\n");
    expect(doc.frontmatter?.tags).toEqual([]);
    expect(doc.frontmatter?.supersedes).toEqual([]);
    expect(doc.frontmatter?.status).toBeUndefined();
  });
});