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
