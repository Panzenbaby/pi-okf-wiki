// Deterministic v0.1 -> v0.2 concept migration (`/wiki-migrate`).
//
// OKF v0.2 superseded two v0.1 conventions (§13.1):
//   - `timestamp` -> `generated: { by, at }`
//   - the body `# Citations` list -> the `sources` frontmatter family
//
// A v0.1 concept stays consumable through the spec's fallbacks, but a bundle
// that declares `okf_version: "0.2"` should not keep emitting v0.1 fields
// forever. This module rewrites legacy concepts in place, without the agent:
//
//   - A legacy `timestamp` becomes `generated.at` (the content's last
//     meaningful change — that is exactly what v0.1 `timestamp` recorded).
//     `generated.by` is REQUIRED within `generated` (§5.2) but the original
//     writer's model is unknown for old concepts, so the producer/version
//     actor `pi-okf-wiki/legacy` is used (§7). When `generated` already
//     exists, the redundant `timestamp` is simply dropped.
//   - A legacy `status` value becomes its §5.4 counterpart: `current` ->
//     `stable`, `superseded` -> `deprecated`. v0.1 left `status` to the
//     producer, so this bundle used it for the supersession graph; v0.2
//     standardizes the field, and a consumer reads any unknown value as
//     `stable` — which would silently promote a superseded concept back to
//     current. `supersedes` stays a producer extension (§4.1) and is left
//     alone.
//   - Each `# Citations` list entry becomes a `sources` entry
//     `{ id, resource, title }` (§5.1) and the body section is removed.
//     Existing `sources` entries are kept; a citation whose resource is
//     already listed is not duplicated. No footnotes are fabricated —
//     per-claim attribution cannot be reconstructed retroactively, and
//     `sources` without body footnotes is fully conformant.
//
// Only concepts that carry a legacy field are touched; everything else is
// left byte-for-byte alone. Frontmatter of migrated concepts is re-serialized
// via YAML (key order preserved, `timestamp` replaced in place by
// `generated`), which may normalize quoting — acceptable for a one-time
// migration and covered by round-trip tests.

import { ok, type Concept, type Result } from "./types.ts";
import { serializeDocument } from "./frontmatter.ts";
import { writeTextFile } from "./files.ts";
import { proseLineMask } from "./links.ts";
import { appendLogMd, loadAllConcepts, wikiPaths, writeAllIndexMd } from "./wiki.ts";

/** Actor (§7) recorded as `generated.by` for pre-v0.2 content of unknown origin. */
export const LEGACY_ACTOR = "pi-okf-wiki/legacy";

/** Pre-v0.2 `status` values and their §5.4 counterparts. */
const LEGACY_STATUS: Readonly<Record<string, string>> = {
  current: "stable",
  superseded: "deprecated",
};

/** The §5.4 value for a legacy `status`, or undefined when it needs no change. */
function migratedStatus(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return LEGACY_STATUS[value.trim().toLowerCase()];
}

export interface MigrationReport {
  /** Concept ids rewritten to v0.2, sorted. */
  readonly migrated: readonly string[];
  /** Concepts inspected and already v0.2 (untouched). */
  readonly alreadyCurrent: number;
}

/**
 * Migrate every legacy concept in the wiki to v0.2, regenerate `index.md`
 * (which also bumps the declared `okf_version`), and append a log entry for
 * the rewritten concepts.
 */
export async function migrateWiki(
  cwd: string,
  date: string = today(),
): Promise<Result<MigrationReport>> {
  const paths = wikiPaths(cwd);
  const concepts = await loadAllConcepts(paths.wiki);
  if (!concepts.success) return concepts;

  const migrated: string[] = [];
  for (const concept of concepts.data) {
    const rewritten = migrateConcept(concept);
    if (rewritten === null) continue;
    const written = await writeTextFile(concept.absolutePath, rewritten);
    if (!written.success) return written;
    migrated.push(concept.conceptId);
  }
  migrated.sort();

  if (migrated.length > 0) {
    const after = await loadAllConcepts(paths.wiki);
    if (!after.success) return after;
    const indexed = await writeAllIndexMd(paths.wiki, after.data);
    if (!indexed.success) return indexed;
    const logged = await appendLogMd(paths.wiki, date, {
      created: [],
      updated: migrated,
    });
    if (!logged.success) return logged;
  }

  return ok({
    migrated,
    alreadyCurrent: concepts.data.length - migrated.length,
  });
}

/**
 * Rewrite one concept to v0.2, or return null when it is already current
 * (no legacy `timestamp`, no legacy `status`, no body `# Citations` section).
 */
export function migrateConcept(concept: Concept): string | null {
  const raw = concept.frontmatter.raw;
  const hasLegacyTimestamp = raw["timestamp"] !== undefined;
  const nextStatus = migratedStatus(raw["status"]);
  const citations = extractCitations(concept.body);
  if (!hasLegacyTimestamp && citations === null && nextStatus === undefined) {
    return null;
  }

  // Rebuild the record in original key order, replacing `timestamp` in place
  // by `generated` (or dropping it when `generated` already exists).
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "timestamp") {
      if (raw["generated"] === undefined) {
        next["generated"] = { by: LEGACY_ACTOR, at: String(value) };
      }
      continue;
    }
    if (key === "status" && nextStatus !== undefined) {
      next[key] = nextStatus;
      continue;
    }
    next[key] = value;
  }

  let body = concept.body;
  if (citations !== null) {
    body = citations.cleanedBody;
    const existing = Array.isArray(next["sources"])
      ? [...(next["sources"] as unknown[])]
      : [];
    const known = new Set(
      existing
        .map((entry) =>
          typeof entry === "object" && entry !== null
            ? (entry as Record<string, unknown>)["resource"]
            : undefined,
        )
        .filter((resource): resource is string => typeof resource === "string"),
    );
    const usedIds = new Set(
      existing
        .map((entry) =>
          typeof entry === "object" && entry !== null
            ? (entry as Record<string, unknown>)["id"]
            : undefined,
        )
        .filter((id): id is string => typeof id === "string"),
    );
    for (const citation of citations.entries) {
      if (known.has(citation.resource)) continue;
      known.add(citation.resource);
      const entry: Record<string, unknown> = {
        id: uniqueId(slugForCitation(citation), usedIds),
        resource: citation.resource,
      };
      if (citation.title !== undefined) entry["title"] = citation.title;
      existing.push(entry);
    }
    if (existing.length > 0) next["sources"] = existing;
  }

  return serializeDocument(next, body);
}

interface Citation {
  readonly resource: string;
  readonly title: string | undefined;
}

interface ExtractedCitations {
  readonly entries: readonly Citation[];
  readonly cleanedBody: string;
}

const CITATIONS_HEADING_RE = /^#{1,6}\s+Citations\s*$/i;
const MARKDOWN_LINK_RE = /\[([^\]]*)\]\(\s*(<[^>]*>|[^()\s]+)\s*\)/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])?\s*(?:\[\d+\]\s+)?(.*)$/;
const BULLET_RE = /^\s*(?:[-*+]|\d+[.)]|\[\d+\])\s/;
const AUTOLINK_RE = /<((?:[a-z][a-z0-9+.-]*:|\.{0,2}\/)[^<>\s]*)>/i;
const BARE_URL_RE = /(https?:\/\/\S+)/;

/**
 * Find the `# Citations` section, parse its list entries, and return the body
 * with the whole section removed. Returns null when no section exists. A
 * section that exists but yields no parseable entries is still removed (it
 * carried no information a v0.2 consumer could use).
 *
 * Headings and list items inside a fenced code block are ignored throughout:
 * a concept that documents the v0.1 citation format shows exactly these lines
 * as an example, and cutting into the fence would leave it unterminated and
 * render the rest of the document as code.
 */
export function extractCitations(body: string): ExtractedCitations | null {
  const lines = body.split("\n");
  const isProse = proseLineMask(body);
  const start = lines.findIndex(
    (line, index) => isProse[index] === true && CITATIONS_HEADING_RE.test(line),
  );
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isProse[i] === true && /^#{1,6}\s/.test(lines[i]!)) {
      end = i;
      break;
    }
  }

  const entries: Citation[] = [];
  for (let i = start + 1; i < end; i++) {
    const line = lines[i]!;
    if (isProse[i] !== true || !BULLET_RE.test(line)) continue;
    // The v0.1 prompt asked for numbered citations, so a `[3]` marker after
    // the bullet is the norm rather than part of the citation itself.
    const text = LIST_ITEM_RE.exec(line)![1]!.trim();
    const link = MARKDOWN_LINK_RE.exec(text);
    if (link !== null) {
      let target = link[2]!;
      if (target.startsWith("<") && target.endsWith(">")) {
        target = target.slice(1, -1).trim();
      }
      const title = link[1]!.trim();
      entries.push({ resource: target, title: title === "" ? undefined : title });
      continue;
    }
    // A markdown autolink delimits its target, so the closing `>` belongs to
    // the syntax and must not reach the bare-URL fallback as part of the URL.
    const autolink = AUTOLINK_RE.exec(text);
    if (autolink !== null) {
      entries.push({ resource: autolink[1]!, title: undefined });
      continue;
    }
    const url = BARE_URL_RE.exec(text);
    if (url !== null) {
      entries.push({ resource: trimSentencePunctuation(url[1]!), title: undefined });
      continue;
    }
    // Prose-only citation: keep it as a scope-descriptor resource (§5.1
    // allows a resource a consumer cannot follow) rather than dropping it.
    if (text !== "") entries.push({ resource: text, title: undefined });
  }

  // Remove the section plus any blank lines directly above/below it.
  let cutStart = start;
  while (cutStart > 0 && lines[cutStart - 1]!.trim() === "") cutStart--;
  let cutEnd = end;
  while (cutEnd < lines.length && lines[cutEnd]!.trim() === "") cutEnd++;
  const cleaned = [...lines.slice(0, cutStart), ...(cutEnd < lines.length ? [""] : []), ...lines.slice(cutEnd)]
    .join("\n");
  return { entries, cleanedBody: cleaned };
}

/**
 * Strip punctuation that ends the surrounding sentence rather than the URL.
 * A closing bracket is only sentence punctuation when it is unbalanced —
 * `…/Foo_(Bar)` is a legitimate target, `(see …/foo)` is not.
 */
function trimSentencePunctuation(url: string): string {
  let out = url;
  for (;;) {
    const trimmed = out.replace(/[.,;:!?"'»›]+$/, "");
    const last = trimmed.slice(-1);
    const opener = last === ")" ? "(" : last === "]" ? "[" : null;
    if (opener === null || countChar(trimmed, opener) >= countChar(trimmed, last)) {
      return trimmed;
    }
    out = trimmed.slice(0, -1);
  }
}

function countChar(value: string, character: string): number {
  let count = 0;
  for (const char of value) if (char === character) count++;
  return count;
}

/**
 * Slug for a citation id: from its title, else from the resource. The id is
 * the join key body footnotes resolve against (§5.1), so a URL ending in a
 * slash must not collapse to the anonymous `source` — fall back to the last
 * non-empty path segment and then to the host before giving up.
 */
function slugForCitation(citation: Citation): string {
  const base = citation.title ?? slugSourceFromResource(citation.resource);
  const slug = base
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    // Truncation can cut mid-word and reintroduce an edge dash, so trim after.
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "source" : slug;
}

function slugSourceFromResource(resource: string): string {
  let path = resource;
  let host = "";
  try {
    const url = new URL(resource);
    path = decodeURIComponent(url.pathname);
    host = url.hostname;
  } catch {
    // Not a URL: a plain path or prose, both usable as they are.
  }
  const segment = path.split("/").filter((part) => part.trim() !== "").pop();
  return segment ?? host;
}

function uniqueId(slug: string, used: Set<string>): string {
  let candidate = slug;
  for (let n = 2; used.has(candidate); n++) candidate = `${slug}-${n}`;
  used.add(candidate);
  return candidate;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
