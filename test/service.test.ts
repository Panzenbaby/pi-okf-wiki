import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  archiveExtractedText,
  cleanExtractionTemp,
  cleanupExtractionTemp,
  extractToTempFile,
} from "../extract/service.ts";
import { pathExists } from "../files.ts";
import { resolveArchiveTarget } from "../files.ts";

let workdir: string;
let inputRoot: string;
let archiveDir: string;

beforeEach(async () => {
  workdir = join(tmpdir(), `okf-svc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  inputRoot = join(workdir, "input");
  archiveDir = join(workdir, "archive");
  await mkdir(inputRoot, { recursive: true });
  await mkdir(archiveDir, { recursive: true });
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

async function writeHtml(relativePath: string, html: string): Promise<string> {
  const absolute = join(inputRoot, relativePath);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, html);
  return absolute;
}

async function writeOdt(relativePath: string, text: string): Promise<string> {
  const absolute = join(inputRoot, relativePath);
  await mkdir(join(absolute, ".."), { recursive: true });
  const zip = new JSZip();
  zip.file("content.xml", `<?xml version="1.0"?><office:text><text:p>${text}</text:p></office:text>`);
  await writeFile(absolute, await zip.generateAsync({ type: "nodebuffer" }));
  return absolute;
}

describe("extractToTempFile", () => {
  it("writes the extracted text to input/.okf-extract mirroring the path", async () => {
    const absolute = await writeHtml("notes/foo.html", "<p>Hello extracted</p>");
    const result = await extractToTempFile(inputRoot, "notes/foo.html", absolute);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.sourceFormat).toBe("html");
    expect(result.data.tempRelativeName).toBe("notes/foo-extracted.txt");
    expect(result.data.extractedTextPath).toBe(join(inputRoot, ".okf-extract", "notes/foo-extracted.txt"));
    expect(await pathExists(result.data.extractedTextPath)).toBe(true);
    const { readFile } = await import("node:fs/promises");
    const written = await readFile(result.data.extractedTextPath, "utf8");
    expect(written).toContain("Hello extracted");
  });

  it("disambiguates same-stem-different-extension files in the same directory", async () => {
    const htmlAbs = await writeHtml("dir/foo.html", "<p>HTML one</p>");
    const odtAbs = await writeOdt("dir/foo.odt", "ODT one");
    const first = await extractToTempFile(inputRoot, "dir/foo.html", htmlAbs);
    const second = await extractToTempFile(inputRoot, "dir/foo.odt", odtAbs);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (!first.success || !second.success) return;
    expect(first.data.tempRelativeName).toBe("dir/foo-extracted.txt");
    expect(second.data.tempRelativeName).toBe("dir/foo.odt-extracted.txt");
    expect(await pathExists(join(inputRoot, ".okf-extract", first.data.tempRelativeName))).toBe(true);
    expect(await pathExists(join(inputRoot, ".okf-extract", second.data.tempRelativeName))).toBe(true);
  });

  it("propagates extraction failures with a stable cause", async () => {
    const result = await extractToTempFile(inputRoot, "missing.html", join(inputRoot, "missing.html"));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.cause).toBe("extraction_failed");
  });
});

describe("extraction temp lifecycle", () => {
  it("cleanExtractionTemp removes a stale temp dir", async () => {
    await mkdir(join(inputRoot, ".okf-extract", "leftover"), { recursive: true });
    await writeFile(join(inputRoot, ".okf-extract", "leftover", "x-extracted.txt"), "stale");
    const result = await cleanExtractionTemp(inputRoot);
    expect(result.success).toBe(true);
    expect(await pathExists(join(inputRoot, ".okf-extract"))).toBe(false);
  });

  it("archiveExtractedText copies the temp text to a collision-free archive path", async () => {
    const absolute = await writeHtml("top.html", "<p>Archive me</p>");
    const extracted = await extractToTempFile(inputRoot, "top.html", absolute);
    if (!extracted.success) return;
    const archiveResult = await archiveExtractedText(
      inputRoot,
      archiveDir,
      extracted.data.tempRelativeName,
      resolveArchiveTarget,
    );
    expect(archiveResult.success).toBe(true);
    expect(await pathExists(join(archiveDir, "top-extracted.txt"))).toBe(true);

    // cleanup removes the temp dir afterward.
    const cleanup = await cleanupExtractionTemp(inputRoot);
    expect(cleanup.success).toBe(true);
    expect(await pathExists(join(inputRoot, ".okf-extract"))).toBe(false);
    // archive copy still present after cleanup.
    expect(await pathExists(join(archiveDir, "top-extracted.txt"))).toBe(true);
  });
});