# pi-okf-wiki

A [Pi](https://github.com/earendil-works/pi-coding-agent) extension that turns any
project into a local, agent-readable knowledge base using the
[Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md).

Drop documents into `input/`, run `/wiki-update`, and they become OKF concept
files in `wiki/`. Then ask `/wiki-query <question>` and get an answer cited to
the concepts that back it.

## Commands

| Command | What it does |
| --- | --- |
| `/wiki-update` | Ingest new documents from `input/` into the `wiki/` bundle, archive the originals, regenerate `index.md` / `log.md`, and show a summary. |
| `/wiki-query <question>` | Answer a question against the wiki, with every claim cited to a `wiki/<concept-id>.md` source. |

## Folder layout

The extension operates on three folders at the project root (`ctx.cwd`):

```
.
├── input/     # drop new material here
├── archive/   # originals land here after their concept exists in wiki/
└── wiki/      # the OKF knowledge bundle (concepts + index.md + log.md)
```

Missing folders are created on the first `/wiki-update`.

## Installation

### From npm

```bash
pi install npm:pi-okf-wiki
```

### From git

```bash
pi install git:github.com/Panzenbaby/pi-okf-wiki
# or, for a specific ref:
pi install git:github.com/Panzenbaby/pi-okf-wiki@v0.1.0
```

### Local / development

Clone the repo, then either load it for a single run:

```bash
pi -e /path/to/pi-okf-wiki
```

…or add it to your project's `.pi/settings.json` so it auto-loads:

```json
{
  "packages": ["./pi-okf-wiki"]
}
```

After installing, (re)start Pi in your project and the two commands are
available. Reload after upgrading with `/reload`.

## How `/wiki-update` works

`/wiki-update` classifies every file in `input/` into one of three buckets:

1. **Conformant** — a `.md` file with parseable YAML frontmatter and a
   non-empty `type` field. Taken over deterministically (no LLM): the file is
   written to `wiki/<relative-path>` and only then moved from `input/` to
   `archive/`. Its concept ID is the path without `.md`.
2. **Non-conformant** — everything else worth reading: a `.md` lacking
   frontmatter or a non-empty `type` field; plain text (`.txt`, `.csv`, `.json`)
   and images (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`) read directly by
   Pi's `read` tool; and binary/structured documents (`.pdf`, `.docx`, `.pptx`,
   `.xlsx`, `.odt`, `.html`/`.htm`, `.epub`, `.rtf`) which the extension
   **pre-extracts to plain text** into a temp
   `input/.okf-extract/<relative-dir>/<stem>-extracted.txt` and hands *that* to
   the agent (see [Supported formats](#supported-formats)). These are handed to
   the agent, which reads every non-conformant file, **clusters** those
   describing the same real-world entity (matched on asserted name / resource /
   keywords, not on filename), and writes **one OKF concept per cluster**
   (frontmatter + structured body, cross-links, citations) to `wiki/` before
   moving each original to `archive/`. The existing wiki structure —
   directories, types in use, and the **full list of existing concept IDs** — is
   passed to the agent so new concepts fit in and duplicate IDs are avoided.
   This bucket (and every `/wiki-query`) invokes an agent turn, i.e. uses the
   LLM; conformant files are ingested deterministically with no LLM call.
3. **Ignored** — unsupported file types, reserved filenames `index.md` /
   `log.md` placed in `input/`, and documents whose extraction failed (encrypted,
   no extractable text, or a lib error). Listed in the summary with a stable
   reason code (`unsupported`, `reserved`, `encrypted`, `extraction_failed`,
   `empty`, `io_failed`) and left in `input/`.

After the agent turn, the extension regenerates `index.md`, appends a dated
entry to `log.md`, detects any files still left in `input/` (the agent did not
finish them), and renders a summary widget:

```
OKF /wiki-update summary
  Conformant imported:   1
  Agent-transformed:     3 (of 4)
  Ignored:               1
  Leftover (failed):     1
  Concepts created:      3
  Concepts updated:      0
  Wiki size:             5 -> 9
  Imported concept IDs:
    + tables/orders
  Created by agent:
    + playbooks/incident
  Ignored:
    - notes/old.doc (unsupported file type)
  Leftover in input/ (agent did not finish):
    ! reports/q3.md
```

## Supported formats

| Bucket | Extensions | How they reach the agent |
| --- | --- | --- |
| Conformant (deterministic) | `.md` with frontmatter `type` | Copied to `wiki/` directly, no LLM. |
| Plain text (read directly) | `.txt`, `.csv`, `.json` | Pi's `read` tool. |
| Images (vision) | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp` | Pi's `read` tool. |
| Extracted to text | `.pdf`, `.docx`, `.pptx`, `.xlsx`, `.odt`, `.html`/`.htm`, `.epub`, `.rtf` | Pre-extracted to `input/.okf-extract/<rel-dir>/<stem>-extracted.txt`; the agent reads that. The original is archived; a copy of the extracted text is archived next to it. |

Extraction libraries (runtime dependencies of the extension):

| Format | Library |
| --- | --- |
| `.pdf` | [`unpdf`](https://www.npmjs.com/package/unpdf) |
| `.docx` | [`mammoth`](https://www.npmjs.com/package/mammoth) |
| `.xlsx` | [`exceljs`](https://www.npmjs.com/package/exceljs) (rendered as markdown tables) |
| `.pptx` / `.odt` / `.epub` | [`jszip`](https://www.npmjs.com/package/jszip) + an XML-text stripper |
| `.html` | [`html-to-text`](https://www.npmjs.com/package/html-to-text) |
| `.rtf` | dependency-free RTF stripper (control words + destination groups) |

Extraction failures are reported with a stable code and never archive the
original: `encrypted` (password-protected), `empty` (no extractable text),
`extraction_failed` (library error), `io_failed` (read/write error).
Unsupported types and reserved filenames are `unsupported` / `reserved`.

### Safety invariant

An original is moved to `archive/` **only after** its content exists as a
concept in `wiki/` — per file. If a run is interrupted, the file stays in
`input/` and is reprocessed on the next `/wiki-update`. Archive destinations
are **collision-free**: if `archive/<rel>` is already taken, the new copy is
timestamped (`orders.2026-07-12-1305.md`, then `…-1`, `…-2` within the same
minute) and existing archive files are **never** overwritten. This keeps every
version of an original while making `/wiki-update` idempotent and abort-safe.

Finalization (snapshot diff, `index.md`/`log.md` regeneration, leftover
detection, summary) runs in Pi's `agent_end` event, so it always sees the wiki
state *after* the agent finished writing — not a racy pre-turn snapshot.

### Conflict handling & versioning

When several inputs (or a new input and an existing concept) describe the same
entity but disagree on a value, the agent does **not** silently pick one.
Instead it records the disagreement inside the single concept body:

- A `# Conflicts` (or `# Versions`) table — one row per source with the
  differing attribute, its value, citation, and timestamp.
- Each source cited under a `# Citations` heading (numbered `[1]` `[2]`).
- A **canonical** value chosen by temporal precedence: the value with the
  latest `timestamp` / “latest” marker wins and is stated in the `description`
  and `# Schema`; older values are marked superseded. If no source is clearly
  newer, all conflicting values stay in the table labelled **unverified** and
  no canonical value is declared.

## How `/wiki-query` works

1. Load all concepts from `wiki/`.
2. Term-frequency retrieval picks the top 10 matches for the question; the
   root `index.md` and the full wiki tree are always included as context.
3. The agent answers in the same language as the question, citing each claim
   with an inline `[title](wiki/<concept-id>.md)` link and a `# Sources` section
   at the end. It may use `read`/`grep` to explore the wiki further.
4. The retrieved concepts, `index.md`, and the wiki tree are injected into the
   **system prompt** via a `before_agent_start` hook, so the user message stays
   clean — just the question itself. This keeps the session readable and the
   question persistable. The agent is also told to **open the whole concept
   body** before answering (not just the retrieved snippet), to follow
   `# Related Concepts` / `# Versions` links, and to surface any conflicts it
   finds while exploring.

If `wiki/` does not exist or has no concepts, `/wiki-query` tells you to run
`/wiki-update` first instead of inventing an answer.

## OKF conformance

Concepts are markdown files with YAML frontmatter; `type` is the only required
field. Recommended fields: `title`, `description`, `resource`, `tags`,
`timestamp`. `index.md` and `log.md` are reserved filenames maintained by
`/wiki-update`. See the
[OKF spec](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
for the full format.

Example concept (`wiki/tables/orders.md`):

```markdown
---
type: BigQuery Table
title: Orders
description: One row per completed order.
tags: [sales, orders]
timestamp: 2026-07-03T00:00:00Z
---

# Schema

| Column        | Type   | Description                       |
|---------------|--------|-----------------------------------|
| `order_id`    | STRING | Unique order identifier.          |
| `customer_id` | STRING | FK to [customers](/tables/customers.md). |

Part of the [sales dataset](/datasets/sales.md).
```

> **Link styles:** inside concept files, links are bundle-relative
> (`/tables/orders.md` — relative to the `wiki/` bundle). In `/wiki-query`
> answers, links are repo-relative (`wiki/tables/orders.md`) because the answer
> renders outside the bundle, from the project root. These are two different
> rendering contexts, not two competing conventions.

## Configuration

There is no configuration file yet. The extension always reads from
`input/`, `archive/`, and `wiki/` relative to `ctx.cwd`. `/wiki-query`
answers and `/wiki-update` summaries follow the language of the question /
transformed content automatically; edit `prompts.ts` to change that behavior.

## Architecture

A TypeScript extension, strictly typed with no `any`. Filesystem, wiki, and
extraction operations return a `Result<T>` (success/error) and never throw to
callers. Per the project's `AGENTS.md`, document extraction follows the
Repository pattern: each format family has a `DocumentExtractorRepository`
that wraps a third-party library, converts the library's native Dto to the
`ExtractedText` AppModel, and returns `Result<ExtractedText>`. The Dto never
leaks outside its repository.

| File | Responsibility |
| --- | --- |
| `index.ts` | Registers the `/wiki-update` and `/wiki-query` commands; owns the `agent_end` finalize hook and the `before_agent_start` query-context hook (both via the session registries). |
| `types.ts` | `Result<T>`, `AppError`, OKF domain models, and the `IgnoreReason` code union. |
| `session.ts` | `Session` interface and the generic `SessionRegistry<T>` that owns the single-slot handoff between a command handler and an event hook. |
| `frontmatter.ts` | Minimal YAML frontmatter parser for the OKF subset. |
| `files.ts` | Filesystem helpers, all returning `Result<T>` (incl. `copyFile`, `removeDir`). |
| `wiki.ts` | Barrel re-exporting the `wiki/` modules so the `./wiki.ts` import surface stays stable for `update.ts`, `query.ts`, `classifier.ts`, and `prompts.ts`. |
| `wiki/paths.ts` | `wikiPaths`, `conceptIdFromRelativePath`, `isConceptFile`, `relativePosix`, `WikiPaths`. |
| `wiki/concepts.ts` | Concept loading (`loadConcept`, `loadAllConcepts`), snapshot/diff (`snapshotWiki`, `diffSnapshots`, `WikiDiff`). |
| `wiki/index-log.ts` | `index.md` / `log.md` generation (`generateIndexMd`, `writeIndexMd`, `appendLogMd`, `buildLogEntry`). |
| `wiki/retrieval.ts` | Structure preview and term-frequency retrieval (`retrieveConcepts`, `tokenize`, `renderConceptForPrompt`, `renderWikiTree`, `displayTitle`, `buildStructurePreview`, `TERM_STOPWORDS`). |
| `prompts.ts` | Agent prompt builders for ingestion and query. |
| `update.ts` | `/wiki-update` command logic and the `IntakeSession` (finalize) that owns the agent-handoff state. |
| `classifier.ts` | `InputClassifier` that owns the full input→bucket pipeline AND the deterministic conformant intake: tentative dispatch by extension, the extraction pass (staging extracted text), and pass 3 — read + verify frontmatter + write to `wiki/` + archive original — for conformant `.md` files. Emits the three final buckets (`conformantImported` / `forAgent` / `ignored`) once, in input order. |
| `query.ts` | `/wiki-query` command logic and the `QuerySession` that owns the pending question. |
| `extract/types.ts` | `ExtractedText` AppModel, `DocumentExtractorRepository` interface, extraction-failure cause codes. |
| `extract/pdf.ts` | `PdfRepository` (`unpdf`). |
| `extract/docx.ts` | `DocxRepository` (`mammoth`). |
| `extract/sheet.ts` | `SheetRepository` (`exceljs`), rendering worksheets as markdown tables. |
| `extract/office-xml.ts` | `PptxRepository`, `OdtRepository`, `EpubRepository` (shared `jszip` + XML helpers, EPUB spine-order). |
| `extract/html.ts` | `HtmlRepository` (`html-to-text`). |
| `extract/rtf.ts` | `RtfRepository` (dependency-free RTF stripper). |
| `extract/registry.ts` | Format taxonomy + `ExtractorRegistry` dispatch. |
| `extract/service.ts` | Extraction-to-temp-file orchestration and the `.okf-extract/` lifecycle. |
| `extract/util.ts` | Shared `Result<T>` failure + error-message helpers for repositories. |

### Development

```bash
npm install          # installs peer/dev deps for type-checking
npm run check        # tsc --noEmit (strict, noUnusedLocals)
```

The extension imports `@earendil-works/pi-coding-agent` only as type-only
imports (erased at runtime), so it has no bundled runtime dependencies.

## License

MIT — see [LICENSE](./LICENSE).