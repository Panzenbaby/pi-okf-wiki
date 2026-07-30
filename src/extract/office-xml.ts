// Zip-based XML repositories for formats that are just zipped XML:
//   - PptxRepository (.pptx)  -> reads `ppt/slides/slideN.xml`, extracts `<a:t>` text.
//   - OdtRepository   (.odt)   -> reads `content.xml`, strips tags.
//   - OdsRepository   (.ods)   -> reads `content.xml`, renders each sheet as a table.
//   - OdpRepository   (.odp)   -> reads `content.xml`, one block per `<draw:page>`.
//   - EpubRepository   (.epub)  -> reads every `.xhtml`/`.html` part, strips tags.
//
// They share a `jszip` helper. The JSZip object (Dto) never leaks; each
// repository returns the `ExtractedText` AppModel wrapped in `Result<T>`.
//
// `.ods` and `.odp` do NOT reuse OdtRepository's blunt tag stripping: flattening
// their content.xml would dissolve row/column and slide boundaries, leaving them
// worse off than their OOXML twins (.xlsx keeps a markdown table, .pptx keeps
// `## Slide N`). Both therefore parse their own structural elements.

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
      return ok<ExtractedText>({ parts: [text], sourceFormat: this.sourceFormat, warnings });
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

/**
 * Cap on how often a single `table:number-{columns,rows}-repeated` run is
 * materialised. ODS routinely pads a sheet to the full grid width with a single
 * repeated empty cell (counts in the thousands); expanding those literally
 * would blow up the rendered table for no content.
 */
const MAX_REPEAT = 256;

/** Maximum rows rendered per sheet, mirroring SheetRepository's cap for .xlsx. */
const MAX_ROWS_PER_SHEET = 5000;

// Element matchers. The `(?=[\s>/])` lookahead stops an element from matching a
// sibling that merely shares its prefix (`table:table` must not swallow
// `table:table-row`). Group 1 is the attribute list, group 2 the inner XML.
// These are module constants because `String.matchAll` clones the regex rather
// than advancing this one's `lastIndex` — recompiling them per row would mean
// tens of thousands of compilations on a large sheet.
const TABLE_PATTERN = /<table:table(?=[\s>/])([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table>)/g;
const ROW_PATTERN = /<table:table-row(?=[\s>/])([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-row>)/g;
const PAGE_PATTERN = /<draw:page(?=[\s>/])([^>]*?)(?:\/>|>([\s\S]*?)<\/draw:page>)/g;
// Covered cells are the placeholders a merged range leaves behind. They carry no
// visible content but MUST still occupy a column, or every cell after a merge
// shifts left and the rendered table misaligns with its header.
const CELL_PATTERN =
  /<table:(covered-table-cell|table-cell)(?=[\s>/])([^>]*?)(?:\/>|>([\s\S]*?)<\/table:\1>)/g;
const COLUMNS_REPEATED_PATTERN = /\btable:number-columns-repeated="([^"]*)"/;
const ROWS_REPEATED_PATTERN = /\btable:number-rows-repeated="([^"]*)"/;
const TABLE_NAME_PATTERN = /\btable:name="([^"]*)"/;

export class OdsRepository extends ZipXmlRepository {
  readonly supportedExtensions = [".ods"] as const;
  readonly sourceFormat = "ods";

  protected async render(zip: JSZipDto, warnings: string[]): Promise<string> {
    const content = zip.file("content.xml");
    if (content === null) return "";
    const xml = await content.async("string");
    const sheets: string[] = [];
    for (const table of xml.matchAll(TABLE_PATTERN)) {
      const name = attributeOf(table[1] ?? "", TABLE_NAME_PATTERN) ?? `Sheet ${sheets.length + 1}`;
      const rendered = renderSheet(name, table[2] ?? "", warnings);
      if (rendered.length > 0) sheets.push(rendered);
    }
    return sheets.join("\n\n");
  }
}

export class OdpRepository extends ZipXmlRepository {
  readonly supportedExtensions = [".odp"] as const;
  readonly sourceFormat = "odp";

  protected async render(zip: JSZipDto): Promise<string> {
    const content = zip.file("content.xml");
    if (content === null) return "";
    const xml = await content.async("string");
    const slides: string[] = [];
    let slideNumber = 0;
    for (const page of xml.matchAll(PAGE_PATTERN)) {
      slideNumber++;
      const text = stripXmlTags(page[2] ?? "");
      if (text.length === 0) continue;
      slides.push(`## Slide ${slideNumber}\n\n${text}`);
    }
    return slides.join("\n\n");
  }
}

/** Render one `<table:table>` body as a markdown table, or "" when it is blank. */
function renderSheet(name: string, tableXml: string, warnings: string[]): string {
  const rows: string[][] = [];
  let truncated = false;
  for (const rowMatch of tableXml.matchAll(ROW_PATTERN)) {
    const cells = parseRowCells(rowMatch[2] ?? "");
    const repeat = repeatCountOf(rowMatch[1] ?? "", ROWS_REPEATED_PATTERN);
    for (let copy = 0; copy < repeat; copy++) {
      if (rows.length >= MAX_ROWS_PER_SHEET) {
        truncated = true;
        break;
      }
      rows.push(cells);
    }
    if (truncated) break;
  }
  if (truncated) {
    warnings.push(`Sheet "${name}": truncated to ${MAX_ROWS_PER_SHEET} rows.`);
  }

  while (rows.length > 0 && isBlankRow(rows[rows.length - 1])) rows.pop();
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  if (width === 0) return "";

  const header = padRow(rows[0] ?? [], width);
  const separator = Array<string>(width).fill("---");
  const body = rows.slice(1).map((row) => padRow(row, width));
  return [
    `## Sheet: ${name}`,
    "",
    toTableLine(header),
    toTableLine(separator),
    ...body.map(toTableLine),
  ].join("\n");
}

/** Expand a row's cells, honouring `table:number-columns-repeated`, then trim the trailing filler. */
function parseRowCells(rowXml: string): string[] {
  const cells: string[] = [];
  for (const cellMatch of rowXml.matchAll(CELL_PATTERN)) {
    const text = stripXmlTags(cellMatch[3] ?? "").replace(/\|/g, "\\|");
    const repeat = repeatCountOf(cellMatch[2] ?? "", COLUMNS_REPEATED_PATTERN);
    for (let copy = 0; copy < repeat; copy++) cells.push(text);
  }
  while (cells.length > 0 && (cells[cells.length - 1] ?? "").length === 0) cells.pop();
  return cells;
}

function repeatCountOf(attributes: string, pattern: RegExp): number {
  const raw = attributeOf(attributes, pattern);
  if (raw === undefined) return 1;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, MAX_REPEAT);
}

function attributeOf(attributes: string, pattern: RegExp): string | undefined {
  const match = attributes.match(pattern);
  return match === null ? undefined : decodeEntities(match[1] ?? "");
}

function isBlankRow(row: readonly string[] | undefined): boolean {
  return row === undefined || row.every((cell) => cell.length === 0);
}

function padRow(row: readonly string[], width: number): string[] {
  const padded = row.slice();
  while (padded.length < width) padded.push("");
  return padded;
}

function toTableLine(cells: readonly string[]): string {
  return `| ${cells.join(" | ")} |`;
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