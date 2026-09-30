// HtmlRepository — extracts plain text from HTML files using `html-to-text`.
//
// The library's string output is wrapped as the `ExtractedText` AppModel. No
// Dto leaks (the library returns a plain string, so the "Dto" is the string
// itself; we still keep the conversion explicit for symmetry with siblings).

import { readFile } from "node:fs/promises";

import { ok, type Result } from "../types.ts";
import type { ExtractedText, DocumentExtractorRepository } from "./types.ts";
import { readEmbeddedImages, type EmbeddedImageReference } from "./embedded-images.ts";
import { extractionFailure, message } from "./util.ts";

function extractDataUriImages(html: string): EmbeddedImageReference[] {
  const images: EmbeddedImageReference[] = [];
  const headings = [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .map((match) => ({ index: match.index ?? 0, level: Number(match[1]), text: stripMarkup(match[2] ?? "") }))
    .filter((heading) => heading.text.length > 0);
  const imagePattern = /<img\b([^>]*?)\bsrc=["']data:(image\/[a-zA-Z0-9.+-]+);base64,([^"']+)["']([^>]*)>/gi;
  for (const match of html.matchAll(imagePattern)) {
    const mediaType = match[2]?.toLowerCase();
    const encoded = match[3];
    if (mediaType === undefined || encoded === undefined) continue;
    const alt = (match[1] ?? "").match(/\balt=["']([^"']*)["']/i)?.[1]
      ?? (match[4] ?? "").match(/\balt=["']([^"']*)["']/i)?.[1];
    const surrounding = surroundingHtmlContext(html, match.index ?? 0, match[0].length, headings);
    const contextParts = [surrounding.text, alt === undefined || alt.trim() === "" ? undefined : `Image alt text: ${alt.trim()}`]
      .filter((part): part is string => part !== undefined && part.length > 0);
    const extension = mediaType.split("/")[1] ?? "bin";
    const estimatedBytes = Math.floor(encoded.length * 3 / 4);
    images.push({
      file: {
        name: `image.${extension}`,
        _data: { uncompressedSize: estimatedBytes },
        async: async () => new Uint8Array(Buffer.from(encoded, "base64")),
      },
      ...(contextParts.length === 0 ? {} : { context: contextParts.join(" — ") }),
      ...(surrounding.location === undefined ? {} : { location: surrounding.location }),
    });
  }
  return images;
}

interface HtmlImageContext {
  readonly text: string;
  readonly location?: string;
}

interface HtmlHeading {
  readonly index: number;
  readonly level: number;
  readonly text: string;
}

function surroundingHtmlContext(
  html: string,
  imageIndex: number,
  imageLength: number,
  headings: readonly HtmlHeading[],
): HtmlImageContext {
  const before = html.slice(0, imageIndex);
  const after = html.slice(imageIndex + imageLength);
  const figureStart = before.toLowerCase().lastIndexOf("<figure");
  const paragraphStart = before.toLowerCase().lastIndexOf("<p");
  const divStart = before.toLowerCase().lastIndexOf("<section");
  const candidates = [
    { start: figureStart, tag: "figure" },
    { start: paragraphStart, tag: "p" },
    { start: divStart, tag: "section" },
  ].filter((candidate) => candidate.start >= 0 && before.indexOf(">", candidate.start) >= candidate.start);
  const nearest = candidates.sort((left, right) => right.start - left.start)[0];
  const structuralTexts: string[] = [];
  let location: string | undefined;
  if (nearest !== undefined) {
    const tagOpenEnd = before.indexOf(">", nearest.start) + 1;
    const closeTag = `</${nearest.tag}>`;
    const closeIndex = after.toLowerCase().indexOf(closeTag);
    const inner = closeIndex < 0
      ? `${before.slice(tagOpenEnd)}${html.slice(imageIndex, imageIndex + imageLength)}`
      : `${before.slice(tagOpenEnd)}${html.slice(imageIndex, imageIndex + imageLength)}${after.slice(0, closeIndex)}`;
    const structuralText = stripMarkup(inner);
    if (structuralText.length > 0) structuralTexts.push(structuralText);
    const heading = [...before.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)]
      .map((match) => ({ level: Number(match[1]), text: stripMarkup(match[2] ?? "") }))
      .filter((entry) => entry.text.length > 0)
      .at(-1);
    if (heading !== undefined) {
      const sectionHeading = headings
        .filter((entry) => entry.index <= imageIndex && entry.level <= heading.level)
        .at(-1);
      const topic = sectionHeading?.text ?? heading.text;
      location = `Section: ${topic}`;
      if (heading.text !== topic) structuralTexts.push(`Heading: ${heading.text}`);
    } else {
      location = nearest.tag === "figure" ? "Figure; section uncertain" : `${nearest.tag} near image; section uncertain`;
    }
  } else {
    const previousHeadings = headings.filter((heading) => heading.index <= imageIndex);
    const heading = previousHeadings.at(-1);
    if (heading !== undefined) {
      structuralTexts.push(`Section: ${heading.text}`);
      location = `After heading: ${heading.text}; image container uncertain`;
    }
  }
  return { text: structuralTexts.join(" — "), ...(location === undefined ? {} : { location }) };
}

function stripMarkup(markup: string): string {
  return decodeHtmlEntities(markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)));
}

function imageCountWarnings(total: number, extracted: number, format: string): string[] {
  if (total === extracted) return [];
  return [`${format}: skipped ${total - extracted} embedded image(s) due to format, size, or workload limits.`];
}

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
      const extractedImages = extractDataUriImages(html);
      const embedded = await readEmbeddedImages(extractedImages, this.sourceFormat);
      if (text.length === 0 && embedded.images.length === 0) {
        return extractionFailure("empty", "HTML yielded no text or embedded data images.", absolutePath);
      }
      return ok<ExtractedText>({
        parts: [text || "No extractable text; inspect the embedded images."],
        sourceFormat: this.sourceFormat,
        warnings: [...embedded.warnings, ...imageCountWarnings(extractedImages.length, embedded.images.length, this.sourceFormat)],
        embeddedImages: embedded.images,
      });
    } catch (error) {
      return extractionFailure("extraction_failed", `HTML extraction failed: ${message(error)}`, absolutePath);
    }
  }
}