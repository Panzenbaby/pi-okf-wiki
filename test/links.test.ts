import { describe, expect, it } from "vitest";

import { rewriteArchiveCitationLinks } from "../src/links.ts";

describe("rewriteArchiveCitationLinks", () => {
  it("rewrites a placeholder link to the renamed archive path", () => {
    const content = "See [spec v2](/archive/notes/spec-v2.pdf) for details.";
    const mapping = new Map([["notes/spec-v2.pdf", "notes/spec-v2.2026-07-19-1719.pdf"]]);
    expect(rewriteArchiveCitationLinks(content, mapping)).toEqual({
      content: "See [spec v2](/archive/notes/spec-v2.2026-07-19-1719.pdf) for details.",
      changed: true,
    });
  });

  it("rewrites every occurrence, not just the first", () => {
    const content =
      "[1](/archive/a.md) and [2](/archive/a.md) both cite a.md.";
    const mapping = new Map([["a.md", "a.2026-07-19-1719.md"]]);
    expect(rewriteArchiveCitationLinks(content, mapping)).toEqual({
      content:
        "[1](/archive/a.2026-07-19-1719.md) and [2](/archive/a.2026-07-19-1719.md) both cite a.md.",
      changed: true,
    });
  });

  it("leaves external URLs and plain text (no leading slash) untouched", () => {
    // Only the `/archive/<path>` placeholder form is rewritten. A bare
    // `archive/a.md` (no leading slash) is not the placeholder, so it stays —
    // the prompt instructs the agent to use the `/archive/` link form, and the
    // rewriter only fixes that form.
    const content =
      "External: [pi](https://example.com/pi). Plain: archive/a.md not a link.";
    const mapping = new Map([["a.md", "a.2026-07-19-1719.md"]]);
    expect(rewriteArchiveCitationLinks(content, mapping)).toEqual({
      content,
      changed: false,
    });
  });

  it("leaves references that do not match any mapping key untouched", () => {
    const content = "[old](/archive/legacy/doc.md) was archived last year.";
    const mapping = new Map([["notes/spec-v2.pdf", "notes/spec-v2.2026-07-19-1719.pdf"]]);
    expect(rewriteArchiveCitationLinks(content, mapping)).toEqual({
      content,
      changed: false,
    });
  });

  it("applies the longest original path first to avoid prefix collisions", () => {
    // `notes/foo.md.bak` is longer than `notes/foo.md`; processing the longer
    // key first keeps the shorter from partially rewriting it.
    const content =
      "[a](/archive/notes/foo.md) [b](/archive/notes/foo.md.bak)";
    const mapping = new Map<string, string>([
      ["notes/foo.md", "notes/foo.2026-07-19-1719.md"],
      ["notes/foo.md.bak", "notes/foo.md.bak.2026-07-19-1719.bak"],
    ]);
    expect(rewriteArchiveCitationLinks(content, mapping)).toEqual({
      content:
        "[a](/archive/notes/foo.2026-07-19-1719.md) [b](/archive/notes/foo.md.bak.2026-07-19-1719.bak)",
      changed: true,
    });
  });

  it("handles path characters that are regex-special (., +) safely", () => {
    const content = "[x](/archive/v1.2+3.pdf)";
    const mapping = new Map([["v1.2+3.pdf", "v1.2+3.2026-07-19-1719.pdf"]]);
    expect(rewriteArchiveCitationLinks(content, mapping)).toEqual({
      content: "[x](/archive/v1.2+3.2026-07-19-1719.pdf)",
      changed: true,
    });
  });

  it("reports changed=false and returns the same content for an empty mapping", () => {
    const content = "[x](/archive/a.md)";
    expect(rewriteArchiveCitationLinks(content, new Map())).toEqual({
      content,
      changed: false,
    });
  });

  it("reports changed=false when the placeholder is not present", () => {
    const content = "no archive links here";
    const mapping = new Map([["a.md", "a.2026-07-19-1719.md"]]);
    expect(rewriteArchiveCitationLinks(content, mapping)).toEqual({
      content,
      changed: false,
    });
  });

  it("rewrites placeholder paths inside the frontmatter (v0.2 sources[].resource, §5.1)", () => {
    // v0.2 moves provenance into the frontmatter: an archive placeholder in a
    // `sources[].resource` value must be renamed together with body links.
    const content = `---\ntype: concept\nsources:\n  - id: spec\n    resource: /archive/notes/spec-v2.pdf\n---\n\nbody`;
    const mapping = new Map([["notes/spec-v2.pdf", "notes/spec-v2.2026-07-19-1719.pdf"]]);
    const result = rewriteArchiveCitationLinks(content, mapping);
    expect(result.changed).toBe(true);
    expect(result.content).toContain(
      "resource: /archive/notes/spec-v2.2026-07-19-1719.pdf",
    );
  });

  it("rewrites a placeholder that appears only in the body, leaving frontmatter verbatim", () => {
    const content = `---\ntype: concept\nresource: https://example.com/spec\n---\n\n[spec](/archive/notes/spec-v2.pdf)`;
    const mapping = new Map([["notes/spec-v2.pdf", "notes/spec-v2.2026-07-19-1719.pdf"]]);
    expect(rewriteArchiveCitationLinks(content, mapping)).toEqual({
      content: `---\ntype: concept\nresource: https://example.com/spec\n---\n\n[spec](/archive/notes/spec-v2.2026-07-19-1719.pdf)`,
      changed: true,
    });
  });

  it("does not rewrite when original and archive path are identical", () => {
    const content = "[x](/archive/a.md)";
    const mapping = new Map([["a.md", "a.md"]]);
    expect(rewriteArchiveCitationLinks(content, mapping)).toEqual({
      content,
      changed: false,
    });
  });

  it("does NOT prefix-match a shorter key inside a longer path that is not in the mapping", () => {
    // `a.md` is a mapping key; `a.md.bak` is a DIFFERENT file the agent cited
    // (e.g. a previously-archived original) and must NOT be corrupted into
    // `<renamed>.bak`. The end boundary blocks the prefix match.
    const content = "[short](/archive/a.md) [other](/archive/a.md.bak)";
    const mapping = new Map([["a.md", "a.2026-07-19-1719.md"]]);
    expect(rewriteArchiveCitationLinks(content, mapping)).toEqual({
      content: "[short](/archive/a.2026-07-19-1719.md) [other](/archive/a.md.bak)",
      changed: true,
    });
  });

  it("rewrites an angle-bracket link whose path contains spaces", () => {
    // A path with spaces needs CommonMark's angle-bracket form to be valid
    // markdown; the `>` close is part of the rewriter's end boundary.
    const content = "[my spec](</archive/notes/my spec.pdf>)";
    const mapping = new Map([["notes/my spec.pdf", "notes/my spec.2026-07-19-1719.pdf"]]);
    expect(rewriteArchiveCitationLinks(content, mapping)).toEqual({
      content: "[my spec](</archive/notes/my spec.2026-07-19-1719.pdf>)",
      changed: true,
    });
  });

  it("does not rewrite a placeholder followed by a path-continuation char (e.g. a hyphenated sibling)", () => {
    // `/archive/a.md-old` is a different filename; the `a.md` key must not
    // match it. (Hyphen is not a boundary char in `[)\s]`, so this is blocked.)
    const content = "[x](/archive/a.md-old)";
    const mapping = new Map([["a.md", "a.2026-07-19-1719.md"]]);
    expect(rewriteArchiveCitationLinks(content, mapping)).toEqual({
      content,
      changed: false,
    });
  });

  it("rewrites a placeholder that appears ONLY in the frontmatter (whole-document scope)", () => {
    const content = `---\ntype: concept\nsources:\n  - resource: /archive/a.md\n---\n\nbody`;
    const mapping = new Map([["a.md", "a.2026-07-19-1719.md"]]);
    const result = rewriteArchiveCitationLinks(content, mapping);
    expect(result.changed).toBe(true);
    expect(result.content).toContain("resource: /archive/a.2026-07-19-1719.md");
  });
});