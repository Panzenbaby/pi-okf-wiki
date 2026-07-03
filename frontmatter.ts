// Minimal YAML frontmatter parser for the OKF subset.
// Handles `key: value`, `key: [a, b, c]`, quoted strings, and inline comments.
// No external dependency — sufficient for classification and index generation.

import type { Frontmatter } from "./types.ts";

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
  return { frontmatter: toFrontmatter(parseYamlSubset(fmLines)), body };
}

function parseYamlSubset(lines: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (key === "") continue;
    const valueRaw = line.slice(idx + 1).trim();
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
    tags: asStringArray(raw["tags"]),
    raw,
  };
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value !== "") return value;
  return undefined;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}