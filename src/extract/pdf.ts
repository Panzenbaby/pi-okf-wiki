// PdfRepository — extracts plain text from PDF files using `unpdf` (pdfjs).
//
// Dto (unpdf's native shape) is converted to the `ExtractedText` AppModel and
// never leaks to callers. Errors are mapped to stable cause codes:
//   - PasswordException  -> "encrypted"
//   - empty text output  -> "empty"
//   - anything else      -> "extraction_failed"

import { readFile } from "node:fs/promises";
import { PNG } from "pngjs";

import { ok, type Result } from "../types.ts";
import type { EmbeddedImage, ExtractedText, DocumentExtractorRepository } from "./types.ts";
import { extractionFailure, message } from "./util.ts";

/** unpdf's native output for `extractText(proxy, { mergePages: true })`. */
interface UnpdfImageDto {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly channels: 1 | 3 | 4;
}
interface UnpdfModuleDto {
  getDocumentProxy(data: Uint8Array): Promise<{
    readonly numPages: number;
  }>;
  extractText(proxy: { readonly numPages: number }, options: { mergePages: true }): Promise<{
    readonly totalPages: number;
    readonly text: string;
  }>;
  extractText(proxy: { readonly numPages: number }, options: { mergePages: false }): Promise<{
    readonly totalPages: number;
    readonly text: readonly string[];
  }>;
  extractImages(proxy: { readonly numPages: number }, page: number): Promise<readonly UnpdfImageDto[]>;
}

const MAX_PDF_IMAGE_COUNT = 24;
const MAX_PDF_IMAGE_PIXELS = 16_000_000;
const MAX_PDF_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PDF_TOTAL_IMAGE_BYTES = 32 * 1024 * 1024;

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
      const unpdf = (await import("unpdf")) as unknown as UnpdfModuleDto;
      const proxy = await unpdf.getDocumentProxy(new Uint8Array(buffer));
      const dto = await unpdf.extractText(proxy, { mergePages: true });
      const text = (dto.text ?? "").trim();
      const warnings: string[] = [];
      let pageTexts: readonly string[] = [];
      try {
        pageTexts = (await unpdf.extractText(proxy, { mergePages: false })).text;
      } catch (error) {
        warnings.push(`PDF: could not associate embedded images with page text: ${message(error)}.`);
      }
      const embeddedImages: EmbeddedImage[] = [];
      let extractedImageCount = 0;
      let totalImageBytes = 0;
      for (let page = 1; page <= proxy.numPages; page++) {
        try {
          const pageImages = await unpdf.extractImages(proxy, page);
          for (const image of pageImages) {
            extractedImageCount++;
            if (embeddedImages.length >= MAX_PDF_IMAGE_COUNT) {
              warnings.push(`PDF: skipped remaining embedded images after the ${MAX_PDF_IMAGE_COUNT}-image limit.`);
              break;
            }
            if (image.width * image.height > MAX_PDF_IMAGE_PIXELS) {
              warnings.push(`PDF: skipped oversized image on page ${page} (${image.width} x ${image.height} pixels).`);
              continue;
            }
            const rawImageBytes = image.data.byteLength;
            if (rawImageBytes > MAX_PDF_IMAGE_BYTES) {
              warnings.push(`PDF: skipped oversized embedded image on page ${page} (${rawImageBytes} bytes).`);
              continue;
            }
            if (totalImageBytes + rawImageBytes > MAX_PDF_TOTAL_IMAGE_BYTES) {
              warnings.push(`PDF: skipped remaining images after the ${MAX_PDF_TOTAL_IMAGE_BYTES}-byte workload limit.`);
              break;
            }
            const colorType = image.channels === 1 ? 0 : image.channels === 3 ? 2 : 6;
            const pngData = PNG.sync.write(
              Object.assign(new PNG({
                width: image.width,
                height: image.height,
                inputColorType: colorType,
                inputHasAlpha: image.channels === 4,
                colorType: 6,
              }), {
                data: Buffer.from(image.data),
              }),
            );
            totalImageBytes += rawImageBytes;
            const pageContext = pageTexts[page - 1]?.trim();
            embeddedImages.push({
              data: pngData,
              mediaType: "image/png",
              location: `Page ${page}`,
              ...(pageContext === undefined || pageContext.length === 0 ? {} : { context: pageContext.slice(0, 1000) }),
            });
          }
        } catch (error) {
          warnings.push(`PDF: could not extract images from page ${page}: ${message(error)}.`);
        }
        if (embeddedImages.length >= MAX_PDF_IMAGE_COUNT && page < proxy.numPages) {
          warnings.push(`PDF: skipped embedded images on remaining pages after the ${MAX_PDF_IMAGE_COUNT}-image limit.`);
          break;
        }
      }
      if (extractedImageCount > embeddedImages.length) {
        warnings.push(`PDF: skipped ${extractedImageCount - embeddedImages.length} embedded image(s) because they exceeded image workload limits.`);
      }
      if (text.length === 0 && embeddedImages.length === 0) {
        return extractionFailure("empty", "PDF yielded no text or extractable images (scanned image or empty).", absolutePath);
      }
      return ok<ExtractedText>({
        parts: [text || "No extractable text; inspect the embedded images."],
        sourceFormat: this.sourceFormat,
        warnings,
        embeddedImages,
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