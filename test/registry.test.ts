import { describe, expect, it } from "vitest";

import {
  EXTRACTABLE_EXTENSIONS,
  IMAGE_EXTENSIONS,
  TEXT_READABLE_EXTENSIONS,
  extractorForExtension,
} from "../src/extract/registry.ts";

describe("extractor registry", () => {
  it("registers every extractable format", () => {
    for (const extension of [
      ".pdf",
      ".docx",
      ".xlsx",
      ".pptx",
      ".odt",
      ".epub",
      ".html",
      ".htm",
      ".rtf",
    ]) {
      expect(EXTRACTABLE_EXTENSIONS, `missing ${extension}`).toContain(extension);
    }
  });

  it("classifies plain-text and image formats separately", () => {
    expect([...TEXT_READABLE_EXTENSIONS]).toEqual([".txt", ".csv", ".json"]);
    expect([...IMAGE_EXTENSIONS]).toEqual([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
  });

  it("dispatches by extension (case-insensitive) to the right format id", () => {
    const cases: ReadonlyArray<[string, string]> = [
      [".pdf", "pdf"],
      [".PDF", "pdf"],
      [".docx", "docx"],
      [".xlsx", "xlsx"],
      [".pptx", "pptx"],
      [".odt", "odt"],
      [".epub", "epub"],
      [".html", "html"],
      [".htm", "html"],
      [".rtf", "rtf"],
    ];
    for (const [extension, format] of cases) {
      const repository = extractorForExtension(extension);
      expect(repository, `no repo for ${extension}`).toBeDefined();
      expect(repository?.sourceFormat).toBe(format);
    }
  });

  it("returns undefined for unknown extensions", () => {
    expect(extractorForExtension(".doc")).toBeUndefined();
    expect(extractorForExtension(".zip")).toBeUndefined();
  });
});