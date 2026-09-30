// DocxRepository — extracts plain text from Word .docx files using `mammoth`.
//
// mammoth's native `Result` (Dto) is converted to the `ExtractedText` AppModel;
// the Dto never leaks. Warnings from mammoth are surfaced as non-fatal
// `warnings`; empty output maps to the "empty" cause.

import { ok, type Result } from "../types.ts";
import type { ExtractedText, DocumentExtractorRepository } from "./types.ts";
import {
  MAX_EMBEDDED_IMAGE_BYTES,
  MAX_EMBEDDED_IMAGE_TOTAL_BYTES,
  MAX_EMBEDDED_IMAGES,
  readEmbeddedImages,
  type EmbeddedImageReference,
} from "./embedded-images.ts";
import { extractDocxCharts } from "./docx-charts.ts";
import { fingerprint, inspectDocxImages } from "./docx-images.ts";
import { extractionFailure, message } from "./util.ts";

/** mammoth's native result DTOs, kept inside this repository. */
interface MammothRawTextDto {
  readonly value: string;
  readonly messages: ReadonlyArray<{ type: string; message: string }>;
}
interface PendingImage {
  reference: EmbeddedImageReference;
  readonly marker: string;
}
interface MammothImageDto {
  readonly contentType: string;
  readAsBuffer(): Promise<Buffer>;
}
interface MammothHtmlDto {
  readonly value: string;
  readonly messages: ReadonlyArray<{ type: string; message: string }>;
}
interface MammothModuleDto {
  extractRawText(input: { path: string }): Promise<MammothRawTextDto>;
  convertToHtml(input: { path: string }, options: {
    convertImage: unknown;
    ignoreEmptyParagraphs?: boolean;
  }): Promise<MammothHtmlDto>;
  images: {
    imgElement(convert: (image: MammothImageDto) => Promise<{ src: string }>): unknown;
  };
}

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
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
      const imageInspection = await inspectDocxImages(absolutePath);
      const warnings = [
        ...dto.messages.filter((entry) => entry.type === "warning").map((entry) => entry.message),
        ...chartExtraction.warnings,
        ...imageInspection.warnings,
      ];
      const associatedImageIndexes = new Set<number>();
      const pendingImages: PendingImage[] = [];
      let embeddedImageBytes = 0;
      let embeddedImageWorkCount = 0;
      let rejectedImageCount = 0;
      try {
        const html = await mammothModule.convertToHtml(
          { path: absolutePath },
          {
            convertImage: mammothModule.images.imgElement(async (image) => {
              const imageIndex = embeddedImageWorkCount + 1;
              const marker = `okf-embedded-image-${imageIndex}`;
              embeddedImageWorkCount++;
              if (embeddedImageWorkCount > MAX_EMBEDDED_IMAGES) {
                rejectedImageCount++;
                warnings.push(`DOCX: skipped embedded images after the ${MAX_EMBEDDED_IMAGES}-image limit.`);
                return { src: marker };
              }
              const data = await image.readAsBuffer();
              const imageFingerprint = fingerprint(data);
              const associationIndex = imageInspection.associations.findIndex((association, index) =>
                !associatedImageIndexes.has(index)
                && association.fingerprint === imageFingerprint
                && association.mediaType.toLowerCase() === image.contentType.toLowerCase(),
              );
              const association = associationIndex < 0
                ? undefined
                : imageInspection.associations[associationIndex];
              if (associationIndex >= 0) associatedImageIndexes.add(associationIndex);
              else warnings.push(`DOCX: image occurrence ${embeddedImageWorkCount} could not be matched to its document relationship; context is uncertain.`);
              if (data.byteLength > MAX_EMBEDDED_IMAGE_BYTES) {
                rejectedImageCount++;
                warnings.push(`DOCX: skipped oversized embedded image ${imageIndex} (over ${MAX_EMBEDDED_IMAGE_BYTES} bytes).`);
                return { src: marker };
              }
              if (embeddedImageBytes + data.byteLength > MAX_EMBEDDED_IMAGE_TOTAL_BYTES) {
                rejectedImageCount++;
                warnings.push(`DOCX: skipped remaining embedded images after the ${MAX_EMBEDDED_IMAGE_TOTAL_BYTES}-byte workload limit.`);
                return { src: marker };
              }
              embeddedImageBytes += data.byteLength;
              const name = `word/media/image${imageIndex}.${image.contentType.split("/")[1] ?? "bin"}`;
              pendingImages.push({
                marker,
                reference: {
                  file: {
                    name,
                    _data: { uncompressedSize: data.byteLength },
                    async: async () => new Uint8Array(data),
                  },
                  ...(association?.context === undefined ? {} : { context: association.context }),
                  location: association?.location ?? `Near paragraph ${embeddedImageWorkCount}; section uncertain`,
                },
              });
              return { src: marker };
            }),
          },
        );
        for (const pending of pendingImages) {
          if (pending.reference.context !== undefined) continue;
          const paragraphs = html.value.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) ?? [];
          const surroundingParagraph = paragraphs.find((paragraph) => paragraph.includes(pending.marker));
          const context = surroundingParagraph === undefined
            ? undefined
            : stripHtmlTags(surroundingParagraph.replace(new RegExp(`src=[\"']${pending.marker}[\"']`, "i"), ""));
          pending.reference = {
            ...pending.reference,
            ...(context === undefined || context.length === 0 ? {} : { context }),
          };
        }
      } catch (error) {
        warnings.push(`DOCX: could not inspect embedded images: ${message(error)}.`);
      }
      const embeddedReferences = pendingImages.map((pending) => pending.reference);
      const embedded = await readEmbeddedImages(embeddedReferences, this.sourceFormat);
      if (text.length === 0 && embedded.images.length === 0 && chartExtraction.text.length === 0) {
        return extractionFailure("empty", "DOCX yielded no text or extractable images.", absolutePath);
      }
      return ok<ExtractedText>({
        parts: [[text, chartExtraction.text].filter((value) => value.length > 0).join("\n\n") || "No extractable text; inspect the embedded images."],
        sourceFormat: this.sourceFormat,
        warnings: [
          ...warnings,
          ...embedded.warnings,
          ...(rejectedImageCount === 0 && pendingImages.length === embedded.images.length
            ? []
            : [`DOCX: ${rejectedImageCount + pendingImages.length - embedded.images.length} embedded image(s) were skipped due to format, size, or workload limits.`]),
        ],
        embeddedImages: embedded.images,
      });
    } catch (error) {
      return extractionFailure("extraction_failed", `DOCX extraction failed: ${message(error)}`, absolutePath);
    }
  }
}