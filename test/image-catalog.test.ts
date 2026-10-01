import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { catalogEmbeddedImages, extractToTempFile } from "../src/extract/service.ts";
import { pathExists } from "../src/files.ts";
import { createChartPng, createChartRgb, createUniformPng, encodeRgbPngAsRgba } from "./support/images.ts";

let workdir: string;

beforeEach(async () => {
  workdir = join(tmpdir(), `okf-catalog-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(workdir, { recursive: true });
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("catalogEmbeddedImages", () => {
  it("deduplicates identical bytes by SHA-256 and keeps every location", () => {
    const chart = createChartPng(200, 120, 1);
    const other = createChartPng(200, 120, 2);
    const catalog = catalogEmbeddedImages([
      { data: chart, mediaType: "image/png", location: "Page 1", context: "Revenue" },
      { data: other, mediaType: "image/png", location: "Page 2" },
      { data: Buffer.from(chart), mediaType: "image/png", location: "Page 3", context: "Revenue again" },
    ], "pdf");
    expect(catalog.duplicates).toBe(1);
    expect(catalog.images.map((entry) => entry.record.id)).toEqual(["img-01", "img-02"]);
    expect(catalog.images[0]?.record.occurrences).toEqual([
      { location: "Page 1", context: "Revenue" },
      { location: "Page 3", context: "Revenue again" },
    ]);
    expect(catalog.images.every((entry) => entry.record.status === "staged")).toBe(true);
  });

  it("records tiny images as decorative and broken extractions as broken", () => {
    const catalog = catalogEmbeddedImages([
      { data: createUniformPng(1, 1, 0), mediaType: "image/png", location: "Section A" },
      { data: encodeRgbPngAsRgba(createChartRgb(320, 200, 1)), mediaType: "image/png", location: "Page 2" },
      { data: createChartPng(320, 200, 1), mediaType: "image/png", location: "Page 3" },
    ], "docx");
    const [tiny, broken, content] = catalog.images.map((entry) => entry.record);
    expect(tiny?.status).toBe("decorative");
    expect(tiny?.statusReason).toContain("tiny image (1×1 px)");
    expect(broken?.status).toBe("broken");
    expect(broken?.statusReason).toContain("incoherent pixel neighbourhoods");
    expect(content?.status).toBe("staged");
    expect(content?.width).toBe(320);
  });
});

describe("extractToTempFile image staging", () => {
  it("writes only analyzable images, reports statistics, and plans a findings file", async () => {
    const chart = createChartPng(160, 100, 1).toString("base64");
    const tiny = createUniformPng(2, 2, 0).toString("base64");
    const html = `<h2>Sales</h2><p>Revenue chart</p><img alt="Revenue" src="data:image/png;base64,${chart}"/>`
      + `<img alt="Spacer" src="data:image/png;base64,${tiny}"/><p>Again</p><img alt="Revenue copy" src="data:image/png;base64,${chart}"/>`;
    const source = join(workdir, "input", "report.html");
    await mkdir(join(workdir, "input"), { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(source, html);
    const result = await extractToTempFile(join(workdir, "input"), "report.html", source);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.imageStatistics).toMatchObject({ occurrences: 3, unique: 2, duplicates: 1, tiny: 1, broken: 0, staged: 1 });
    const [staged, decorative] = result.data.embeddedImages;
    expect(staged?.occurrences).toHaveLength(2);
    expect(staged?.path).toBeDefined();
    expect(await readFile(staged?.path ?? "")).toEqual(createChartPng(160, 100, 1));
    expect(decorative?.status).toBe("decorative");
    expect(decorative?.path).toBeUndefined();
    expect(result.data.imageFindingsPath).toBe(join(workdir, "input", ".okf-extract", "report-image-findings.txt"));
    expect(await pathExists(result.data.imageFindingsPath ?? "")).toBe(false);
  });
});
