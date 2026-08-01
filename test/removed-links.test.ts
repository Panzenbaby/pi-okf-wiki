import { describe, expect, it } from "vitest";

import {
  compileRemovedConceptRewriter,
  conceptIdFromLinkTarget,
} from "../src/links.ts";

const mapping = new Map([["project/foo", "/trash/project/foo.md.orig"]]);

describe("conceptIdFromLinkTarget", () => {
  it("resolves every spelling of the same concept to one id", () => {
    expect(conceptIdFromLinkTarget("/project/foo.md", "")).toBe("project/foo");
    expect(conceptIdFromLinkTarget("/wiki/project/foo.md", "")).toBe("project/foo");
    expect(conceptIdFromLinkTarget("foo.md", "project")).toBe("project/foo");
    expect(conceptIdFromLinkTarget("./foo.md", "project")).toBe("project/foo");
    expect(conceptIdFromLinkTarget("../project/foo.md", "guidelines")).toBe("project/foo");
    expect(conceptIdFromLinkTarget("<project/foo.md>", "")).toBe("project/foo");
  });

  it("drops anchors and queries — they address a place inside the file", () => {
    expect(conceptIdFromLinkTarget("/project/foo.md#setup", "")).toBe("project/foo");
  });

  it("percent-decodes so an encoded href matches the real file name", () => {
    expect(conceptIdFromLinkTarget("/project/My%20Doc.md", "")).toBe("project/My Doc");
  });

  it("returns null for non-concept targets", () => {
    expect(conceptIdFromLinkTarget("https://example.com/a.md", "")).toBeNull();
    expect(conceptIdFromLinkTarget("mailto:a@b.c", "")).toBeNull();
    expect(conceptIdFromLinkTarget("/archive/spec.pdf", "")).toBeNull();
    expect(conceptIdFromLinkTarget("", "")).toBeNull();
  });

  it("returns null when the path escapes the bundle root", () => {
    expect(conceptIdFromLinkTarget("../../secret.md", "project")).toBeNull();
  });
});

describe("compileRemovedConceptRewriter", () => {
  it("redirects links to a removed concept, in every spelling", () => {
    const rewriter = compileRemovedConceptRewriter(mapping);
    const body = "See [Foo](/project/foo.md) and [again](../project/foo.md).";
    const result = rewriter.rewrite(body, "guidelines");
    expect(result.changed).toBe(true);
    expect(result.content).toBe(
      "See [Foo](/trash/project/foo.md.orig) and [again](/trash/project/foo.md.orig).",
    );
  });

  it("keeps the link label untouched — the /trash/ path is the signal", () => {
    const rewriter = compileRemovedConceptRewriter(mapping);
    const result = rewriter.rewrite("[Foo](/project/foo.md)", "");
    expect(result.content).toBe("[Foo](/trash/project/foo.md.orig)");
  });

  it("leaves frontmatter byte-for-byte untouched", () => {
    const rewriter = compileRemovedConceptRewriter(mapping);
    const content = `---\ntype: note\nresource: /project/foo.md\n---\n\n[Foo](/project/foo.md)\n`;
    const result = rewriter.rewrite(content, "");
    expect(result.changed).toBe(true);
    expect(result.content).toBe(
      `---\ntype: note\nresource: /project/foo.md\n---\n\n[Foo](/trash/project/foo.md.orig)\n`,
    );
  });

  it("leaves links to surviving concepts alone", () => {
    const rewriter = compileRemovedConceptRewriter(mapping);
    const result = rewriter.rewrite("[Bar](/project/bar.md)", "");
    expect(result.changed).toBe(false);
    expect(result.content).toBe("[Bar](/project/bar.md)");
  });

  it("is idempotent — an already rewritten link is not touched again", () => {
    const rewriter = compileRemovedConceptRewriter(mapping);
    const once = rewriter.rewrite("[Foo](/project/foo.md)", "");
    const twice = rewriter.rewrite(once.content, "");
    expect(twice.changed).toBe(false);
    expect(twice.content).toBe(once.content);
  });

  it("wraps a target containing spaces in angle brackets so it still parses", () => {
    const rewriter = compileRemovedConceptRewriter(
      new Map([["project/My Doc", "/trash/project/My Doc.md.orig"]]),
    );
    const result = rewriter.rewrite("[Doc](/project/My%20Doc.md)", "");
    expect(result.content).toBe("[Doc](</trash/project/My Doc.md.orig>)");
  });

  it("does nothing without mappings", () => {
    const rewriter = compileRemovedConceptRewriter(new Map());
    expect(rewriter.hasMappings).toBe(false);
    expect(rewriter.rewrite("[Foo](/project/foo.md)", "").changed).toBe(false);
  });
});
