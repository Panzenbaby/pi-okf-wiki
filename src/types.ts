// Core types: Result<T>, AppError, and OKF domain models.
// No `any`, explicit types everywhere, Result<T> for fallible operations.

export type Result<T> =
  | { success: true; data: T }
  | { success: false; error: AppError };

export interface AppError {
  message: string;
  path?: string;
  cause?: string;
}

export function ok<T>(data: T): Result<T> {
  return { success: true, data };
}

export function err<T>(message: string, extras: Partial<AppError> = {}): Result<T> {
  return { success: false, error: { message, ...extras } };
}

/**
 * Parsed YAML frontmatter of a concept document.
 *
 * `status` and `supersedes` are producer-defined OKF extensions (§4.1), not
 * registered by the spec. They are typed here (rather than left only in `raw`)
 * so the precedence graph is first-class: `renderConceptForPrompt` surfaces
 * them to the query agent without it having to open the file. `status` stays
 * an open string (the prompt convention is `current` | `superseded`, but
 * producers MAY use other values — §11 forbids rejecting them); `supersedes`
 * is a path list so a concept can supersede several older ones (merge).
 */
export interface Frontmatter {
  readonly type: string | undefined;
  readonly title: string | undefined;
  readonly description: string | undefined;
  readonly resource: string | undefined;
  readonly tags: readonly string[];
  /** LEGACY (OKF v0.1): superseded by `generated.at` (§13.1). Read-only fallback. */
  readonly timestamp: string | undefined;
  /** Producer-defined (§4.1): `current` | `superseded` by convention. Open string. */
  readonly status: string | undefined;
  /** Producer-defined (§4.1): bundle-relative paths to concepts this one supersedes. */
  readonly supersedes: readonly string[];
  /** OKF v0.2 trust (§5.2): how the current content was produced. */
  readonly generated: ActorEvent | undefined;
  /**
   * OKF v0.2 trust (§5.2): verification events. A bare `{ by, at }` mapping in
   * YAML is normalized to a one-element list at parse time (spec MUST).
   */
  readonly verified: readonly ActorEvent[];
  /** OKF v0.2 provenance (§5.1): the materials this concept derives from. */
  readonly sources: readonly SourceEntry[];
  /** OKF v0.2 lifecycle (§5.5): ISO 8601 instant on/after which content is stale. */
  readonly staleAfter: string | undefined;
  readonly raw: Readonly<Record<string, unknown>>;
}

/** A `{ by, at }` event (§5.2). `by` uses the actor convention (§7). */
export interface ActorEvent {
  readonly by: string | undefined;
  readonly at: string | undefined;
}

/** One `sources` entry (§5.1). `resource` is REQUIRED by the spec but kept
 * optional here — a malformed entry is preserved, never rejected (§11). */
export interface SourceEntry {
  readonly id: string | undefined;
  readonly resource: string | undefined;
  readonly title: string | undefined;
  /** Credibility signal (§5.1): who/what produced the source (actor convention, §7). */
  readonly author: string | undefined;
  /** Credibility signal (§5.1): how often the resource was exercised. */
  readonly usageCount: number | undefined;
  /** Credibility signal (§5.1): when the source itself last changed. */
  readonly lastModified: string | undefined;
}

/** A concept document read from the wiki. */
export interface Concept {
  readonly conceptId: string; // path within wiki without `.md`
  readonly absolutePath: string;
  readonly frontmatter: Frontmatter;
  readonly body: string;
}

/** Classification of a single input file. */
export type InputClassification = "conformant" | "non-conformant" | "ignored";

/**
 * Stable, machine-readable reason an input file was ignored. The app layer
 * translates these for the UI; the extension's own summary widget renders a
 * short English phrase via `describeIgnoreReason` in `update.ts`.
 */
export type IgnoreReason =
  | "unsupported"
  | "reserved"
  | "encrypted"
  | "extraction_failed"
  | "empty"
  | "io_failed";

export interface InputFile {
  readonly relativePath: string; // relative to input/, with extension
  readonly absolutePath: string;
  readonly classification: InputClassification;
  readonly frontmatter?: Frontmatter;
  readonly ignoreReason?: IgnoreReason;
  /** Human-readable detail for an ignored file (e.g. the underlying lib error). */
  readonly ignoreDetail?: string;
  /**
   * Absolute paths to the temp extracted `.txt` files the agent should read
   * INSTEAD of `absolutePath`. Set only for formats that were successfully
   * extracted. Usually one; several when the extractor split a large file.
   */
  readonly extractedTextPaths?: readonly string[];
  /** Paths of the extracted text relative to `.okf-extract/` (e.g. `notes/foo-extracted.txt`). */
  readonly tempRelativeNames?: readonly string[];
  /** Source format id when extracted (e.g. "docx"). */
  readonly sourceFormat?: string;
}

/** Snapshot of the wiki used for diffing before/after an update. */
export interface WikiSnapshot {
  readonly entries: ReadonlyMap<string, string>; // conceptId -> content hash
}

export interface UpdateReport {
  readonly conformantImported: readonly string[]; // concept ids
  readonly nonConformantHandedToAgent: readonly string[]; // input relative paths
  readonly ignored: ReadonlyArray<{ path: string; reason: IgnoreReason; detail?: string }>;
  readonly leftover: readonly string[]; // input files still present after run
  readonly createdConcepts: readonly string[];
  readonly updatedConcepts: readonly string[];
  readonly wikiConceptCountBefore: number;
  readonly wikiConceptCountAfter: number;
  readonly hadAgentTurn: boolean;
  /** Non-fatal issues surfaced to the user (e.g. temp-dir cleanup failures). */
  readonly warnings: readonly string[];
}
