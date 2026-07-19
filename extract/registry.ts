// Extractor registry + format taxonomy.
//
// The registry maps a file extension to the `DocumentExtractorRepository`
// that handles it. `EXTRACTABLE_EXTENSIONS` is derived from the registered
// repositories so the taxonomy has a single source of truth. The two
// non-extracted allowlists (plain-text and image) live here too because the
// classifier in `update.ts` consumes them alongside the extractable set.

import { err, type Result } from "../types.ts";
import type { ExtractedText, DocumentExtractorRepository } from "./types.ts";
import { PdfRepository } from "./pdf.ts";
import { DocxRepository } from "./docx.ts";
import { SheetRepository } from "./sheet.ts";
import { PptxRepository, OdtRepository, EpubRepository } from "./office-xml.ts";
import { HtmlRepository } from "./html.ts";
import { RtfRepository } from "./rtf.ts";

const repositories: readonly DocumentExtractorRepository[] = [
  new PdfRepository(),
  new DocxRepository(),
  new SheetRepository(),
  new PptxRepository(),
  new OdtRepository(),
  new EpubRepository(),
  new HtmlRepository(),
  new RtfRepository(),
];

const repositoryByExtension = new Map<string, DocumentExtractorRepository>();
for (const repository of repositories) {
  for (const extension of repository.supportedExtensions) {
    repositoryByExtension.set(extension.toLowerCase(), repository);
  }
}

/** Extensions that need a real extractor (binary/structured formats). */
export const EXTRACTABLE_EXTENSIONS: readonly string[] = [...repositoryByExtension.keys()];

/** Plain-text formats the agent's `read` tool handles directly (no extraction). */
export const TEXT_READABLE_EXTENSIONS = [".txt", ".csv", ".json"] as const;

/** Image formats the agent's `read` tool reads via vision (no extraction). */
export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"] as const;

export function extractorForExtension(extension: string): DocumentExtractorRepository | undefined {
  return repositoryByExtension.get(extension.toLowerCase());
}

/**
 * Extract text from `absolutePath` using the repository registered for
 * `extension`. Returns `Result<ExtractedText>`; never throws.
 */
export async function extractFile(
  absolutePath: string,
  extension: string,
): Promise<Result<ExtractedText>> {
  const repository = extractorForExtension(extension);
  if (repository === undefined) {
    return err<ExtractedText>(`No extractor registered for ${extension}`, {
      path: absolutePath,
      cause: "extraction_failed",
    });
  }
  return repository.extract(absolutePath);
}