// Retrieval & preview: retrieveConcepts, renderConceptForPrompt, tokenize,
// renderWikiTree, displayTitle, buildStructurePreview.

import type { Concept, Frontmatter } from "../types.ts";

/**
 * The default scoring strategy. No hardcoded stopword list is used: the
 * tokenizer keeps every Unicode word/number run (length > 2), and common
 * terms are downweighted automatically via IDF computed from the wiki
 * corpus itself. This keeps retrieval language- and script-independent.
 */

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
 * (term-frequency/TF-IDF today, embedding/semantic later) can be swapped at
 * the call site without editing callers. `query.ts` takes a `Retriever` with
 * a default {@link TermFrequencyRetriever} so the commands keep working with
 * no extra configuration.
 */
export interface Retriever {
  retrieve(
    concepts: readonly Concept[],
    question: string,
    limit: number,
  ): readonly RetrievedConcept[];
}

/**
 * TF-IDF cosine-similarity retrieval over the wiki for `/wiki-query`.
 *
 * Note: the class name is kept as `TermFrequencyRetriever` for import
 * stability, but the implementation scores with TF-IDF weighted cosine
 * similarity — not raw term frequency. IDF is computed on the fly from the
 * passed-in concepts (no persistence, no cache), so common terms across the
 * corpus are downweighted in any language without a hardcoded stopword list.
 *
 * The haystack covers the same fields the former scorer used —
 * `title` + `description` + `tags` + `body` — and the tokenizer is the
 * language-agnostic {@link tokenize}. Query and document vectors are
 * L2-normalized; the returned `score` is the cosine similarity in [0, 1].
 * Concepts with no overlapping term (cosine 0) are excluded, and the top
 * `limit` by descending score are returned.
 */
export class TermFrequencyRetriever implements Retriever {
  retrieve(
    concepts: readonly Concept[],
    question: string,
    limit: number,
  ): readonly RetrievedConcept[] {
    if (concepts.length === 0) return [];

    // Per-concept term-frequency maps over the combined haystack.
    const docTfs = concepts.map((concept) => {
      const haystack = `${concept.frontmatter.title ?? ""} ${
        concept.frontmatter.description ?? ""
      } ${concept.frontmatter.tags.join(" ")} ${concept.body}`.toLowerCase();
      return termFrequencies(haystack);
    });

    // Document frequency per term across the corpus → IDF. This is the
    // default TfidfVectorizer formula with smooth_idf=True:
    //   idf = log((1 + N) / (1 + df)) + 1
    // never zero, so single-doc wikis still score instead of collapsing to 0.
    const df = new Map<string, number>();
    for (const tf of docTfs) {
      for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
    }
    const n = concepts.length;
    const idf = (term: string): number => {
      const dfreq = df.get(term) ?? 0;
      return Math.log((n + 1) / (dfreq + 1)) + 1;
    };

    // Precompute each document's tf*idf vector and its L2 magnitude.
    const docVectors = docTfs.map((tf) => {
      const vec = new Map<string, number>();
      let magSquared = 0;
      for (const [term, freq] of tf) {
        const w = freq * idf(term);
        vec.set(term, w);
        magSquared += w * w;
      }
      return { vec, mag: Math.sqrt(magSquared) };
    });

    // Query vector + magnitude.
    const queryTf = termFrequencies(question);
    const queryVec = new Map<string, number>();
    let queryMagSquared = 0;
    for (const [term, freq] of queryTf) {
      const w = freq * idf(term);
      queryVec.set(term, w);
      queryMagSquared += w * w;
    }
    const queryMag = Math.sqrt(queryMagSquared);
    if (queryMag === 0) return [];

    const scored: RetrievedConcept[] = [];
    for (let i = 0; i < concepts.length; i++) {
      const { vec, mag } = docVectors[i];
      if (mag === 0) continue;
      let dot = 0;
      // Query vectors are typically the smallest, so iterate queryVec and
      // look up each term in the (larger) document vector.
      for (const [term, w] of queryVec) {
        const other = vec.get(term);
        if (other !== undefined) dot += w * other;
      }
      if (dot === 0) continue;
      const score = dot / (queryMag * mag);
      scored.push({
        conceptId: concepts[i].conceptId,
        score,
        content: renderConceptForPrompt(concepts[i]),
      });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

/** The default retriever instance used by `query.ts` and by {@link retrieveConcepts}. */
export const defaultRetriever: Retriever = new TermFrequencyRetriever();

/**
 * Honest alias for {@link TermFrequencyRetriever}. The class name is kept for
 * import stability, but the implementation is TF-IDF cosine — new callers
 * should import and use this name instead.
 */
export const TfIdfRetriever = TermFrequencyRetriever;

/**
 * TF-IDF cosine retrieval over the wiki for `/wiki-query`.
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
    fm.status ? `status: ${fm.status}` : null,
    fm.supersedes.length > 0 ? `supersedes: [${fm.supersedes.join(", ")}]` : null,
    renderGenerated(fm),
    renderVerified(fm),
    fm.staleAfter ? `stale_after: ${fm.staleAfter}` : null,
    renderSources(fm),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  return `### ${concept.conceptId}\n\n${meta}\n\n${concept.body.trim()}`;
}

/** `generated` line, falling back to the legacy v0.1 `timestamp` (§13.1). */
function renderGenerated(fm: Frontmatter): string | null {
  if (fm.generated) {
    const by = fm.generated.by ?? "(unknown)";
    const at = fm.generated.at ?? "(unknown)";
    return `generated: by ${by} at ${at}`;
  }
  if (fm.timestamp) return `timestamp: ${fm.timestamp} (legacy v0.1)`;
  return null;
}

/** Trust tier (§5.3) plus the latest verification, for the query agent. */
function renderVerified(fm: Frontmatter): string | null {
  if (fm.verified.length === 0) return null;
  const humanReviewed = fm.verified.some((event) => event.by?.startsWith("human:"));
  const tier = humanReviewed ? "human-reviewed" : "machine-confirmed";
  const latest = fm.verified
    .map((event) => event.at)
    .filter((at): at is string => at !== undefined)
    .sort()
    .pop();
  return `verified: ${tier}${latest ? ` (latest ${latest})` : ""}`;
}

/** Compact `sources` summary so footnote labels resolve without opening the file. */
function renderSources(fm: Frontmatter): string | null {
  if (fm.sources.length === 0) return null;
  const entries = fm.sources.map((source) => {
    const id = source.id ?? "(no id)";
    const resource = source.resource ?? "(no resource)";
    return `${id} -> ${resource}`;
  });
  return `sources: ${entries.join("; ")}`;
}

/**
 * Tokenize text for retrieval. Language- and script-independent: extracts
 * runs of Unicode letters/numbers (`\p{L}\p{N}`), lowercases them, drops
 * tokens shorter than 3 characters, and deduplicates. No stopword filtering
 * is applied here — common terms are downweighted at scoring time via IDF,
 * so no language-specific list is maintained.
 */
export function tokenize(text: string): readonly string[] {
  return [...new Set(rawTokens(text))];
}

/**
 * Shared tokenizer core: lowercases and returns every Unicode letter/number
 * run of length > 2, without deduplication. {@link tokenize} dedupes on top
 * for query-term extraction; {@link termFrequencies} counts on top for
 * document/query vectors. Centralizing the regex + length rule here keeps
 * the two consumers from drifting.
 */
function rawTokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (token) => token.length > 2,
  );
}

/**
 * Per-term counts for a piece of text. Same tokenizer as {@link tokenize}
 * but without deduplication, so the retriever can compute term frequencies
 * for document/query vectors. Internal helper, not part of the public API.
 */
function termFrequencies(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of rawTokens(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
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