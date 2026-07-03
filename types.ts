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

/** Parsed YAML frontmatter of a concept document. */
export interface Frontmatter {
  readonly type: string | undefined;
  readonly title: string | undefined;
  readonly description: string | undefined;
  readonly resource: string | undefined;
  readonly tags: readonly string[];
  readonly timestamp: string | undefined;
  readonly raw: Readonly<Record<string, unknown>>;
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

export interface InputFile {
  readonly relativePath: string; // relative to input/, with extension
  readonly absolutePath: string;
  readonly classification: InputClassification;
  readonly frontmatter?: Frontmatter;
  readonly ignoreReason?: string;
}

/** Snapshot of the wiki used for diffing before/after an update. */
export interface WikiSnapshot {
  readonly entries: ReadonlyMap<string, string>; // conceptId -> content hash
}

export interface UpdateReport {
  readonly conformantImported: readonly string[]; // concept ids
  readonly nonConformantHandedToAgent: readonly string[]; // input relative paths
  readonly ignored: ReadonlyArray<{ path: string; reason: string }>;
  readonly leftover: readonly string[]; // input files still present after run
  readonly createdConcepts: readonly string[];
  readonly updatedConcepts: readonly string[];
  readonly wikiConceptCountBefore: number;
  readonly wikiConceptCountAfter: number;
  readonly hadAgentTurn: boolean;
}

/** File extensions the `read` tool can extract, so we hand them to the agent. */
export const READABLE_NON_MD_EXTENSIONS = [
  ".txt",
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
] as const;