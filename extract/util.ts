// Shared helpers for extractor repositories: error formatting and a typed
// `Result<T>` failure constructor. Kept here so each repository stays focused
// on its format instead of redefining the same two helpers.

import { err, type Result } from "../types.ts";
import type { ExtractedText, ExtractionFailureCause } from "./types.ts";

/** Render an unknown error as a single-line message. */
export function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Build a failed `Result<ExtractedText>` carrying a stable `cause` code on the
 * `AppError`, so the classifier can map it to an `IgnoreReason`.
 */
export function extractionFailure(
  cause: ExtractionFailureCause,
  messageText: string,
  path: string,
): Result<ExtractedText> {
  return err<ExtractedText>(messageText, { path, cause });
}