// AppModel + repository contract for document text extraction.
//
// Per AGENTS.md: external SDK/lib models (Dtos) never leak outside the
// repository; repositories return AppModels wrapped in Result<T> and never
// throw to callers. Internal logic may try/catch but must convert exceptions
// into a Result before returning.

import type { Result } from "../types.ts";

/**
 * AppModel — the application-level result of extracting text from a binary
 * document. Returned by every `DocumentExtractorRepository`.
 */
export interface ExtractedText {
  /** Plain, readable text suitable for the agent's `read` tool. */
  readonly text: string;
  /** Source format id (e.g. "pdf", "docx", "xlsx", "pptx", "odt", "epub", "html"). */
  readonly sourceFormat: string;
  /** Non-fatal warnings (e.g. skipped sheets, embedded images ignored). */
  readonly warnings: readonly string[];
}

/**
 * Stable cause codes a repository may set on `AppError.cause` when extraction
 * fails. The classifier maps these to `IgnoreReason` entries. Keep these
 * machine-stable (never localise) — the app layer translates them for UI.
 */
export const EXTRACTION_FAILURE_CAUSES = [
  "encrypted",
  "extraction_failed",
  "empty",
] as const;

export type ExtractionFailureCause = (typeof EXTRACTION_FAILURE_CAUSES)[number];

/**
 * A repository that knows how to extract plain text from one or more binary
 * document formats. Mirrors the Repository pattern: callers never touch the
 * underlying SDK/lib Dto directly.
 */
export interface DocumentExtractorRepository {
  /** File extensions (lowercase, with leading dot) this repository handles. */
  readonly supportedExtensions: readonly string[];
  /** Format id emitted as `ExtractedText.sourceFormat`. */
  readonly sourceFormat: string;
  /**
   * Extract text from the file at `absolutePath`. Never throws to the caller;
   * returns `Result<ExtractedText>`. On failure, `error.cause` is one of
   * `ExtractionFailureCause`.
   */
  extract(absolutePath: string): Promise<Result<ExtractedText>>;
}