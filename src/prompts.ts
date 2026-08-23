// Prompt builders for the agent turns. Prompts are in English; the agent is
// asked to reply in the same language as the user's input (the question for
// /wiki-query, the transformed content for /wiki-update).

import type { StructurePreview } from "./wiki.ts";

/**
 * The provenance rule (OKF v0.2 §5.1), stated ONCE and interpolated into both
 * OKF_RULES and the STEP 2 conflict bullet so the two cannot drift apart.
 * Provenance lives in the \`sources\` frontmatter list; archived originals use
 * a \`/archive/<input-relative-path>\` placeholder as the entry's \`resource\`
 * (original input path, NOT the renamed archive destination); the finalize
 * step rewrites the placeholder to the renamed path. Per-claim attribution
 * uses footnotes keyed to \`sources[].id\`. The top-level \`resource:\` stays a
 * canonical URI only.
 */
const SOURCES_RULE = `Record provenance in the \`sources\` frontmatter list (§5.1). One entry per
  source, each with a stable \`id\` (short slug), a \`resource\`, and a \`title\`:
  * External source → \`resource\` is its URL.
  * Archived original from THIS run → \`resource\` is EXACTLY
    \`/archive/<input-relative-path>\`, where \`<input-relative-path>\` is the
    path shown for the source in the file list below (the \`input/...\` prefix
    stripped). ALWAYS use the ORIGINAL input relative path, never the
    precomputed archive destination — the system rewrites these values to the
    actual (collision-renamed) archive path after you move the originals.
    Example entry for \`input/notes/spec-v2.pdf\`:
    \`- { id: spec-v2, resource: /archive/notes/spec-v2.pdf, title: Spec v2 }\`.
    Quote the resource (\`resource: "/archive/my doc.pdf"\`) when the path
    contains spaces.
  Attribute individual claims with a markdown footnote whose label is the
  source's \`id\`: write \`...the value is 42.[^spec-v2]\` in the body and define
  \`[^spec-v2]: Spec v2\` at the bottom. The footnote label is the join key
  into \`sources\` — never cite by position ([1], [2]) and never use a body
  # Citations list (that is the superseded v0.1 form).
  NEVER put an archive path in the TOP-LEVEL frontmatter \`resource\` field —
  it holds a canonical URI only; archive paths belong in \`sources[].resource\`.`;

const OKF_RULES = `OKF (Open Knowledge Format, v0.2) rules for a concept file:
- A concept is a markdown file with YAML frontmatter delimited by --- lines.
- Frontmatter MUST contain a non-empty \`type\` field. Recommended: \`title\`,
  \`description\`, \`resource\` (canonical URI, optional — NEVER an archive path),
  \`tags\` (flow list like \`[a, b]\`).
- Record how the content was produced with
  \`generated: { by: <actor>, at: <ISO 8601 datetime with UTC offset> }\` (§5.2).
  The actor (§7) is \`pi-okf-wiki/<your model id>\` (producer/version form,
  e.g. \`pi-okf-wiki/claude-sonnet-4\`). Do NOT write the legacy v0.1
  \`timestamp\` key in new or rewritten concepts.
- Producers MAY add extra keys (§4.1); consumers preserve them. Do NOT invent
  \`verified\` entries — verification is recorded by humans/processes that
  actually confirmed the content, not by the writer.
- The body is structural markdown: headings (# Schema, # Examples where
  applicable), lists, tables, fenced code blocks.
- Link related concepts with bundle-relative links like
  [title](/tables/orders.md). Broken links are tolerated.
- ${SOURCES_RULE}
- One concept per real-world entity: do NOT split a single entity into parallel
  concept files just because several input files describe it. Variants,
  versions, and superseded values are expressed INSIDE one concept body, not
  as separate files.
- Contradictions are knowledge too. When multiple sources disagree on an
  attribute of the same concept, do NOT silently pick one value and discard
  the others. Make the conflict visible in the body (a # Versions / # Conflicts
  table or prose), cite each source via its footnote, and mark the canonical
  value.
- Temporal precedence: when values conflict, prefer the one with the latest
  source date (\`sources[].last_modified\`, the source's own \`generated.at\` or
  legacy \`timestamp\`, or a "neueste Version" / "latest" marker) as canonical;
  mark older values as superseded. Make the precedence graph explicit with
  \`status\` (§5.4: \`draft\` | \`stable\` | \`deprecated\`; absent means
  \`stable\`) plus the producer-defined \`supersedes: [/path/to/older.md]\` (a
  bundle-relative path LIST, so one concept can supersede several older ones):
  the superseding concept lists the older ones in \`supersedes\`, and a concept
  that is no longer current gets \`status: deprecated\`. Do NOT write the legacy
  values \`current\` or \`superseded\` into \`status\` — v0.2 standardizes that
  field, and a consumer reads any other value as \`stable\`. Absent dates =>
  keep the conflict unresolved and label all values as "unverified".`;

export interface UpdatePromptInput {
  readonly inputFiles: ReadonlyArray<{
    relativePath: string;
    absolutePath: string;
    /** Precomputed, collision-free archive destination for the ORIGINAL file. */
    archiveTarget: string;
    /**
     * When set, the agent reads these extracted `.txt` files instead of the
     * original. Several entries mean ONE source was split into ordered parts.
     */
    extractedTextPaths?: readonly string[];
    /** Source format id when extracted (e.g. "docx"). */
    sourceFormat?: string;
  }>;
  readonly archiveDir: string;
  readonly wikiDir: string;
  readonly structure: StructurePreview;
}

export function buildUpdatePrompt(input: UpdatePromptInput): string {
  const fileList = input.inputFiles
    .map((file) => {
      const extracted = file.extractedTextPaths ?? [];
      const format = file.sourceFormat ?? "unknown";
      if (extracted.length > 1) {
        return `- input/${file.relativePath} (source format: ${format}; ONE source split into ${extracted.length} ordered parts — READ ALL of them: ${extracted.join(", ")}) -> archive ORIGINAL to: ${file.archiveTarget}`;
      }
      if (extracted.length === 1) {
        return `- input/${file.relativePath} (source format: ${format}; READ extracted text: ${extracted[0]}) -> archive ORIGINAL to: ${file.archiveTarget}`;
      }
      return `- input/${file.relativePath} (READ directly: ${file.absolutePath}) -> archive to: ${file.archiveTarget}`;
    })
    .join("\n");
  const dirs = input.structure.directories.length > 0
    ? input.structure.directories.join(", ")
    : "(none yet)";
  const types = input.structure.types.length > 0
    ? input.structure.types.map((entry) => `${entry.type} (${entry.count})`).join(", ")
    : "(none yet)";
  const existingIds = input.structure.conceptIds.length > 0
    ? input.structure.conceptIds.join(", ")
    : "(none yet)";

  return `You are ingesting new documents into an OKF knowledge base (the "wiki").

${OKF_RULES}

Existing wiki structure:
- Directories: ${dirs}
- Types in use: ${types}
- Existing concept IDs: ${existingIds}

The following input files are NOT yet OKF-conformant.

STEP 0 — Cluster inputs by the entity they describe (BEFORE assigning concept IDs):
- Read every input file first. For binary/structured formats (pdf, docx, xlsx,
  pptx, odt, ods, odp, epub, html, rtf, jsonl, ipynb) an extracted plain-text
  file has already been written for you — READ THE EXTRACTED TEXT path listed
  for that input, NOT the original. When an input lists SEVERAL extracted parts,
  they are consecutive slices of ONE source file: read them all and treat them
  as a single document, never as separate sources. For plain text (.txt, .csv,
  .tsv, .json, .yaml, .toml, diagram DSLs, .rst/.adoc/.org), markdown, and
  images, read the original file directly with the read tool (images are read
  via vision).
- Group files that describe the SAME real-world entity. Match on the asserted
  name (e.g. "ALG-32"), canonical resource, or distinctive keywords — NOT on the
  input filename. Files named like foo-2.txt / foo-3.txt are usually VERSIONS of
  the same entity, not new concepts.
- Each cluster becomes a SINGLE concept file. Do not create one concept per
  input file when several inputs describe one entity.

STEP 1 — Decide a concept ID (path without .md) for each cluster that fits the
existing structure.
- First check the "Existing concept IDs" list above; reuse an existing ID when
  a cluster updates or extends that concept rather than creating a new file.
- If unsure whether a concept already exists (large wiki, similar topic),
  verify with "ls"/"find" on ${input.wikiDir} and "grep" for the candidate
  title/keywords before writing — do not duplicate an existing concept under
  a new ID.
- NEW concepts MUST be placed inside a subdirectory — NEVER write a new
  concept directly at the wiki root as \`<slug>.md\`. The concept ID MUST
  contain at least one path separator (\`<directory>/<slug>\`). Choose the
  directory by, in order of preference:
    1. an existing directory whose topic the concept matches (see the
       "Directories" list above);
    2. a new directory derived from the concept's \`type\` (use the \`type\`
       value, lowercased and slugified, as the top-level namespace, e.g.
       type \`Database\` -> \`database/<slug>.md\`);
    3. a new topical directory derived from the subject when no \`type\` fits
       (a short, stable slug such as \`tables/orders.md\`).
  Only an ID that ALREADY exists at the root (an update to an existing
  root-level concept) may stay at the root; never CREATE a new root-level
  concept file. Reusing an existing nested ID keeps its directory.

STEP 2 — Reconcile the cluster and write ONE OKF concept file to
${input.wikiDir}/<concept-id>.md:
- The <concept-id> MUST contain a path separator (see STEP 1). Create the
  parent directory first with \`mkdir -p ${input.wikiDir}/<directory>\` before
  writing the file.
- Frontmatter: type, title, description, tags (flow list \`[a, b]\`),
  \`generated: { by: pi-okf-wiki/<your model id>, at: <ISO 8601> }\` (set \`at\`
  to now), and the \`sources\` list (one entry per source in the cluster).
  Optional: \`status\` (\`draft\` | \`stable\` | \`deprecated\`, §5.4) and
  \`supersedes: [/path/to/older.md]\` (bundle-relative path list) to mark the
  precedence graph.
- Body: structured markdown. Extract schemas and examples where present, and
  attribute claims with \`[^id]\` footnotes keyed to \`sources\`. Express
  variants/versions INSIDE the body (a # Versions table or a # Conflicts
  section), linked and explained — not as parallel concept files.
- CONFLICT HANDLING: if the cluster's sources disagree on the same attribute
  (e.g. colour = green in one file, blue in another), do NOT pick one silently.
  Make the disagreement visible:
    * Add a # Conflicts (or # Versions) table: one row per source with columns
      for the differing attribute(s), the source value, the source footnote
      (\`[^id]\`), and the source date.
    * ${SOURCES_RULE}
    * Choose a CANONICAL value using temporal precedence (latest source date /
      "neueste Version" / "latest" marker wins) and state it explicitly in the
      description and in the # Schema. Mark superseded values as such.
    * If no source is clearly newer, leave ALL conflicting values in the table
      labelled "unverified" and do not declare a canonical one.
  Use \`status\` (\`draft\` | \`stable\` | \`deprecated\`, §5.4 — never the legacy
  \`current\` / \`superseded\`) and the producer-defined
  \`supersedes: [/path/to/older.md]\` (a bundle-relative path LIST) to make the
  precedence graph explicit when applicable.

STEP 3 — ONLY AFTER the concept file is written successfully, move EACH original
from input/<relativePath> to the EXACT archive path listed for that file
("archive to: ..." above). Each archive path is precomputed and unique so it
will not collide with existing archive files — do NOT pick your own name.
Create any needed subdirectories first (mkdir -p), then move with
\`mv -n\` (no-clobber). Never overwrite an existing file: if \`mv -n\` does not
move (target already exists), leave the file in input/ and note it under
"## Skipped". Never archive before the wiki write succeeds. Archive every
member of a cluster once its merged concept file is written.

STEP 4 — If a file cannot be transformed (unreadable, empty, binary without text),
leave it in input/ and note it in your summary.

Input files to transform:
${fileList}

When done, output a concise summary section titled "## Transformed"
with one bullet per transformed concept: \`<concept-id>\` — <title> — one-line
note (mention merged source count and any conflicts, e.g. "merged 3 sources;
conflict on colour -> canonical green (latest)"). Then a "## Skipped" section
for files you could not transform.
Reply in the same language as the content you transformed.`;
}

export interface QueryPromptInput {
  readonly question: string;
  readonly retrieved: ReadonlyArray<{ conceptId: string; content: string }>;
  readonly wikiTree: string;
  readonly indexMd: string | null;
}

export function buildQueryPrompt(input: QueryPromptInput): string {
  return `${buildQuerySystemContext(input)}\n\n## Question\n${input.question}\n\nReply in the same language as the question.`;
}

/**
 * Build only the instruction + context portion of a /wiki-query prompt.
 * This is injected into the system prompt (before_agent_start) so the
 * user message stays clean: just the question itself.
 */
export function buildQuerySystemContext(input: Omit<QueryPromptInput, "question">): string {
  const contextBlock = input.retrieved.length > 0
    ? input.retrieved
        .map((concept) => `--- Concept: ${concept.conceptId} ---\n${concept.content}`)
        .join("\n\n")
    : "(no direct matches found — explore the wiki with read/grep yourself)";
  const indexBlock = input.indexMd ?? "(no index.md present)";
  return `Answer the user's question using ONLY the OKF knowledge base in wiki/.
Cite every claim with a source. Use inline links of the form
[title](wiki/<concept-id>.md) at the claim, and end with a "# Sources" section
listing every concept you used as \`- [title](wiki/<concept-id>.md) — description\`.
NEVER write a source path as plain text — always render it as a markdown link.
If the wiki does not contain the answer, say so explicitly and do not invent
sources. You may use read/grep to explore the wiki further.

Conflict & completeness rules (IMPORTANT):
- A single concept may hold several values for one attribute (a # Conflicts /
  # Versions table) when its sources disagree. Before answering, OPEN the
  concept and read the whole body — do not answer from a snippet alone.
- When the concept declares a CANONICAL value (via temporal precedence on
  \`generated.at\` / legacy \`timestamp\`, a \`status\` that is not \`deprecated\`,
  or an explicit "canonical" statement), answer with the canonical value, but
  ALSO note that other sources disagree (e.g. "grün (kanonisch laut neuester
  Version); ältere Quelle nennt blau").

Trust & freshness rules (OKF v0.2):
- Trust tier from \`verified\` (§5.3): no \`verified\` => unverified; verified
  only by non-\`human:\` actors => machine-confirmed; verified by a
  \`human:<id>\` actor => human-reviewed. When concepts conflict, prefer the
  higher tier and the fresher \`generated.at\`; when you rely on an unverified
  concept for a substantive claim, say so.
- \`status\` (§5.4) is \`draft\` | \`stable\` | \`deprecated\`; absent means
  \`stable\`. Older bundles may still carry the legacy values \`current\` (read
  it as \`stable\`) and \`superseded\` (read it as \`deprecated\`).
- When \`stale_after\` lies in the past or the concept is deprecated, still
  answer if it is the best available knowledge, but flag it explicitly as
  possibly stale/deprecated.
- \`sources\` entries and \`[^id]\` footnotes tell you which source backs which
  claim; when the user asks where a fact comes from, resolve the footnote
  label through the concept's \`sources\` list.
- When NO canonical value is declared, do NOT pick one silently. State that
  the wiki records conflicting values, list each value with its source, and
  label them unverified. Do not present a single value as fact.
- Traverse links: if a concept links to related/variant/superseded concepts
  via # Related Concepts / # Versions / \`supersedes\`, follow those links
  (read the target files) before answering, so you never miss a newer or
  superseding value.
- If you find a contradiction while exploring, make it explicit in the answer
  and cite both sides.

Removed knowledge (IMPORTANT):
- Files under \`/trash/\` are knowledge that was REMOVED from the wiki. Never
  open them and never use them as evidence — they are not part of the answer.
- When a link you would follow points into \`/trash/\`, treat it as a dead end
  and say that the referenced source was removed from the wiki. Do not
  reconstruct its content from the link text or from memory.

## Wiki tree
${input.wikiTree}

## index.md
${indexBlock}

## Retrieved concepts (most relevant)
${contextBlock}`;
}
