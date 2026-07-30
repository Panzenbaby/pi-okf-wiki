// PdfRepository — extracts plain text from PDF files using `unpdf` (pdfjs).
//
// Dto (unpdf's native shape) is converted to the `ExtractedText` AppModel and
// never leaks to callers. Errors are mapped to stable cause codes:
//   - PasswordException  -> "encrypted"
//   - empty text output  -> "empty"
//   - anything else      -> "extraction_failed"

import { readFile } from "node:fs/promises";

import { ok, type Result } from "../types.ts";
import type { ExtractedText, DocumentExtractorRepository } from "./types.ts";
import { extractionFailure, message } from "./util.ts";

/** unpdf's native output for `extractText(proxy, { mergePages: true })`. */
interface UnpdfTextDto {
  readonly totalPages: number;
  readonly text: string;
}

export class PdfRepository implements DocumentExtractorRepository {
  readonly supportedExtensions = [".pdf"] as const;
  readonly sourceFormat = "pdf";

  async extract(absolutePath: string): Promise<Result<ExtractedText>> {
    let buffer: Buffer;
    try {
      buffer = await readFile(absolutePath);
    } catch (error) {
      return extractionFailure("extraction_failed", `Failed to read PDF: ${message(error)}`, absolutePath);
    }

    try {
      const { getDocumentProxy, extractText } = await import("unpdf");
      const proxy = await getDocumentProxy(new Uint8Array(buffer));
      const dto: UnpdfTextDto = await extractText(proxy, { mergePages: true });
      const text = (dto.text ?? "").trim();
      if (text.length === 0) {
        return extractionFailure("empty", "PDF yielded no text (scanned image or empty).", absolutePath);
      }
      return ok<ExtractedText>({
        parts: [text],
        sourceFormat: this.sourceFormat,
        warnings: dto.totalPages > 0 ? [`pages: ${dto.totalPages}`] : [],
      });
    } catch (error) {
      const cause = isPasswordError(error) ? "encrypted" : "extraction_failed";
      return extractionFailure(cause, `PDF extraction failed: ${message(error)}`, absolutePath);
    }
  }
}

function isPasswordError(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  return name === "PasswordException" || name === "PasswordExceptionException";
}