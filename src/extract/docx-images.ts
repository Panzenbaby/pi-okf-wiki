// Resolve DOCX raster-image relationships to their document-order paragraph
// context. Mammoth exposes image bytes to its converter, but not the original
// relationship/paragraph; content hashing joins those callbacks to references
// in word/document.xml without confusing repeated or reordered occurrences.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { mediaTypeForName } from "./embedded-images.ts";

interface ZipFileDto {
  readonly name: string;
  readonly _data?: { readonly uncompressedSize?: number };
  async(type: "string"): Promise<string>;
  async(type: "uint8array"): Promise<Uint8Array>;
}
interface ZipDto {
  loadAsync(data: Uint8Array): Promise<ZipDto>;
  file(path: string): ZipFileDto | null;
}
interface ZipModuleDto {
  default: new () => ZipDto;
}

export interface DocxImageAssociation {
  readonly fingerprint: string;
  readonly mediaType: string;
  readonly context?: string;
  readonly location: string;
  readonly paragraphNumber: number;
}

export interface DocxImageInspection {
  readonly associations: readonly DocxImageAssociation[];
  readonly warnings: readonly string[];
}

interface Relationship {
  readonly target: string;
  readonly external: boolean;
  readonly isImage: boolean;
}

interface ParagraphContext {
  readonly number: number;
  readonly xml: string;
  readonly text: string;
  readonly heading: string | undefined;
  readonly headingLevel: number | undefined;
}

const MAX_CONTEXT_LENGTH = 1000;
const MAX_ASSOCIATED_IMAGES = 24;
const MAX_ASSOCIATED_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_ASSOCIATED_TOTAL_IMAGE_BYTES = 32 * 1024 * 1024;

export async function inspectDocxImages(absolutePath: string): Promise<DocxImageInspection> {
  const warnings: string[] = [];
  try {
    const { default: JSZip } = await import("jszip") as unknown as ZipModuleDto;
    const zip = await new JSZip().loadAsync(new Uint8Array(await readFile(absolutePath)));
    const document = zip.file("word/document.xml");
    if (document === null) return { associations: [], warnings: ["DOCX: main document XML is missing; embedded image context is uncertain."] };

    const [documentXml, relationshipsXml, stylesXml] = await Promise.all([
      document.async("string"),
      zip.file("word/_rels/document.xml.rels")?.async("string") ?? Promise.resolve(""),
      zip.file("word/styles.xml")?.async("string") ?? Promise.resolve(""),
    ]);
    const relationships = parseRelationships(relationshipsXml);
    const styleNames = parseStyleNames(stylesXml);
    const paragraphs = parseParagraphs(documentXml, styleNames);
    const associations: DocxImageAssociation[] = [];
    let totalImageBytes = 0;

    for (const paragraph of paragraphs) {
      for (const relationshipId of imageRelationshipIds(paragraph.xml)) {
        if (associations.length >= MAX_ASSOCIATED_IMAGES) {
          warnings.push(`DOCX: stopped associating image references after the ${MAX_ASSOCIATED_IMAGES}-image context limit.`);
          return { associations, warnings };
        }
        const relationship = relationships.get(relationshipId);
        if (relationship === undefined || !relationship.isImage || relationship.external) {
          warnings.push(`DOCX: image relationship ${relationshipId} in paragraph ${paragraph.number} could not be resolved; its context is uncertain.`);
          continue;
        }
        const target = resolveTarget("word/document.xml", relationship.target);
        const mediaType = mediaTypeForName(target);
        if (mediaType === undefined) {
          warnings.push(`DOCX: image relationship ${relationshipId} in paragraph ${paragraph.number} uses an unsupported image format.`);
          continue;
        }
        const imageFile = zip.file(target);
        if (imageFile === null) {
          warnings.push(`DOCX: image relationship ${relationshipId} points to missing package content; its context is uncertain.`);
          continue;
        }
        const knownSize = imageFile._data?.uncompressedSize;
        if (knownSize !== undefined && knownSize > MAX_ASSOCIATED_IMAGE_BYTES) {
          warnings.push(`DOCX: skipped oversized image context payload in paragraph ${paragraph.number}; its location is uncertain.`);
          continue;
        }
        if (knownSize !== undefined && totalImageBytes + knownSize > MAX_ASSOCIATED_TOTAL_IMAGE_BYTES) {
          warnings.push(`DOCX: skipped remaining image context payloads after the ${MAX_ASSOCIATED_TOTAL_IMAGE_BYTES}-byte workload limit.`);
          return { associations, warnings };
        }
        try {
          const bytes = await imageFile.async("uint8array");
          if (bytes.byteLength > MAX_ASSOCIATED_IMAGE_BYTES) {
            warnings.push(`DOCX: skipped oversized image context payload in paragraph ${paragraph.number}; its location is uncertain.`);
            continue;
          }
          if (totalImageBytes + bytes.byteLength > MAX_ASSOCIATED_TOTAL_IMAGE_BYTES) {
            warnings.push(`DOCX: skipped remaining image context payloads after the ${MAX_ASSOCIATED_TOTAL_IMAGE_BYTES}-byte workload limit.`);
            return { associations, warnings };
          }
          totalImageBytes += bytes.byteLength;
          const surroundingText = paragraph.text || precedingParagraphText(paragraphs, paragraph.number);
          const sectionHeading = paragraph.heading === undefined
            ? undefined
            : nearestSectionHeading(paragraphs, paragraph.number, paragraph.headingLevel);
          const context = [sectionHeading, surroundingText]
            .filter((value): value is string => value !== undefined && value.length > 0)
            .join(" — ");
          associations.push({
            fingerprint: fingerprint(bytes),
            mediaType,
            ...(context.length === 0 ? {} : { context: context.slice(0, MAX_CONTEXT_LENGTH) }),
            location: sectionHeading === undefined
              ? `Near paragraph ${paragraph.number}; section uncertain`
              : `Section: ${sectionHeading}`,
            paragraphNumber: paragraph.number,
          });
        } catch (error) {
          warnings.push(`DOCX: could not read image relationship ${relationshipId}: ${message(error)}; its context is uncertain.`);
        }
      }
    }
    return { associations, warnings };
  } catch (error) {
    return {
      associations: [],
      warnings: [`DOCX: could not inspect image relationships for context: ${message(error)}; image context is uncertain.`],
    };
  }
}

export function fingerprint(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseRelationships(xml: string): Map<string, Relationship> {
  const relationships = new Map<string, Relationship>();
  const pattern = /<Relationship\b([^>]*)\/?\s*>/gi;
  for (const match of xml.matchAll(pattern)) {
    const attributes = match[1] ?? "";
    const id = attribute(attributes, "Id");
    const target = attribute(attributes, "Target");
    if (id === undefined || target === undefined) continue;
    relationships.set(id, {
      target,
      external: attribute(attributes, "TargetMode")?.toLowerCase() === "external",
      isImage: (attribute(attributes, "Type") ?? "").endsWith("/image"),
    });
  }
  return relationships;
}

function parseStyleNames(xml: string): Map<string, string> {
  const styles = new Map<string, string>();
  const stylePattern = /<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/gi;
  for (const match of xml.matchAll(stylePattern)) {
    const attributes = match[1] ?? "";
    if (attribute(attributes, "w:type") !== "paragraph") continue;
    const id = attribute(attributes, "w:styleId");
    const nameAttributes = match[2]?.match(/<w:name\b([^>]*)\/?\s*>/i)?.[1] ?? "";
    const name = attribute(nameAttributes, "w:val");
    if (id !== undefined && name !== undefined) styles.set(id, decodeXml(name));
  }
  return styles;
}

function parseParagraphs(xml: string, styleNames: ReadonlyMap<string, string>): ParagraphContext[] {
  const paragraphs: ParagraphContext[] = [];
  let currentHeading: string | undefined;
  let currentHeadingLevel: number | undefined;
  const pattern = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/gi;
  for (const match of xml.matchAll(pattern)) {
    const paragraphXml = match[0] ?? "";
    const styleId = paragraphXml.match(/<w:pStyle\b([^>]*)\/?\s*>/i)?.[1];
    const style = styleId === undefined ? undefined : attribute(styleId, "w:val");
    const styleName = style === undefined ? undefined : styleNames.get(style);
    const isStyledHeading = (style !== undefined && /^heading[1-9]$/i.test(style))
      || (styleName !== undefined && /^(?:heading\s*[1-9]|title|subtitle)$/i.test(styleName))
      || /<w:outlineLvl\b[^>]*\bw:val="[0-8]"/i.test(paragraphXml);
    const text = [...paragraphXml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi)]
      .map((textMatch) => decodeXml(textMatch[1] ?? ""))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    const headingLikeSectionLabel = !isStyledHeading && isConservativeSectionLabel(text);
    const explicitOutlineLevel = paragraphXml.match(/<w:outlineLvl\b[^>]*\bw:val="([0-8])"/i)?.[1];
    const styleHeadingLevel = style?.match(/^Heading([1-9])$/i)?.[1]
      ?? styleName?.match(/^Heading\s*([1-9])$/i)?.[1];
    if ((isStyledHeading || headingLikeSectionLabel) && text.length > 0) {
      currentHeading = text;
      currentHeadingLevel = headingLikeSectionLabel
        ? 3
        : explicitOutlineLevel === undefined
          ? styleHeadingLevel === undefined ? undefined : Number(styleHeadingLevel)
          : Number(explicitOutlineLevel) + 1;
    }
    paragraphs.push({
      number: paragraphs.length + 1,
      xml: paragraphXml,
      text,
      heading: currentHeading,
      headingLevel: currentHeadingLevel,
    });
  }
  return paragraphs;
}

function imageRelationshipIds(paragraphXml: string): string[] {
  const ids: { readonly index: number; readonly id: string }[] = [];
  const patterns = [
    /<a:blip\b([^>]*)\/?\s*>/gi,
    /<v:imagedata\b([^>]*)\/?\s*>/gi,
  ];
  for (const pattern of patterns) {
    for (const match of paragraphXml.matchAll(pattern)) {
      const id = attribute(match[1] ?? "", "r:embed") ?? attribute(match[1] ?? "", "r:id");
      if (id !== undefined && match.index !== undefined) ids.push({ index: match.index, id });
    }
  }
  return ids.sort((left, right) => left.index - right.index).map((entry) => entry.id);
}

function isConservativeSectionLabel(text: string): boolean {
  if (text.length === 0 || text.length > 100 || /[.!?;:]$/.test(text)) return false;
  if (!/\([^()]{1,80}\)$/.test(text)) return false;
  const words = text.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return words.length >= 3 && words.length <= 14;
}

function nearestSectionHeading(
  paragraphs: readonly ParagraphContext[],
  paragraphNumber: number,
  headingLevel: number | undefined,
): string | undefined {
  const currentIndex = paragraphNumber - 1;
  if (currentIndex < 0 || headingLevel === undefined) return undefined;
  for (let index = currentIndex; index >= 0; index--) {
    const candidate = paragraphs[index];
    if (candidate?.heading === undefined || candidate.headingLevel === undefined) continue;
    if (candidate.headingLevel <= headingLevel) return candidate.heading;
  }
  return undefined;
}

function precedingParagraphText(paragraphs: readonly ParagraphContext[], paragraphNumber: number): string | undefined {
  for (let index = paragraphNumber - 2; index >= 0; index--) {
    const candidate = paragraphs[index];
    if (candidate === undefined) continue;
    if (candidate.text.length > 0) return candidate.text;
  }
  return undefined;
}

function resolveTarget(sourcePath: string, targetPath: string): string {
  const directory = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/") + 1) : "";
  const segments: string[] = [];
  for (const segment of `${directory}${targetPath}`.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment !== "" && segment !== ".") segments.push(segment);
  }
  return segments.join("/");
}

function attribute(attributes: string, name: string): string | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const value = attributes.match(new RegExp(`(?:^|\\s)${escapedName}="([^"]*)"`))?.[1];
  return value === undefined ? undefined : decodeXml(value);
}

function decodeXml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
