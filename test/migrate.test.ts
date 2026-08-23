import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractCitations, migrateConcept, migrateWiki, LEGACY_ACTOR } from "../src/migrate.ts";
import { parseDocument } from "../src/frontmatter.ts";
import type { Concept } from "../src/types.ts";

function conceptOf(conceptId: string, content: string): Concept {
  const parsed = parseDocument(content);
  if (parsed.frontmatter === null) throw new Error("test concept must have frontmatter");
  return {
    conceptId,
    absolutePath: `/wiki/${conceptId}.md`,
    frontmatter: parsed.frontmatter,
    body: parsed.body,
  };
}

describe("migrateConcept", () => {
  it("moves a legacy timestamp into generated with the legacy actor (§13.1)", () => {
    const concept = conceptOf(
      "tables/orders",
      "---\ntype: table\ntitle: Orders\ntimestamp: 2026-07-03T00:00:00Z\ntags: [sales]\n---\n\nbody\n",
    );
    const out = migrateConcept(concept);
    expect(out).not.toBeNull();
    const reparsed = parseDocument(out!);
    expect(reparsed.frontmatter?.generated).toEqual({
      by: LEGACY_ACTOR,
      at: "2026-07-03T00:00:00Z",
    });
    expect(reparsed.frontmatter?.raw["timestamp"]).toBeUndefined();
    // Key order: generated sits where timestamp was (between title and tags).
    expect(Object.keys(reparsed.frontmatter!.raw)).toEqual([
      "type",
      "title",
      "generated",
      "tags",
    ]);
    expect(reparsed.body.trim()).toBe("body");
  });

  it("drops a redundant timestamp when generated already exists", () => {
    const concept = conceptOf(
      "t/c",
      "---\ntype: t\ngenerated: { by: pi-okf-wiki/model, at: 2026-08-01T00:00:00Z }\ntimestamp: 2026-07-03T00:00:00Z\n---\n\nbody\n",
    );
    const out = migrateConcept(concept);
    const reparsed = parseDocument(out!);
    expect(reparsed.frontmatter?.generated?.at).toBe("2026-08-01T00:00:00Z");
    expect(reparsed.frontmatter?.raw["timestamp"]).toBeUndefined();
  });

  it("lifts a # Citations list into sources and removes the section", () => {
    const concept = conceptOf(
      "t/c",
      [
        "---",
        "type: t",
        "timestamp: 2026-07-03T00:00:00Z",
        "---",
        "",
        "# Schema",
        "",
        "stuff",
        "",
        "# Citations",
        "",
        "- [spec v2](/archive/notes/spec-v2.pdf)",
        "- https://example.com/docs",
        "",
        "# Examples",
        "",
        "more",
      ].join("\n"),
    );
    const out = migrateConcept(concept);
    const reparsed = parseDocument(out!);
    expect(reparsed.frontmatter?.sources).toHaveLength(2);
    expect(reparsed.frontmatter?.sources[0]).toMatchObject({
      id: "spec-v2",
      resource: "/archive/notes/spec-v2.pdf",
      title: "spec v2",
    });
    expect(reparsed.frontmatter?.sources[1].resource).toBe("https://example.com/docs");
    expect(reparsed.body).not.toContain("# Citations");
    expect(reparsed.body).toContain("# Schema");
    expect(reparsed.body).toContain("# Examples");
  });

  it("merges citations into existing sources without duplicating resources", () => {
    const concept = conceptOf(
      "t/c",
      [
        "---",
        "type: t",
        "sources:",
        "  - id: spec",
        "    resource: /archive/a.pdf",
        "---",
        "",
        "# Citations",
        "",
        "- [a](/archive/a.pdf)",
        "- [b](/archive/b.pdf)",
      ].join("\n"),
    );
    const out = migrateConcept(concept);
    const reparsed = parseDocument(out!);
    expect(reparsed.frontmatter?.sources).toHaveLength(2);
    expect(reparsed.frontmatter?.sources.map((s) => s.resource)).toEqual([
      "/archive/a.pdf",
      "/archive/b.pdf",
    ]);
  });

  it("maps the legacy status values onto the §5.4 lifecycle", () => {
    const current = conceptOf(
      "t/a",
      "---\ntype: t\nstatus: current\n---\n\nbody\n",
    );
    expect(parseDocument(migrateConcept(current)!).frontmatter?.status).toBe("stable");

    const superseded = conceptOf(
      "t/b",
      "---\ntype: t\nstatus: Superseded\nsupersedes: [/t/a.md]\n---\n\nbody\n",
    );
    const migrated = parseDocument(migrateConcept(superseded)!);
    expect(migrated.frontmatter?.status).toBe("deprecated");
    // `supersedes` is a producer extension (§4.1) and stays untouched.
    expect(migrated.frontmatter?.supersedes).toEqual(["/t/a.md"]);
  });

  it("leaves a status that is already §5.4 alone", () => {
    for (const status of ["draft", "stable", "deprecated"]) {
      const concept = conceptOf("t/c", `---\ntype: t\nstatus: ${status}\n---\n\nbody\n`);
      expect(migrateConcept(concept)).toBeNull();
    }
  });

  it("does not invent a status for a concept that has none", () => {
    const concept = conceptOf(
      "t/c",
      "---\ntype: t\ntimestamp: 2026-07-03T00:00:00Z\n---\n\nbody\n",
    );
    const migrated = parseDocument(migrateConcept(concept)!);
    expect(migrated.frontmatter?.status).toBeUndefined();
    expect(migrated.frontmatter?.raw["status"]).toBeUndefined();
  });

  it("returns null for a concept that is already v0.2", () => {
    const concept = conceptOf(
      "t/c",
      "---\ntype: t\ngenerated: { by: a/1, at: 2026-08-01T00:00:00Z }\nsources:\n  - { id: x, resource: https://example.com }\n---\n\nbody\n",
    );
    expect(migrateConcept(concept)).toBeNull();
  });

  it("deduplicates generated source ids", () => {
    const concept = conceptOf(
      "t/c",
      "---\ntype: t\n---\n\n# Citations\n\n- [spec](/archive/a.pdf)\n- [spec](/archive/b.pdf)\n",
    );
    const reparsed = parseDocument(migrateConcept(concept)!);
    expect(reparsed.frontmatter?.sources.map((s) => s.id)).toEqual(["spec", "spec-2"]);
  });
});

describe("source ids", () => {
  it("never ends on a dash, even when truncation cuts mid-word", () => {
    const concept = conceptOf(
      "t/c",
      "---\ntype: t\n---\n\n# Citations\n\n- [1] abcd efgh ijkl mnop qrst uvwx yzab cdef gh\n",
    );
    const sources = parseDocument(migrateConcept(concept)!).frontmatter?.sources;
    expect(sources?.[0]?.id).toBe("abcd-efgh-ijkl-mnop-qrst-uvwx-yzab-cdef");
  });
});

describe("extractCitations", () => {
  it("returns null when no # Citations section exists", () => {
    expect(extractCitations("# Schema\n\nstuff")).toBeNull();
  });

  it("parses numbered and [n]-prefixed items and keeps prose-only entries", () => {
    const result = extractCitations(
      "# Citations\n\n1. [a](https://a.example)\n[2] [b](https://b.example)\n- interview with the ops team\n",
    );
    expect(result?.entries.map((entry) => entry.resource)).toEqual([
      "https://a.example",
      "https://b.example",
      "interview with the ops team",
    ]);
  });

  it("strips the [n] marker that follows a bullet (the v0.1 normal form)", () => {
    const result = extractCitations(
      "# Citations\n\n- [3] internal oncall tribal knowledge, no artifact\n- [1] [Spec](https://e.com/s)\n",
    );
    expect(result?.entries).toEqual([
      { resource: "internal oncall tribal knowledge, no artifact", title: undefined },
      { resource: "https://e.com/s", title: "Spec" },
    ]);
  });

  it("drops sentence punctuation after a bare URL but keeps a balanced bracket", () => {
    const result = extractCitations(
      [
        "# Citations",
        "",
        "- [1] Siehe https://example.org/a.",
        "- [2] Siehe https://en.wikipedia.org/wiki/Foo_(Bar)",
        "- [3] Siehe https://en.wikipedia.org/wiki/Foo_(Bar).",
        "- [4] Siehe (https://example.org/b), Absatz 2",
        "",
      ].join("\n"),
    );
    expect(result?.entries.map((entry) => entry.resource)).toEqual([
      "https://example.org/a",
      "https://en.wikipedia.org/wiki/Foo_(Bar)",
      "https://en.wikipedia.org/wiki/Foo_(Bar)",
      "https://example.org/b",
    ]);
  });

  it("ignores a # Citations example inside a code fence", () => {
    const body = [
      "# Beispiel",
      "",
      "```markdown",
      "# Citations",
      "",
      "- [x](https://a.example)",
      "```",
      "",
      "# Schema",
      "",
      "danach",
      "",
    ].join("\n");
    expect(extractCitations(body)).toBeNull();
  });

  it("neither ends the section nor collects entries on fenced lines", () => {
    const body = [
      "# Citations",
      "",
      "- [1] [a](https://a.example)",
      "",
      "```markdown",
      "# Sources",
      "",
      "- [2] [b](https://b.example)",
      "```",
      "",
      "- [3] [c](https://c.example)",
      "",
      "# Schema",
      "",
      "danach",
      "",
    ].join("\n");
    const result = extractCitations(body);
    expect(result?.entries.map((entry) => entry.resource)).toEqual([
      "https://a.example",
      "https://c.example",
    ]);
    expect(result?.cleanedBody).toBe("\n# Schema\n\ndanach\n");
  });
});

describe("migrateWiki", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = join(
      tmpdir(),
      `okf-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(join(workdir, "wiki", "tables"), { recursive: true });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("migrates legacy concepts, regenerates the index, and logs the change", async () => {
    await writeFile(
      join(workdir, "wiki", "tables", "orders.md"),
      "---\ntype: table\ntitle: Orders\ntimestamp: 2026-07-03T00:00:00Z\n---\n\n# Citations\n\n- [spec](/archive/spec.pdf)\n",
      "utf8",
    );
    await writeFile(
      join(workdir, "wiki", "tables", "modern.md"),
      "---\ntype: table\ngenerated: { by: a/1, at: 2026-08-01T00:00:00Z }\n---\n\nbody\n",
      "utf8",
    );

    const result = await migrateWiki(workdir, "2026-08-21");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.migrated).toEqual(["tables/orders"]);
    expect(result.data.alreadyCurrent).toBe(1);

    const migratedContent = await readFile(
      join(workdir, "wiki", "tables", "orders.md"),
      "utf8",
    );
    const reparsed = parseDocument(migratedContent);
    expect(reparsed.frontmatter?.generated?.at).toBe("2026-07-03T00:00:00Z");
    expect(reparsed.frontmatter?.sources[0]?.resource).toBe("/archive/spec.pdf");
    expect(reparsed.body).not.toContain("# Citations");

    const rootIndex = await readFile(join(workdir, "wiki", "index.md"), "utf8");
    expect(rootIndex.startsWith('---\nokf_version: "0.2"\n---\n')).toBe(true);

    const log = await readFile(join(workdir, "wiki", "log.md"), "utf8");
    expect(log).toContain("## 2026-08-21");
    expect(log).toContain("[tables/orders](/tables/orders.md)");

    // Untouched modern concept stays byte-identical.
    const modern = await readFile(join(workdir, "wiki", "tables", "modern.md"), "utf8");
    expect(modern).toContain("generated: { by: a/1, at: 2026-08-01T00:00:00Z }");
  });

  it("is a no-op on an already-current wiki", async () => {
    await writeFile(
      join(workdir, "wiki", "tables", "modern.md"),
      "---\ntype: table\n---\n\nbody\n",
      "utf8",
    );
    const result = await migrateWiki(workdir, "2026-08-21");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.migrated).toEqual([]);
    expect(result.data.alreadyCurrent).toBe(1);
    // No index/log churn on a no-op run.
    const { access } = await import("node:fs/promises");
    await expect(access(join(workdir, "wiki", "log.md"))).rejects.toThrow();
  });
});
