// Input classifier: the single module that owns the full input -> bucket
// pipeline AND the deterministic conformant intake. A file's final bucket
// emerges from three refinement steps that used to live separately in
// `update.ts` (tentative classification, the extraction pass, and the
// conformant import: read + verify + write to wiki/ + archive original). This
// module runs them in one pass and emits the three final buckets —
// `conformantImported`, `forAgent`, and `ignored` — once, so `runUpdate`
// never recomposes buckets by hand and never re-reads a conformant `.md`.
//
// Behaviour is identical to the previous flow for the same input, including
// the order within each bucket: the extraction pass runs over the
// non-conformant candidates before the conformant intake runs over the
// conformant candidates, so `forAgent` is `[non-md forAgent files ...] ++ [md
// deferred ...]` and `ignored` is `[reserved/unsupported ...] ++ [extraction
// failures ...] ++ [conformant io_failed (read/write/archive) ...]`, each in
// input order. `conformantImported` lists concept ids in input order too.

import {
  EXTRACTABLE_EXTENSIONS,
  IMAGE_EXTENSIONS,
  TEXT_READABLE_EXTENSIONS,
} from "./extract/registry.ts";
import {
  extractToTempFile,
  type ExtractedArtifact,
} from "./extract/service.ts";
import { moveFile, readTextFile, resolveArchiveTarget, writeTextFile } from "./files.ts";
import { parseDocument } from "./frontmatter.ts";
import { err, ok, type IgnoreReason, type InputFile, type Result } from "./types.ts";
import {
  conceptIdFromRelativePath,
  type WikiPaths,
} from "./wiki.ts";

/** Reserved filenames in `input/` that are never ingested. */
const RESERVED_INPUT = new Set(["index.md", "log.md"]);

/** A file dropped from the run with a stable, machine-readable reason. */
export interface IgnoredEntry {
  /** The file's path relative to `input/`. */
  readonly path: string;
  readonly reason: IgnoreReason;
  /** Human-readable detail (e.g. the underlying extractor/library error). */
  readonly detail?: string;
}

/**
 * The final, post-refinement buckets a `/wiki-update` run consumes.
 *
 * Pass 3 deterministically imports conformant `.md` files into `wiki/` and
 * archives their originals, so `conformantImported` is a list of concept ids
 * (not `InputFile`s). The same `InputFile` objects flow through `runUpdate`
 * for the `forAgent` and `ignored` buckets; the bucket a file lands in is the
 * source of truth for its fate (the `InputFile.classification` field is left
 * as the tentative value and is informational only).
 */
export interface Classification {
  /**
   * Concept ids of conformant `.md` files deterministically imported into
   * `wiki/` (and their originals archived), in input order.
   */
  readonly conformantImported: readonly string[];
  /**
   * Files to hand to the agent: plain-text/image files read directly, plus
   * extractable files with their `extractedTextPath` already staged, plus
   * `.md` files that lack frontmatter/type (the "deferred non-conformant").
   */
  readonly forAgent: readonly InputFile[];
  /**
   * Files dropped from the run with a stable reason, in the same
   * category-grouped order as the original code: `[reserved/unsupported] ++
   * [extraction failures] ++ [conformant io_failed (read/write/archive, in
   * input order)]`.
   */
  readonly ignored: readonly IgnoredEntry[];
}

/** The input classifier: turns a flat list of input files into final buckets. */
export interface Classifier {
  classify(files: readonly InputFile[]): Promise<Result<Classification>>;
}

/**
 * Create a classifier bound to `paths`. The extraction pass writes its staged
 * text under `paths.input/.okf-extract/`; pass 3 writes conformant content to
 * `paths.wiki/<relative-path>` and moves originals to `paths.archive/`. The
 * caller is responsible for `cleanExtractionTemp(paths.input)` once per run
 * before calling `classify` (the classifier does not clean, to keep that
 * warning surfaced by the caller and to guarantee the clean runs exactly
 * once per run).
 */
export function createClassifier(paths: WikiPaths): Classifier {
  return new InputClassifier(paths);
}

class InputClassifier implements Classifier {
  constructor(private readonly paths: WikiPaths) {}

  async classify(files: readonly InputFile[]): Promise<Result<Classification>> {
    // Pass 1 — tentative classification, preserving input order within each
    // tentative bucket. This mirrors the old `classifyInput`/`classifyOne`.
    const conformantCandidates: InputFile[] = [];
    const nonConformantCandidates: InputFile[] = [];
    const tentativelyIgnored: IgnoredEntry[] = [];
    for (const file of files) {
      const name = basename(file.relativePath);
      if (RESERVED_INPUT.has(name)) {
        tentativelyIgnored.push({ path: file.relativePath, reason: "reserved" });
        continue;
      }
      const lower = file.relativePath.toLowerCase();
      if (lower.endsWith(".md")) {
        // Conformance is confirmed in pass 3 by parsing frontmatter.
        conformantCandidates.push({ ...file, classification: "conformant" });
        continue;
      }
      if (
        matchesAny(lower, TEXT_READABLE_EXTENSIONS) ||
        matchesAny(lower, IMAGE_EXTENSIONS) ||
        matchesAny(lower, EXTRACTABLE_EXTENSIONS)
      ) {
        // Extractable formats are refined by pass 2 (they become forAgent with
        // an `extractedTextPath`, or ignored on extraction failure). Text and
        // image formats are read directly by the agent.
        nonConformantCandidates.push({ ...file, classification: "non-conformant" });
        continue;
      }
      tentativelyIgnored.push({ path: file.relativePath, reason: "unsupported" });
    }

    // Pass 2 — extraction pass over the non-conformant candidates, in input
    // order. Mirrors the old `runExtractionPass`.
    const forAgentFromExtraction: InputFile[] = [];
    const extractionIgnored: IgnoredEntry[] = [];
    for (const file of nonConformantCandidates) {
      if (!matchesAny(file.relativePath.toLowerCase(), EXTRACTABLE_EXTENSIONS)) {
        // Text-readable / image: read directly by the agent, no extraction.
        forAgentFromExtraction.push(file);
        continue;
      }
      const result = await extractToTempFile(
        this.paths.input,
        file.relativePath,
        file.absolutePath,
      );
      if (result.success) {
        const artifact: ExtractedArtifact = result.data;
        forAgentFromExtraction.push({
          ...file,
          extractedTextPath: artifact.extractedTextPath,
          tempRelativeName: artifact.tempRelativeName,
          sourceFormat: artifact.sourceFormat,
        });
      } else {
        extractionIgnored.push({
          path: file.relativePath,
          reason: asIgnoreReason(result.error.cause) ?? "extraction_failed",
          detail: result.error.message,
        });
      }
    }

    // Pass 3 — deterministic conformant intake, over the conformant candidates
    // in input order. Replaces the old `importConformant` (read + verify +
    // write to wiki/ + archive original). A `.md` that turns out to lack
    // frontmatter/type is NOT ignored — it is `forAgent` (deferred hybrid
    // ingestion). Any io step failing (read, write, or archive) is `ignored`
    // with `io_failed`. A failed archive move does NOT count the file as
    // imported (matching the original: `importConformant` returned the move
    // error and did not push the concept id), even though the concept is
    // already written to `wiki/` in that case (the write happened before the
    // move).
    const conformantImported: string[] = [];
    const deferredForAgent: InputFile[] = [];
    const conformantIoIgnored: IgnoredEntry[] = [];
    for (const file of conformantCandidates) {
      const imported = await importConformant(file, this.paths);
      if (imported.success) {
        conformantImported.push(imported.data);
      } else if (imported.error.cause === "non-conformant") {
        deferredForAgent.push({ ...file, classification: "non-conformant" });
      } else {
        conformantIoIgnored.push({
          path: file.relativePath,
          reason: "io_failed",
          detail: imported.error.message,
        });
      }
    }

    const forAgent = [...forAgentFromExtraction, ...deferredForAgent];
    const ignored = [...tentativelyIgnored, ...extractionIgnored, ...conformantIoIgnored];
    return ok({ conformantImported, forAgent, ignored });
  }
}

/**
 * Read + verify + write + archive a single conformant `.md` candidate. This is
 * the deterministic intake for one file:
 * - Read the file. On read failure → `io_failed` (do NOT also try to write).
 * - Parse frontmatter. If missing frontmatter or `type` → `non-conformant`
 *   (deferred to the agent; no io, no write).
 * - Else (conformant): write the content to `wiki/<relative-path>`. On write
 *   failure → `io_failed`.
 * - Then resolve the archive target and move the original there. On move
 *   failure → `io_failed` (and do NOT push the concept id, even though the
 *   concept is already in `wiki/` — matches the original `importConformant`).
 * - On full success → the concept id.
 *
 * Returns the concept id on success; the cause is `"non-conformant"` when
 * frontmatter/type is missing and `"io_failed"` when any io step failed.
 */
async function importConformant(
  file: InputFile,
  paths: WikiPaths,
): Promise<Result<string>> {
  const content = await readTextFile(file.absolutePath);
  if (!content.success) {
    return err<string>(content.error.message, {
      path: file.relativePath,
      cause: "io_failed",
    });
  }
  const parsed = parseDocument(content.data);
  if (!parsed.frontmatter || !parsed.frontmatter.type) {
    return err<string>("missing frontmatter or type field", {
      path: file.relativePath,
      cause: "non-conformant",
    });
  }
  const targetPath = `${paths.wiki}/${file.relativePath}`;
  const writeResult = await writeTextFile(targetPath, content.data);
  if (!writeResult.success) {
    return err<string>(writeResult.error.message, {
      path: file.relativePath,
      cause: "io_failed",
    });
  }
  const archivePath = await resolveArchiveTarget(paths.archive, file.relativePath);
  const moveResult = await moveFile(file.absolutePath, archivePath);
  if (!moveResult.success) {
    return err<string>(moveResult.error.message, {
      path: file.relativePath,
      cause: "io_failed",
    });
  }
  return ok(conceptIdFromRelativePath(file.relativePath));
}

/** True iff `lowerPath` (already lowercased) ends with any of `extensions`. */
function matchesAny(lowerPath: string, extensions: readonly string[]): boolean {
  return extensions.some((extension) => lowerPath.endsWith(extension));
}

/**
 * Map an extraction error `cause` to a stable `IgnoreReason`. Only extraction
 * causes flow through here; `io_failed` is set directly by `importConformant`
 * and never arrives here. Unknown causes fall back to `extraction_failed`.
 */
function asIgnoreReason(cause: string | undefined): IgnoreReason | undefined {
  if (cause === "encrypted" || cause === "extraction_failed" || cause === "empty") {
    return cause;
  }
  return undefined;
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}