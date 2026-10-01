import { describe, expect, it } from "vitest";

import { buildUpdatePrompt, type UpdatePromptInput } from "../src/prompts.ts";

function promptFor(files: UpdatePromptInput["inputFiles"]): string {
  return buildUpdatePrompt({
    inputFiles: files,
    archiveDir: "/w/wiki/archive",
    wikiDir: "/w/wiki",
    structure: { directories: [], types: [], conceptIds: [] },
  });
}

describe("buildUpdatePrompt file list", () => {
  it("points at the extracted text for a single-part extraction", () => {
    const prompt = promptFor([
      {
        relativePath: "notes/spec.pdf",
        absolutePath: "/w/input/notes/spec.pdf",
        archiveTarget: "/w/wiki/archive/notes/spec.pdf",
        extractedTextPaths: ["/w/input/.okf-extract/notes/spec-extracted.txt"],
        sourceFormat: "pdf",
      },
    ]);
    expect(prompt).toContain("READ extracted text: /w/input/.okf-extract/notes/spec-extracted.txt");
    expect(prompt).not.toContain("split into");
  });

  it("marks split parts as one source so the agent does not treat them as separate inputs", () => {
    const prompt = promptFor([
      {
        relativePath: "logs/events.jsonl",
        absolutePath: "/w/input/logs/events.jsonl",
        archiveTarget: "/w/wiki/archive/logs/events.jsonl",
        extractedTextPaths: [
          "/w/input/.okf-extract/logs/events-extracted.part01.txt",
          "/w/input/.okf-extract/logs/events-extracted.part02.txt",
        ],
        sourceFormat: "jsonl",
      },
    ]);
    expect(prompt).toContain("ONE source split into 2 ordered parts");
    expect(prompt).toContain("events-extracted.part01.txt");
    expect(prompt).toContain("events-extracted.part02.txt");
    // One prompt entry, and therefore one archive instruction, for the original.
    expect(prompt.split("logs/events.jsonl (").length - 1).toBe(1);
  });

  it("lists embedded images with location/context and records extraction limitations", () => {
    const prompt = promptFor([
      {
        relativePath: "reports/sales.pptx",
        absolutePath: "/w/input/reports/sales.pptx",
        archiveTarget: "/w/wiki/archive/reports/sales.pptx",
        extractedTextPaths: ["/w/input/.okf-extract/reports/sales-extracted.txt"],
        sourceFormat: "pptx",
        embeddedImages: [{
          id: "img-01",
          path: "/w/input/.okf-extract/reports/sales-embedded-image-01.png",
          mediaType: "image/png",
          byteLength: 2048,
          sha256: "a",
          occurrences: [{ location: "Slide 4", context: "Revenue overview" }],
          status: "failed",
        }, {
          id: "img-02",
          path: "/w/input/.okf-extract/reports/sales-embedded-image-02.png",
          mediaType: "image/png",
          byteLength: 2048,
          sha256: "b",
          occurrences: [{ location: "Slide 5" }],
          status: "analyzed",
          finding: { id: "img-02", classification: "content", description: "Bar chart", legibleValues: ["Q1: 10"], uncertainties: [] },
        }],
        imageFindingsPath: "/w/input/.okf-extract/reports/sales-image-findings.txt",
        extractionWarnings: ["pptx: skipped image beyond workload limit"],
      },
    ]);
    expect(prompt).toContain("Image findings (READ this file instead of the images): /w/input/.okf-extract/reports/sales-image-findings.txt");
    expect(prompt).toContain("img-01: /w/input/.okf-extract/reports/sales-embedded-image-01.png — Slide 4");
    expect(prompt).not.toContain("img-02: /w/input");
    expect(prompt).toContain("surrounding text: Revenue overview");
    expect(prompt).toContain("## Image outcomes");
    expect(prompt).toContain("record these in the update log");
    expect(prompt).toContain("Embedded images are temporary visual aids");
    expect(prompt).toContain("state unreadable content or uncertain context without guessing");
  });

  it("reads a plain-text file directly instead of an extract", () => {
    const prompt = promptFor([
      {
        relativePath: "board.dsl",
        absolutePath: "/w/input/board.dsl",
        archiveTarget: "/w/wiki/archive/board.dsl",
      },
    ]);
    expect(prompt).toContain("READ directly: /w/input/board.dsl");
  });
});
