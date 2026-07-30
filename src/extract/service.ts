// Extraction orchestration: run the registry's extractor for a file and write
// the result to a temp `.okf-extract/<relDir>/<stem>-extracted.txt` that the
// agent reads instead of the binary original. Also provides the temp-dir
// lifecycle (clean before a run, archive + remove after).
//
// All file IO is wrapped in `Result<T>` via `files.ts`; this service never
// throws to callers.

import { join } from "node:path";

import { copyFile, pathExists, removeDir, writeTextFile } from "../files.ts";
import { ok, type Result } from "../types.ts";
import { extractFile } from "./registry.ts";
import type { ExtractedText } from "./types.ts";

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
}

/** Directory name (inside `input/`) where extracted text is staged. */
export const EXTRACTION_TEMP_DIR = ".okf-extract";

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

  return ok<ExtractedArtifact>({
    extractedTextPaths,
    tempRelativeNames,
    sourceFormat: extracted.data.sourceFormat,
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

function extensionOf(relativePath: string): string {
  const dot = relativePath.lastIndexOf(".");
  return dot > 0 ? relativePath.slice(dot).toLowerCase() : "";
}