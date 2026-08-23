import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Concept, Frontmatter, Result } from "../src/types.ts";
import {
  TermFrequencyRetriever,
  defaultRetriever,
  type RetrievedConcept,
  type Retriever,
} from "../src/wiki/retrieval.ts";
import { buildWikiQueryContext } from "../src/query.ts";

const frontmatter = (overrides: Partial<Frontmatter> = {}): Frontmatter => ({
  type: "concept",
  title: undefined,
  description: undefined,
  resource: undefined,
  tags: [],
  timestamp: undefined,
  status: undefined,
  supersedes: [],
  generated: undefined,
  verified: [],
  sources: [],
  staleAfter: undefined,
  raw: {},
  ...overrides,
});

const concept = (
  conceptId: string,
  overrides: Partial<Frontmatter> = {},
  body = "",
): Concept => ({
  conceptId,
  absolutePath: `/wiki/${conceptId}.md`,
  frontmatter: frontmatter(overrides),
  body,
});

describe("TermFrequencyRetriever", () => {
  const retriever = new TermFrequencyRetriever();

  it("ranks a matching concept above a non-matching one", () => {
    const matching = concept(
      "tables/orders",
      { title: "Orders", description: "One row per completed order." },
      "The orders table holds every order with its order_id.",
    );
    const unrelated = concept(
      "glossary/colors",
      { title: "Colors", description: "Color names." },
      "Red, green, and blue are colors of the rainbow.",
    );
    const result = retriever.retrieve([matching, unrelated], "orders", 10);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].conceptId).toBe("tables/orders");
  });

  it("returns an empty array when the question has no term overlap with any concept", () => {
    // No hardcoded stopword filter is involved: the question's terms simply
    // do not appear in any concept, so every cosine similarity is 0 and all
    // concepts are excluded. (The earlier "only stopwords" framing is gone —
    // stopword-like terms are now downweighted via IDF, not dropped.)
    const concepts = [
      concept("tables/orders", { title: "Orders" }, "order order order"),
    ];
    expect(retriever.retrieve(concepts, "colors unrelated", 10)).toEqual([]);
  });

  it("returns an empty array when the question yields no usable query terms", () => {
    // Locks in the queryMag === 0 guard: a question whose only tokens are
    // ≤2 characters produces an empty query vector (no terms pass the
    // length filter), so retrieval short-circuits without scoring any doc.
    const concepts = [
      concept("tables/orders", { title: "Orders" }, "order order order"),
    ];
    expect(retriever.retrieve(concepts, "a ab", 10)).toEqual([]);
  });

  it("respects the limit argument", () => {
    const concepts = [
      concept("a/orders", { title: "orders" }, "orders"),
      concept("b/orders", { title: "orders" }, "orders"),
      concept("c/orders", { title: "orders" }, "orders"),
    ];
    const result = retriever.retrieve(concepts, "orders", 2);
    expect(result.length).toBe(2);
  });

  it("matches byte-for-byte with the default retriever wrapper", () => {
    const concepts = [
      concept("tables/orders", { title: "Orders", tags: ["sales"] }, "orders"),
      concept("glossary/colors", { title: "Colors" }, "colors"),
    ];
    const direct = new TermFrequencyRetriever().retrieve(concepts, "orders", 5);
    const wrapper = defaultRetriever.retrieve(concepts, "orders", 5);
    expect(wrapper).toEqual(direct);
  });
});

describe("buildWikiQueryContext wiring", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = join(
      tmpdir(),
      `okf-retrieval-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(join(workdir, "wiki"), { recursive: true });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  async function writeConcept(relativePath: string, content: string): Promise<void> {
    const absolute = join(workdir, "wiki", relativePath);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }

  it("uses the injected retriever's output in the built prompt", async () => {
    await writeConcept(
      "tables/orders.md",
      "---\ntype: table\ntitle: Orders\n---\n\n# Schema\norder_id\n",
    );

    const fakeRetrieved: RetrievedConcept[] = [
      {
        conceptId: "injected/concept",
        content: "### injected/concept\n\ninjected body",
        score: 42,
      },
    ];

    const fake: Retriever = {
      retrieve: (_concepts, _question, _limit) => fakeRetrieved,
    };

    const result: Result<string> = await buildWikiQueryContext(
      workdir,
      "anything",
      fake,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    // The FakeRetriever's fixed output must appear verbatim in the system
    // context — proving buildWikiQueryContext routes retrieval through the
    // injected seam, not through its own scoring.
    expect(result.data).toContain("Concept: injected/concept");
    expect(result.data).toContain("injected body");
  });

  it("falls back to the default TermFrequencyRetriever when no retriever is passed", async () => {
    await writeConcept(
      "tables/orders.md",
      "---\ntype: table\ntitle: Orders\ndescription: One row per order.\n---\n\norders orders orders\n",
    );

    const result = await buildWikiQueryContext(workdir, "orders");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toContain("Concept: tables/orders");
  });
});