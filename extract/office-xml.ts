// Zip-based XML repositories for formats that are just zipped XML:
//   - PptxRepository (.pptx)  -> reads `ppt/slides/slideN.xml`, extracts `<a:t>` text.
//   - OdtRepository   (.odt)   -> reads `content.xml`, strips tags.
//   - EpubRepository   (.epub)  -> reads every `.xhtml`/`.html` part, strips tags.
//
// All three share a `jszip` helper. The JSZip object (Dto) never leaks; each
// repository returns the `ExtractedText` AppModel wrapped in `Result<T>`.

import { readFile } from "node:fs/promises";

import { ok, type Result } from "../types.ts";
import type { ExtractedText, DocumentExtractorRepository } from "./types.ts";
import { extractionFailure, message } from "./util.ts";

/** JSZip instance (Dto) — only the slice we touch is typed here. */
interface JSZipDto {
  loadAsync(data: Buffer | Uint8Array): Promise<JSZipDto>;
  file(path: string): JSZipFileDto | null;
  file(regex: RegExp): ReadonlyArray<JSZipFileDto>;
}
interface JSZipFileDto {
  readonly name: string;
  async(type: "string"): Promise<string>;
}
interface JSZipModuleDto {
  default: new () => JSZipDto;
}

abstract class ZipXmlRepository implements DocumentExtractorRepository {
  abstract readonly supportedExtensions: readonly string[];
  abstract readonly sourceFormat: string;
  protected abstract render(zip: JSZipDto, warnings: string[]): Promise<string>;

  async extract(absolutePath: string): Promise<Result<ExtractedText>> {
    let buffer: Buffer;
    try {
      buffer = await readFile(absolutePath);
    } catch (error) {
      return extractionFailure("extraction_failed", `Failed to read ${this.sourceFormat}: ${message(error)}`, absolutePath);
    }

    let zip: JSZipDto;
    try {
      const JSZip = (await import("jszip")).default as JSZipModuleDto["default"];
      zip = await new JSZip().loadAsync(buffer);
    } catch (error) {
      return extractionFailure("extraction_failed", `${this.sourceFormat} open failed: ${message(error)}`, absolutePath);
    }

    const warnings: string[] = [];
    try {
      const text = (await this.render(zip, warnings)).trim();
      if (text.length === 0) {
        return extractionFailure("empty", `${this.sourceFormat} yielded no text.`, absolutePath);
      }
      return ok<ExtractedText>({ text, sourceFormat: this.sourceFormat, warnings });
    } catch (error) {
      return extractionFailure("extraction_failed", `${this.sourceFormat} extraction failed: ${message(error)}`, absolutePath);
    }
  }
}

export class PptxRepository extends ZipXmlRepository {
  readonly supportedExtensions = [".pptx"] as const;
  readonly sourceFormat = "pptx";

  protected async render(zip: JSZipDto, warnings: string[]): Promise<string> {
    const matched = zip.file(/^ppt\/slides\/slide\d+\.xml$/);
    if (matched.length === 0) return "";
    const slideFiles = matched
      .slice()
      .sort((left, right) => slideIndex(left.name) - slideIndex(right.name));
    for (const file of slideFiles) {
      if (slideIndex(file.name) === -1) warnings.push(`Unparseable slide filename: ${file.name}`);
    }
    const slides: string[] = [];
    for (const file of slideFiles) {
      const xml = await file.async("string");
      const text = extractTagContents(xml, "a:t")
        .map(decodeEntities)
        .join(" ")
        .trim();
      if (text.length > 0) slides.push(`## Slide ${slideIndex(file.name)}\n\n${text}`);
    }
    return slides.join("\n\n");
  }
}

export class OdtRepository extends ZipXmlRepository {
  readonly supportedExtensions = [".odt"] as const;
  readonly sourceFormat = "odt";

  protected async render(zip: JSZipDto): Promise<string> {
    const content = zip.file("content.xml");
    if (content === null) return "";
    const xml = await content.async("string");
    return stripXmlTags(xml);
  }
}

export class EpubRepository extends ZipXmlRepository {
  readonly supportedExtensions = [".epub"] as const;
  readonly sourceFormat = "epub";

  protected async render(zip: JSZipDto, warnings: string[]): Promise<string> {
    const htmlParts = zip.file(/\.(x?html?|htm)$/i);
    if (htmlParts.length === 0) return "";

    // Prefer spine order from the OPF (META-INF/container.xml -> content.opf
    // -> <itemref idref>) so reading order is correct even when filenames are
    // not sequential. Fall back to filename order if the OPF is unparseable.
    const orderedNames = await spineOrder(zip, htmlParts.map((part) => part.name));
    if (orderedNames.fallback) {
      warnings.push("EPUB spine unreadable; used filename order for parts.");
    }
    const byName = new Map(htmlParts.map((part) => [part.name, part] as const));
    const chunks: string[] = [];
    for (const name of orderedNames.names) {
      const part = byName.get(name);
      if (part === undefined) continue;
      const xml = await part.async("string");
      const text = stripXmlTags(xml);
      if (text.length > 0) chunks.push(text);
    }
    return chunks.join("\n\n");
  }
}

/** Extract the inner text of every `<ns:tag>...</ns:tag>` occurrence (regex). */
function extractTagContents(xml: string, tagName: string): string[] {
  const pattern = new RegExp(`<${escapeRegex(tagName)}>([^<]*)</${escapeRegex(tagName)}>`, "g");
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    matches.push(match[1] ?? "");
  }
  return matches;
}

function stripXmlTags(xml: string): string {
  // Drop scripts/styles/comments entirely, then strip tags (incl. empty `<>`),
  // decode entities, collapse whitespace.
  const withoutBlocks = xml
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const withoutTags = withoutBlocks.replace(/<[^>]*>/g, " ");
  return decodeEntities(withoutTags).replace(/\s+/g, " ").trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => safeFromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => safeFromCodePoint(parseInt(code, 16)));
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

function slideIndex(name: string): number {
  const match = name.match(/slide(\d+)\.xml$/i);
  return match ? Number(match[1]) : -1;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Resolve the spine reading order of an EPUB. Returns the ordered list of part
 * names (matched against the available html parts) and a `fallback` flag set
 * when the OPF could not be parsed (caller falls back to filename order).
 */
async function spineOrder(
  zip: JSZipDto,
  available: readonly string[],
): Promise<{ readonly names: readonly string[]; readonly fallback: boolean }> {
  const availableSet = new Set(available);
  try {
    const containerXml = await zip.file("META-INF/container.xml")?.async("string");
    const opfPath = containerXml?.match(/full-path="([^"]+)"/)?.[1];
    if (opfPath === undefined) return fallbackOrder(available);
    const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
    const opfXml = await zip.file(opfPath)?.async("string");
    if (opfXml === undefined) return fallbackOrder(available);

    const manifest = new Map<string, string>();
    const itemPattern = /<item\b[^>]*\bid="([^"]+)"[^>]*\bhref="([^"]+)"[^>]*>/g;
    let itemMatch: RegExpExecArray | null;
    while ((itemMatch = itemPattern.exec(opfXml)) !== null) {
      manifest.set(itemMatch[1], normalizePath(opfDir + decodeEntities(itemMatch[2])));
    }

    const names: string[] = [];
    const spinePattern = /<itemref\b[^>]*\bidref="([^"]+)"[^>]*>/g;
    let spineMatch: RegExpExecArray | null;
    while ((spineMatch = spinePattern.exec(opfXml)) !== null) {
      const href = manifest.get(spineMatch[1]);
      if (href !== undefined && availableSet.has(href)) names.push(href);
    }
    if (names.length === 0) return fallbackOrder(available);
    return { names, fallback: false };
  } catch {
    return fallbackOrder(available);
  }
}

function fallbackOrder(available: readonly string[]): { readonly names: readonly string[]; readonly fallback: boolean } {
  return { names: [...available].sort((left, right) => left.localeCompare(right)), fallback: true };
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}