// JsonLinesRepository — renders JSON Lines (.jsonl / .ndjson) as readable
// record blocks.
//
// Raw JSONL packs one whole record into a single very long line, which reads
// badly. Each record is therefore re-emitted pretty-printed under a `## Record
// <n>` heading. Unlike the other formats this one may return SEVERAL parts:
// JSONL is typically an export or log with far more records than fit in one
// readable file, so records are chunked and the extraction service stages each
// chunk as its own file.

import { readFile } from "node:fs/promises";

import { ok, type Result } from "../types.ts";
import type { ExtractedText, DocumentExtractorRepository } from "./types.ts";
import { extractionFailure, message } from "./util.ts";

/** Records per staged part. A part stays small enough for the agent to read whole. */
const MAX_RECORDS_PER_PART = 1000;

/** How many offending line numbers to name in the skipped-lines warning. */
const MAX_REPORTED_BAD_LINES = 10;

export class JsonLinesRepository implements DocumentExtractorRepository {
  readonly supportedExtensions = [".jsonl", ".ndjson"] as const;
  readonly sourceFormat = "jsonl";

  async extract(absolutePath: string): Promise<Result<ExtractedText>> {
    let content: string;
    try {
      content = await readFile(absolutePath, "utf8");
    } catch (error) {
      return extractionFailure(
        "extraction_failed",
        `Failed to read JSONL: ${message(error)}`,
        absolutePath,
      );
    }

    const blocks: string[] = [];
    const badLines: number[] = [];
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = (lines[index] ?? "").trim();
      if (line.length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        badLines.push(index + 1);
        continue;
      }
      blocks.push(`## Record ${blocks.length + 1}\n\n${JSON.stringify(value, null, 2)}`);
    }

    if (blocks.length === 0) {
      return extractionFailure("empty", "JSONL holds no parseable record.", absolutePath);
    }

    const parts: string[] = [];
    for (let start = 0; start < blocks.length; start += MAX_RECORDS_PER_PART) {
      parts.push(blocks.slice(start, start + MAX_RECORDS_PER_PART).join("\n\n"));
    }

    const warnings: string[] = [];
    if (badLines.length > 0) warnings.push(describeBadLines(badLines));
    if (parts.length > 1) {
      warnings.push(`Split ${blocks.length} records into ${parts.length} parts.`);
    }

    return ok<ExtractedText>({ parts, sourceFormat: this.sourceFormat, warnings });
  }
}

function describeBadLines(badLines: readonly number[]): string {
  const plural = badLines.length === 1 ? "" : "s";
  const shown = badLines.slice(0, MAX_REPORTED_BAD_LINES).join(", ");
  const suffix = badLines.length > MAX_REPORTED_BAD_LINES ? ", ..." : "";
  return `Skipped ${badLines.length} unparseable line${plural} (line${plural}: ${shown}${suffix}).`;
}
