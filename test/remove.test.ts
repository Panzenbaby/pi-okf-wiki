import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { planRemoval, removeFromWiki } from "../src/remove.ts";
import { pathExists } from "../src/files.ts";
import { loadAllConcepts } from "../src/wiki.ts";

let workdir: string;

beforeEach(async () => {
  workdir = join(
    tmpdir(),
    `okf-remove-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(join(workdir, "wiki"), { recursive: true });
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

async function writeConcept(
  relativePath: string,
  frontmatter: string,
  body: string,
): Promise<void> {
  const absolute = join(workdir, "wiki", relativePath);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, `---\n${frontmatter}\n---\n\n${body}\n`, "utf8");
}

function read(relativePath: string): Promise<string> {
  return readFile(join(workdir, relativePath), "utf8");
}

function exists(relativePath: string): Promise<boolean> {
  return pathExists(join(workdir, relativePath));
}

/** Two concepts in `project/`, one in `guidelines/` linking to both. */
async function seedWiki(): Promise<void> {
  await writeConcept("project/foo.md", "type: note\ntitle: Foo", "# Foo");
  await writeConcept("project/bar.md", "type: note\ntitle: Bar", "See [Foo](/project/foo.md).");
  await writeConcept(
    "guidelines/rules.md",
    "type: note\ntitle: Rules",
    "Follow [Foo](../project/foo.md) and [Bar](/project/bar.md).",
  );
}

describe("removeFromWiki", () => {
  it("moves a concept to the trash with an .orig suffix instead of deleting it", async () => {
    await seedWiki();
    const result = await removeFromWiki(workdir, "project/foo.md", "2026-08-01");

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.removed).toEqual([
      { conceptId: "project/foo", trashPath: "/trash/project/foo.md.orig" },
    ]);
    expect(await exists("wiki/project/foo.md")).toBe(false);
    expect(await read("wiki/trash/project/foo.md.orig")).toContain("# Foo");
  });

  it("redirects links in surviving concepts to the trash path", async () => {
    await seedWiki();
    const result = await removeFromWiki(workdir, "project/foo.md", "2026-08-01");

    expect(result.success && result.data.rewrittenConcepts).toEqual([
      "guidelines/rules",
      "project/bar",
    ]);
    expect(await read("wiki/project/bar.md")).toContain("[Foo](/trash/project/foo.md.orig)");
    expect(await read("wiki/guidelines/rules.md")).toContain(
      "[Foo](/trash/project/foo.md.orig)",
    );
    // The link to the surviving concept is untouched.
    expect(await read("wiki/guidelines/rules.md")).toContain("[Bar](/project/bar.md)");
  });

  it("leaves links pointing OUT of the removed concept alone", async () => {
    await writeConcept("project/foo.md", "type: note", "Related: [Bar](/project/bar.md).");
    await writeConcept("project/bar.md", "type: note", "# Bar");
    await removeFromWiki(workdir, "project/foo.md", "2026-08-01");

    expect(await read("wiki/trash/project/foo.md.orig")).toContain("[Bar](/project/bar.md)");
  });

  it("removes the whole directory when its last concept goes", async () => {
    await seedWiki();
    await writeFile(
      join(workdir, "wiki", "guidelines", "index.md"),
      "# guidelines Index\n\n* [Rules](rules.md)\n",
      "utf8",
    );
    const result = await removeFromWiki(workdir, "guidelines/rules.md", "2026-08-01");

    expect(result.success && result.data.removedDirectories).toEqual(["guidelines"]);
    expect(await exists("wiki/guidelines")).toBe(false);
    // The generated index.md is deleted, not kept in the trash.
    expect(await exists("wiki/trash/guidelines/index.md.orig")).toBe(false);
  });

  it("keeps trashed concepts out of the wiki's concept set", async () => {
    await seedWiki();
    await removeFromWiki(workdir, "project/foo.md", "2026-08-01");
    const concepts = await loadAllConcepts(join(workdir, "wiki"));

    expect(concepts.success && concepts.data.map((c) => c.conceptId).sort()).toEqual([
      "guidelines/rules",
      "project/bar",
    ]);
  });

  it("removes a directory target with every concept below it", async () => {
    await seedWiki();
    await writeConcept("project/nested/deep.md", "type: note", "# Deep");
    const result = await removeFromWiki(workdir, "project", "2026-08-01");

    expect(result.success && result.data.removed.map((r) => r.conceptId)).toEqual([
      "project/bar",
      "project/foo",
      "project/nested/deep",
    ]);
    expect(await exists("wiki/project")).toBe(false);
    expect(await exists("wiki/trash/project/nested/deep.md.orig")).toBe(true);
  });

  it("regenerates index.md immediately", async () => {
    await seedWiki();
    await removeFromWiki(workdir, "project/foo.md", "2026-08-01");

    expect(await read("wiki/project/index.md")).not.toContain("foo.md");
    expect(await read("wiki/project/index.md")).toContain("bar.md");
    expect(await read("wiki/index.md")).toContain("okf_version");
  });

  it("appends a Removal entry to log.md that links into the trash", async () => {
    await seedWiki();
    await removeFromWiki(workdir, "project/foo.md", "2026-08-01");

    const log = await read("wiki/log.md");
    expect(log).toContain("## 2026-08-01");
    expect(log).toContain("* **Removal**: Removed [project/foo](/trash/project/foo.md.orig).");
  });

  it("keeps the removal entry even when log.md has a foreign heading", async () => {
    await seedWiki();
    await writeFile(join(workdir, "wiki", "log.md"), "# Change Log\n\nhand-written\n", "utf8");
    await removeFromWiki(workdir, "project/foo.md", "2026-08-01");

    const log = await read("wiki/log.md");
    expect(log).toContain("* **Removal**: Removed [project/foo]");
    // The existing content is preserved, not overwritten.
    expect(log).toContain("hand-written");
  });

  it("separates the new entry from the previous one with a blank line", async () => {
    await seedWiki();
    await removeFromWiki(workdir, "project/foo.md", "2026-08-01");
    await removeFromWiki(workdir, "project/bar.md", "2026-08-02");

    expect(await read("wiki/log.md")).toContain(
      "* **Removal**: Removed [project/bar](/trash/project/bar.md.orig).\n\n## 2026-08-01",
    );
  });

  it("keeps earlier log entries pointing at the original path", async () => {
    await seedWiki();
    await writeFile(
      join(workdir, "wiki", "log.md"),
      "# Wiki Update Log\n\n## 2026-07-01\n\n* **Creation**: Added [project/foo](/project/foo.md).\n",
      "utf8",
    );
    await removeFromWiki(workdir, "project/foo.md", "2026-08-01");

    expect(await read("wiki/log.md")).toContain(
      "* **Creation**: Added [project/foo](/project/foo.md).",
    );
  });

  it("never overwrites an existing trash entry", async () => {
    await seedWiki();
    await removeFromWiki(workdir, "project/foo.md", "2026-08-01");
    await writeConcept("project/foo.md", "type: note\ntitle: Foo again", "# Foo again");
    const second = await removeFromWiki(workdir, "project/foo.md", "2026-08-02");

    expect(second.success).toBe(true);
    if (!second.success) return;
    // Both versions survive, each at its own path, and the second removal's
    // reported path is the one that actually holds the second version.
    const secondPath = second.data.removed[0]!.trashPath;
    expect(secondPath).not.toBe("/trash/project/foo.md.orig");
    expect(await read("wiki/trash/project/foo.md.orig")).toContain("# Foo\n");
    expect(await read(`wiki${secondPath}`)).toContain("# Foo again");
    expect(await read("wiki/log.md")).toContain(`(${secondPath})`);
  });

  it("rewrites concepts in a directory that is merely NAMED trash", async () => {
    await writeConcept("project/foo.md", "type: note", "# Foo");
    await writeConcept("project/trash/notes.md", "type: note", "See [Foo](/project/foo.md).");
    const result = await removeFromWiki(workdir, "project/foo.md", "2026-08-01");

    expect(result.success && result.data.rewrittenConcepts).toEqual(["project/trash/notes"]);
    expect(await read("wiki/project/trash/notes.md")).toContain(
      "[Foo](/trash/project/foo.md.orig)",
    );
  });

  it("leaves archived ingest originals untouched", async () => {
    await seedWiki();
    await mkdir(join(workdir, "wiki", "archive"), { recursive: true });
    await writeFile(join(workdir, "wiki", "archive", "foo.md.orig"), "original", "utf8");
    await removeFromWiki(workdir, "project/foo.md", "2026-08-01");

    expect(await read("wiki/archive/foo.md.orig")).toBe("original");
  });

  it("refuses to remove generated files", async () => {
    await seedWiki();
    const index = await removeFromWiki(workdir, "project/index.md", "2026-08-01");
    const log = await removeFromWiki(workdir, "log.md", "2026-08-01");

    expect(index.success).toBe(false);
    expect(log.success).toBe(false);
  });

  it("refuses targets outside the wiki and inside archive/ or trash/", async () => {
    await seedWiki();
    for (const target of ["../secret.md", "/etc/passwd", "archive", "trash/x.md"]) {
      expect((await removeFromWiki(workdir, target, "2026-08-01")).success).toBe(false);
    }
  });

  it("accepts a wiki/-prefixed target", async () => {
    await seedWiki();
    const result = await removeFromWiki(workdir, "wiki/project/foo.md", "2026-08-01");
    expect(result.success).toBe(true);
  });

  it("leaves the wiki untouched when nothing can be moved", async () => {
    await seedWiki();
    // A read-only trash makes every move fail before anything is rewritten.
    await mkdir(join(workdir, "wiki", "trash"), { recursive: true });
    await chmod(join(workdir, "wiki", "trash"), 0o500);

    const result = await removeFromWiki(workdir, "project/foo.md", "2026-08-01");
    await chmod(join(workdir, "wiki", "trash"), 0o700);

    expect(result.success).toBe(false);
    expect(await exists("wiki/project/foo.md")).toBe(true);
    expect(await read("wiki/project/bar.md")).toContain("[Foo](/project/foo.md)");
    expect(await exists("wiki/log.md")).toBe(false);
  });

  it("fails when the target does not exist", async () => {
    await seedWiki();
    expect((await removeFromWiki(workdir, "project/ghost.md", "2026-08-01")).success).toBe(false);
  });
});

describe("planRemoval", () => {
  it("lists the concepts, the directories that would vanish, and incoming links", async () => {
    await seedWiki();
    const plan = await planRemoval(workdir, "project/foo.md");

    expect(plan.success).toBe(true);
    if (!plan.success) return;
    expect(plan.data.conceptIds).toEqual(["project/foo"]);
    expect(plan.data.directories).toEqual([]);
    expect(plan.data.incomingLinks).toEqual([
      { fromConceptId: "guidelines/rules", toConceptId: "project/foo" },
      { fromConceptId: "project/bar", toConceptId: "project/foo" },
    ]);
  });

  it("reports the directory when its last concept would go", async () => {
    await seedWiki();
    const plan = await planRemoval(workdir, "guidelines/rules.md");

    expect(plan.success && plan.data.directories).toEqual(["guidelines"]);
  });

  it("does not promise a directory disappears when a non-concept file stays", async () => {
    await seedWiki();
    await writeFile(join(workdir, "wiki", "guidelines", "diagram.png"), "binary", "utf8");
    const plan = await planRemoval(workdir, "guidelines/rules.md");

    expect(plan.success && plan.data.directories).toEqual([]);
  });

  it("lists a repeated link once — the dialog shows relationships, not hits", async () => {
    await writeConcept("project/foo.md", "type: note", "# Foo");
    await writeConcept(
      "project/bar.md",
      "type: note",
      "See [Foo](/project/foo.md) and again [Foo](/project/foo.md).",
    );
    const plan = await planRemoval(workdir, "project/foo.md");

    expect(plan.success && plan.data.incomingLinks).toEqual([
      { fromConceptId: "project/bar", toConceptId: "project/foo" },
    ]);
  });

  it("announces a concept that references the target only via sources[].resource", async () => {
    await writeConcept("project/foo.md", "type: note", "# Foo");
    await writeConcept(
      "zitierer.md",
      "type: note\nsources:\n  - id: foo\n    resource: /project/foo.md",
      "body ohne jeden Link",
    );
    const plan = await planRemoval(workdir, "project/foo.md");

    expect(plan.success && plan.data.incomingLinks).toEqual([
      { fromConceptId: "zitierer", toConceptId: "project/foo" },
    ]);

    const report = await removeFromWiki(workdir, "project/foo.md", "2026-08-01");
    expect(report.success && report.data.rewrittenConcepts).toEqual(["zitierer"]);
  });

  it("resolves a relative sources[].resource against the citing concept", async () => {
    await writeConcept("project/foo.md", "type: note", "# Foo");
    await writeConcept(
      "project/bar.md",
      "type: note\nsources:\n  - id: foo\n    resource: ./foo.md",
      "body",
    );
    const plan = await planRemoval(workdir, "project/foo.md");

    expect(plan.success && plan.data.incomingLinks).toEqual([
      { fromConceptId: "project/bar", toConceptId: "project/foo" },
    ]);
  });

  it("lists a concept once when it references the target in body AND frontmatter", async () => {
    await writeConcept("project/foo.md", "type: note", "# Foo");
    await writeConcept(
      "project/bar.md",
      "type: note\nsources:\n  - id: foo\n    resource: /project/foo.md",
      "See [Foo](/project/foo.md).",
    );
    const plan = await planRemoval(workdir, "project/foo.md");

    expect(plan.success && plan.data.incomingLinks).toEqual([
      { fromConceptId: "project/bar", toConceptId: "project/foo" },
    ]);
  });

  it("does not touch the wiki", async () => {
    await seedWiki();
    await planRemoval(workdir, "project/foo.md");

    expect(await exists("wiki/project/foo.md")).toBe(true);
    expect(await exists("wiki/trash")).toBe(false);
  });
});
