import { mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { rewriteArchiveCitationsInConcepts } from "../src/update.ts";

let workdir: string;

beforeEach(async () => {
  workdir = join(
    tmpdir(),
    `okf-archive-links-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(workdir, { recursive: true });
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

async function writeConcept(relativePath: string, content: string): Promise<void> {
  const absolute = join(workdir, relativePath);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

async function readConcept(relativePath: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(join(workdir, relativePath), "utf8");
}

describe("rewriteArchiveCitationsInConcepts", () => {
  it("rewrites placeholder links in agent-written concepts to the renamed archive path", async () => {
    await writeConcept(
      "tables/orders.md",
      `---\ntype: table\ntitle: Orders\n---\n\n# Citations\n\n- [spec v2](/archive/notes/spec-v2.pdf)\n`,
    );
    const warnings = await rewriteArchiveCitationsInConcepts(
      workdir,
      new Set(["tables/orders"]),
      new Map([["notes/spec-v2.pdf", "notes/spec-v2.2026-07-19-1719.pdf"]]),
    );
    expect(warnings).toEqual([]);
    expect(await readConcept("tables/orders.md")).toContain(
      "[spec v2](/archive/notes/spec-v2.2026-07-19-1719.pdf)",
    );
    expect(await readConcept("tables/orders.md")).not.toContain(
      "/archive/notes/spec-v2.pdf)",
    );
  });

  it("leaves concepts untouched when no placeholder matches", async () => {
    const original = `---\ntype: table\n---\n\nno archive links here`;
    await writeConcept("tables/empty.md", original);
    const warnings = await rewriteArchiveCitationsInConcepts(
      workdir,
      new Set(["tables/empty"]),
      new Map([["a.md", "a.2026-07-19-1719.md"]]),
    );
    expect(warnings).toEqual([]);
    expect(await readConcept("tables/empty.md")).toBe(original);
  });

  it("only touches the concept ids passed in (the agent's writes), not other concepts", async () => {
    // A conformant-imported concept that the agent did NOT touch is simply not in
    // the passed set — so it is never read or rewritten. (The finalize caller
    // derives the set from a post-classification vs. post-agent snapshot.)
    const untouched = `---\ntype: t\n---\n\n[old](/archive/a.md)`;
    await writeConcept("t/other.md", untouched);
    await writeConcept(
      "t/touched.md",
      `---\ntype: t\n---\n\n[touch](/archive/a.md)`,
    );
    await rewriteArchiveCitationsInConcepts(
      workdir,
      new Set(["t/touched"]),
      new Map([["a.md", "a.2026-07-19-1719.md"]]),
    );
    expect(await readConcept("t/other.md")).toBe(untouched); // not passed -> unchanged
    expect(await readConcept("t/touched.md")).toContain(
      "[touch](/archive/a.2026-07-19-1719.md)",
    );
  });

  it("REWRITES a concept the agent updated even if it was also conformant-imported this run", async () => {
    // Regression for the old conformant-skip bug: if the agent updates a concept
    // id that the classifier also imported this run, the agent's placeholder
    // citations must still be rewritten. The new caller passes that id because
    // it appears in the post-classification vs. post-agent diff.
    await writeConcept(
      "imported/notes.md",
      `---\ntype: concept\n---\n\n[agent added](/archive/a.md)`,
    );
    await rewriteArchiveCitationsInConcepts(
      workdir,
      new Set(["imported/notes"]), // agent updated it -> in the set
      new Map([["a.md", "a.2026-07-19-1719.md"]]),
    );
    expect(await readConcept("imported/notes.md")).toContain(
      "[agent added](/archive/a.2026-07-19-1719.md)",
    );
  });

  it("handles nested concept ids (subdirectory paths)", async () => {
    await writeConcept(
      "domain/sub/concept.md",
      `# Citations\n\n- [x](/archive/dir/file.pdf)`,
    );
    await rewriteArchiveCitationsInConcepts(
      workdir,
      new Set(["domain/sub/concept"]),
      new Map([["dir/file.pdf", "dir/file.2026-07-19-1719.pdf"]]),
    );
    expect(await readConcept("domain/sub/concept.md")).toContain(
      "[x](/archive/dir/file.2026-07-19-1719.pdf)",
    );
  });

  it("returns a warning and leaves the file unchanged when the concept cannot be read", async () => {
    const warnings = await rewriteArchiveCitationsInConcepts(
      workdir,
      new Set(["does/not/exist"]),
      new Map([["a.md", "a.2026-07-19-1719.md"]]),
    );
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("Could not read");
  });

  it("returns a warning when writing the rewritten file fails (read-only file)", async () => {
    // Create a readable concept with a placeholder, then make it read-only so
    // the write-back fails. The rewrite is computed (placeholder matched) but
    // the write returns {success:false}, producing a "Could not write" warning.
    const path = "readonly/c.md";
    await writeConcept(
      path,
      `---\ntype: t\n---\n\n[x](/archive/a.md)`,
    );
    await chmod(join(workdir, path), 0o444);
    const warnings = await rewriteArchiveCitationsInConcepts(
      workdir,
      new Set(["readonly/c"]),
      new Map([["a.md", "a.2026-07-19-1719.md"]]),
    );
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("Could not write");
    // Restore perms so afterEach cleanup can remove it.
    await chmod(join(workdir, path), 0o644);
  });

  it("is a no-op for an empty archiveTargets mapping", async () => {
    const original = `---\ntype: t\n---\n\n[x](/archive/a.md)`;
    await writeConcept("t/c.md", original);
    const warnings = await rewriteArchiveCitationsInConcepts(
      workdir,
      new Set(["t/c"]),
      new Map(),
    );
    expect(warnings).toEqual([]);
    expect(await readConcept("t/c.md")).toBe(original);
  });

  it("does not rewrite placeholder links inside the frontmatter (resource: is canonical URI, out of scope)", async () => {
    // Per OKF §4.1 `resource:` holds a canonical URI; the prompt forbids archive
    // paths there. The rewriter touches the BODY only, so even a stray
    // `/archive/a.md` in `resource:` is left as-is rather than silently fixed.
    const original = `---\ntype: t\nresource: /archive/a.md\n---\n\n[x](/archive/a.md)`;
    await writeConcept("t/c.md", original);
    await rewriteArchiveCitationsInConcepts(
      workdir,
      new Set(["t/c"]),
      new Map([["a.md", "a.2026-07-19-1719.md"]]),
    );
    const after = await readConcept("t/c.md");
    expect(after).toContain("resource: /archive/a.md"); // frontmatter untouched
    expect(after).toContain("[x](/archive/a.2026-07-19-1719.md)"); // body rewritten
  });
});