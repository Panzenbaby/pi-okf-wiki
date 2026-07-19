// HtmlRepository — extracts plain text from HTML files using `html-to-text`.
//
// The library's string output is wrapped as the `ExtractedText` AppModel. No
// Dto leaks (the library returns a plain string, so the "Dto" is the string
// itself; we still keep the conversion explicit for symmetry with siblings).

import { readFile } from "node:fs/promises";

import { ok, type Result } from "../types.ts";
import type { ExtractedText, DocumentExtractorRepository } from "./types.ts";
import { extractionFailure, message } from "./util.ts";

export class HtmlRepository implements DocumentExtractorRepository {
  readonly supportedExtensions = [".html", ".htm"] as const;
  readonly sourceFormat = "html";

  async extract(absolutePath: string): Promise<Result<ExtractedText>> {
    let buffer: Buffer;
    try {
      buffer = await readFile(absolutePath);
    } catch (error) {
      return extractionFailure("extraction_failed", `Failed to read HTML: ${message(error)}`, absolutePath);
    }

    try {
      const { htmlToText } = await import("html-to-text");
      const html = buffer.toString("utf-8");
      const text = htmlToText(html, {
        wordwrap: false,
        selectors: [
          { selector: "a", options: { linkBrackets: ["(", ")"] } },
          { selector: "img", format: "skip" },
        ],
      }).trim();
      if (text.length === 0) {
        return extractionFailure("empty", "HTML yielded no text.", absolutePath);
      }
      return ok<ExtractedText>({ text, sourceFormat: this.sourceFormat, warnings: [] });
    } catch (error) {
      return extractionFailure("extraction_failed", `HTML extraction failed: ${message(error)}`, absolutePath);
    }
  }
}