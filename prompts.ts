// Prompt builders for the agent turns. Prompts are in English; the agent is
// asked to reply in the same language as the user's input (the question for
// /wiki-query, the transformed content for /wiki-update).

import type { StructurePreview } from "./wiki.ts";

const OKF_RULES = `OKF (Open Knowledge Format) rules for a concept file:
- A concept is a markdown file with YAML frontmatter delimited by --- lines.
- Frontmatter MUST contain a non-empty \`type\` field. Recommended: \`title\`,
  \`description\`, \`resource\` (canonical URI, optional), \`tags\` (list),
  \`timestamp\` (ISO 8601).
- The body is structural markdown: headings (# Schema, # Examples, # Citations
  where applicable), lists, tables, fenced code blocks.
- Link related concepts with bundle-relative links like
  [title](/tables/orders.md). Broken links are tolerated.
- Cite external sources under a # Citations heading, numbered [1] [2].`;

export interface UpdatePromptInput {
  readonly inputFiles: ReadonlyArray<{
    relativePath: string;
    absolutePath: string;
    /** Precomputed, collision-free archive destination for this file. */
    archiveTarget: string;
  }>;
  readonly archiveDir: string;
  readonly wikiDir: string;
  readonly structure: StructurePreview;
}

export function buildUpdatePrompt(input: UpdatePromptInput): string {
  const fileList = input.inputFiles
    .map(
      (file) =>
        `- input/${file.relativePath} (absolute: ${file.absolutePath}) -> archive to: ${file.archiveTarget}`,
    )
    .join("\n");
  const dirs = input.structure.directories.length > 0
    ? input.structure.directories.join(", ")
    : "(none yet)";
  const types = input.structure.types.length > 0
    ? input.structure.types.map((entry) => `${entry.type} (${entry.count})`).join(", ")
    : "(none yet)";
  const samples = input.structure.sampleConceptIds.length > 0
    ? input.structure.sampleConceptIds.join(", ")
    : "(none yet)";

  return `You are ingesting new documents into an OKF knowledge base (the "wiki").

${OKF_RULES}

Existing wiki structure:
- Directories: ${dirs}
- Types in use: ${types}
- Sample concept IDs: ${samples}

The following input files are NOT yet OKF-conformant. For EACH file:
1. Read it (use the read tool; it handles .md, .txt, .pdf, and images).
2. Decide a concept ID (path without .md) that fits the existing structure.
   Prefer existing directories/types when the content matches; create a new
   subdirectory only when nothing existing fits.
3. Write the OKF concept file to ${input.wikiDir}/<concept-id>.md with proper
   frontmatter (type, title, description, tags, timestamp) and a structured
   body. Extract schemas, examples, and citations where present.
4. ONLY AFTER the concept file is written successfully, move the original from
   input/<relativePath> to the EXACT archive path listed for that file
   ("archive to: ..." above). Each archive path is precomputed and unique so it
   will not collide with existing archive files — do NOT pick your own name.
   Create any needed subdirectories first (mkdir -p), then move with
   \`mv -n\` (no-clobber). Never overwrite an existing file: if \`mv -n\` does not
   move (target already exists), leave the file in input/ and note it under
   "## Skipped". Never archive before the wiki write succeeds.
5. If a file cannot be transformed (unreadable, empty, binary without text),
   leave it in input/ and note it in your summary.

Input files to transform:
${fileList}

When done, output a concise summary section titled "## Transformed"
with one bullet per transformed concept: \`<concept-id>\` — <title> — one-line
note. Then a "## Skipped" section for files you could not transform.
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

## Wiki tree
${input.wikiTree}

## index.md
${indexBlock}

## Retrieved concepts (most relevant)
${contextBlock}`;
}