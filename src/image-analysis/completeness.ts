// Completeness bookkeeping for embedded images: parse the agent's reported
// outcomes for fallback images, and summarize each document's image statuses
// for wiki/log.md (counts per status + IDs that never got a finding).

import {
  IMAGE_STATUSES,
  type ImageFindingClassification,
  type StagedImage,
} from "../types.ts";
import { applyFinding, countImageStatuses } from "./prepass.ts";

/** One `<document> img-NN: <classification>` line the agent reported. */
export interface AgentImageOutcome {
  /** Document as written by the agent (input-relative, `input/` stripped); empty when omitted. */
  readonly documentPath: string;
  readonly id: string;
  readonly classification: ImageFindingClassification;
  readonly note: string;
}

/** Heading the agent uses for its outcome list (see the update prompt). */
export const IMAGE_OUTCOMES_HEADING = "## Image outcomes";

/**
 * Parse outcome lines such as
 * `- reports/sales.pptx img-03: content — revenue chart` from the agent's
 * final message. Lines without an image ID and a valid classification are ignored.
 */
export function parseAgentImageOutcomes(text: string): AgentImageOutcome[] {
  const outcomes: AgentImageOutcome[] = [];
  const pattern = /^\s*(?:[-*]\s*)?(.*?)\s*`?\b(img-\d+)\b`?\s*[:=–—-]\s*\**(content|decorative|unreadable)\b\**\s*(?:[—–:-]\s*)?(.*)$/i;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(pattern);
    if (match === null) continue;
    const documentPath = (match[1] ?? "")
      .replace(/[`*]/g, "")
      .replace(/[:,]\s*$/, "")
      .trim()
      .replace(/^input\//, "");
    outcomes.push({
      documentPath,
      id: (match[2] ?? "").toLowerCase(),
      classification: (match[3] ?? "content").toLowerCase() as ImageFindingClassification,
      note: (match[4] ?? "").trim(),
    });
  }
  return outcomes;
}

/** A document's images, keyed by its input-relative path. */
export interface DocumentImages {
  readonly relativePath: string;
  readonly images: readonly StagedImage[];
}

/**
 * Apply agent-reported outcomes to images that were still awaiting the agent
 * (`staged` / `failed`). An outcome without a document path is applied only
 * when exactly one document has an awaiting image with that ID.
 */
export function applyAgentImageOutcomes(
  documents: readonly DocumentImages[],
  outcomes: readonly AgentImageOutcome[],
): DocumentImages[] {
  const awaiting = (image: StagedImage): boolean => image.status === "staged" || image.status === "failed";
  return documents.map((document) => ({
    relativePath: document.relativePath,
    images: document.images.map((image) => {
      if (!awaiting(image)) return image;
      const outcome = outcomes.find((candidate) => {
        if (candidate.id !== image.id) return false;
        if (candidate.documentPath.length > 0) {
          return candidate.documentPath === document.relativePath || candidate.documentPath.endsWith(`/${document.relativePath}`);
        }
        return documents.filter((other) => other.images.some((otherImage) => otherImage.id === image.id && awaiting(otherImage))).length === 1;
      });
      if (outcome === undefined) return image;
      return applyFinding(image, {
        id: image.id,
        classification: outcome.classification,
        description: outcome.note,
        legibleValues: [],
        uncertainties: [],
      });
    }),
  }));
}

/** IDs that still have no outcome (never analyzed by the model or the agent). */
export function imagesMissingFinding(images: readonly StagedImage[]): string[] {
  return images.filter((image) => image.status === "staged" || image.status === "failed").map((image) => image.id);
}

/**
 * One concise log line per document, e.g.
 * `reports/q3.docx: 41 occurrence(s), 39 unique — analyzed 36, decorative 1, …; missing findings: none`.
 */
export function summarizeDocumentImages(document: DocumentImages): string {
  const counts = countImageStatuses(document.images);
  const occurrences = document.images.reduce((count, image) => count + image.occurrences.length, 0);
  const missing = imagesMissingFinding(document.images);
  const statusText = IMAGE_STATUSES.map((status) => `${status} ${counts[status]}`).join(", ");
  return `${document.relativePath}: ${occurrences} occurrence(s), ${document.images.length} unique — ${statusText}; missing findings: ${missing.length === 0 ? "none" : missing.join(", ")}`;
}
