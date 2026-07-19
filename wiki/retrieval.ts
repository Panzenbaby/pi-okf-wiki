// Retrieval & preview: retrieveConcepts, renderConceptForPrompt, tokenize,
// renderWikiTree, displayTitle, buildStructurePreview, TERM_STOPWORDS.

import type { Concept, Frontmatter } from "../types.ts";

const TERM_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for",
  "is", "are", "was", "were", "be", "been", "with", "as", "by", "at",
  "from", "that", "this", "these", "those", "it", "its", "der", "die",
  "das", "ein", "eine", "und", "oder", "von", "zu", "mit", "auf", "ist",
  "war", "im", "für", "wie", "was", "wer", "wenn", "dass", "auch", "nicht",
]);

/** A compact preview of the existing wiki structure to guide the agent. */
export interface StructurePreview {
  readonly directories: readonly string[];
  readonly types: ReadonlyArray<{ type: string; count: number }>;
  /** All existing concept IDs (sorted). Used by the agent to avoid duplicates. */
  readonly conceptIds: readonly string[];
}

export function buildStructurePreview(concepts: readonly Concept[]): StructurePreview {
  const directories = new Set<string>();
  const typeCounts = new Map<string, number>();
  for (const concept of concepts) {
    const dir = concept.conceptId.includes("/")
      ? concept.conceptId.slice(0, concept.conceptId.lastIndexOf("/"))
      : "";
    if (dir !== "") directories.add(dir);
    const type = concept.frontmatter.type ?? "(untyped)";
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
  }
  const types = [...typeCounts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
  // Full list of existing concept IDs (not a capped sample) so the agent can
  // avoid exact-ID duplicates. This grows with the wiki size; the /wiki-update
  // prompt additionally instructs the agent to verify a candidate ID with
  // ls/grep before writing, which scales to any size and also catches
  // semantic duplicates a pure ID list would miss.
  const conceptIds = concepts
    .slice()
    .map((c) => c.conceptId)
    .sort((a, b) => a.localeCompare(b));
  return {
    directories: [...directories].sort(),
    types,
    conceptIds,
  };
}

export interface RetrievedConcept {
  readonly conceptId: string;
  readonly content: string;
  readonly score: number;
}

/**
 * The retrieval seam for `/wiki-query`. Promotes the former free-function
 * `retrieveConcepts` into an injectable interface so the scoring strategy
 * (term-frequency today, embedding/semantic later) can be swapped at the
 * call site without editing callers. `query.ts` takes a `Retriever` with a
 * default {@link TermFrequencyRetriever} so the commands keep working with no
 * extra configuration.
 */
export interface Retriever {
  retrieve(
    concepts: readonly Concept[],
    question: string,
    limit: number,
  ): readonly RetrievedConcept[];
}

/**
 * Term-frequency retrieval over the wiki for `/wiki-query`. The scoring body
 * is byte-for-byte identical to the former free-function `retrieveConcepts`:
 * same tokenizer, same stopword set, same `split(term).length - 1` occurrence
 * counting, same descending sort, same `limit` slice.
 */
export class TermFrequencyRetriever implements Retriever {
  retrieve(
    concepts: readonly Concept[],
    question: string,
    limit: number,
  ): readonly RetrievedConcept[] {
    const terms = tokenize(question);
    if (terms.length === 0) return [];
    const scored: RetrievedConcept[] = [];
    for (const concept of concepts) {
      const haystack = `${concept.frontmatter.title ?? ""} ${
        concept.frontmatter.description ?? ""
      } ${concept.frontmatter.tags.join(" ")} ${concept.body}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        const occurrences = haystack.split(term).length - 1;
        score += occurrences;
      }
      if (score > 0) {
        scored.push({
          conceptId: concept.conceptId,
          score,
          content: renderConceptForPrompt(concept),
        });
      }
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

/** The default retriever instance used by `query.ts` and by {@link retrieveConcepts}. */
export const defaultRetriever: Retriever = new TermFrequencyRetriever();

/**
 * Simple term-frequency retrieval over the wiki for `/wiki-query`.
 *
 * Thin wrapper around the default {@link TermFrequencyRetriever} so existing
 * call-sites and tests keep working. New callers should take a `Retriever`
 * and inject it instead.
 */
export function retrieveConcepts(
  concepts: readonly Concept[],
  question: string,
  limit: number,
): readonly RetrievedConcept[] {
  return defaultRetriever.retrieve(concepts, question, limit);
}

export function renderConceptForPrompt(concept: Concept): string {
  const fm = concept.frontmatter;
  const meta = [
    `type: ${fm.type ?? "(untyped)"}`,
    fm.title ? `title: ${fm.title}` : null,
    fm.description ? `description: ${fm.description}` : null,
    fm.tags.length > 0 ? `tags: [${fm.tags.join(", ")}]` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  return `### ${concept.conceptId}\n\n${meta}\n\n${concept.body.trim()}`;
}

export function tokenize(text: string): readonly string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9äöüß]+/i)
        .filter((token) => token.length > 2)
        .filter((token) => !TERM_STOPWORDS.has(token)),
    ),
  ];
}

export function renderWikiTree(concepts: readonly Concept[]): string {
  if (concepts.length === 0) return "(empty)";
  return concepts
    .map((concept) => `wiki/${concept.conceptId}.md`)
    .sort()
    .join("\n");
}

export function displayTitle(frontmatter: Frontmatter, conceptId: string): string {
  return frontmatter.title ?? conceptId;
}