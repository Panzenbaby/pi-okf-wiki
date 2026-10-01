import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyAgentImageOutcomes,
  imagesMissingFinding,
  parseAgentImageOutcomes,
  summarizeDocumentImages,
} from "../src/image-analysis/completeness.ts";
import type { StagedImage } from "../src/types.ts";
import { aggregateWarnings } from "../src/warnings.ts";
import { appendLogMd } from "../src/wiki/index-log.ts";

function image(id: string, status: StagedImage["status"], occurrences = 1): StagedImage {
  return {
    id,
    mediaType: "image/png",
    byteLength: 1000,
    sha256: id,
    occurrences: Array.from({ length: occurrences }, (_, index) => ({ location: `Page ${index + 1}` })),
    status,
  };
}

let workdir: string;

beforeEach(async () => {
  workdir = join(tmpdir(), `okf-completeness-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(workdir, { recursive: true });
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("agent image outcomes", () => {
  it("parses outcome lines with or without a document path", () => {
    const outcomes = parseAgentImageOutcomes([
      "## Image outcomes",
      "- reports/q3.docx img-07: content — revenue by quarter",
      "* `input/reports/q3.docx` `img-08`: **decorative**",
      "- img-09 — unreadable: blurred",
      "- img-10 is interesting",
    ].join("\n"));
    expect(outcomes).toEqual([
      { documentPath: "reports/q3.docx", id: "img-07", classification: "content", note: "revenue by quarter" },
      { documentPath: "reports/q3.docx", id: "img-08", classification: "decorative", note: "" },
      { documentPath: "", id: "img-09", classification: "unreadable", note: "blurred" },
    ]);
  });

  it("applies outcomes only to images still awaiting the agent", () => {
    const documents = [
      { relativePath: "reports/q3.docx", images: [image("img-07", "failed"), image("img-08", "staged"), image("img-09", "analyzed")] },
      { relativePath: "other.pdf", images: [image("img-07", "staged")] },
    ];
    const resolved = applyAgentImageOutcomes(documents, parseAgentImageOutcomes([
      "- reports/q3.docx img-07: content — chart",
      "- reports/q3.docx img-09: unreadable",
      // Without a document path an outcome applies only when its ID awaits in exactly one document.
      "- img-08: decorative",
      "- img-07: decorative",
    ].join("\n")));
    expect(resolved[0]?.images.map((entry) => entry.status)).toEqual(["analyzed", "decorative", "analyzed"]);
    expect(resolved[1]?.images[0]?.status).toBe("staged");
  });
});

describe("image completeness summary", () => {
  it("counts every status and lists IDs missing a finding", () => {
    const document = {
      relativePath: "reports/q3.docx",
      images: [image("img-01", "analyzed", 2), image("img-02", "decorative", 3), image("img-03", "broken"), image("img-04", "failed"), image("img-05", "staged")],
    };
    expect(imagesMissingFinding(document.images)).toEqual(["img-04", "img-05"]);
    expect(summarizeDocumentImages(document)).toBe(
      "reports/q3.docx: 8 occurrence(s), 5 unique — staged 1, analyzed 1, decorative 1, unreadable 0, broken 1, failed 1; missing findings: img-04, img-05",
    );
  });

  it("writes one Images line per document and aggregates repeated warnings in log.md", async () => {
    const repeated = Array.from({ length: 17 }, () => "report.docx: DOCX: skipped embedded images after the 24-image limit.");
    const result = await appendLogMd(workdir, "2026-10-01", { created: ["notes/report"], updated: [] }, [...repeated, "Other warning"], [
      "report.docx: 41 occurrence(s), 39 unique — staged 0, analyzed 38, decorative 1, unreadable 0, broken 0, failed 0; missing findings: none",
    ]);
    expect(result.success).toBe(true);
    const log = await readFile(join(workdir, "log.md"), "utf8");
    expect(log).toContain("* **Images**: report.docx: 41 occurrence(s), 39 unique");
    expect(log.match(/24-image limit/g)).toHaveLength(1);
    expect(log).toContain("after the 24-image limit. (×17)");
    expect(log).toContain("* **Warning**: Other warning");
  });
});

describe("aggregateWarnings", () => {
  it("collapses duplicates with a count, keeps first-occurrence order, and is idempotent", () => {
    const once = aggregateWarnings(["b", "a", "b ", "  b", "c", "a"]);
    expect(once).toEqual(["b (×3)", "a (×2)", "c"]);
    expect(aggregateWarnings([...once, "b"])).toEqual(["b (×4)", "a (×2)", "c"]);
  });
});
