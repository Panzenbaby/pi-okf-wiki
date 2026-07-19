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
    // Archive lives INSIDE the OKF bundle (wiki/), not as a sibling, so that
    // `/archive/<rel>` citation links in concept bodies are bundle-relative
    // and resolvable by any OKF consumer. Archived `.md` originals are stored
    // with an outermost `.orig` suffix (see resolveArchiveTarget in files.ts)
    // so they are not concept documents per OKF §3.1 and the bundle stays
    // conformant (§9.1) without requiring frontmatter on archived originals.
    archive: join(cwd, "wiki", "archive"),
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