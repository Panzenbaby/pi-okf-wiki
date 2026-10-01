// Collect DOCX raster images in document order, directly from the package.
//
// `word/document.xml` is walked with a small XML tokenizer (not a paragraph
// regex), so nested paragraphs inside text boxes (`w:txbxContent`) do not
// split their host paragraph. Every image reference — `a:blip` in inline,
// anchored, or grouped drawings (`wp:inline`, `wp:anchor`, `wpg:wgp`) and
// VML `v:imagedata` — is resolved through `word/_rels/document.xml.rels`
// (`r:embed` / `r:id`) and read from the zip. `mc:AlternateContent` is honored:
// the `mc:Choice` branch wins, and `mc:Fallback` images are used only when the
// choice carries no image itself (e.g. a grouped shape whose fallback is a
// rasterized picture). Header/footer parts referenced from the main document
// are scanned the same way and appended after the body images.
//
// jszip objects (Dtos) stay inside this module; callers receive the
// `EmbeddedImageReference` list consumed by `readEmbeddedImages`.

import { readFile } from "node:fs/promises";

import { mediaTypeForName, type EmbeddedImageReference, type EmbeddedZipFile } from "./embedded-images.ts";

interface ZipFileDto extends EmbeddedZipFile {
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

export interface DocxImageCollection {
  /** Image references in document order (body first, then headers/footers). */
  readonly references: readonly EmbeddedImageReference[];
  readonly warnings: readonly string[];
}

/** One image reference found while walking a part, before relationship resolution. */
export interface DocxImageReferenceSite {
  readonly relationshipId: string;
  /** 1-based number of the top-level paragraph that hosts the reference. */
  readonly paragraphNumber: number;
}

/** A top-level paragraph of a walked part. */
export interface DocxParagraph {
  readonly number: number;
  /** Text of the paragraph itself (used for heading detection). */
  readonly ownText: string;
  /** Own text plus text of nested text-box paragraphs (used as image context). */
  readonly fullText: string;
  readonly styleId: string | undefined;
  readonly outlineLevel: number | undefined;
}

export interface DocxPartWalk {
  readonly paragraphs: readonly DocxParagraph[];
  readonly images: readonly DocxImageReferenceSite[];
}

interface Relationship {
  readonly target: string;
  readonly external: boolean;
  readonly type: string;
}

interface SectionedParagraph extends DocxParagraph {
  readonly heading: string | undefined;
  readonly headingLevel: number | undefined;
}

const MAX_CONTEXT_LENGTH = 1000;
const MAIN_DOCUMENT_PATH = "word/document.xml";

export async function collectDocxImages(absolutePath: string): Promise<DocxImageCollection> {
  const warnings: string[] = [];
  try {
    const { default: JSZip } = await import("jszip") as unknown as ZipModuleDto;
    const zip = await new JSZip().loadAsync(new Uint8Array(await readFile(absolutePath)));
    const document = zip.file(MAIN_DOCUMENT_PATH);
    if (document === null) {
      return { references: [], warnings: ["DOCX: main document XML is missing; embedded images cannot be located."] };
    }
    const [documentXml, stylesXml] = await Promise.all([
      document.async("string"),
      zip.file("word/styles.xml")?.async("string") ?? Promise.resolve(""),
    ]);
    const styleNames = parseStyleNames(stylesXml);
    const relationships = await readRelationships(zip, MAIN_DOCUMENT_PATH);
    const references: EmbeddedImageReference[] = [];

    const bodyWalk = walkDocxPart(documentXml);
    const paragraphs = assignSections(bodyWalk.paragraphs, styleNames);
    for (const site of bodyWalk.images) {
      const file = resolveImageFile(zip, relationships, MAIN_DOCUMENT_PATH, site, warnings);
      if (file === undefined) continue;
      references.push({ file, ...describeLocation(paragraphs, site.paragraphNumber) });
    }

    for (const [, relationship] of relationships) {
      const kind = relationship.type.endsWith("/header") ? "header" : relationship.type.endsWith("/footer") ? "footer" : undefined;
      if (kind === undefined || relationship.external) continue;
      const partPath = resolveTarget(MAIN_DOCUMENT_PATH, relationship.target);
      const part = zip.file(partPath);
      if (part === null) continue;
      const partWalk = walkDocxPart(await part.async("string"));
      if (partWalk.images.length === 0) continue;
      const partRelationships = await readRelationships(zip, partPath);
      const partText = partWalk.paragraphs.map((paragraph) => paragraph.fullText).filter((text) => text.length > 0).join(" ");
      for (const site of partWalk.images) {
        const file = resolveImageFile(zip, partRelationships, partPath, site, warnings);
        if (file === undefined) continue;
        references.push({
          file,
          location: `Page ${kind} (${partPath})`,
          ...(partText.length === 0 ? {} : { context: partText.slice(0, MAX_CONTEXT_LENGTH) }),
        });
      }
    }
    return { references, warnings };
  } catch (error) {
    return {
      references: [],
      warnings: [`DOCX: could not read embedded images: ${message(error)}.`],
    };
  }
}

function resolveImageFile(
  zip: ZipDto,
  relationships: ReadonlyMap<string, Relationship>,
  partPath: string,
  site: DocxImageReferenceSite,
  warnings: string[],
): ZipFileDto | undefined {
  const relationship = relationships.get(site.relationshipId);
  if (relationship === undefined) {
    warnings.push(`DOCX: image relationship ${site.relationshipId} in paragraph ${site.paragraphNumber} could not be resolved; the image was skipped.`);
    return undefined;
  }
  if (!relationship.type.endsWith("/image")) {
    warnings.push(`DOCX: image relationship ${site.relationshipId} in paragraph ${site.paragraphNumber} has an unexpected relationship type; its target was read as an image.`);
  }
  if (relationship.external) {
    warnings.push("DOCX: skipped linked (external) image; it is not embedded in the package.");
    return undefined;
  }
  const target = resolveTarget(partPath, relationship.target);
  if (mediaTypeForName(target) === undefined) {
    warnings.push(`DOCX: skipped embedded image with unsupported format (${target}).`);
    return undefined;
  }
  const file = zip.file(target);
  if (file === null) {
    warnings.push(`DOCX: image relationship ${site.relationshipId} points to missing package content (${target}).`);
    return undefined;
  }
  return file;
}

function describeLocation(
  paragraphs: readonly SectionedParagraph[],
  paragraphNumber: number,
): { readonly location: string; readonly context?: string } {
  const paragraph = paragraphs[paragraphNumber - 1];
  if (paragraph === undefined) {
    return { location: `Near paragraph ${paragraphNumber}; section uncertain` };
  }
  const surroundingText = paragraph.fullText || precedingParagraphText(paragraphs, paragraphNumber);
  const sectionHeading = paragraph.heading === undefined
    ? undefined
    : nearestSectionHeading(paragraphs, paragraphNumber, paragraph.headingLevel);
  const context = (sectionHeading !== undefined && surroundingText?.startsWith(sectionHeading) === true
    ? [surroundingText]
    : [sectionHeading, surroundingText])
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(" — ");
  return {
    location: sectionHeading === undefined
      ? `Near paragraph ${paragraphNumber}; section uncertain`
      : `Section: ${sectionHeading}`,
    ...(context.length === 0 ? {} : { context: context.slice(0, MAX_CONTEXT_LENGTH) }),
  };
}

interface AlternateContentFrame {
  inFallback: boolean;
  choiceHadImage: boolean;
  readonly fallbackImages: DocxImageReferenceSite[];
}

interface ParagraphBuilder {
  readonly number: number;
  ownText: string;
  nestedText: string;
  styleId: string | undefined;
  outlineLevel: number | undefined;
}

/**
 * Walk one WordprocessingML part (document, header, or footer) in document
 * order. Only TOP-LEVEL paragraphs are numbered; paragraphs nested inside a
 * text box contribute their text to the host paragraph. Exported for tests.
 */
export function walkDocxPart(xml: string): DocxPartWalk {
  const paragraphs: DocxParagraph[] = [];
  const images: DocxImageReferenceSite[] = [];
  const elementStack: string[] = [];
  const alternateContentStack: AlternateContentFrame[] = [];
  let paragraphDepth = 0;
  let current: ParagraphBuilder | undefined;
  let insideText = false;

  const insideFallback = (): boolean => alternateContentStack.some((frame) => frame.inFallback);
  const finishParagraph = (): void => {
    if (current === undefined) return;
    const ownText = normalizeSpace(current.ownText);
    paragraphs.push({
      number: current.number,
      ownText,
      fullText: normalizeSpace(`${current.ownText} ${current.nestedText}`),
      styleId: current.styleId,
      outlineLevel: current.outlineLevel,
    });
    current = undefined;
  };
  const recordImage = (relationshipId: string): void => {
    const paragraphNumber = current?.number ?? Math.max(1, paragraphs.length);
    const site: DocxImageReferenceSite = { relationshipId, paragraphNumber };
    const frame = alternateContentStack[alternateContentStack.length - 1];
    if (frame === undefined) {
      images.push(site);
      return;
    }
    if (frame.inFallback) frame.fallbackImages.push(site);
    else {
      frame.choiceHadImage = true;
      images.push(site);
    }
  };

  for (const token of tokenizeXml(xml)) {
    if (token.kind === "text") {
      if (!insideText || current === undefined || insideFallback()) continue;
      const text = decodeXml(token.text);
      if (paragraphDepth === 1) current.ownText += text;
      else current.nestedText += ` ${text}`;
      continue;
    }
    if (token.kind === "close") {
      if (token.name === "w:t") insideText = false;
      if (token.name === "w:p") {
        paragraphDepth = Math.max(0, paragraphDepth - 1);
        if (paragraphDepth === 0) finishParagraph();
      }
      if (token.name === "mc:Fallback") {
        const frame = alternateContentStack[alternateContentStack.length - 1];
        if (frame !== undefined) frame.inFallback = false;
      }
      if (token.name === "mc:AlternateContent") {
        const frame = alternateContentStack.pop();
        if (frame !== undefined && !frame.choiceHadImage) {
          for (const site of frame.fallbackImages) recordImage(site.relationshipId);
        }
      }
      popElement(elementStack, token.name);
      continue;
    }
    // Open (or self-closing) element.
    const parent = elementStack[elementStack.length - 1];
    switch (token.name) {
      case "w:p":
        if (!token.selfClosing) {
          paragraphDepth++;
          if (paragraphDepth === 1) {
            current = { number: paragraphs.length + 1, ownText: "", nestedText: "", styleId: undefined, outlineLevel: undefined };
          }
        } else if (paragraphDepth === 0) {
          paragraphs.push({ number: paragraphs.length + 1, ownText: "", fullText: "", styleId: undefined, outlineLevel: undefined });
        }
        break;
      case "w:pStyle":
        if (paragraphDepth === 1 && parent === "w:pPr" && current !== undefined) {
          current.styleId = attribute(token.attributes, "w:val");
        }
        break;
      case "w:outlineLvl":
        if (paragraphDepth === 1 && parent === "w:pPr" && current !== undefined) {
          const level = Number(attribute(token.attributes, "w:val"));
          if (Number.isInteger(level) && level >= 0 && level <= 8) current.outlineLevel = level;
        }
        break;
      case "w:t":
        if (!token.selfClosing) insideText = true;
        break;
      case "w:tab":
      case "w:br":
        if (current !== undefined && !insideFallback() && parent === "w:r") {
          if (paragraphDepth === 1) current.ownText += " ";
          else current.nestedText += " ";
        }
        break;
      case "mc:AlternateContent":
        if (!token.selfClosing) alternateContentStack.push({ inFallback: false, choiceHadImage: false, fallbackImages: [] });
        break;
      case "mc:Fallback": {
        const frame = alternateContentStack[alternateContentStack.length - 1];
        if (frame !== undefined && !token.selfClosing) frame.inFallback = true;
        break;
      }
      case "a:blip": {
        const id = attribute(token.attributes, "r:embed") ?? attribute(token.attributes, "r:link");
        if (id !== undefined && id.length > 0) recordImage(id);
        break;
      }
      case "v:imagedata": {
        const id = attribute(token.attributes, "r:id") ?? attribute(token.attributes, "r:embed");
        if (id !== undefined && id.length > 0) recordImage(id);
        break;
      }
      default:
        break;
    }
    if (!token.selfClosing) elementStack.push(token.name);
  }
  finishParagraph();
  return { paragraphs, images };
}

type XmlToken =
  | { readonly kind: "open"; readonly name: string; readonly attributes: string; readonly selfClosing: boolean }
  | { readonly kind: "close"; readonly name: string }
  | { readonly kind: "text"; readonly text: string };

/** Minimal XML tokenizer: elements and text; skips declarations, comments, CDATA, and doctype. */
function* tokenizeXml(xml: string): Generator<XmlToken> {
  const pattern = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!(?:[^>])*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
  for (const match of xml.matchAll(pattern)) {
    if (match[1] !== undefined) {
      yield { kind: "text", text: match[1] };
    } else if (match[2] !== undefined) {
      yield { kind: "close", name: match[2] };
    } else if (match[3] !== undefined) {
      yield { kind: "open", name: match[3], attributes: match[4] ?? "", selfClosing: match[5] === "/" };
    } else if (match[6] !== undefined) {
      yield { kind: "text", text: match[6] };
    }
  }
}

function popElement(stack: string[], name: string): void {
  const index = stack.lastIndexOf(name);
  if (index >= 0) stack.length = index;
}

function assignSections(
  paragraphs: readonly DocxParagraph[],
  styleNames: ReadonlyMap<string, string>,
): SectionedParagraph[] {
  let currentHeading: string | undefined;
  let currentHeadingLevel: number | undefined;
  return paragraphs.map((paragraph) => {
    const style = paragraph.styleId;
    const styleName = style === undefined ? undefined : styleNames.get(style);
    const isStyledHeading = (style !== undefined && /^heading[1-9]$/i.test(style))
      || (styleName !== undefined && /^(?:heading\s*[1-9]|title|subtitle)$/i.test(styleName))
      || paragraph.outlineLevel !== undefined;
    const text = paragraph.ownText;
    const headingLikeSectionLabel = !isStyledHeading && isConservativeSectionLabel(text);
    const styleHeadingLevel = style?.match(/^Heading([1-9])$/i)?.[1]
      ?? styleName?.match(/^Heading\s*([1-9])$/i)?.[1];
    if ((isStyledHeading || headingLikeSectionLabel) && text.length > 0) {
      currentHeading = text;
      currentHeadingLevel = headingLikeSectionLabel
        ? 3
        : paragraph.outlineLevel === undefined
          ? styleHeadingLevel === undefined ? undefined : Number(styleHeadingLevel)
          : paragraph.outlineLevel + 1;
    }
    return { ...paragraph, heading: currentHeading, headingLevel: currentHeadingLevel };
  });
}

async function readRelationships(zip: ZipDto, partPath: string): Promise<Map<string, Relationship>> {
  const slash = partPath.lastIndexOf("/");
  const relationshipsPath = `${partPath.slice(0, slash + 1)}_rels/${partPath.slice(slash + 1)}.rels`;
  const xml = await (zip.file(relationshipsPath)?.async("string") ?? Promise.resolve(""));
  const relationships = new Map<string, Relationship>();
  for (const match of xml.matchAll(/<Relationship\b([^>]*?)\/?>/gi)) {
    const attributes = match[1] ?? "";
    const id = attribute(attributes, "Id");
    const target = attribute(attributes, "Target");
    if (id === undefined || target === undefined) continue;
    relationships.set(id, {
      target,
      external: attribute(attributes, "TargetMode")?.toLowerCase() === "external",
      type: attribute(attributes, "Type") ?? "",
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

function isConservativeSectionLabel(text: string): boolean {
  if (text.length === 0 || text.length > 100 || /[.!?;:]$/.test(text)) return false;
  if (!/\([^()]{1,80}\)$/.test(text)) return false;
  const words = text.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return words.length >= 3 && words.length <= 14;
}

function nearestSectionHeading(
  paragraphs: readonly SectionedParagraph[],
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

function precedingParagraphText(paragraphs: readonly SectionedParagraph[], paragraphNumber: number): string | undefined {
  for (let index = paragraphNumber - 2; index >= 0; index--) {
    const candidate = paragraphs[index];
    if (candidate === undefined) continue;
    if (candidate.fullText.length > 0) return candidate.fullText;
  }
  return undefined;
}

function resolveTarget(sourcePath: string, targetPath: string): string {
  if (targetPath.startsWith("/")) return targetPath.slice(1);
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
  const value = attributes.match(new RegExp(`(?:^|\\s)${escapedName}\\s*=\\s*["']([^"']*)["']`))?.[1];
  return value === undefined ? undefined : decodeXml(value);
}

function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
