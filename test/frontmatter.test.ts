import { describe, expect, it } from "vitest";

import { parseDocument, serializeDocument } from "../src/frontmatter.ts";

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

  it("returns null frontmatter on malformed YAML (deferred, not crashed)", () => {
    const doc = parseDocument("---\ntype: [unclosed\n---\n\nbody\n");
    expect(doc.frontmatter).toBeNull();
    expect(doc.body.trim()).toBe("body");
  });

  it("coerces numeric list items to strings (tags: [2024])", () => {
    const doc = parseDocument("---\ntype: note\ntags: [sales, 2024]\n---\n\nbody\n");
    expect(doc.frontmatter?.tags).toEqual(["sales", "2024"]);
  });
});

describe("parseDocument OKF v0.2 families", () => {
  it("parses generated as a { by, at } mapping (§5.2)", () => {
    const doc = parseDocument(
      "---\ntype: note\ngenerated: { by: pi-okf-wiki/0.3.0, at: 2026-06-20T22:53:05Z }\n---\n\nbody\n",
    );
    expect(doc.frontmatter?.generated).toEqual({
      by: "pi-okf-wiki/0.3.0",
      at: "2026-06-20T22:53:05Z",
    });
  });

  it("keeps YAML timestamps as strings, not Date objects", () => {
    const doc = parseDocument(
      "---\ntype: note\ngenerated: { by: a/1, at: 2026-06-20T22:53:05Z }\nstale_after: 2026-09-23T00:00:00Z\n---\n\nbody\n",
    );
    expect(typeof doc.frontmatter?.generated?.at).toBe("string");
    expect(doc.frontmatter?.staleAfter).toBe("2026-09-23T00:00:00Z");
  });

  it("normalizes a bare verified mapping to a one-element list (§5.2 MUST)", () => {
    const doc = parseDocument(
      "---\ntype: note\nverified: { by: human:ahormati, at: 2026-06-25T09:00:00Z }\n---\n\nbody\n",
    );
    expect(doc.frontmatter?.verified).toEqual([
      { by: "human:ahormati", at: "2026-06-25T09:00:00Z" },
    ]);
  });

  it("parses verified as a list of events", () => {
    const doc = parseDocument(
      "---\ntype: note\nverified:\n  - { by: human:a, at: 2026-06-25T09:00:00Z }\n  - { by: process:nightly, at: 2026-06-26T02:00:00Z }\n---\n\nbody\n",
    );
    expect(doc.frontmatter?.verified).toHaveLength(2);
    expect(doc.frontmatter?.verified[1].by).toBe("process:nightly");
  });

  it("parses sources with credibility signals (§5.1)", () => {
    const doc = parseDocument(
      [
        "---",
        "type: note",
        "sources:",
        "  - id: ga4-schema",
        "    resource: https://example.com/schema",
        "    title: GA4 schema",
        "    author: team:ga4-docs",
        "    usage_count: 5000",
        "    last_modified: 2026-05-30T00:00:00Z",
        "  - resource: /archive/notes/spec.pdf",
        "---",
        "",
        "body",
      ].join("\n"),
    );
    expect(doc.frontmatter?.sources).toHaveLength(2);
    expect(doc.frontmatter?.sources[0]).toEqual({
      id: "ga4-schema",
      resource: "https://example.com/schema",
      title: "GA4 schema",
      author: "team:ga4-docs",
      usageCount: 5000,
      lastModified: "2026-05-30T00:00:00Z",
    });
    expect(doc.frontmatter?.sources[1].resource).toBe("/archive/notes/spec.pdf");
  });

  it("still surfaces the legacy v0.1 timestamp for §13.1 fallback", () => {
    const doc = parseDocument(
      "---\ntype: note\ntimestamp: 2026-07-03T00:00:00Z\n---\n\nbody\n",
    );
    expect(doc.frontmatter?.timestamp).toBe("2026-07-03T00:00:00Z");
    expect(doc.frontmatter?.generated).toBeUndefined();
  });
});

describe("serializeDocument", () => {
  it("round-trips a v0.2 concept including unknown keys (§4.1)", () => {
    const original = [
      "---",
      "type: Metric",
      "title: Revenue",
      "tags: [finance]",
      "generated: { by: pi-okf-wiki/0.3.0, at: 2026-06-20T22:53:05Z }",
      "custom_field: hello",
      "sources:",
      "  - id: policy",
      "    resource: https://example.com/policy",
      "---",
      "",
      "# Definition",
      "",
      "Revenue.[^policy]",
      "",
      "[^policy]: Revenue policy",
    ].join("\n");
    const parsed = parseDocument(original);
    expect(parsed.frontmatter).not.toBeNull();
    const serialized = serializeDocument(parsed.frontmatter!.raw, parsed.body);
    const reparsed = parseDocument(serialized);
    expect(reparsed.frontmatter?.raw).toEqual(parsed.frontmatter!.raw);
    expect(reparsed.frontmatter?.generated).toEqual(parsed.frontmatter!.generated);
    expect(reparsed.frontmatter?.sources).toEqual(parsed.frontmatter!.sources);
    expect(reparsed.body.trim()).toBe(parsed.body.trim());
  });

  it("emits a well-formed document for a minimal record", () => {
    const out = serializeDocument({ type: "note" }, "body text\n");
    expect(out.startsWith("---\n")).toBe(true);
    const parsed = parseDocument(out);
    expect(parsed.frontmatter?.type).toBe("note");
    expect(parsed.body.trim()).toBe("body text");
  });
});