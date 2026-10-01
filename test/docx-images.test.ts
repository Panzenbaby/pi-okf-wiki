import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DocxRepository } from "../src/extract/docx.ts";
import { walkDocxPart } from "../src/extract/docx-images.ts";

let workdir: string;

beforeEach(async () => {
  workdir = join(tmpdir(), `okf-docx-images-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(workdir, { recursive: true });
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

const NAMESPACES = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
  'xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"',
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"',
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
  'xmlns:v="urn:schemas-microsoft-com:vml"',
].join(" ");

const picture = (relationshipId: string): string =>
  `<pic:pic><pic:blipFill><a:blip r:embed="${relationshipId}"/></pic:blipFill></pic:pic>`;
const inline = (relationshipId: string): string =>
  `<w:r><w:drawing><wp:inline><a:graphic><a:graphicData uri="pic">${picture(relationshipId)}</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
const anchor = (relationshipId: string): string =>
  `<w:r><w:drawing><wp:anchor><wp:simplePos x="0" y="0"/><a:graphic><a:graphicData uri="pic">${picture(relationshipId)}</a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`;
const group = (relationshipId: string, textBoxText: string): string =>
  `<w:r><w:drawing><wp:anchor><a:graphic><a:graphicData uri="group"><wpg:wgp>${picture(relationshipId)}<wps:wsp><wps:txbx><w:txbxContent><w:p><w:r><w:t>${textBoxText}</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></wpg:wgp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`;
const textBoxWithImage = (relationshipId: string): string =>
  `<w:r><w:drawing><wp:anchor><a:graphic><a:graphicData uri="shape"><wps:wsp><wps:txbx><w:txbxContent><w:p><w:r><w:t>Box caption</w:t></w:r></w:p><w:p>${inline(relationshipId)}</w:p></w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`;
const alternate = (choice: string, fallback: string): string =>
  `<w:r><mc:AlternateContent><mc:Choice Requires="wpg">${choice}</mc:Choice><mc:Fallback>${fallback}</mc:Fallback></mc:AlternateContent></w:r>`;
const vml = (relationshipId: string): string =>
  `<w:r><w:pict><v:shape><v:imagedata r:id="${relationshipId}"/></v:shape></w:pict></w:r>`;
const paragraph = (content: string): string => `<w:p>${content}</w:p>`;
const text = (value: string): string => `<w:r><w:t>${value}</w:t></w:r>`;
const heading = (value: string): string => `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr>${text(value)}</w:p>`;

async function buildDocx(body: string, imageNames: readonly string[], options: { readonly header?: string } = {}): Promise<string> {
  const zip = new JSZip();
  const relationships = imageNames.map((name, index) =>
    `<Relationship Id="rImg${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}.png"/>`);
  if (options.header !== undefined) {
    relationships.push('<Relationship Id="rHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>');
    zip.file("word/header1.xml", `<w:hdr ${NAMESPACES}>${options.header}</w:hdr>`);
    zip.file("word/_rels/header1.xml.rels", '<Relationships><Relationship Id="rLogo" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/logo.png"/></Relationships>');
    zip.file("word/media/logo.png", Buffer.from("logo-bytes"));
  }
  zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="root" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/document.xml", `<w:document ${NAMESPACES}><w:body>${body}</w:body></w:document>`);
  zip.file("word/_rels/document.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.join("")}</Relationships>`);
  for (const name of imageNames) zip.file(`word/media/${name}.png`, Buffer.from(`${name}-bytes`));
  const path = join(workdir, "document.docx");
  await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
  return path;
}

describe("DOCX image collection", () => {
  it("finds inline, anchored, grouped, text-box, VML, and fallback images in document order", async () => {
    const images = ["inline", "anchored", "grouped", "textbox", "fallback", "choice", "vml"];
    const body = [
      heading("Overview"),
      paragraph(`${text("Intro chart")}${inline("rImg1")}`),
      paragraph(`${text("Anchored figure")}${anchor("rImg2")}`),
      paragraph(`${text("Grouped figure")}${group("rImg3", "Label in group")}`),
      paragraph(`${text("Host paragraph")}${textBoxWithImage("rImg4")}`),
      heading("Details"),
      // Choice has no image: the fallback picture represents the shape.
      paragraph(`${text("Numbered badge")}${alternate(group("missing", "3").replace(picture("missing"), ""), anchor("rImg5"))}`),
      // Choice has an image: the fallback copy must NOT be counted again.
      paragraph(`${text("Modern picture")}${alternate(anchor("rImg6"), vml("rImg6"))}`),
      paragraph(`${text("Legacy picture")}${vml("rImg7")}`),
    ].join("");
    const path = await buildDocx(body, images);
    const result = await new DocxRepository().extract(path);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const embedded = result.data.embeddedImages ?? [];
    expect(embedded.map((image) => image.sourceName)).toEqual(images.map((name) => `word/media/${name}.png`));
    expect(result.data.warnings.filter((warning) => warning.startsWith("DOCX"))).toEqual([]);
    expect(embedded[0]?.location).toBe("Section: Overview");
    expect(embedded[0]?.context).toContain("Intro chart");
    expect(embedded[2]?.context).toContain("Grouped figure");
    expect(embedded[2]?.context).toContain("Label in group");
    // The nested text-box paragraphs belong to their host paragraph.
    expect(embedded[3]?.context).toContain("Host paragraph");
    expect(embedded[3]?.context).toContain("Box caption");
    expect(embedded[4]?.location).toBe("Section: Details");
    expect(embedded[6]?.context).toContain("Legacy picture");
  });

  it("numbers only top-level paragraphs, so text boxes do not split their host", () => {
    const walk = walkDocxPart(`<w:body>${paragraph("Before")}${paragraph(`${text("Host")}${textBoxWithImage("rImg1")}${text(" tail")}`)}${paragraph(`${text("After")}${inline("rImg2")}`)}</w:body>`);
    expect(walk.paragraphs.map((entry) => entry.ownText)).toEqual(["", "Host tail", "After"]);
    expect(walk.images).toEqual([
      { relationshipId: "rImg1", paragraphNumber: 2 },
      { relationshipId: "rImg2", paragraphNumber: 3 },
    ]);
  });

  it("appends header images after the body with a header location", async () => {
    const path = await buildDocx(paragraph(`${text("Body")}${inline("rImg1")}`), ["body"], {
      header: paragraph(`${text("Company header")}${inline("rLogo")}`),
    });
    const result = await new DocxRepository().extract(path);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const embedded = result.data.embeddedImages ?? [];
    expect(embedded.map((image) => image.sourceName)).toEqual(["word/media/body.png", "word/media/logo.png"]);
    expect(embedded[1]?.location).toBe("Page header (word/header1.xml)");
    expect(embedded[1]?.context).toContain("Company header");
  });

  it("keeps repeated references to the same image as separate occurrences", async () => {
    const body = [paragraph(`${text("First")}${inline("rImg1")}`), paragraph(`${text("Second")}${inline("rImg1")}`)].join("");
    const path = await buildDocx(body, ["shared"]);
    const result = await new DocxRepository().extract(path);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const embedded = result.data.embeddedImages ?? [];
    expect(embedded).toHaveLength(2);
    expect(embedded[0]?.context).toContain("First");
    expect(embedded[1]?.context).toContain("Second");
  });
});
