import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentEndEvent, ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { intakeSessionRegistry, runUpdate } from "../src/update.ts";
import { createChartPng, createUniformPng } from "./support/images.ts";

let workdir: string;

beforeEach(async () => {
  workdir = join(tmpdir(), `okf-update-images-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(workdir, "input"), { recursive: true });
  intakeSessionRegistry.reset();
});

afterEach(async () => {
  intakeSessionRegistry.reset();
  await rm(workdir, { recursive: true, force: true });
});

interface FakeHarness {
  readonly pi: ExtensionAPI;
  readonly ctx: ExtensionCommandContext;
  readonly prompts: string[];
  readonly modelCalls: number[];
}

function harness(model: { provider: string; id: string; input: string[] }): FakeHarness {
  const prompts: string[] = [];
  const modelCalls: number[] = [];
  const registry = {
    hasConfiguredAuth: (): boolean => true,
    complete: async (_model: unknown, context: { messages: { content: { type: string; text?: string }[] }[] }) => {
      const ids = (context.messages[0]?.content ?? [])
        .map((part) => part.text?.match(/^Image ID: (img-\d+)/)?.[1])
        .filter((id): id is string => id !== undefined);
      modelCalls.push(ids.length);
      // Answer only for img-01, so img-02 falls back to the agent.
      const findings = ids.filter((id) => id === "img-01").map((id) => ({
        id, classification: "content", description: "Revenue bar chart", legibleValues: ["Q1: 10"], uncertainties: [],
      }));
      return { content: [{ type: "text", text: JSON.stringify({ findings }) }], stopReason: "stop", usage: { input: 10, output: 5, totalTokens: 15 } };
    },
  };
  const ui = {
    setWidget: (): void => undefined,
    notify: (): void => undefined,
    setStatus: (): void => undefined,
  };
  const ctx = { cwd: workdir, hasUI: true, ui, model, modelRegistry: registry, signal: undefined } as unknown as ExtensionCommandContext;
  const pi = { sendUserMessage: (message: string): void => { prompts.push(message); } } as unknown as ExtensionAPI;
  return { pi, ctx, prompts, modelCalls };
}

async function writeReport(): Promise<void> {
  const image = (png: Buffer, alt: string): string => `<img alt="${alt}" src="data:image/png;base64,${png.toString("base64")}"/>`;
  await writeFile(join(workdir, "input", "report.html"), [
    "<h2>Revenue</h2><p>Quarterly revenue</p>",
    image(createChartPng(160, 100, 1), "Revenue"),
    image(createChartPng(160, 100, 2), "Costs"),
    image(createUniformPng(1, 1, 0), "Spacer"),
  ].join(""));
}

function agentEnd(text: string): AgentEndEvent {
  return { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text }] }] } as unknown as AgentEndEvent;
}

describe("/wiki-update image pre-analysis", () => {
  it("hands the agent a findings file, lists only fallback images, and logs completeness", async () => {
    await writeReport();
    const { pi, ctx, prompts, modelCalls } = harness({ provider: "fake", id: "vision", input: ["text", "image"] });
    const result = await runUpdate(pi, ctx);
    expect(result.success).toBe(true);
    expect(modelCalls).toEqual([2]);
    const prompt = prompts[0] ?? "";
    const findingsPath = join(workdir, "input", ".okf-extract", "report-image-findings.txt");
    expect(prompt).toContain(`Image findings (READ this file instead of the images): ${findingsPath}`);
    expect(prompt).toContain("Images NOT pre-analyzed");
    expect(prompt).toContain("img-02: ");
    expect(prompt).not.toContain("img-01: ");
    const findings = await readFile(findingsPath, "utf8");
    expect(findings).toContain("## img-01 — analyzed (content)");
    expect(findings).toContain("Q1: 10");
    expect(findings).toContain("## img-02 — NOT PRE-ANALYZED");
    expect(findings).toContain("## img-03 — decorative");

    const session = intakeSessionRegistry.take();
    expect(session).toBeDefined();
    const report = await session?.finalize(ctx, agentEnd("## Transformed\n- x\n\n## Image outcomes\n- report.html img-02: content — cost chart"));
    expect(report?.imageSummaries[0]).toBe(
      "report.html: 3 occurrence(s), 3 unique — staged 0, analyzed 2, decorative 1, unreadable 0, broken 0, failed 0; missing findings: none",
    );
    expect(report?.imageSummaries[1]).toContain("Pre-analysis: 1 batch call(s) to fake/vision");
    const log = await readFile(join(workdir, "wiki", "log.md"), "utf8");
    expect(log).toContain("* **Images**: report.html: 3 occurrence(s)");
  });

  it("falls back to the agent reading images when the model has no image input", async () => {
    await writeReport();
    const { pi, ctx, prompts, modelCalls } = harness({ provider: "fake", id: "text-only", input: ["text"] });
    await runUpdate(pi, ctx);
    expect(modelCalls).toEqual([]);
    const prompt = prompts[0] ?? "";
    expect(prompt).toContain("img-01: ");
    expect(prompt).toContain("img-02: ");
    const session = intakeSessionRegistry.take();
    const report = await session?.finalize(ctx, agentEnd("## Image outcomes\n- report.html img-01: content — revenue"));
    expect(report?.imageSummaries[0]).toContain("missing findings: img-02");
    expect(report?.warnings.some((warning) => warning.includes("does not accept image input"))).toBe(true);
  });
});
