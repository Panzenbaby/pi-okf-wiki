// NotebookRepository — extracts prose and code from Jupyter notebooks (.ipynb).
//
// A notebook is JSON, so reading the original directly would bury the content
// under execution metadata and base64 image outputs. Markdown cells are emitted
// as text and code cells as fenced blocks; cell OUTPUTS are dropped entirely
// (they are mostly rendered images, stack traces, and stream noise, none of
// which is knowledge worth indexing).

import { readFile } from "node:fs/promises";

import { ok, type Result } from "../types.ts";
import type { ExtractedText, DocumentExtractorRepository } from "./types.ts";
import { readEmbeddedImages, type EmbeddedImageReference } from "./embedded-images.ts";
import { extractionFailure, message } from "./util.ts";

/** Jupyter notebook JSON (Dto) — only the slice we touch is typed here. */
interface NotebookDto {
  readonly cells?: readonly NotebookCellDto[];
  readonly metadata?: NotebookMetadataDto;
}
interface NotebookCellDto {
  readonly cell_type?: string;
  readonly source?: string | readonly string[];
  readonly outputs?: readonly NotebookOutputDto[];
}
interface NotebookOutputDto {
  readonly data?: Readonly<Record<string, string | readonly string[]>>;
}
interface NotebookMetadataDto {
  readonly language_info?: { readonly name?: string };
  readonly kernelspec?: { readonly language?: string };
}

export class NotebookRepository implements DocumentExtractorRepository {
  readonly supportedExtensions = [".ipynb"] as const;
  readonly sourceFormat = "ipynb";

  async extract(absolutePath: string): Promise<Result<ExtractedText>> {
    let content: string;
    try {
      content = await readFile(absolutePath, "utf8");
    } catch (error) {
      return extractionFailure(
        "extraction_failed",
        `Failed to read notebook: ${message(error)}`,
        absolutePath,
      );
    }

    let notebook: NotebookDto;
    try {
      notebook = asNotebook(JSON.parse(content));
    } catch (error) {
      return extractionFailure(
        "extraction_failed",
        `Notebook is not valid JSON: ${message(error)}`,
        absolutePath,
      );
    }

    const language = notebook.metadata?.language_info?.name
      ?? notebook.metadata?.kernelspec?.language
      ?? "";
    const chunks: string[] = [];
    const embeddedReferences: EmbeddedImageReference[] = [];
    const cells = notebook.cells ?? [];
    for (let cellIndex = 0; cellIndex < cells.length; cellIndex++) {
      const cell = cells[cellIndex];
      const source = joinSource(cell.source).trim();
      if (source.length > 0) chunks.push(cell.cell_type === "code" ? fence(source, language) : source);
      for (const output of cell.outputs ?? []) {
        for (const [mediaType, encodedValue] of Object.entries(output.data ?? {})) {
          if (!mediaType.startsWith("image/")) continue;
          const encoded = Array.isArray(encodedValue) ? encodedValue.join("") : encodedValue;
          if (typeof encoded !== "string") continue;
          const extension = mediaType.split("/")[1] ?? "bin";
          const fileName = `notebook-cell-${cellIndex + 1}.${extension}`;
          const estimatedBytes = Math.floor(encoded.length * 3 / 4);
          embeddedReferences.push({
            file: {
              name: fileName,
              _data: { uncompressedSize: estimatedBytes },
              async: async () => new Uint8Array(Buffer.from(encoded, "base64")),
            },
            location: `Cell ${cellIndex + 1}`,
            ...(source.length > 0 ? { context: source.slice(0, 500) } : {}),
          });
        }
      }
    }

    const text = chunks.join("\n\n").trim();
    const embedded = await readEmbeddedImages(embeddedReferences, this.sourceFormat);
    if (text.length === 0 && embedded.images.length === 0) {
      return extractionFailure("empty", "Notebook holds no cell content or embedded images.", absolutePath);
    }
    return ok<ExtractedText>({
      parts: [text || "No extractable cell text; inspect the embedded images."],
      sourceFormat: this.sourceFormat,
      warnings: [
        ...embedded.warnings,
        ...(embeddedReferences.length === embedded.images.length
          ? []
          : [`ipynb: skipped ${embeddedReferences.length - embedded.images.length} embedded image(s) due to format, size, or workload limits.`]),
      ],
      embeddedImages: embedded.images,
    });
  }
}

function asNotebook(value: unknown): NotebookDto {
  if (typeof value !== "object" || value === null) {
    throw new Error("notebook root is not an object");
  }
  return value as NotebookDto;
}

/** `source` is a string or an array of lines that already carry their newlines. */
function joinSource(source: string | readonly string[] | undefined): string {
  if (typeof source === "string") return source;
  if (Array.isArray(source)) return source.join("");
  return "";
}

/**
 * Wrap code in a fence longer than any backtick run it contains, so a cell that
 * itself emits markdown cannot break out of its own block.
 */
function fence(code: string, language: string): string {
  const longestRun = Math.max(0, ...[...code.matchAll(/`+/g)].map((match) => match[0].length));
  const marker = "`".repeat(Math.max(3, longestRun + 1));
  return `${marker}${language}\n${code}\n${marker}`;
}
