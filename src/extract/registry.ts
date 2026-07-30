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
import {
  PptxRepository,
  OdtRepository,
  OdsRepository,
  OdpRepository,
  EpubRepository,
} from "./office-xml.ts";
import { HtmlRepository } from "./html.ts";
import { RtfRepository } from "./rtf.ts";
import { JsonLinesRepository } from "./jsonl.ts";
import { NotebookRepository } from "./notebook.ts";

const repositories: readonly DocumentExtractorRepository[] = [
  new PdfRepository(),
  new DocxRepository(),
  new SheetRepository(),
  new PptxRepository(),
  new OdtRepository(),
  new OdsRepository(),
  new OdpRepository(),
  new EpubRepository(),
  new HtmlRepository(),
  new RtfRepository(),
  new JsonLinesRepository(),
  new NotebookRepository(),
];

const repositoryByExtension = new Map<string, DocumentExtractorRepository>();
for (const repository of repositories) {
  for (const extension of repository.supportedExtensions) {
    repositoryByExtension.set(extension.toLowerCase(), repository);
  }
}

/** Extensions that need a real extractor (binary/structured formats). */
export const EXTRACTABLE_EXTENSIONS: readonly string[] = [...repositoryByExtension.keys()];

/**
 * Plain-text formats the agent's `read` tool handles directly (no extraction).
 *
 * This is a deliberate allowlist rather than a "sniff whether it decodes as
 * text" fallback: sniffing would pull in lockfiles, keys, minified bundles and
 * half-binary exports, and `unsupported` is a more useful signal than silently
 * ingesting them.
 *
 * `.dsl` covers diagram/architecture DSLs — notably the text Miro's MCP tools
 * read and write. It is deliberately NOT parsed: that grammar is fetched at
 * runtime (`layout_get_dsl`) and versioned server-side, so any parser would
 * target a moving spec. Treating it as text also covers every other `.dsl`
 * dialect for free.
 */
export const TEXT_READABLE_EXTENSIONS = [
  ".txt",
  ".csv",
  ".tsv",
  ".json",
  // Diagrams and models as text.
  ".dsl",
  ".mmd",
  ".mermaid",
  ".puml",
  ".plantuml",
  ".dot",
  ".gv",
  // Structured config.
  ".yaml",
  ".yml",
  ".toml",
  // Prose markup.
  ".rst",
  ".adoc",
  ".asciidoc",
  ".org",
] as const;

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