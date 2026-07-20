// Minimal YAML frontmatter parser for the OKF subset.
// Handles `key: value`, `key: [a, b, c]` (flow list), quoted strings, inline
// comments, AND block-list syntax (`key:\n  - a\n  - b`) for the list-valued
// OKF fields (`tags`, `supersedes`). Scalar tolerance: a bare scalar value
// for a list field (e.g. `tags: foo`) is wrapped to a single-element list so
// a producer who forgets the brackets does not silently lose data (§9
// permissive consumption).
//
// Limitations (documented, by design — see §2.3 design note): multi-line
// scalar values, nested maps, and block lists for producer-defined keys
// outside `tags`/`supersedes` are NOT supported; such lines are silently
// dropped rather than rejected. Conformance-critical fields (§4.1) are all
// scalars or flat lists, so the subset suffices for OKF v0.1 conformance.
// No external dependency — sufficient for classification and index generation.

import type { Frontmatter } from "./types.ts";

const FENCE = "---";

/** Frontmatter keys whose value is a list and therefore may be written as a YAML block sequence. */
const LIST_KEYS = new Set(["tags", "supersedes"]);

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
  return { frontmatter: toFrontmatter(parseYamlSubset(fmLines)), body };
}

function parseYamlSubset(lines: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  // When non-null, we are inside a block list for this key; subsequent
  // indented `- item` lines append to it until a non-list line ends the block.
  let pendingListKey: string | null = null;
  for (const line of lines) {
    if (pendingListKey !== null) {
      const isIndented = line.startsWith(" ") || line.startsWith("\t");
      const trimmed = line.trim();
      // An indented `- item` line appends to the pending block list.
      if (isIndented && trimmed.startsWith("-")) {
        let item = trimmed.slice(1).trim();
        // Strip inline ` #…` comments exactly like the flow-list path
        // (parseValue) does, so `  - foo # note` yields `foo`, not
        // `foo # note`. Only for unquoted values, matching parseValue.
        if (!item.startsWith('"') && !item.startsWith("'")) {
          const commentIndex = item.indexOf(" #");
          if (commentIndex !== -1) item = item.slice(0, commentIndex).trim();
        }
        item = unquote(item);
        const existing = result[pendingListKey];
        if (Array.isArray(existing)) existing.push(item);
        else result[pendingListKey] = [item];
        continue;
      }
      // Blank lines and comments are tolerated inside a block sequence.
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      // Anything else ends the block list and falls through to key parsing.
      pendingListKey = null;
    }
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (key === "") continue;
    const valueRaw = line.slice(idx + 1).trim();
    if (valueRaw === "" && LIST_KEYS.has(key)) {
      // Start a block list; collect subsequent indented `- item` lines.
      result[key] = [];
      pendingListKey = key;
      continue;
    }
    result[key] = parseValue(valueRaw);
  }
  return result;
}

function parseValue(raw: string): unknown {
  let value = raw.trim();
  if (value === "") return "";
  if (!value.startsWith('"') && !value.startsWith("'")) {
    const commentIndex = value.indexOf(" #");
    if (commentIndex !== -1) value = value.slice(0, commentIndex).trim();
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((part) => unquote(part.trim()));
  }
  return unquote(value);
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
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
    raw,
  };
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value !== "") return value;
  return undefined;
}

/**
 * Coerce a frontmatter value to a string list. Accepts a YAML flow/block
 * list (Array) OR a bare scalar string, which is wrapped to a single-element
 * list (scalar tolerance — never silently drop a forgotten-brackets value).
 */
function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string" && value !== "") return [value];
  return [];
}
