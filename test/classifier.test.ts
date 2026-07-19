import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cleanExtractionTemp } from "../src/extract/service.ts";
import { createClassifier } from "../src/classifier.ts";
import { wikiPaths } from "../src/wiki.ts";
import type { InputFile } from "../src/types.ts";

let workdir: string;
let inputRoot: string;
let wikiRoot: string;
let archiveRoot: string;

beforeEach(async () => {
  workdir = join(tmpdir(), `okf-cls-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  inputRoot = join(workdir, "input");
  wikiRoot = join(workdir, "wiki");
  archiveRoot = join(workdir, "wiki", "archive");
  // The classifier writes conformant content to wiki/ and moves originals to
  // wiki/archive/ (archive lives INSIDE the OKF bundle so `/archive/<rel>`
  // citation links resolve bundle-relative), so those dirs must exist for the
  // import to succeed.
  await mkdir(inputRoot, { recursive: true });
  await mkdir(wikiRoot, { recursive: true });
  await mkdir(archiveRoot, { recursive: true });
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

async function writeInput(relativePath: string, content: string): Promise<InputFile> {
  const absolute = join(inputRoot, relativePath);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content);
  return {
    relativePath,
    absolutePath: absolute,
    classification: "non-conformant",
  };
}

function pathsOf(files: readonly InputFile[]): string[] {
  return files.map((file) => file.relativePath);
}

describe("InputClassifier", () => {
  it("sorts conformant, deferred, text-readable, and ignored files into the three buckets", async () => {
    const conformantMd = await writeInput(
      "notes/conformant.md",
      "---\ntype: note\ntitle: Conformant\n---\nbody\n",
    );
    const deferredMd = await writeInput("deferred.md", "# no frontmatter here");
    const textFile = await writeInput("plain.txt", "plain text body");
    const htmlFile = await writeInput("page.html", "<p>Hello extracted</p>");
    const reservedFile = await writeInput("index.md", "---\ntype: index\n---\nreserved\n");
    const unsupportedFile = await writeInput("thing.bin", "\x00\x01\x02");

    // cleanExtractionTemp once per run, as runUpdate does before classify.
    await cleanExtractionTemp(inputRoot);

    const classifier = createClassifier(wikiPaths(workdir));
    const result = await classifier.classify([
      conformantMd,
      deferredMd,
      textFile,
      htmlFile,
      reservedFile,
      unsupportedFile,
    ]);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const { conformantImported, forAgent, ignored } = result.data;

    // The conformant .md was deterministically imported: its concept id is
    // listed, the content was written under wiki/<relative-path>, and the
    // original was moved out of input/ into archive/<relative-path>.
    expect(conformantImported).toEqual(["notes/conformant"]);
    const { readFile } = await import("node:fs/promises");
    const wikiContent = await readFile(join(wikiRoot, "notes/conformant.md"), "utf8");
    expect(wikiContent).toContain("type: note");
    await expect(readFile(join(inputRoot, "notes/conformant.md"), "utf8")).rejects.toThrow();
    // Archived `.md` originals land with an outermost `.orig` suffix so they
    // are not concept documents per OKF §3.1 and the bundle stays conformant.
    const archivedContent = await readFile(join(archiveRoot, "notes/conformant.md.orig"), "utf8");
    expect(archivedContent).toContain("type: note");

    // forAgent order: non-md (txt, html) first, then deferred .md.
    expect(pathsOf(forAgent)).toEqual(["plain.txt", "page.html", "deferred.md"]);
    // The extractable html file gets an extractedTextPath staged.
    const htmlEntry = forAgent.find((file) => file.relativePath === "page.html");
    expect(htmlEntry?.extractedTextPath).toBeTruthy();
    expect(htmlEntry?.sourceFormat).toBe("html");
    // Text-readable file has no extractedTextPath.
    const txtEntry = forAgent.find((file) => file.relativePath === "plain.txt");
    expect(txtEntry?.extractedTextPath).toBeUndefined();

    // ignored order: reserved/unsupported first, then extraction failures.
    expect(ignored.map((entry) => ({ path: entry.path, reason: entry.reason }))).toEqual([
      { path: "index.md", reason: "reserved" },
      { path: "thing.bin", reason: "unsupported" },
    ]);
  });

  it("routes a .md file whose frontmatter lacks a type into forAgent (deferred non-conformant)", async () => {
    const noType = await writeInput("no-type.md", "---\ntitle: Missing Type\n---\nbody\n");
    await cleanExtractionTemp(inputRoot);
    const result = await createClassifier(wikiPaths(workdir)).classify([noType]);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.conformantImported).toEqual([]);
    expect(pathsOf(result.data.forAgent)).toEqual(["no-type.md"]);
    expect(result.data.ignored).toEqual([]);
  });

  it("routes an extraction failure into ignored with the stable cause", async () => {
    const missingHtml: InputFile = {
      relativePath: "missing.html",
      absolutePath: join(inputRoot, "missing.html"),
      classification: "non-conformant",
    };
    await cleanExtractionTemp(inputRoot);
    const result = await createClassifier(wikiPaths(workdir)).classify([missingHtml]);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.forAgent).toEqual([]);
    expect(result.data.conformantImported).toEqual([]);
    expect(result.data.ignored).toEqual([
      { path: "missing.html", reason: "extraction_failed", detail: expect.any(String) },
    ]);
  });

  it("imports a conformant .md into wiki/ and archives the original in input order", async () => {
    const conformantMd = await writeInput(
      "concepts/alpha.md",
      "---\ntype: concept\ntitle: Alpha\n---\nalpha body\n",
    );
    await cleanExtractionTemp(inputRoot);

    const result = await createClassifier(wikiPaths(workdir)).classify([conformantMd]);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const { conformantImported, forAgent, ignored } = result.data;

    expect(conformantImported).toEqual(["concepts/alpha"]);
    expect(forAgent).toEqual([]);
    expect(ignored).toEqual([]);

    const { readFile } = await import("node:fs/promises");
    const wikiContent = await readFile(join(wikiRoot, "concepts/alpha.md"), "utf8");
    expect(wikiContent).toBe("---\ntype: concept\ntitle: Alpha\n---\nalpha body\n");
    await expect(readFile(join(inputRoot, "concepts/alpha.md"), "utf8")).rejects.toThrow();
    const archivedContent = await readFile(join(archiveRoot, "concepts/alpha.md.orig"), "utf8");
    expect(archivedContent).toBe("---\ntype: concept\ntitle: Alpha\n---\nalpha body\n");
  });

  it("ignores a .md pointing at a missing path with reason io_failed", async () => {
    const missingMd: InputFile = {
      relativePath: "missing.md",
      absolutePath: join(inputRoot, "does-not-exist.md"),
      classification: "non-conformant",
    };
    await cleanExtractionTemp(inputRoot);

    const result = await createClassifier(wikiPaths(workdir)).classify([missingMd]);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const { conformantImported, forAgent, ignored } = result.data;

    expect(conformantImported).toEqual([]);
    expect(forAgent).toEqual([]);
    expect(ignored).toEqual([
      { path: "missing.md", reason: "io_failed", detail: expect.any(String) },
    ]);
  });
});