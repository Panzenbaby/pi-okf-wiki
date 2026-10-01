import { describe, expect, it } from "vitest";

import { parseBatchResponse, type ImageAnalysisRequestItem } from "../src/image-analysis/batch-prompt.ts";
import {
  createModelImageAnalysisRepository,
  type ImageAnalysisBatchResult,
  type ImageAnalysisRepository,
} from "../src/image-analysis/repository.ts";
import {
  MAX_AGENT_FALLBACK_IMAGES,
  planImageBatches,
  renderImageFindings,
  runImagePrepass,
  selectAgentFallbackImages,
} from "../src/image-analysis/prepass.ts";
import { err, ok, type Result, type StagedImage } from "../src/types.ts";

function stagedImage(number: number, overrides: Partial<StagedImage> = {}): StagedImage {
  const id = `img-${String(number).padStart(2, "0")}`;
  return {
    id,
    path: `/tmp/staged/${id}.png`,
    mediaType: "image/png",
    byteLength: 1000,
    sha256: id,
    occurrences: [{ location: `Page ${number}`, context: `Context ${number}` }],
    status: "staged",
    ...overrides,
  };
}

/** Fake repository: fails batches containing `failingId`, omits `omittedId`. */
class FakeRepository implements ImageAnalysisRepository {
  readonly modelLabel = "fake/vision";
  readonly batches: string[][] = [];
  private readonly failingId: string | undefined;
  private readonly omittedId: string | undefined;

  constructor(options: { readonly failingId?: string; readonly omittedId?: string } = {}) {
    this.failingId = options.failingId;
    this.omittedId = options.omittedId;
  }

  async analyzeBatch(items: readonly ImageAnalysisRequestItem[]): Promise<Result<ImageAnalysisBatchResult>> {
    this.batches.push(items.map((item) => item.id));
    if (items.some((item) => item.id === this.failingId)) return err("HTTP 500", { cause: "model_error" });
    return ok({
      findings: items
        .filter((item) => item.id !== this.omittedId)
        .map((item) => ({
          id: item.id,
          classification: item.id === "img-03" ? "decorative" as const : "content" as const,
          description: `Chart for ${item.locations.join(", ")}`,
          legibleValues: ["Q1: 10"],
          uncertainties: [],
        })),
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cost: 0.001 },
    });
  }
}

const readImage = async (): Promise<Uint8Array> => new Uint8Array([1, 2, 3]);

describe("planImageBatches", () => {
  it("splits by image count and by bytes, and reports oversized images", () => {
    const images = [
      { id: "a", byteLength: 10 }, { id: "b", byteLength: 10 }, { id: "c", byteLength: 10 },
      { id: "huge", byteLength: 1000 }, { id: "d", byteLength: 60 }, { id: "e", byteLength: 50 },
    ];
    const plan = planImageBatches(images, { batchSize: 2, maxBatchBytes: 100, maxImageBytes: 500 });
    expect(plan.batches).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(plan.oversized).toEqual(["huge"]);
  });
});

describe("runImagePrepass", () => {
  it("analyzes staged images in batches and leaves decorative/broken ones untouched", async () => {
    const repository = new FakeRepository();
    const images = [
      stagedImage(1), stagedImage(2), stagedImage(3),
      stagedImage(4, { status: "broken", statusReason: "row striping" }),
      stagedImage(5, { status: "decorative", statusReason: "tiny image (1×1 px)" }),
    ];
    const result = await runImagePrepass([{ relativePath: "report.docx", images }], ok(repository), { batchSize: 2, readImage, concurrency: 1 });
    expect(repository.batches).toEqual([["img-01", "img-02"], ["img-03"]]);
    const statuses = result.documents[0]?.images.map((image) => image.status);
    expect(statuses).toEqual(["analyzed", "analyzed", "decorative", "broken", "decorative"]);
    expect(result.modelCalls).toBe(2);
    expect(result.usage.inputTokens).toBe(200);
    expect(result.warnings).toEqual([]);
  });

  it("keeps going after a failed batch and marks only its images as failed (agent fallback)", async () => {
    const repository = new FakeRepository({ failingId: "img-01", omittedId: "img-04" });
    const images = [stagedImage(1), stagedImage(2), stagedImage(3), stagedImage(4)];
    const result = await runImagePrepass([{ relativePath: "report.docx", images }], ok(repository), { batchSize: 2, readImage, concurrency: 1 });
    const updated = result.documents[0]?.images ?? [];
    expect(updated.map((image) => image.status)).toEqual(["failed", "failed", "decorative", "failed"]);
    expect(updated[0]?.statusReason).toContain("HTTP 500");
    expect(updated[3]?.statusReason).toContain("no finding");
    expect(result.warnings.some((warning) => warning.includes("batch failed"))).toBe(true);
    expect(selectAgentFallbackImages(updated).map((image) => image.id)).toEqual(["img-01", "img-02", "img-04"]);
  });

  it("falls back to the agent when the model has no image input", async () => {
    const repository = createModelImageAnalysisRepository(
      { hasConfiguredAuth: () => true, complete: async () => ({ content: [] }) },
      { provider: "local", id: "text-only", input: ["text"] },
    );
    expect(repository.success).toBe(false);
    if (repository.success) return;
    expect(repository.error.cause).toBe("no_image_input");
    const images = [stagedImage(1)];
    const result = await runImagePrepass([{ relativePath: "report.pdf", images }], repository, { readImage });
    expect(result.modelCalls).toBe(0);
    expect(result.documents[0]?.images[0]?.status).toBe("staged");
    expect(result.warnings[0]).toContain("does not accept image input");
    expect(renderImageFindings(result.documents[0] ?? { relativePath: "", images: [] }, undefined))
      .toContain("img-01 — NOT PRE-ANALYZED");
  });

  it("caps the images the agent has to read itself", () => {
    const images = Array.from({ length: MAX_AGENT_FALLBACK_IMAGES + 3 }, (_, index) => stagedImage(index + 1));
    expect(selectAgentFallbackImages(images)).toHaveLength(MAX_AGENT_FALLBACK_IMAGES);
  });
});

describe("model image analysis repository", () => {
  it("rejects missing auth and older registries without nested completion", () => {
    const model = { provider: "p", id: "vision", input: ["text", "image"] };
    const noAuth = createModelImageAnalysisRepository({ hasConfiguredAuth: () => false, complete: async () => ({ content: [] }) }, model);
    expect(noAuth.success ? undefined : noAuth.error.cause).toBe("no_auth");
    const oldRegistry = createModelImageAnalysisRepository({ hasConfiguredAuth: () => true }, model);
    expect(oldRegistry.success ? undefined : oldRegistry.error.cause).toBe("no_completion_api");
    expect(createModelImageAnalysisRepository({}, undefined).success).toBe(false);
  });

  it("sends images as base64 content and maps findings and usage", async () => {
    const calls: unknown[] = [];
    const registry = {
      hasConfiguredAuth: () => true,
      complete: async (_model: unknown, context: unknown) => {
        calls.push(context);
        return {
          content: [{ type: "text", text: '```json\n{"findings":[{"id":"img-01","classification":"content","description":"Bar chart","legibleValues":["v1.0: 64.2%"],"uncertainties":[]},{"id":"img-99","classification":"content"}]}\n```' }],
          stopReason: "stop",
          usage: { input: 50, output: 10, totalTokens: 60, cost: { total: 0.002 } },
        };
      },
    };
    const repository = createModelImageAnalysisRepository(registry, { provider: "p", id: "vision", input: ["text", "image"] });
    expect(repository.success).toBe(true);
    if (!repository.success) return;
    const result = await repository.data.analyzeBatch([{
      id: "img-01", documentPath: "doc.pdf", locations: ["Page 2"], context: "Benchmark", data: new Uint8Array([1, 2, 3]), mediaType: "image/png",
    }]);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.findings).toEqual([{ id: "img-01", classification: "content", description: "Bar chart", legibleValues: ["v1.0: 64.2%"], uncertainties: [] }]);
    expect(result.data.usage).toEqual({ inputTokens: 50, outputTokens: 10, totalTokens: 60, cost: 0.002 });
    const context = calls[0] as { messages: { content: { type: string; data?: string; text?: string }[] }[] };
    const content = context.messages[0]?.content ?? [];
    expect(content.some((part) => part.type === "image" && part.data === "AQID")).toBe(true);
    expect(content.some((part) => part.type === "text" && (part.text ?? "").includes("Location: Page 2"))).toBe(true);
  });

  it("reports provider errors as a failed Result instead of throwing", async () => {
    const repository = createModelImageAnalysisRepository(
      { hasConfiguredAuth: () => true, complete: async () => ({ content: [], stopReason: "error", errorMessage: "rate limited" }) },
      { provider: "p", id: "vision", input: ["image"] },
    );
    if (!repository.success) throw new Error("expected repository");
    const result = await repository.data.analyzeBatch([{ id: "img-01", documentPath: "d", locations: [], data: new Uint8Array(), mediaType: "image/png" }]);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain("rate limited");
  });
});

describe("parseBatchResponse", () => {
  it("accepts a bare JSON array with prose around it and ignores unknown IDs and bad entries", () => {
    const parsed = parseBatchResponse('Here you go: [{"id":"img-02","classification":"unreadable","description":"blurred","legibleValues":"","uncertainties":["axis"]},{"id":"img-02","classification":"content"},{"id":"img-03","classification":"maybe"}] done', ["img-02", "img-03"]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual([{ id: "img-02", classification: "unreadable", description: "blurred", legibleValues: [], uncertainties: ["axis"] }]);
  });

  it("rejects non-JSON answers", () => {
    expect(parseBatchResponse("I cannot see any image.", ["img-01"]).success).toBe(false);
  });
});
