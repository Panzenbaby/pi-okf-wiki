import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NotebookRepository } from "../src/extract/notebook.ts";

let workdir: string;

beforeEach(async () => {
  workdir = join(tmpdir(), `okf-nb-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(workdir, { recursive: true });
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

async function fixture(name: string, content: unknown): Promise<string> {
  const path = join(workdir, name);
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

describe("NotebookRepository", () => {
  it("keeps markdown cells as text and code cells as fenced blocks", async () => {
    const path = await fixture("demo.ipynb", {
      cells: [
        { cell_type: "markdown", source: ["# Title\n", "Some prose"] },
        { cell_type: "code", source: "print('hi')", outputs: [] },
      ],
      metadata: { language_info: { name: "python" } },
    });
    const result = await new NotebookRepository().extract(path);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.sourceFormat).toBe("ipynb");
    const text = result.data.parts[0] ?? "";
    expect(text).toContain("# Title");
    expect(text).toContain("Some prose");
    expect(text).toContain("```python");
    expect(text).toContain("print('hi')");
  });

  it("drops cell outputs entirely", async () => {
    const path = await fixture("out.ipynb", {
      cells: [
        {
          cell_type: "code",
          source: "compute()",
          outputs: [
            { output_type: "stream", text: ["DROPPED_STREAM_TEXT\n"] },
            { output_type: "display_data", data: { "image/png": "DROPPED_BASE64_BLOB" } },
            { output_type: "error", traceback: ["DROPPED_TRACEBACK"] },
          ],
        },
      ],
      metadata: {},
    });
    const result = await new NotebookRepository().extract(path);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const text = result.data.parts[0] ?? "";
    expect(text).toContain("compute()");
    expect(text).not.toContain("DROPPED_STREAM_TEXT");
    expect(text).not.toContain("DROPPED_BASE64_BLOB");
    expect(text).not.toContain("DROPPED_TRACEBACK");
  });

  it("falls back to a bare fence when the notebook declares no language", async () => {
    const path = await fixture("nolang.ipynb", {
      cells: [{ cell_type: "code", source: "x = 1" }],
      metadata: {},
    });
    const result = await new NotebookRepository().extract(path);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.parts[0]).toContain("```\nx = 1\n```");
  });

  it("reads the language from kernelspec when language_info is absent", async () => {
    const path = await fixture("kernel.ipynb", {
      cells: [{ cell_type: "code", source: "puts 1" }],
      metadata: { kernelspec: { language: "ruby" } },
    });
    const result = await new NotebookRepository().extract(path);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.parts[0]).toContain("```ruby");
  });

  it("fails with extraction_failed on malformed JSON", async () => {
    const path = await fixture("broken.ipynb", "{ not json");
    const result = await new NotebookRepository().extract(path);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.cause).toBe("extraction_failed");
  });

  it("reports empty when every cell is blank", async () => {
    const path = await fixture("blank.ipynb", {
      cells: [{ cell_type: "code", source: "" }, { cell_type: "markdown", source: [] }],
      metadata: {},
    });
    const result = await new NotebookRepository().extract(path);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.cause).toBe("empty");
  });
});
