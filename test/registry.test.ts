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
      ".ods",
      ".odp",
      ".epub",
      ".html",
      ".htm",
      ".rtf",
      ".jsonl",
      ".ndjson",
      ".ipynb",
    ]) {
      expect(EXTRACTABLE_EXTENSIONS, `missing ${extension}`).toContain(extension);
    }
  });

  it("classifies plain-text and image formats separately", () => {
    for (const extension of [
      ".txt",
      ".csv",
      ".tsv",
      ".json",
      ".dsl",
      ".mmd",
      ".mermaid",
      ".puml",
      ".plantuml",
      ".dot",
      ".gv",
      ".yaml",
      ".yml",
      ".toml",
      ".rst",
      ".adoc",
      ".asciidoc",
      ".org",
    ]) {
      expect(TEXT_READABLE_EXTENSIONS, `missing ${extension}`).toContain(extension);
    }
    expect([...IMAGE_EXTENSIONS]).toEqual([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
  });

  it("keeps machine-noise formats out of the taxonomy entirely", () => {
    // Deliberate exclusions: these are almost never knowledge worth indexing,
    // and leaving them `unsupported` is a more useful signal than ingesting them.
    for (const extension of [".xml", ".ini", ".log", ".mdx", ".doc", ".xls", ".ppt"]) {
      expect(TEXT_READABLE_EXTENSIONS, `unexpected ${extension}`).not.toContain(extension);
      expect(EXTRACTABLE_EXTENSIONS, `unexpected ${extension}`).not.toContain(extension);
    }
  });

  it("routes .jsonl and .json to different buckets despite the shared suffix", () => {
    // `matchesAny` compares with endsWith, so a bucket mix-up here would be silent.
    expect(TEXT_READABLE_EXTENSIONS).toContain(".json");
    expect(TEXT_READABLE_EXTENSIONS).not.toContain(".jsonl");
    expect(extractorForExtension(".json")).toBeUndefined();
    expect("data.jsonl".endsWith(".json")).toBe(false);
  });

  it("dispatches by extension (case-insensitive) to the right format id", () => {
    const cases: ReadonlyArray<[string, string]> = [
      [".pdf", "pdf"],
      [".PDF", "pdf"],
      [".docx", "docx"],
      [".xlsx", "xlsx"],
      [".pptx", "pptx"],
      [".odt", "odt"],
      [".ods", "ods"],
      [".odp", "odp"],
      [".epub", "epub"],
      [".html", "html"],
      [".htm", "html"],
      [".rtf", "rtf"],
      [".jsonl", "jsonl"],
      [".ndjson", "jsonl"],
      [".JSONL", "jsonl"],
      [".ipynb", "ipynb"],
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