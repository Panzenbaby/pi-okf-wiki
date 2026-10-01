// Extraction orchestration: run the registry's extractor for a file and write
// the result to a temp `.okf-extract/<relDir>/<stem>-extracted.txt` that the
// agent reads instead of the binary original. Also provides the temp-dir
// lifecycle (clean before a run, archive + remove after).
//
// All file IO is wrapped in `Result<T>` via `files.ts`; this service never
// throws to callers.

import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import { createHash } from "node:crypto";

import { copyFile, pathExists, removeDir, writeTextFile } from "../files.ts";
import {
  ok,
  type ImageOccurrence,
  type ImageStatus,
  type Result,
  type StagedImage,
} from "../types.ts";
import { aggregateWarnings } from "../warnings.ts";
import { inspectImage } from "./image-inspection.ts";
import { extractFile } from "./registry.ts";
import type { EmbeddedImage, ExtractedText } from "./types.ts";

/**
 * A successfully extracted text artifact staged for the agent to read.
 *
 * Most formats yield exactly one file. A repository that splits its output
 * (JSONL) yields several, ordered; the input file still counts as ONE unit
 * everywhere else (one prompt entry, one archive target for the original).
 */
export interface ExtractedArtifact {
  /** Absolute paths to the temp extracted `.txt` files (inside `input/.okf-extract/`). */
  readonly extractedTextPaths: readonly string[];
  /** Paths relative to `.okf-extract/`, mirroring the original (e.g. `notes/foo-extracted.txt`). */
  readonly tempRelativeNames: readonly string[];
  /** Source format id (e.g. "docx"). */
  readonly sourceFormat: string;
  /** Unique embedded images (deduplicated) with stable IDs, locations, and status. */
  readonly embeddedImages: readonly StagedImage[];
  /** Counters describing how the embedded images were processed. */
  readonly imageStatistics: ImageStagingStatistics;
  /**
   * Where the image findings file for this document goes (absolute and
   * relative to `.okf-extract/`). Set only when the document has images.
   */
  readonly imageFindingsPath?: string;
  readonly imageFindingsRelativeName?: string;
  /** Non-fatal issues from text/image extraction or image staging (aggregated). */
  readonly warnings: readonly string[];
}

/** Directory name (inside `input/`) where extracted text is staged. */
export const EXTRACTION_TEMP_DIR = ".okf-extract";

/** Unique images staged per document (duplicates do not count). */
export const MAX_STAGED_EMBEDDED_IMAGES = 200;
export const MAX_STAGED_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_STAGED_TOTAL_IMAGE_BYTES = 96 * 1024 * 1024;

/** How the embedded images of one document were processed. */
export interface ImageStagingStatistics {
  /** Image occurrences delivered by the extractor (before deduplication). */
  readonly occurrences: number;
  /** Occurrences that carry surrounding-text context. */
  readonly occurrencesWithContext: number;
  /** Unique images after SHA-256 deduplication. */
  readonly unique: number;
  /** Occurrences folded into an earlier identical image. */
  readonly duplicates: number;
  /** Unique images skipped as tiny (recorded as `decorative`). */
  readonly tiny: number;
  /** Unique images rejected by the broken-image heuristic. */
  readonly broken: number;
  /** Unique images written to the temp tree for analysis. */
  readonly staged: number;
  /** Unique images dropped by staging limits or write errors (no record). */
  readonly dropped: number;
}

/** One catalogued unique image, still holding its bytes (before staging). */
export interface CatalogedImage {
  readonly record: StagedImage;
  readonly data: Uint8Array;
}

export interface ImageCatalog {
  readonly images: readonly CatalogedImage[];
  readonly warnings: readonly string[];
  readonly duplicates: number;
}

/**
 * Deduplicate embedded images by SHA-256 (first occurrence wins the ID, later
 * occurrences are added as extra locations), assign stable IDs (`img-01`, …),
 * and run the deterministic inspection: tiny images become `decorative`,
 * broken extractions become `broken`, everything else is `staged`. Pure — no IO.
 */
export function catalogEmbeddedImages(
  payloads: readonly EmbeddedImage[],
  format: string,
): ImageCatalog {
  const images: CatalogedImage[] = [];
  const bySha = new Map<string, number>();
  const occurrencesById = new Map<number, ImageOccurrence[]>();
  const warnings: string[] = [];
  let duplicates = 0;
  let acceptedBytes = 0;
  for (const payload of payloads) {
    const sha256 = createHash("sha256").update(payload.data).digest("hex");
    const occurrence: ImageOccurrence = {
      ...(payload.location === undefined ? {} : { location: payload.location }),
      ...(payload.context === undefined ? {} : { context: payload.context }),
    };
    const existing = bySha.get(sha256);
    if (existing !== undefined) {
      duplicates++;
      occurrencesById.get(existing)?.push(occurrence);
      continue;
    }
    if (images.length >= MAX_STAGED_EMBEDDED_IMAGES) {
      warnings.push(`${format}: skipped further unique embedded images after the ${MAX_STAGED_EMBEDDED_IMAGES}-image staging limit.`);
      continue;
    }
    if (payload.data.byteLength > MAX_STAGED_IMAGE_BYTES) {
      warnings.push(`${format}: skipped an oversized embedded image during staging (over ${MAX_STAGED_IMAGE_BYTES} bytes).`);
      continue;
    }
    if (acceptedBytes + payload.data.byteLength > MAX_STAGED_TOTAL_IMAGE_BYTES) {
      warnings.push(`${format}: skipped further embedded images after the ${MAX_STAGED_TOTAL_IMAGE_BYTES}-byte staging limit.`);
      continue;
    }
    if (imageExtension(payload.mediaType) === undefined) {
      warnings.push(`${format}: could not stage an embedded image with unsupported media type ${payload.mediaType}.`);
      continue;
    }
    acceptedBytes += payload.data.byteLength;
    const index = images.length;
    const occurrences: ImageOccurrence[] = [occurrence];
    occurrencesById.set(index, occurrences);
    bySha.set(sha256, index);
    const inspection = inspectImage(payload.data, payload.mediaType);
    const status: ImageStatus = inspection.verdict.kind === "tiny"
      ? "decorative"
      : inspection.verdict.kind === "broken" ? "broken" : "staged";
    images.push({
      data: payload.data,
      record: {
        id: imageId(index + 1),
        mediaType: payload.mediaType,
        byteLength: payload.data.byteLength,
        sha256,
        occurrences,
        status,
        ...(inspection.dimensions === undefined ? {} : { width: inspection.dimensions.width, height: inspection.dimensions.height }),
        ...(inspection.verdict.kind === "content"
          ? {}
          : { statusReason: inspection.verdict.kind === "tiny" ? `tiny image (${inspection.verdict.reason})` : inspection.verdict.reason }),
      },
    });
  }
  return { images, warnings, duplicates };
}

/** Stable per-document image ID, e.g. `img-01`. */
export function imageId(number: number): string {
  return `img-${String(number).padStart(2, "0")}`;
}

/**
 * Remove the extraction temp dir at the start of a run so stale temp files
 * from an interrupted previous run never survive. Safe because any original
 * still in `input/` is re-extracted this run.
 */
export async function cleanExtractionTemp(inputRoot: string): Promise<Result<void>> {
  return removeDir(join(inputRoot, EXTRACTION_TEMP_DIR));
}

/**
 * Extract `file`'s text and write it to `input/.okf-extract/<relDir>/<stem>-extracted.txt`.
 * Returns the artifact the agent should read, or an error Result whose
 * `error.cause` is a stable `ExtractionFailureCause`.
 */
export async function extractToTempFile(
  inputRoot: string,
  relativePath: string,
  absolutePath: string,
): Promise<Result<ExtractedArtifact>> {
  const extension = extensionOf(relativePath);
  const extracted: Result<ExtractedText> = await extractFile(absolutePath, extension);
  if (!extracted.success) return extracted;

  const parts = extracted.data.parts;
  const warnings = [...extracted.data.warnings];
  const tempRelativeNames = await tempRelativeNamesFor(
    inputRoot,
    relativePath,
    extension,
    parts.length,
  );
  const extractedTextPaths: string[] = [];
  for (let index = 0; index < parts.length; index++) {
    const path = join(inputRoot, EXTRACTION_TEMP_DIR, tempRelativeNames[index] ?? "");
    const write = await writeTextFile(path, parts[index] ?? "");
    if (!write.success) return write;
    extractedTextPaths.push(path);
  }

  const payloads = extracted.data.embeddedImages ?? [];
  const catalog = catalogEmbeddedImages(payloads, extracted.data.sourceFormat);
  for (const warning of catalog.warnings) warnings.push(warning);
  const embeddedImages: StagedImage[] = [];
  const imageRoot = join(inputRoot, EXTRACTION_TEMP_DIR);
  let dropped = 0;
  for (const [index, entry] of catalog.images.entries()) {
    if (entry.record.status !== "staged") {
      embeddedImages.push(entry.record);
      continue;
    }
    const extension = imageExtension(entry.record.mediaType) ?? "bin";
    const imagePath = join(imageRoot, imageRelativeName(relativePath, index + 1, extension));
    if (!imagePath.startsWith(`${imageRoot}/`)) {
      warnings.push(`${extracted.data.sourceFormat}: skipped embedded image with unsafe generated path.`);
      dropped++;
      continue;
    }
    try {
      await mkdir(join(imagePath, ".."), { recursive: true });
      await writeFile(imagePath, entry.data);
      embeddedImages.push({ ...entry.record, path: imagePath });
    } catch (error) {
      warnings.push(`${extracted.data.sourceFormat}: failed to stage embedded image ${entry.record.id}: ${errorMessage(error)}.`);
      dropped++;
    }
  }
  const findingsRelativeName = embeddedImages.length === 0
    ? undefined
    : findingsRelativeNameFor(tempRelativeNames[0] ?? relativePath);
  const imageStatistics: ImageStagingStatistics = {
    occurrences: payloads.length,
    occurrencesWithContext: payloads.filter((payload) => (payload.context ?? "").trim().length > 0).length,
    unique: catalog.images.length,
    duplicates: catalog.duplicates,
    tiny: embeddedImages.filter((image) => image.status === "decorative").length,
    broken: embeddedImages.filter((image) => image.status === "broken").length,
    staged: embeddedImages.filter((image) => image.status === "staged").length,
    dropped,
  };

  return ok<ExtractedArtifact>({
    extractedTextPaths,
    tempRelativeNames,
    sourceFormat: extracted.data.sourceFormat,
    embeddedImages,
    imageStatistics,
    ...(findingsRelativeName === undefined
      ? {}
      : { imageFindingsRelativeName: findingsRelativeName, imageFindingsPath: join(imageRoot, findingsRelativeName) }),
    warnings: aggregateWarnings(warnings),
  });
}

/**
 * Copy a staged extracted text file into the archive (collision-safe), so the
 * archive holds both the original binary and its extracted text. Called per
 * successfully-archived original during finalize.
 */
export async function archiveExtractedText(
  inputRoot: string,
  archiveDir: string,
  tempRelativeNames: readonly string[],
  resolveArchiveTarget: (archive: string, relative: string) => Promise<string>,
): Promise<Result<void>> {
  for (const tempRelativeName of tempRelativeNames) {
    const source = join(inputRoot, EXTRACTION_TEMP_DIR, tempRelativeName);
    if (!(await pathExists(source))) continue;
    const destination = await resolveArchiveTarget(archiveDir, tempRelativeName);
    const copied = await copyFile(source, destination);
    if (!copied.success) return copied;
  }
  return ok(undefined);
}

/** Remove the whole extraction temp dir once finalize is done. */
export async function cleanupExtractionTemp(inputRoot: string): Promise<Result<void>> {
  return removeDir(join(inputRoot, EXTRACTION_TEMP_DIR));
}

/**
 * Compute the temp relative name(s) for `relativePath`. A single-part
 * extraction keeps the historical `<relDir>/<stem>-extracted.txt`; a split one
 * numbers its parts `<relDir>/<stem>-extracted.part01.txt`, so adding the split
 * capability changed no path for the formats that never split.
 *
 * If the base name is already taken inside this run (same stem, different
 * extension in the same directory), fall back to `<stem>.<extWithoutDot>-extracted`.
 *
 * Invariant: this single-level fallback is sufficient because (a) the temp dir
 * is wiped at the start of every run (cleanExtractionTemp), so no cross-run
 * names exist, and (b) within one run two files in the same directory cannot
 * share both stem AND extension (that would be the same path). The ext-based
 * fallback is therefore always unique. If a future scenario breaks this
 * invariant, add a numeric suffix loop here.
 */
async function tempRelativeNamesFor(
  inputRoot: string,
  relativePath: string,
  extension: string,
  partCount: number,
): Promise<readonly string[]> {
  const segments = relativePath.split("/");
  const fileName = segments[segments.length - 1] ?? relativePath;
  const dirParts = segments.slice(0, -1);
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;

  const plainNames = partNames([...dirParts, `${stem}-extracted`].join("/"), partCount);
  const firstPlain = plainNames[0] ?? "";
  if (!(await pathExists(join(inputRoot, EXTRACTION_TEMP_DIR, firstPlain)))) {
    return plainNames;
  }
  const extWithoutDot = extension.replace(/^\./, "");
  return partNames([...dirParts, `${stem}.${extWithoutDot}-extracted`].join("/"), partCount);
}

function partNames(base: string, partCount: number): readonly string[] {
  if (partCount <= 1) return [`${base}.txt`];
  const names: string[] = [];
  for (let index = 1; index <= partCount; index++) {
    names.push(`${base}.part${String(index).padStart(2, "0")}.txt`);
  }
  return names;
}

/**
 * Findings file name derived from the first extracted text name, so it
 * inherits the same collision handling: `notes/foo-extracted.txt` ->
 * `notes/foo-image-findings.txt`, `notes/foo.odt-extracted.part01.txt` ->
 * `notes/foo.odt-image-findings.txt`.
 */
function findingsRelativeNameFor(extractedRelativeName: string): string {
  return extractedRelativeName.replace(/-extracted(?:\.part\d+)?\.txt$/, "-image-findings.txt");
}

function imageRelativeName(relativePath: string, index: number, extension: string): string {
  const segments = relativePath.split("/");
  const fileName = segments[segments.length - 1] ?? relativePath;
  const dirParts = segments.slice(0, -1);
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const sourceExtension = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "document";
  return [...dirParts, `${stem}.${sourceExtension}-embedded-image-${String(index).padStart(2, "0")}.${extension}`].join("/");
}

function imageExtension(mediaType: string): string | undefined {
  const extensions: Readonly<Record<string, string>> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/tiff": "tiff",
  };
  return extensions[mediaType];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extensionOf(relativePath: string): string {
  const dot = relativePath.lastIndexOf(".");
  return dot > 0 ? relativePath.slice(dot).toLowerCase() : "";
}