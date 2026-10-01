// Batched image pre-analysis for /wiki-update.
//
// Before the agent turn, every staged image of every document is sent in
// small batches to the session model (through `ImageAnalysisRepository`).
// The structured findings are written to `<stem>-image-findings.txt` next to
// the extracted text, so the agent reads ONE compact text file per document
// instead of loading every image into its context. Images the pre-pass could
// not analyze (no image-capable model, no auth, failed batch, missing finding,
// oversized for a model call) fall back to the previous behaviour: the agent
// reads them itself, capped at MAX_AGENT_FALLBACK_IMAGES per document.
//
// A failed batch never aborts the update; it only changes the affected
// images' status to `failed` (agent fallback) and adds a warning.

import { readFile } from "node:fs/promises";

import { writeTextFile } from "../files.ts";
import { aggregateWarnings } from "../warnings.ts";
import {
  IMAGE_STATUSES,
  type ImageFinding,
  type ImageStatus,
  type Result,
  type StagedImage,
} from "../types.ts";
import type { ImageAnalysisRequestItem } from "./batch-prompt.ts";
import {
  EMPTY_MODEL_USAGE,
  addUsage,
  type ImageAnalysisRepository,
  type ModelUsage,
} from "./repository.ts";

/** Images per model call. Small batches keep each call's payload and answer bounded. */
export const IMAGE_ANALYSIS_BATCH_SIZE = 5;
/** Model calls in flight at once during the pre-pass. */
export const IMAGE_ANALYSIS_CONCURRENCY = 3;
/** Raw image bytes per model call (base64 adds ~33 %). */
export const MAX_IMAGE_ANALYSIS_BATCH_BYTES = 12 * 1024 * 1024;
/** Larger images are not sent to the model; the agent's read tool resizes them instead. */
export const MAX_MODEL_IMAGE_BYTES = 5 * 1024 * 1024;
/** Images per document the agent must read itself when the pre-pass did not analyze them. */
export const MAX_AGENT_FALLBACK_IMAGES = 24;
/** Characters of surrounding text kept per occurrence in the findings file. */
const FINDINGS_CONTEXT_CHARACTERS = 300;

/** One document whose staged images should be pre-analyzed. */
export interface ImageAnalysisDocument {
  readonly relativePath: string;
  readonly images: readonly StagedImage[];
}

export interface ImagePrepassProgress {
  readonly completedBatches: number;
  readonly totalBatches: number;
  readonly relativePath: string;
}

export interface ImagePrepassOptions {
  readonly batchSize?: number;
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ImagePrepassProgress) => void;
  /** Loads staged image bytes; defaults to reading the staged path. Injectable for tests. */
  readonly readImage?: (path: string) => Promise<Uint8Array>;
}

export interface ImagePrepassResult {
  /** Documents in input order with updated image statuses/findings. */
  readonly documents: readonly ImageAnalysisDocument[];
  readonly warnings: readonly string[];
  readonly usage: ModelUsage;
  readonly modelCalls: number;
  readonly modelLabel?: string;
}

/** Batch plan for one document. */
export interface ImageBatchPlan {
  readonly batches: readonly (readonly string[])[];
  /** IDs too large to send to a model (agent fallback). */
  readonly oversized: readonly string[];
}

export interface BatchPlanningOptions {
  readonly batchSize?: number;
  readonly maxBatchBytes?: number;
  readonly maxImageBytes?: number;
}

/**
 * Split images into batches of at most `batchSize` images and
 * `maxBatchBytes` raw bytes, in order. Images above `maxImageBytes` are
 * reported as oversized instead of being batched.
 */
export function planImageBatches(
  images: readonly { readonly id: string; readonly byteLength: number }[],
  options: BatchPlanningOptions = {},
): ImageBatchPlan {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? IMAGE_ANALYSIS_BATCH_SIZE));
  const maxBatchBytes = options.maxBatchBytes ?? MAX_IMAGE_ANALYSIS_BATCH_BYTES;
  const maxImageBytes = options.maxImageBytes ?? MAX_MODEL_IMAGE_BYTES;
  const batches: string[][] = [];
  const oversized: string[] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const image of images) {
    if (image.byteLength > maxImageBytes) {
      oversized.push(image.id);
      continue;
    }
    if (current.length > 0 && (current.length >= batchSize || currentBytes + image.byteLength > maxBatchBytes)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(image.id);
    currentBytes += image.byteLength;
  }
  if (current.length > 0) batches.push(current);
  return { batches, oversized };
}

/** True when the agent still has to look at this image itself. */
export function awaitsAgent(image: StagedImage): boolean {
  return (image.status === "staged" || image.status === "failed") && image.path !== undefined;
}

/** The fallback images the agent is asked to read (first MAX_AGENT_FALLBACK_IMAGES). */
export function selectAgentFallbackImages(images: readonly StagedImage[]): readonly StagedImage[] {
  return images.filter(awaitsAgent).slice(0, MAX_AGENT_FALLBACK_IMAGES);
}

/**
 * Run the pre-pass. When `repository` is an error (pre-pass unavailable),
 * images stay `staged` and a single warning explains the agent fallback.
 */
export async function runImagePrepass(
  documents: readonly ImageAnalysisDocument[],
  repository: Result<ImageAnalysisRepository>,
  options: ImagePrepassOptions = {},
): Promise<ImagePrepassResult> {
  const warnings: string[] = [];
  const pendingCount = documents.reduce((count, document) => count + document.images.filter((image) => image.status === "staged").length, 0);
  if (pendingCount === 0) {
    return { documents, warnings, usage: EMPTY_MODEL_USAGE, modelCalls: 0 };
  }
  if (!repository.success) {
    warnings.push(`Image pre-analysis unavailable (${repository.error.message}); the agent reads embedded images itself.`);
    addFallbackOverflowWarnings(documents, warnings);
    return { documents, warnings, usage: EMPTY_MODEL_USAGE, modelCalls: 0 };
  }
  const analyzer = repository.data;
  const readImage = options.readImage ?? (async (path: string): Promise<Uint8Array> => new Uint8Array(await readFile(path)));
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? IMAGE_ANALYSIS_CONCURRENCY));
  const updates = documents.map(() => new Map<string, StagedImage>());
  const byId = documents.map((document) => new Map(document.images.map((image) => [image.id, image])));
  const tasks: { readonly documentIndex: number; readonly ids: readonly string[] }[] = [];
  for (const [documentIndex, document] of documents.entries()) {
    const plan = planImageBatches(
      document.images.filter((image) => image.status === "staged" && image.path !== undefined),
      options.batchSize === undefined ? {} : { batchSize: options.batchSize },
    );
    for (const id of plan.oversized) {
      const image = byId[documentIndex]?.get(id);
      if (image === undefined) continue;
      updates[documentIndex]?.set(id, { ...image, status: "failed", statusReason: `too large for a model call (over ${MAX_MODEL_IMAGE_BYTES} bytes)` });
    }
    for (const ids of plan.batches) tasks.push({ documentIndex, ids });
  }
  let usage = EMPTY_MODEL_USAGE;
  let modelCalls = 0;
  let completedBatches = 0;
  let cancelled = false;
  let nextTask = 0;

  const runTask = async (task: { readonly documentIndex: number; readonly ids: readonly string[] }): Promise<void> => {
    const document = documents[task.documentIndex];
    const images = byId[task.documentIndex];
    const documentUpdates = updates[task.documentIndex];
    if (document === undefined || images === undefined || documentUpdates === undefined) return;
    const batchImages = task.ids.map((id) => images.get(id)).filter((image): image is StagedImage => image !== undefined);
    if (cancelled || options.signal?.aborted === true) {
      cancelled = true;
      for (const image of batchImages) documentUpdates.set(image.id, { ...image, status: "failed", statusReason: "pre-analysis cancelled" });
      return;
    }
    const items: ImageAnalysisRequestItem[] = [];
    for (const image of batchImages) {
      try {
        items.push(toRequestItem(document.relativePath, image, await readImage(image.path ?? "")));
      } catch (error) {
        documentUpdates.set(image.id, { ...image, status: "failed", statusReason: `could not read staged image: ${errorMessage(error)}` });
      }
    }
    if (items.length === 0) return;
    modelCalls++;
    const result = await analyzer.analyzeBatch(items, options.signal);
    if (result.success) {
      usage = addUsage(usage, result.data.usage);
      const findings = new Map(result.data.findings.map((finding) => [finding.id, finding]));
      for (const item of items) {
        const image = images.get(item.id);
        if (image === undefined) continue;
        const finding = findings.get(item.id);
        documentUpdates.set(item.id, finding === undefined
          ? { ...image, status: "failed", statusReason: "the model returned no finding for this image" }
          : applyFinding(image, finding));
      }
      const missing = items.filter((item) => !findings.has(item.id)).length;
      if (missing > 0) warnings.push(`Image pre-analysis returned no finding for ${missing} image(s) of ${document.relativePath}; the agent reads them itself.`);
      return;
    }
    if (result.error.cause === "aborted") cancelled = true;
    for (const item of items) {
      const image = images.get(item.id);
      if (image !== undefined) documentUpdates.set(item.id, { ...image, status: "failed", statusReason: `pre-analysis batch failed: ${result.error.message}` });
    }
    warnings.push(result.error.cause === "aborted"
      ? "Image pre-analysis was cancelled; the agent reads the remaining images itself."
      : `Image pre-analysis batch failed (${result.error.message}); the agent reads the affected images itself.`);
  };

  // A small worker pool: at most `concurrency` model calls in flight.
  const worker = async (): Promise<void> => {
    while (nextTask < tasks.length) {
      const task = tasks[nextTask++];
      if (task === undefined) break;
      await runTask(task);
      completedBatches++;
      options.onProgress?.({
        completedBatches,
        totalBatches: tasks.length,
        relativePath: documents[task.documentIndex]?.relativePath ?? "",
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, tasks.length)) }, worker));

  const updatedDocuments: ImageAnalysisDocument[] = documents.map((document, documentIndex) => ({
    relativePath: document.relativePath,
    images: document.images.map((image) => updates[documentIndex]?.get(image.id) ?? image),
  }));
  addFallbackOverflowWarnings(updatedDocuments, warnings);
  return { documents: updatedDocuments, warnings: aggregateWarnings(warnings), usage, modelCalls, modelLabel: analyzer.modelLabel };
}

function addFallbackOverflowWarnings(documents: readonly ImageAnalysisDocument[], warnings: string[]): void {
  for (const document of documents) {
    const awaiting = document.images.filter(awaitsAgent).length;
    if (awaiting > MAX_AGENT_FALLBACK_IMAGES) {
      warnings.push(`${document.relativePath}: ${awaiting - MAX_AGENT_FALLBACK_IMAGES} image(s) were neither pre-analyzed nor handed to the agent (agent fallback limit ${MAX_AGENT_FALLBACK_IMAGES}).`);
    }
  }
}

function toRequestItem(documentPath: string, image: StagedImage, data: Uint8Array): ImageAnalysisRequestItem {
  const locations = [...new Set(image.occurrences.map((occurrence) => occurrence.location).filter((location): location is string => location !== undefined))];
  const context = image.occurrences.map((occurrence) => occurrence.context).find((value) => value !== undefined && value.trim().length > 0);
  return {
    id: image.id,
    documentPath,
    locations,
    ...(context === undefined ? {} : { context }),
    data,
    mediaType: image.mediaType,
  };
}

/** Map a model/agent finding to the image status it implies. */
export function applyFinding(image: StagedImage, finding: ImageFinding): StagedImage {
  const status: ImageStatus = finding.classification === "content"
    ? "analyzed"
    : finding.classification === "decorative" ? "decorative" : "unreadable";
  const { statusReason: _previousReason, ...rest } = image;
  return { ...rest, status, finding };
}

/** Count images per status (every status present, zero when absent). */
export function countImageStatuses(images: readonly StagedImage[]): Record<ImageStatus, number> {
  const counts = Object.fromEntries(IMAGE_STATUSES.map((status) => [status, 0])) as Record<ImageStatus, number>;
  for (const image of images) counts[image.status]++;
  return counts;
}

/** Render the findings file the agent reads instead of the raw images. */
export function renderImageFindings(document: ImageAnalysisDocument, modelLabel: string | undefined): string {
  const counts = countImageStatuses(document.images);
  const fallback = new Set(selectAgentFallbackImages(document.images).map((image) => image.id));
  const occurrenceCount = document.images.reduce((count, image) => count + image.occurrences.length, 0);
  const lines: string[] = [
    `Image findings for input/${document.relativePath}`,
    modelLabel !== undefined
      ? `Pre-analyzed by the pi-okf-wiki extension with ${modelLabel}. Findings report only what was legible; uncertainties are listed, not guessed.`
      : fallback.size > 0
        ? "No image pre-analysis model was available; images marked NOT PRE-ANALYZED must be read with the read tool."
        : "No image needed model analysis (all images are decorative or broken).",
    `${document.images.length} unique image(s), ${occurrenceCount} occurrence(s) in the document. Status: ${IMAGE_STATUSES.map((status) => `${status} ${counts[status]}`).join(", ")}.`,
    "",
  ];
  for (const image of document.images) {
    const heading = image.finding === undefined
      ? fallback.has(image.id)
        ? `## ${image.id} — NOT PRE-ANALYZED: read ${image.path ?? "(missing path)"} yourself`
        : `## ${image.id} — ${image.status}`
      : `## ${image.id} — ${image.status} (${image.finding.classification})`;
    lines.push(heading);
    if (image.statusReason !== undefined) lines.push(`Reason: ${image.statusReason}`);
    for (const [index, occurrence] of image.occurrences.entries()) {
      const context = (occurrence.context ?? "").replace(/\s+/g, " ").trim();
      const shortContext = context.length > FINDINGS_CONTEXT_CHARACTERS ? `${context.slice(0, FINDINGS_CONTEXT_CHARACTERS)}…` : context;
      lines.push(`${index === 0 ? "Location" : "Also at"}: ${occurrence.location ?? "unknown"}${shortContext.length === 0 ? "" : ` — surrounding text: ${shortContext}`}`);
    }
    if (image.finding !== undefined) {
      if (image.finding.description.length > 0) lines.push(`Description: ${image.finding.description}`);
      if (image.finding.legibleValues.length > 0) {
        lines.push("Legible values:");
        for (const value of image.finding.legibleValues) lines.push(`  - ${value}`);
      }
      if (image.finding.uncertainties.length > 0) {
        lines.push("Uncertainties:");
        for (const value of image.finding.uncertainties) lines.push(`  - ${value}`);
      }
      if (image.path !== undefined) lines.push(`Staged image (optional spot check): ${image.path}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export interface FindingsWriteOutcome {
  readonly warnings: readonly string[];
  /** Input-relative paths of documents whose findings file could not be written. */
  readonly failedDocuments: ReadonlySet<string>;
}

/** Write one findings file per document. Failed writes are reported, never thrown. */
export async function writeImageFindings(
  entries: readonly { readonly document: ImageAnalysisDocument; readonly findingsPath: string }[],
  modelLabel: string | undefined,
): Promise<FindingsWriteOutcome> {
  const warnings: string[] = [];
  const failedDocuments = new Set<string>();
  for (const entry of entries) {
    const written = await writeTextFile(entry.findingsPath, renderImageFindings(entry.document, modelLabel));
    if (!written.success) {
      warnings.push(`Could not write image findings for ${entry.document.relativePath}: ${written.error.message}`);
      failedDocuments.add(entry.document.relativePath);
    }
  }
  return { warnings, failedDocuments };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
