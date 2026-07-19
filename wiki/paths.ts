// Wiki path helpers: wikiPaths, conceptIdFromRelativePath, isConceptFile,
// relativePosix.

import { join, relative as nodeRelative } from "node:path";

export interface WikiPaths {
  readonly root: string; // ctx.cwd
  readonly input: string;
  readonly archive: string;
  readonly wiki: string;
}

export function wikiPaths(cwd: string): WikiPaths {
  return {
    root: cwd,
    input: join(cwd, "input"),
    archive: join(cwd, "archive"),
    wiki: join(cwd, "wiki"),
  };
}

const RESERVED = new Set(["index.md", "log.md"]);

export function isConceptFile(relativePath: string): boolean {
  if (!relativePath.endsWith(".md")) return false;
  const segments = relativePath.split("/");
  if (segments.length === 0) return false;
  return !RESERVED.has(segments[segments.length - 1]);
}

export function conceptIdFromRelativePath(relativePath: string): string {
  return relativePath.endsWith(".md")
    ? relativePath.slice(0, -3)
    : relativePath;
}

export function relativePosix(from: string, to: string): string {
  return nodeRelative(from, to).split(/[/\\]/).join("/");
}