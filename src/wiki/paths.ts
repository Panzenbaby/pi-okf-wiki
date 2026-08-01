// Wiki path helpers: wikiPaths, conceptIdFromRelativePath, isConceptFile,
// relativePosix.

import { join, relative as nodeRelative } from "node:path";

export interface WikiPaths {
  readonly root: string; // ctx.cwd
  readonly input: string;
  readonly archive: string;
  readonly trash: string;
  readonly wiki: string;
}

/** Bundle-relative name of the archive directory (ingest originals). */
export const ARCHIVE_DIR = "archive";

/** Bundle-relative name of the trash directory (removed concepts). */
export const TRASH_DIR = "trash";

export function wikiPaths(cwd: string): WikiPaths {
  return {
    root: cwd,
    input: join(cwd, "input"),
    // Archive lives INSIDE the OKF bundle (wiki/), not as a sibling, so that
    // `/archive/<rel>` citation links in concept bodies are bundle-relative
    // paths — one of the three §8-sanctioned citation link forms
    // (absolute URLs, bundle-relative paths, or paths into a `references/`
    // subdirectory). Keeping the archive inside the bundle preserves that
    // spec-form; moving it out would force citations into a non-sanctioned
    // repo-relative form. The archive is a producer-specific OKF extension
    // (the spec's `references/` model is for OKF-concept .md mirrors, not raw
    // binaries) — tolerated because consumers ignore non-`.md` files (§9).
    // Archived `.md` originals are stored with an outermost `.orig` suffix
    // (see resolveArchiveTarget in files.ts) so they are not concept
    // documents per OKF §3.1 and the bundle stays conformant (§9.1) without
    // requiring frontmatter on archived originals. `archive/` is excluded
    // from index.md generation (see src/wiki/index-log.ts).
    archive: join(cwd, "wiki", ARCHIVE_DIR),
    // The trash lives inside the bundle for the same reason as the archive:
    // links in surviving concepts are rewritten to `/trash/<rel>`, which is a
    // bundle-relative path and therefore an OKF §8-sanctioned citation form.
    // A sibling `trash/` outside `wiki/` would force those links into a
    // non-sanctioned repo-relative form. Removed `.md` concepts are stored
    // with an outermost `.orig` suffix (see `resolveArchiveTarget` in
    // files.ts) so they stop being concept documents per OKF §3.1 and the
    // bundle stays conformant (§9.1) — which is also what keeps them out of
    // `/wiki-query` retrieval and out of `index.md` generation.
    trash: join(cwd, "wiki", TRASH_DIR),
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