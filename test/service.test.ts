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
} from "../src/extract/service.ts";
import { pathExists } from "../src/files.ts";
import { createChartPng } from "./support/images.ts";

const firstPng = createChartPng(120, 80, 1);
const secondPng = createChartPng(120, 80, 2);
const dataUri = (png: Buffer): string => `data:image/png;base64,${png.toString("base64")}`;
import { resolveArchiveTarget } from "../src/files.ts";

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
    expect(result.data.embeddedImages).toEqual([]);
    expect(result.data.tempRelativeNames).toEqual(["notes/foo-extracted.txt"]);
    const [textPath = ""] = result.data.extractedTextPaths;
    expect(textPath).toBe(join(inputRoot, ".okf-extract", "notes/foo-extracted.txt"));
    expect(await pathExists(textPath)).toBe(true);
    const { readFile } = await import("node:fs/promises");
    const written = await readFile(textPath, "utf8");
    expect(written).toContain("Hello extracted");
  });

  it("stages one numbered file per part when the extractor splits a source", async () => {
    const lines: string[] = [];
    for (let index = 1; index <= 2100; index++) lines.push(`{"n":${index}}`);
    const absolute = join(inputRoot, "logs/events.jsonl");
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, `${lines.join("\n")}\n`);

    const result = await extractToTempFile(inputRoot, "logs/events.jsonl", absolute);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.tempRelativeNames).toEqual([
      "logs/events-extracted.part01.txt",
      "logs/events-extracted.part02.txt",
      "logs/events-extracted.part03.txt",
    ]);
    for (const path of result.data.extractedTextPaths) {
      expect(await pathExists(path)).toBe(true);
    }
  });

  it("disambiguates same-stem-different-extension files in the same directory", async () => {
    const htmlAbs = await writeHtml("dir/foo.html", "<p>HTML one</p>");
    const odtAbs = await writeOdt("dir/foo.odt", "ODT one");
    const first = await extractToTempFile(inputRoot, "dir/foo.html", htmlAbs);
    const second = await extractToTempFile(inputRoot, "dir/foo.odt", odtAbs);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (!first.success || !second.success) return;
    expect(first.data.tempRelativeNames).toEqual(["dir/foo-extracted.txt"]);
    expect(second.data.tempRelativeNames).toEqual(["dir/foo.odt-extracted.txt"]);
    for (const name of [...first.data.tempRelativeNames, ...second.data.tempRelativeNames]) {
      expect(await pathExists(join(inputRoot, ".okf-extract", name))).toBe(true);
    }
  });

  it("keeps same-stem documents' embedded image paths and bytes distinct", async () => {
    const firstSource = await writeHtml(
      "figures/report.html",
      `<p>First report</p><img alt="First" src="${dataUri(firstPng)}"/>`,
    );
    const secondSource = await writeHtml(
      "figures/report.htm",
      `<p>Second report</p><img alt="Second" src="${dataUri(secondPng)}"/>`,
    );
    const first = await extractToTempFile(inputRoot, "figures/report.html", firstSource);
    const second = await extractToTempFile(inputRoot, "figures/report.htm", secondSource);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (!first.success || !second.success) return;

    const firstImage = first.data.embeddedImages[0];
    const secondImage = second.data.embeddedImages[0];
    expect(firstImage).toBeDefined();
    expect(secondImage).toBeDefined();
    if (firstImage === undefined || secondImage === undefined) return;
    expect(firstImage.path).not.toBe(secondImage.path);

    const { readFile } = await import("node:fs/promises");
    expect(await readFile(firstImage.path ?? "")).toEqual(firstPng);
    expect(await readFile(secondImage.path ?? "")).toEqual(secondPng);
    expect(firstImage.path).toContain("figures/report.html-embedded-image-01.png");
    expect(secondImage.path).toContain("figures/report.htm-embedded-image-01.png");
  });

  it("stages embedded images separately and preserves the original as archive source", async () => {
    const absolute = await writeHtml(
      "figures/chart.html",
      `<p>Chart</p><img alt="Signups" src="${dataUri(firstPng)}"/>`,
    );
    const result = await extractToTempFile(inputRoot, "figures/chart.html", absolute);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.embeddedImages).toHaveLength(1);
    const image = result.data.embeddedImages[0];
    expect(image?.id).toBe("img-01");
    expect(image?.status).toBe("staged");
    expect(image?.path).toContain("chart.html-embedded-image-01.png");
    expect(image?.occurrences[0]?.context).toContain("Signups");
    expect(result.data.imageFindingsRelativeName).toBe("figures/chart-image-findings.txt");
    expect(await pathExists(absolute)).toBe(true);
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
      extracted.data.tempRelativeNames,
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