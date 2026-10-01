// ImageAnalysisRepository — the only place that talks to a model for image
// pre-analysis. Wraps Pi's model registry (`ctx.modelRegistry.complete`) for
// the current session model; the registry/model/message shapes are Dtos that
// never leave this module. Callers get `Result<ImageAnalysisBatchResult>`.
//
// The registry is typed structurally and detected at runtime: older Pi
// versions without `ModelRegistry.complete` simply report the pre-pass as
// unavailable, and `/wiki-update` falls back to the agent reading images.

import { err, ok, type ImageFinding, type Result } from "../types.ts";
import {
  IMAGE_ANALYSIS_SYSTEM_PROMPT,
  buildBatchInstructions,
  describeRequestItem,
  parseBatchResponse,
  type ImageAnalysisRequestItem,
} from "./batch-prompt.ts";

/** Token/cost usage of nested model calls (AppModel). */
export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  /** Total cost as reported by the provider (0 when unknown). */
  readonly cost: number;
}

export const EMPTY_MODEL_USAGE: ModelUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 };

export function addUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    cost: left.cost + right.cost,
  };
}

export interface ImageAnalysisBatchResult {
  /** Findings for the batch's IDs; IDs the model skipped are absent. */
  readonly findings: readonly ImageFinding[];
  readonly usage: ModelUsage;
}

/** Analyze one batch of images. Never throws; `error.cause` is a stable code. */
export interface ImageAnalysisRepository {
  /** Human-readable model label, e.g. `requesty/gpt-6-luna`. */
  readonly modelLabel: string;
  analyzeBatch(items: readonly ImageAnalysisRequestItem[], signal?: AbortSignal): Promise<Result<ImageAnalysisBatchResult>>;
}

/** Why the pre-pass cannot run with the session model. */
export type ImageAnalysisUnavailableCause =
  | "no_model"
  | "no_image_input"
  | "no_auth"
  | "no_completion_api";

// ----- Dtos (Pi model registry shapes), internal to this repository -----

interface ModelDto {
  readonly provider: string;
  readonly id: string;
  readonly input: readonly string[];
  readonly maxTokens?: number;
}

interface TextContentDto {
  readonly type: "text";
  readonly text: string;
}

interface ImageContentDto {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

interface UserMessageDto {
  readonly role: "user";
  readonly content: readonly (TextContentDto | ImageContentDto)[];
  readonly timestamp: number;
}

interface CompletionContextDto {
  readonly systemPrompt: string;
  readonly messages: readonly UserMessageDto[];
}

interface CompletionOptionsDto {
  readonly signal?: AbortSignal;
  readonly maxTokens?: number;
}

interface AssistantContentDto {
  readonly type: string;
  readonly text?: string;
}

interface UsageDto {
  readonly input?: number;
  readonly output?: number;
  readonly totalTokens?: number;
  readonly cost?: { readonly total?: number };
}

interface AssistantMessageDto {
  readonly content: readonly AssistantContentDto[];
  readonly stopReason?: string;
  readonly errorMessage?: string;
  readonly usage?: UsageDto;
}

interface ModelRegistryDto {
  hasConfiguredAuth(model: ModelDto): boolean;
  complete(model: ModelDto, context: CompletionContextDto, options?: CompletionOptionsDto): Promise<AssistantMessageDto>;
}

/** Output tokens requested per image in a batch (plus a fixed overhead). */
const OUTPUT_TOKENS_PER_IMAGE = 1200;
const OUTPUT_TOKENS_OVERHEAD = 800;
const MAX_OUTPUT_TOKENS = 16_000;

/**
 * Create a repository for the given registry and model (normally
 * `ctx.modelRegistry` / `ctx.model`). Returns an error with an
 * `ImageAnalysisUnavailableCause` when the pre-pass cannot use them.
 */
export function createModelImageAnalysisRepository(
  registry: unknown,
  model: unknown,
): Result<ImageAnalysisRepository> {
  if (!isModelDto(model)) {
    return err("No session model is selected.", { cause: "no_model" satisfies ImageAnalysisUnavailableCause });
  }
  const label = `${model.provider}/${model.id}`;
  if (!model.input.includes("image")) {
    return err(`Model ${label} does not accept image input.`, { cause: "no_image_input" satisfies ImageAnalysisUnavailableCause });
  }
  if (!isModelRegistryDto(registry)) {
    return err("This Pi version does not offer nested model calls (ModelRegistry.complete).", {
      cause: "no_completion_api" satisfies ImageAnalysisUnavailableCause,
    });
  }
  let hasAuth = false;
  try {
    hasAuth = registry.hasConfiguredAuth(model);
  } catch {
    hasAuth = false;
  }
  if (!hasAuth) {
    return err(`No authentication is configured for ${label}.`, { cause: "no_auth" satisfies ImageAnalysisUnavailableCause });
  }
  return ok(new ModelImageAnalysisRepository(registry, model, label));
}

class ModelImageAnalysisRepository implements ImageAnalysisRepository {
  readonly modelLabel: string;
  private readonly registry: ModelRegistryDto;
  private readonly model: ModelDto;

  constructor(registry: ModelRegistryDto, model: ModelDto, modelLabel: string) {
    this.registry = registry;
    this.model = model;
    this.modelLabel = modelLabel;
  }

  async analyzeBatch(
    items: readonly ImageAnalysisRequestItem[],
    signal?: AbortSignal,
  ): Promise<Result<ImageAnalysisBatchResult>> {
    if (isAborted(signal)) return err("Image analysis was cancelled.", { cause: "aborted" });
    const content: (TextContentDto | ImageContentDto)[] = [{ type: "text", text: buildBatchInstructions(items) }];
    for (const item of items) {
      content.push({ type: "text", text: describeRequestItem(item) });
      content.push({ type: "image", data: Buffer.from(item.data).toString("base64"), mimeType: item.mediaType });
    }
    const requestedTokens = Math.min(MAX_OUTPUT_TOKENS, OUTPUT_TOKENS_OVERHEAD + OUTPUT_TOKENS_PER_IMAGE * items.length);
    const maxTokens = this.model.maxTokens === undefined || this.model.maxTokens <= 0
      ? requestedTokens
      : Math.min(requestedTokens, this.model.maxTokens);
    let response: AssistantMessageDto;
    try {
      response = await this.registry.complete(
        this.model,
        {
          systemPrompt: IMAGE_ANALYSIS_SYSTEM_PROMPT,
          messages: [{ role: "user", content, timestamp: Date.now() }],
        },
        { maxTokens, ...(signal === undefined ? {} : { signal }) },
      );
    } catch (error) {
      if (isAborted(signal)) return err("Image analysis was cancelled.", { cause: "aborted" });
      return err(`Model call failed: ${error instanceof Error ? error.message : String(error)}`, { cause: "model_error" });
    }
    const usage = toUsage(response.usage);
    if (response.stopReason === "aborted") return err("Image analysis was cancelled.", { cause: "aborted" });
    if (response.stopReason === "error") {
      return err(`Model call failed: ${response.errorMessage ?? "unknown error"}`, { cause: "model_error" });
    }
    const text = response.content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text ?? "")
      .join("\n");
    const parsed = parseBatchResponse(text, items.map((item) => item.id));
    if (!parsed.success) {
      const truncated = response.stopReason === "length" ? " (response was truncated)" : "";
      return err(`${parsed.error.message}${truncated}`, { cause: "invalid_response" });
    }
    return ok({ findings: parsed.data, usage });
  }
}

function toUsage(usage: UsageDto | undefined): ModelUsage {
  if (usage === undefined) return EMPTY_MODEL_USAGE;
  const inputTokens = finiteOrZero(usage.input);
  const outputTokens = finiteOrZero(usage.output);
  return {
    inputTokens,
    outputTokens,
    totalTokens: finiteOrZero(usage.totalTokens) || inputTokens + outputTokens,
    cost: finiteOrZero(usage.cost?.total),
  };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function finiteOrZero(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isModelDto(value: unknown): value is ModelDto {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { provider?: unknown; id?: unknown; input?: unknown };
  return typeof candidate.provider === "string"
    && typeof candidate.id === "string"
    && Array.isArray(candidate.input)
    && candidate.input.every((entry) => typeof entry === "string");
}

function isModelRegistryDto(value: unknown): value is ModelRegistryDto {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { complete?: unknown; hasConfiguredAuth?: unknown };
  return typeof candidate.complete === "function" && typeof candidate.hasConfiguredAuth === "function";
}
