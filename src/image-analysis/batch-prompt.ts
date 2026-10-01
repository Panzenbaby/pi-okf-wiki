// Prompt construction and response parsing for batched image pre-analysis.
// Pure functions (no model access), shared by the repository and tests.

import { err, ok, type ImageFinding, type ImageFindingClassification, type Result } from "../types.ts";

/** One image of a batch, with everything the model needs to place it. */
export interface ImageAnalysisRequestItem {
  readonly id: string;
  readonly documentPath: string;
  readonly locations: readonly string[];
  readonly context?: string;
  readonly data: Uint8Array;
  readonly mediaType: string;
}

/** Characters of surrounding text sent per image (keeps batch prompts small). */
export const MAX_PROMPT_CONTEXT_CHARACTERS = 600;

export const IMAGE_ANALYSIS_SYSTEM_PROMPT = `You analyze images extracted from documents so their knowledge can be added to a knowledge base.
Report only what is actually visible. Never guess, never infer values that are not legible, and never invent labels.
Answer with JSON only.`;

/** Text that precedes the images of one batch. */
export function buildBatchInstructions(items: readonly ImageAnalysisRequestItem[]): string {
  const ids = items.map((item) => item.id).join(", ");
  return `Analyze each of the following ${items.length} image(s) (IDs: ${ids}). Each image is preceded by its ID, its location in the source document, and the surrounding document text.

For EVERY image return one finding:
- "id": the image ID exactly as given.
- "classification": "content" (carries knowledge: chart, diagram, table, screenshot, photo with information), "decorative" (logo, icon, ornament, placeholder, divider — no knowledge), or "unreadable" (content exists but cannot be read reliably, e.g. blurred, garbled, too small).
- "description": what the image shows and its main finding(s), in the language of the surrounding text. For charts: chart type, axes, series, and the key comparison. Keep it concise.
- "legibleValues": every legible value, label, category, legend entry, and number exactly as printed (keep units, decimal separators, and spelling). When the image makes the pairing visible, pair each data value with its category and series, e.g. "Modell v1.0 — Genauigkeit: 64.2%". Axis tick labels may be summarized as a range. Empty list if none.
- "uncertainties": anything you could not read or are unsure about. Do not guess; list it here instead.

Use the surrounding text only to understand context; do not copy values from it that are not visible in the image.

Respond with exactly one JSON object and nothing else:
{"findings":[{"id":"img-01","classification":"content","description":"...","legibleValues":["..."],"uncertainties":["..."]}]}`;
}

/** Text placed directly before one image in the batch message. */
export function describeRequestItem(item: ImageAnalysisRequestItem): string {
  const locations = item.locations.length === 0 ? "unknown" : item.locations.join(" | ");
  const context = (item.context ?? "").replace(/\s+/g, " ").trim();
  const truncated = context.length > MAX_PROMPT_CONTEXT_CHARACTERS
    ? `${context.slice(0, MAX_PROMPT_CONTEXT_CHARACTERS)}…`
    : context;
  return `Image ID: ${item.id}\nDocument: ${item.documentPath}\nLocation: ${locations}\nSurrounding text: ${truncated.length === 0 ? "(none)" : truncated}`;
}

/**
 * Parse the model's JSON answer into findings, keeping only IDs that belong to
 * the batch (first finding per ID wins). Accepts a fenced code block, prose
 * around the JSON object, or a bare JSON array of findings.
 */
export function parseBatchResponse(text: string, expectedIds: readonly string[]): Result<readonly ImageFinding[]> {
  const parsed = parseJsonPayload(text);
  if (parsed === undefined) return err("Image analysis response is not valid JSON.", { cause: "invalid_response" });
  const rawFindings = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed["findings"]) ? parsed["findings"] : undefined;
  if (rawFindings === undefined) {
    return err("Image analysis response has no findings list.", { cause: "invalid_response" });
  }
  const expected = new Set(expectedIds);
  const findings: ImageFinding[] = [];
  const seen = new Set<string>();
  for (const raw of rawFindings) {
    const finding = toFinding(raw);
    if (finding === undefined || !expected.has(finding.id) || seen.has(finding.id)) continue;
    seen.add(finding.id);
    findings.push(finding);
  }
  return ok(findings);
}

function parseJsonPayload(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidates = [fenced, text, sliceBetween(text, "{", "}"), sliceBetween(text, "[", "]")];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate.trim().length === 0) continue;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

function sliceBetween(text: string, open: string, close: string): string | undefined {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  return start >= 0 && end > start ? text.slice(start, end + 1) : undefined;
}

function toFinding(raw: unknown): ImageFinding | undefined {
  if (!isRecord(raw)) return undefined;
  const id = raw["id"];
  const classification = raw["classification"];
  if (typeof id !== "string" || !isClassification(classification)) return undefined;
  const description = typeof raw["description"] === "string" ? raw["description"].trim() : "";
  return {
    id: id.trim(),
    classification,
    description,
    legibleValues: stringList(raw["legibleValues"]),
    uncertainties: stringList(raw["uncertainties"]),
  };
}

function isClassification(value: unknown): value is ImageFindingClassification {
  return value === "content" || value === "decorative" || value === "unreadable";
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") return value.trim().length === 0 ? [] : [value.trim()];
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): string => (typeof entry === "string" ? entry : typeof entry === "number" ? String(entry) : ""))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
