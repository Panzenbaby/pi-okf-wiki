// DocxRepository — extracts plain text from Word .docx files using `mammoth`.
//
// mammoth's native `Result` (Dto) is converted to the `ExtractedText` AppModel;
// the Dto never leaks. Warnings from mammoth are surfaced as non-fatal
// `warnings`; empty output maps to the "empty" cause.

import { ok, type Result } from "../types.ts";
import type { ExtractedText, DocumentExtractorRepository } from "./types.ts";
import { extractionFailure, message } from "./util.ts";

/** mammoth's native result for `extractRawText`. */
interface MammothRawTextDto {
  readonly value: string;
  readonly messages: ReadonlyArray<{ type: string; message: string }>;
}

export class DocxRepository implements DocumentExtractorRepository {
  readonly supportedExtensions = [".docx"] as const;
  readonly sourceFormat = "docx";

  async extract(absolutePath: string): Promise<Result<ExtractedText>> {
    let mammothModule: { extractRawText: (input: { path: string }) => Promise<MammothRawTextDto> };
    try {
      mammothModule = await import("mammoth");
    } catch (error) {
      return extractionFailure("extraction_failed", `Failed to load mammoth: ${message(error)}`, absolutePath);
    }

    try {
      const dto = await mammothModule.extractRawText({ path: absolutePath });
      const text = (dto.value ?? "").trim();
      if (text.length === 0) {
        return extractionFailure("empty", "DOCX yielded no text.", absolutePath);
      }
      const warnings = dto.messages
        .filter((entry) => entry.type === "warning")
        .map((entry) => entry.message);
      return ok<ExtractedText>({ parts: [text], sourceFormat: this.sourceFormat, warnings });
    } catch (error) {
      return extractionFailure("extraction_failed", `DOCX extraction failed: ${message(error)}`, absolutePath);
    }
  }
}