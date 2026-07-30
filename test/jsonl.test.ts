import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JsonLinesRepository } from "../src/extract/jsonl.ts";

let workdir: string;

beforeEach(async () => {
  workdir = join(tmpdir(), `okf-jsonl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(workdir, { recursive: true });
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

async function fixture(name: string, content: string): Promise<string> {
  const path = join(workdir, name);
  await writeFile(path, content);
  return path;
}

describe("JsonLinesRepository", () => {
  it("renders one readable block per record", async () => {
    const path = await fixture(
      "data.jsonl",
      '{"id":42,"name":"Alice"}\n{"id":43,"name":"Bob"}\n',
    );
    const result = await new JsonLinesRepository().extract(path);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.sourceFormat).toBe("jsonl");
    expect(result.data.parts).toHaveLength(1);
    const text = result.data.parts[0] ?? "";
    expect(text).toContain("## Record 1");
    expect(text).toContain("## Record 2");
    expect(text).toContain('"name": "Alice"');
    expect(text).toContain('"name": "Bob"');
    expect(result.data.warnings).toHaveLength(0);
  });

  it("skips unparseable lines instead of failing the whole file", async () => {
    const path = await fixture(
      "mixed.jsonl",
      '{"ok":1}\nNOT JSON AT ALL\n{"ok":2}\n',
    );
    const result = await new JsonLinesRepository().extract(path);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const text = result.data.parts[0] ?? "";
    expect(text).toContain('"ok": 1');
    expect(text).toContain('"ok": 2');
    expect(text).not.toContain("NOT JSON AT ALL");
    expect(result.data.warnings.join(" ")).toMatch(/skipped 1 unparseable line/i);
  });

  it("ignores blank lines without counting them as records", async () => {
    const path = await fixture("blanks.jsonl", '{"a":1}\n\n   \n{"a":2}\n');
    const result = await new JsonLinesRepository().extract(path);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const text = result.data.parts[0] ?? "";
    expect(text).toContain("## Record 2");
    expect(text).not.toContain("## Record 3");
    expect(result.data.warnings).toHaveLength(0);
  });

  it("splits into parts of 1000 records and numbers records continuously", async () => {
    const lines: string[] = [];
    for (let index = 1; index <= 2500; index++) lines.push(`{"n":${index}}`);
    const path = await fixture("big.jsonl", `${lines.join("\n")}\n`);

    const result = await new JsonLinesRepository().extract(path);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.parts).toHaveLength(3);
    expect(result.data.parts[0]).toContain("## Record 1");
    expect(result.data.parts[0]).toContain("## Record 1000");
    expect(result.data.parts[0]).not.toContain("## Record 1001");
    expect(result.data.parts[1]).toContain("## Record 1001");
    expect(result.data.parts[2]).toContain("## Record 2500");
    expect(result.data.parts[2]).not.toContain("## Record 2501");
  });

  it("reports empty when no line holds valid JSON", async () => {
    const path = await fixture("junk.jsonl", "nope\nstill nope\n");
    const result = await new JsonLinesRepository().extract(path);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.cause).toBe("empty");
  });

  it("reports empty for a file with no content at all", async () => {
    const path = await fixture("void.jsonl", "\n\n");
    const result = await new JsonLinesRepository().extract(path);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.cause).toBe("empty");
  });

  it("handles .ndjson as the same format", async () => {
    const repository = new JsonLinesRepository();
    expect(repository.supportedExtensions).toContain(".jsonl");
    expect(repository.supportedExtensions).toContain(".ndjson");
  });
});
