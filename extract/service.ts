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

/** A successfully extracted text artifact staged for the agent to read. */
export interface ExtractedArtifact {
  /** Absolute path to the temp extracted `.txt` (inside `input/.okf-extract/`). */
  readonly extractedTextPath: string;
  /** Path relative to `.okf-extract/`, mirroring the original (e.g. `notes/foo-extracted.txt`). */
  readonly tempRelativeName: string;
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

  const tempRelativeName = await tempRelativeNameFor(inputRoot, relativePath, extension);
  const extractedTextPath = join(inputRoot, EXTRACTION_TEMP_DIR, tempRelativeName);

  const write = await writeTextFile(extractedTextPath, extracted.data.text);
  if (!write.success) return write;

  return ok<ExtractedArtifact>({
    extractedTextPath,
    tempRelativeName,
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
  tempRelativeName: string,
  resolveArchiveTarget: (archive: string, relative: string) => Promise<string>,
): Promise<Result<void>> {
  const source = join(inputRoot, EXTRACTION_TEMP_DIR, tempRelativeName);
  if (!(await pathExists(source))) return ok(undefined);
  const destination = await resolveArchiveTarget(archiveDir, tempRelativeName);
  return copyFile(source, destination);
}

/** Remove the whole extraction temp dir once finalize is done. */
export async function cleanupExtractionTemp(inputRoot: string): Promise<Result<void>> {
  return removeDir(join(inputRoot, EXTRACTION_TEMP_DIR));
}

/**
 * Compute the temp relative name for `relativePath`: `<relDir>/<stem>-extracted.txt`.
 * If that name is already taken inside this run (same stem, different extension
 * in the same directory), fall back to `<stem>.<extWithoutDot>-extracted.txt`.
 *
 * Invariant: this single-level fallback is sufficient because (a) the temp dir
 * is wiped at the start of every run (cleanExtractionTemp), so no cross-run
 * names exist, and (b) within one run two files in the same directory cannot
 * share both stem AND extension (that would be the same path). The ext-based
 * fallback is therefore always unique. If a future scenario breaks this
 * invariant, add a numeric suffix loop here.
 */
async function tempRelativeNameFor(
  inputRoot: string,
  relativePath: string,
  extension: string,
): Promise<string> {
  const parts = relativePath.split("/");
  const fileName = parts[parts.length - 1] ?? relativePath;
  const dirParts = parts.slice(0, -1);
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const plain = [...dirParts, `${stem}-extracted.txt`].join("/");
  const plainPath = join(inputRoot, EXTRACTION_TEMP_DIR, plain);
  if (!(await pathExists(plainPath))) return plain;
  const extWithoutDot = extension.replace(/^\./, "");
  return [...dirParts, `${stem}.${extWithoutDot}-extracted.txt`].join("/");
}

function extensionOf(relativePath: string): string {
  const dot = relativePath.lastIndexOf(".");
  return dot > 0 ? relativePath.slice(dot).toLowerCase() : "";
}