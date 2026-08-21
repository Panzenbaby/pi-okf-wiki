// Archive-citation link rewriting.
//
// The agent cites archived originals with the ORIGINAL input relative path as
// a stable placeholder: `/archive/<input-relative-path>`. In OKF v0.2 those
// placeholders live primarily in the `sources[].resource` frontmatter entries
// (§5.1), and may also appear as markdown links in the body. After the agent
// moves each original into `archive/` — possibly under a collision-renamed
// path (see `resolveArchiveTarget` in files.ts) — the finalize step rewrites
// those placeholders to the real archive path so a consumer can follow them.
//
// Scope: the WHOLE document (frontmatter + body). v0.1 kept frontmatter
// byte-for-byte untouched because provenance lived in a body `# Citations`
// list and the only path-valued frontmatter key was the top-level `resource:`
// (canonical URI, never an archive path). v0.2 moves provenance INTO the
// frontmatter (`sources[].resource` legitimately holds `/archive/...` paths,
// §5.1/§6.2), so the rewriter must reach it. The top-level `resource:` rule
// is unchanged and remains enforced by the prompt, not by this rewriter.
//
// This module is pure + total (no IO, no exceptions) so the rename behavior is
// deterministic and unit-testable independent of the agent and filesystem.

/** A compiled, reusable rewriter for one archive-target mapping. */
export interface ArchiveRewriter {
  /** True iff any non-identity mapping is present (i.e. rewriting can do work). */
  readonly hasMappings: boolean;
  /**
   * Rewrite `/archive/<original-relative-path>` placeholders in the BODY of a
   * concept file to the actual (post-rename) archive path. Frontmatter is
   * preserved verbatim. Returns the (possibly unchanged) content and whether
   * a rewrite happened.
   */
  rewrite(content: string): { content: string; changed: boolean };
}

/**
 * Compile a rewriter for `mapping` (original input relative path -> archive
 * relative path, both posix). The regex alternation is built ONCE here and
 * reused across many {@link ArchiveRewriter.rewrite} calls — call this once
 * per finalize run, not once per concept.
 *
 * The alternation is ordered longest-first so the longest key wins at each
 * position, and is anchored with an end boundary `(?=[)\\s>"']|$)` so a shorter
 * key cannot prefix-match inside a longer path that is NOT a mapping key
 * (e.g. mapping `{a.md}` must not rewrite `/archive/a.md.bak` — a different
 * file). The boundary accepts the forms the prompt actually produces: a plain
 * markdown link close `)`, an angle-bracket link close `>` (for paths with
 * spaces, `[label](</archive/...>)`), a closing YAML quote (`"` or `'` for a
 * quoted `sources[].resource` value), and a line / end-of-string boundary
 * (`\\s` or `$`). Identity mappings (original == archive) are skipped.
 */
export function compileArchiveRewriter(
  mapping: ReadonlyMap<string, string>,
): ArchiveRewriter {
  // Drop identity / empty mappings; sort longest-first so the regex
  // alternation prefers the longest match at each position.
  const entries = [...mapping.entries()]
    .filter(([orig, archive]) => orig !== "" && orig !== archive)
    .sort((a, b) => b[0].length - a[0].length);
  if (entries.length === 0) {
    return { hasMappings: false, rewrite: (c) => ({ content: c, changed: false }) };
  }
  const lookup = new Map(entries);
  const alternation = entries.map(([orig]) => escapeRegex(orig)).join("|");
  const re = new RegExp(`/archive/(?:${alternation})(?=[)\\s>"']|$)`, "g");

  return {
    hasMappings: true,
    // The whole document (frontmatter + body) is rewritten — v0.2 provenance
    // placeholders live in `sources[].resource` frontmatter values (§5.1).
    rewrite(content: string) {
      if (!content.includes("/archive/")) return { content, changed: false };
      let changed = false;
      const out = content.replace(re, (match) => {
        const origRel = match.slice("/archive/".length);
        const archiveRel = lookup.get(origRel);
        if (archiveRel === undefined) return match;
        changed = true;
        return `/archive/${archiveRel}`;
      });
      return { content: changed ? out : content, changed };
    },
  };
}

/**
 * Convenience wrapper: compile a rewriter for `mapping` and apply it once to
 * `content`. Use {@link compileArchiveRewriter} directly when rewriting many
 * files with the same mapping (one compile, many rewrites).
 */
export function rewriteArchiveCitationLinks(
  content: string,
  mapping: ReadonlyMap<string, string>,
): { content: string; changed: boolean } {
  return compileArchiveRewriter(mapping).rewrite(content);
}

/** A compiled rewriter that redirects links pointing at removed concepts. */
export interface RemovedConceptRewriter {
  readonly hasMappings: boolean;
  /**
   * Rewrite references to removed concepts in the concept stored at
   * `sourceDir` (its bundle-relative directory, `""` for the bundle root):
   * markdown links in the BODY plus `resource:` values in the frontmatter
   * (`sources[].resource` may point at another concept, §5.1/§6.2).
   * `sourceDir` is needed because a target may be relative to the file
   * that contains it.
   */
  rewrite(content: string, sourceDir: string): { content: string; changed: boolean };
}

/**
 * Inline link destination: the `(...)` of `[label](target)`. The optional
 * trailing title (`"…"`, `'…'`, or `(…)`) is captured separately so it can be
 * carried over verbatim when the destination is replaced — without this group
 * a titled link does not match at all and would silently keep pointing at a
 * removed concept.
 */
const INLINE_LINK_RE =
  /\]\(\s*(<[^>]*>|[^()\s]*)((?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?)\s*\)/g;

/**
 * Reference-style link definition (`[label]: /project/foo.md "Title"`), which
 * carries a destination just like an inline link and would otherwise be left
 * dangling. Anchored to the start of a line, per CommonMark's up-to-three
 * leading spaces.
 */
const REFERENCE_DEF_RE = /^([ \t]{0,3}\[[^\]\n]+\]:[ \t]*)(<[^>]*>|\S+)/;

/**
 * Apply `transform` to every line that is NOT inside a fenced code block.
 *
 * Concept bodies routinely contain markdown examples in ``` fences; rewriting
 * a link inside one would corrupt documentation that only *shows* a link
 * rather than making one.
 */
function mapProseLines(body: string, transform: (line: string) => string): string {
  let fence: string | null = null;
  return body
    .split("\n")
    .map((line) => {
      const opener = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence !== null) {
        // Only a fence of the same character (and at least as long) closes it.
        if (opener !== null && opener[1]!.startsWith(fence[0]!) && opener[1]!.length >= fence.length) {
          fence = null;
        }
        return line;
      }
      if (opener !== null) {
        fence = opener[1]!;
        return line;
      }
      return transform(line);
    })
    .join("\n");
}

/**
 * Concept ids linked from `body` (inline and reference-style, code fences
 * excluded), resolved relative to `sourceDir`. Shared with the removal plan so
 * the confirmation dialog counts exactly the links the rewriter will redirect.
 */
export function collectConceptLinks(
  body: string,
  sourceDir: string,
): readonly string[] {
  const ids: string[] = [];
  mapProseLines(body, (line) => {
    for (const match of line.matchAll(INLINE_LINK_RE)) {
      const conceptId = conceptIdFromLinkTarget(match[1]!, sourceDir);
      if (conceptId !== null) ids.push(conceptId);
    }
    const definition = REFERENCE_DEF_RE.exec(line);
    if (definition !== null) {
      const conceptId = conceptIdFromLinkTarget(definition[2]!, sourceDir);
      if (conceptId !== null) ids.push(conceptId);
    }
    return line;
  });
  return ids;
}

/**
 * Compile a rewriter for `mapping` (conceptId -> bundle-relative trash path,
 * e.g. `project/foo` -> `/trash/project/foo.md.orig`).
 *
 * The BODY is rewritten link-by-link. In the FRONTMATTER, only `resource:`
 * values are considered (line-based, byte-preserving for everything else):
 * a v0.2 `sources[].resource` may legitimately point at another concept in
 * the bundle (§5.1/§6.2), and leaving it dangling after a removal would
 * silently break the provenance graph. A top-level `resource:` naming a
 * removed concept is redirected by the same rule — it referenced that
 * concept, and the trash path is where it now lives.
 *
 * Targets are matched by resolving each link destination to a conceptId, so
 * every spelling of the same concept is caught: root-relative
 * (`/project/foo.md`), bundle-prefixed (`wiki/project/foo.md`), and relative
 * to the containing file (`../project/foo.md`). Rewritten links are always
 * emitted root-relative, which is the dominant form in generated wikis and
 * stays valid regardless of where the citing concept later moves.
 */
export function compileRemovedConceptRewriter(
  mapping: ReadonlyMap<string, string>,
): RemovedConceptRewriter {
  if (mapping.size === 0) {
    return { hasMappings: false, rewrite: (c) => ({ content: c, changed: false }) };
  }
  const redirectTarget = (rawTarget: string, sourceDir: string): string | null => {
    const conceptId = conceptIdFromLinkTarget(rawTarget, sourceDir);
    if (conceptId === null) return null;
    const trashPath = mapping.get(conceptId);
    if (trashPath === undefined) return null;
    return trashPath;
  };

  const rewriteBody = (
    body: string,
    sourceDir: string,
  ): { content: string; changed: boolean } => {
    let changed = false;
    const redirect = (rawTarget: string): string | null => {
      const trashPath = redirectTarget(rawTarget, sourceDir);
      if (trashPath === null) return null;
      changed = true;
      return encodeLinkTarget(trashPath);
    };
    const out = mapProseLines(body, (line) => {
      const withInline = line.replace(
        INLINE_LINK_RE,
        (match, rawTarget: string, title: string) => {
          const target = redirect(rawTarget);
          return target === null ? match : `](${target}${title})`;
        },
      );
      return withInline.replace(
        REFERENCE_DEF_RE,
        (match, head: string, rawTarget: string) => {
          const target = redirect(rawTarget);
          return target === null ? match : `${head}${target}`;
        },
      );
    });
    return { content: out, changed };
  };

  /**
   * Redirect `resource:` values in the frontmatter, line-based so every other
   * frontmatter byte (key order, comments, quoting of other values) is
   * preserved. Matches both the top-level `resource:` and list-item
   * `- resource:` / indented `resource:` forms of a `sources` entry.
   */
  const rewriteFrontmatter = (
    frontmatter: string,
    sourceDir: string,
  ): { content: string; changed: boolean } => {
    if (frontmatter === "") return { content: frontmatter, changed: false };
    let changed = false;
    const out = frontmatter
      .split("\n")
      .map((line) => {
        const match = /^(\s*(?:-\s+)?resource:\s*)(\S.*?)\s*$/.exec(line);
        if (match === null) return line;
        const rawValue = unquoteYaml(match[2]!);
        const trashPath = redirectTarget(rawValue, sourceDir);
        if (trashPath === null) return line;
        changed = true;
        return `${match[1]!}${quoteYamlIfNeeded(trashPath)}`;
      })
      .join("\n");
    return { content: out, changed };
  };

  return {
    hasMappings: true,
    rewrite(content: string, sourceDir: string) {
      const { frontmatter, body } = splitFrontmatter(content);
      const fmResult = rewriteFrontmatter(frontmatter, sourceDir);
      const bodyResult = rewriteBody(body, sourceDir);
      if (!fmResult.changed && !bodyResult.changed) return { content, changed: false };
      return { content: fmResult.content + bodyResult.content, changed: true };
    },
  };
}

/** Strip a single level of matching YAML quotes from a scalar value. */
function unquoteYaml(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** Quote a YAML scalar when it needs it (spaces / quote chars / `#`). */
function quoteYamlIfNeeded(value: string): string {
  return /[\s"'#]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/**
 * Resolve a markdown link destination to the conceptId it points at, or null
 * when it does not address a concept in this bundle (external URL, non-`.md`
 * target, or a path escaping the bundle root).
 *
 * `sourceDir` is the bundle-relative directory of the file containing the
 * link (`""` for the bundle root).
 */
export function conceptIdFromLinkTarget(
  rawTarget: string,
  sourceDir: string,
): string | null {
  let target = rawTarget.trim();
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1).trim();
  if (target === "") return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) return null; // http:, mailto:, file:, …
  // A writer may percent-encode characters the file name contains literally
  // (`My%20Doc.md`). Concept ids use the real file name, so decode first or
  // the link would silently miss its target.
  target = decodePath(target);
  // Anchors/queries address a location INSIDE the target file; the file
  // identity is all that matters here, so they are dropped.
  target = target.split("#")[0]!.split("?")[0]!;
  if (!target.endsWith(".md")) return null;

  const isRootRelative = target.startsWith("/");
  const normalized = normalizePosix(
    isRootRelative ? target.slice(1) : joinPosix(sourceDir, target),
  );
  if (normalized === null) return null; // escaped the bundle root
  let path = normalized;
  // A root-relative link may address the bundle from outside it (`/wiki/x.md`).
  if (path.startsWith("wiki/")) path = path.slice("wiki/".length);
  if (!path.endsWith(".md")) return null;
  return path.slice(0, -3);
}

function joinPosix(dir: string, path: string): string {
  return dir === "" ? path : `${dir}/${path}`;
}

/** Percent-decode a link target; malformed sequences are left as written. */
function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** A target containing spaces or parens only parses inside angle brackets. */
function encodeLinkTarget(path: string): string {
  return /[\s()]/.test(path) ? `<${path}>` : path;
}

/** Collapse `.` / `..` segments. Returns null if the path escapes the root. */
function normalizePosix(path: string): string | null {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") {
      out.push(segment);
      continue;
    }
    if (out.length === 0) return null;
    out.pop();
  }
  return out.join("/");
}

/**
 * Split a concept file's content into its frontmatter (verbatim, including
 * both `---` fences and the trailing newline) and body. If the content has no
 * valid closed frontmatter block, `frontmatter` is "" and `body` is the whole
 * content (so a frontmatter-less file is still rewritten as a single body).
 *
 * The split is structural (line-based on the closing `---` fence), not a YAML
 * parse, so every frontmatter byte — key order, comments, quoting — is
 * preserved exactly when the body is rewritten and the file is reassembled.
 */
function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  if (!content.startsWith("---")) return { frontmatter: "", body: content };
  const lines = content.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      const frontmatter = lines.slice(0, i + 1).join("\n") + "\n";
      const body = lines.slice(i + 1).join("\n");
      return { frontmatter, body };
    }
  }
  // Unclosed frontmatter — treat the whole content as the body.
  return { frontmatter: "", body: content };
}

/** Escape regex metacharacters in a literal string for use in a RegExp. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}