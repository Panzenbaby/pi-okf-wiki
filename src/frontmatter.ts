// YAML frontmatter parsing and serialization for OKF v0.2 concepts.
//
// v0.2 made nested structures first-class (`generated: { by, at }`, `sources`
// as a list of maps, `verified` as list-or-bare-mapping — §5), which is beyond
// the hand-rolled scalar/flat-list subset that sufficed for v0.1. We therefore
// parse with the `yaml` package (YAML 1.2 core schema: timestamps stay
// strings, no implicit date coercion) and keep the permissive-consumption
// posture of §11 in the typed view:
//
// - Unknown keys are preserved verbatim in `raw` (round-tripping, §4.1).
// - A bare scalar for a list-valued field (`tags: foo`) is wrapped to a
//   one-element list — a forgotten bracket never silently loses data.
// - A bare `verified: { by, at }` mapping is normalized to a one-element
//   list (§5.2 consumers MUST).
// - Scalar list items that YAML types as numbers/booleans (`tags: [2024]`)
//   are coerced back to strings.
// - A YAML syntax error yields `frontmatter: null` — the caller treats the
//   document as non-conformant (deferred to the agent) instead of crashing.
//
// The legacy v0.1 `timestamp` key is still surfaced so consumers can fall
// back to it when `generated` is absent (§13.1).

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { ActorEvent, Frontmatter, SourceEntry } from "./types.ts";

const FENCE = "---";

export interface ParsedDocument {
  readonly frontmatter: Frontmatter | null;
  readonly body: string;
}

export function parseDocument(content: string): ParsedDocument {
  if (!content.startsWith(FENCE)) {
    return { frontmatter: null, body: content };
  }
  const lines = content.split(/\r?\n/);
  let i = 1; // skip opening fence
  const fmLines: string[] = [];
  let closed = false;
  for (; i < lines.length; i++) {
    if (lines[i].trim() === FENCE) {
      closed = true;
      break;
    }
    fmLines.push(lines[i]);
  }
  if (!closed) {
    return { frontmatter: null, body: content };
  }
  const body = lines.slice(i + 1).join("\n");
  const raw = parseYamlBlock(fmLines.join("\n"));
  if (raw === null) {
    // Malformed YAML: not a crash, not a rejection — the document is simply
    // not conformant yet (§11 permissive consumption; the classifier defers
    // such files to the agent for repair).
    return { frontmatter: null, body };
  }
  return { frontmatter: toFrontmatter(raw), body };
}

/**
 * Serialize frontmatter (as a raw key/value record) plus a body back into a
 * concept document. Unknown keys round-trip untouched (§4.1); key order
 * follows the record's insertion order. Used by deterministic writers (e.g.
 * a v0.1→v0.2 migration) — agent-authored concepts are written by the agent.
 */
export function serializeDocument(
  raw: Readonly<Record<string, unknown>>,
  body: string,
): string {
  const yaml = stringifyYaml(raw).trimEnd();
  const trimmedBody = body.replace(/^\n+/, "");
  return `${FENCE}\n${yaml}\n${FENCE}\n\n${trimmedBody}`;
}

/** Parse a YAML block to a plain record; null on syntax error or non-map. */
function parseYamlBlock(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = parseYaml(text);
    if (parsed === null || parsed === undefined) return {};
    if (typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toFrontmatter(raw: Record<string, unknown>): Frontmatter {
  return {
    type: asString(raw["type"]),
    title: asString(raw["title"]),
    description: asString(raw["description"]),
    resource: asString(raw["resource"]),
    timestamp: asString(raw["timestamp"]),
    tags: asStringList(raw["tags"]),
    status: asString(raw["status"]),
    supersedes: asStringList(raw["supersedes"]),
    generated: asActorEvent(raw["generated"]),
    verified: asActorEventList(raw["verified"]),
    sources: asSourceList(raw["sources"]),
    staleAfter: asString(raw["stale_after"]),
    raw,
  };
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value !== "") return value;
  // YAML 1.2 types bare numbers/booleans; a scalar field written as one
  // (e.g. a numeric title) is coerced rather than dropped.
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

/**
 * Coerce a frontmatter value to a string list. Accepts a YAML flow/block
 * list (Array) OR a bare scalar, which is wrapped to a single-element list
 * (scalar tolerance — never silently drop a forgotten-brackets value).
 */
function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => asString(item))
      .filter((item): item is string => item !== undefined);
  }
  const scalar = asString(value);
  return scalar !== undefined ? [scalar] : [];
}

/** A `{ by, at }` mapping (§5.2); undefined for anything else. */
function asActorEvent(value: unknown): ActorEvent | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const by = asString(record["by"]);
  const at = asString(record["at"]);
  if (by === undefined && at === undefined) return undefined;
  return { by, at };
}

/**
 * `verified` accepts a list of `{ by, at }` mappings OR a bare mapping,
 * which consumers MUST treat as a one-element list (§5.2).
 */
function asActorEventList(value: unknown): ActorEvent[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => asActorEvent(item))
      .filter((item): item is ActorEvent => item !== undefined);
  }
  const single = asActorEvent(value);
  return single !== undefined ? [single] : [];
}

function asSourceList(value: unknown): SourceEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: SourceEntry[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const entry: SourceEntry = {
      id: asString(record["id"]),
      resource: asString(record["resource"]),
      title: asString(record["title"]),
      author: asString(record["author"]),
      usageCount: asNumber(record["usage_count"]),
      lastModified: asString(record["last_modified"]),
    };
    // Keep entries with at least one recognized field; a fully opaque item
    // still round-trips via `raw`, it just has no typed view.
    if (Object.values(entry).some((field) => field !== undefined)) {
      entries.push(entry);
    }
  }
  return entries;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}
