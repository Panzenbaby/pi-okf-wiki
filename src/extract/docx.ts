// DocxRepository — extracts plain text from Word .docx files using `mammoth`,
// and embedded raster images directly from the package (`docx-images.ts`).
//
// mammoth's native `Result` (Dto) is converted to the `ExtractedText` AppModel;
// the Dto never leaks. Warnings from mammoth are surfaced as non-fatal
// `warnings`; empty output maps to the "empty" cause. Images are NOT taken
// from mammoth's HTML conversion: they are read in document order from
// `word/document.xml` + its relationships, so every image keeps its exact
// paragraph/section context (including anchored, grouped, and text-box images).

import { ok, type Result } from "../types.ts";
import type { ExtractedText, DocumentExtractorRepository } from "./types.ts";
import { readEmbeddedImages } from "./embedded-images.ts";
import { extractDocxCharts } from "./docx-charts.ts";
import { collectDocxImages } from "./docx-images.ts";
import { extractionFailure, message } from "./util.ts";

/** mammoth's native result DTOs, kept inside this repository. */
interface MammothRawTextDto {
  readonly value: string;
  readonly messages: ReadonlyArray<{ type: string; message: string }>;
}
interface MammothModuleDto {
  extractRawText(input: { path: string }): Promise<MammothRawTextDto>;
}

export class DocxRepository implements DocumentExtractorRepository {
  readonly supportedExtensions = [".docx"] as const;
  readonly sourceFormat = "docx";

  async extract(absolutePath: string): Promise<Result<ExtractedText>> {
    let mammothModule: MammothModuleDto;
    try {
      mammothModule = await import("mammoth") as unknown as MammothModuleDto;
    } catch (error) {
      return extractionFailure("extraction_failed", `Failed to load mammoth: ${message(error)}`, absolutePath);
    }

    try {
      const dto = await mammothModule.extractRawText({ path: absolutePath });
      const text = (dto.value ?? "").trim();
      const chartExtraction = await extractDocxCharts(absolutePath);
      const imageCollection = await collectDocxImages(absolutePath);
      const embedded = await readEmbeddedImages(imageCollection.references, "DOCX");
      const warnings = [
        ...dto.messages.filter((entry) => entry.type === "warning").map((entry) => entry.message),
        ...chartExtraction.warnings,
        ...imageCollection.warnings,
        ...embedded.warnings,
      ];
      if (text.length === 0 && embedded.images.length === 0 && chartExtraction.text.length === 0) {
        return extractionFailure("empty", "DOCX yielded no text or extractable images.", absolutePath);
      }
      return ok<ExtractedText>({
        parts: [[text, chartExtraction.text].filter((value) => value.length > 0).join("\n\n") || "No extractable text; inspect the embedded images."],
        sourceFormat: this.sourceFormat,
        warnings,
        embeddedImages: embedded.images,
      });
    } catch (error) {
      return extractionFailure("extraction_failed", `DOCX extraction failed: ${message(error)}`, absolutePath);
    }
  }
}
