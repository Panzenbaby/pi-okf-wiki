import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import JSZip from "jszip";
import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DocxRepository } from "../src/extract/docx.ts";
import { HtmlRepository } from "../src/extract/html.ts";
import {
  EpubRepository,
  OdpRepository,
  OdsRepository,
  OdtRepository,
  PptxRepository,
} from "../src/extract/office-xml.ts";
import { PdfRepository } from "../src/extract/pdf.ts";
import { RtfRepository } from "../src/extract/rtf.ts";
import { SheetRepository } from "../src/extract/sheet.ts";

let workdir: string;

beforeEach(async () => {
  workdir = join(tmpdir(), `okf-extract-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(workdir, { recursive: true });
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

async function fixture(name: string, content: string | Buffer): Promise<string> {
  const path = join(workdir, name);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
  return path;
}

describe("HtmlRepository", () => {
  it("strips tags and keeps visible text", async () => {
    const path = await fixture(
      "page.html",
      "<html><body><h1>Title</h1><p>Hello <b>world</b></p><script>ignore</script></body></html>",
    );
    const result = await new HtmlRepository().extract(path);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.sourceFormat).toBe("html");
    expect(result.data.parts.join("\n")).toContain("TITLE");
    expect(result.data.parts.join("\n")).toContain("Hello");
    expect(result.data.parts.join("\n")).toContain("world");
    expect(result.data.parts.join("\n")).not.toContain("ignore");
    expect(result.data.parts.join("\n")).not.toContain("<b>");
  });

  it("reports empty when the document has no text", async () => {
    const path = await fixture("empty.html", "<html><body><img src='x'/></body></html>");
    const result = await new HtmlRepository().extract(path);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.cause).toBe("empty");
  });
});

describe("DocxRepository", () => {
  it("extracts text from a generated .docx", async () => {
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    );
    zip.file(
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    );
    zip.file(
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello DOCX World</w:t></w:r></w:p></w:body></w:document>`,
    );
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const path = await fixture("hello.docx", buffer);

    const result = await new DocxRepository().extract(path);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.sourceFormat).toBe("docx");
    expect(result.data.parts.join("\n")).toContain("Hello DOCX World");
  });

  it("maps a missing file to extraction_failed", async () => {
    const result = await new DocxRepository().extract(join(workdir, "nope.docx"));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.cause).toBe("extraction_failed");
  });
});

describe("SheetRepository", () => {
  it("renders sheets as markdown tables", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Orders");
    sheet.addRow(["order_id", "customer_id"]);
    sheet.addRow(["o1", "c1"]);
    sheet.addRow(["o2", "c2"]);
    const path = join(workdir, "orders.xlsx");
    await workbook.xlsx.writeFile(path);

    const result = await new SheetRepository().extract(path);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.sourceFormat).toBe("xlsx");
    expect(result.data.parts.join("\n")).toContain("## Sheet: Orders");
    expect(result.data.parts.join("\n")).toContain("order_id");
    expect(result.data.parts.join("\n")).toContain("customer_id");
    expect(result.data.parts.join("\n")).toContain("| o1 | c1 |");
    expect(result.data.parts.join("\n")).toContain("| o2 | c2 |");
  });
});

describe("PptxRepository", () => {
  it("extracts slide text in order", async () => {
    const zip = new JSZip();
    zip.file(
      "ppt/slides/slide2.xml",
      `<p:slide xmlns:p="a" xmlns:a="a"><a:t>Second slide</a:t></p:slide>`,
    );
    zip.file(
      "ppt/slides/slide1.xml",
      `<p:slide xmlns:p="a" xmlns:a="a"><a:t>First slide</a:t></p:slide>`,
    );
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const path = await fixture("deck.pptx", buffer);

    const result = await new PptxRepository().extract(path);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.parts.join("\n")).toContain("## Slide 1");
    expect(result.data.parts.join("\n")).toContain("First slide");
    expect(result.data.parts.join("\n")).toContain("## Slide 2");
    expect(result.data.parts.join("\n")).toContain("Second slide");
    expect(result.data.parts.join("\n").indexOf("First slide")).toBeLessThan(result.data.parts.join("\n").indexOf("Second slide"));
  });
});

describe("OdtRepository", () => {
  it("strips tags from content.xml", async () => {
    const zip = new JSZip();
    zip.file(
      "content.xml",
      `<?xml version="1.0"?><office:document xmlns:office="o"><office:text><text:p>Hello &amp; goodbye</text:p></office:text></office:document>`,
    );
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const path = await fixture("note.odt", buffer);

    const result = await new OdtRepository().extract(path);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.parts.join("\n")).toContain("Hello & goodbye");
  });
});

async function odsFixture(name: string, contentXml: string): Promise<string> {
  const zip = new JSZip();
  zip.file("content.xml", `<?xml version="1.0"?>${contentXml}`);
  return fixture(name, await zip.generateAsync({ type: "nodebuffer" }));
}

describe("OdsRepository", () => {
  it("renders each sheet as a markdown table, preserving rows and columns", async () => {
    const path = await odsFixture(
      "book.ods",
      `<office:document><office:body><office:spreadsheet>
         <table:table table:name="Orders">
           <table:table-row>
             <table:table-cell><text:p>Name</text:p></table:table-cell>
             <table:table-cell><text:p>Qty</text:p></table:table-cell>
           </table:table-row>
           <table:table-row>
             <table:table-cell><text:p>Widget</text:p></table:table-cell>
             <table:table-cell><text:p>7</text:p></table:table-cell>
           </table:table-row>
         </table:table>
       </office:spreadsheet></office:body></office:document>`,
    );
    const result = await new OdsRepository().extract(path);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.sourceFormat).toBe("ods");
    const text = result.data.parts.join("\n");
    expect(text).toContain("## Sheet: Orders");
    expect(text).toContain("| Name | Qty |");
    expect(text).toContain("| Widget | 7 |");
  });

  it("expands repeated cells but trims the trailing filler ODS emits", async () => {
    const path = await odsFixture(
      "repeat.ods",
      `<office:document><office:body><office:spreadsheet>
         <table:table table:name="S">
           <table:table-row>
             <table:table-cell><text:p>A</text:p></table:table-cell>
             <table:table-cell table:number-columns-repeated="2"><text:p>R</text:p></table:table-cell>
             <table:table-cell table:number-columns-repeated="1013"/>
           </table:table-row>
         </table:table>
       </office:spreadsheet></office:body></office:document>`,
    );
    const result = await new OdsRepository().extract(path);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const text = result.data.parts.join("\n");
    expect(text).toContain("| A | R | R |");
    // The 1013 trailing empty cells must not be materialised into the table.
    expect(text.length).toBeLessThan(200);
  });

  it("keeps columns aligned across merged cells", async () => {
    const path = await odsFixture(
      "merged.ods",
      `<office:document><office:body><office:spreadsheet>
         <table:table table:name="M">
           <table:table-row>
             <table:table-cell><text:p>H1</text:p></table:table-cell>
             <table:table-cell><text:p>H2</text:p></table:table-cell>
             <table:table-cell><text:p>H3</text:p></table:table-cell>
           </table:table-row>
           <table:table-row>
             <table:table-cell table:number-columns-spanned="2"><text:p>wide</text:p></table:table-cell>
             <table:covered-table-cell/>
             <table:table-cell><text:p>tail</text:p></table:table-cell>
           </table:table-row>
         </table:table>
       </office:spreadsheet></office:body></office:document>`,
    );
    const result = await new OdsRepository().extract(path);
    expect(result.success).toBe(true);
    if (!result.success) return;
    // Without counting the covered cell, "tail" would slide under the H2 column.
    expect(result.data.parts.join("\n")).toContain("| wide |  | tail |");
  });

  it("reports empty for a spreadsheet without cell content", async () => {
    const path = await odsFixture(
      "blank.ods",
      `<office:document><office:body><office:spreadsheet>
         <table:table table:name="S"><table:table-row><table:table-cell/></table:table-row></table:table>
       </office:spreadsheet></office:body></office:document>`,
    );
    const result = await new OdsRepository().extract(path);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.cause).toBe("empty");
  });
});

describe("OdpRepository", () => {
  it("keeps slide boundaries", async () => {
    const path = await odsFixture(
      "deck.odp",
      `<office:document><office:body><office:presentation>
         <draw:page draw:name="page1"><draw:frame><draw:text-box><text:p>First slide</text:p></draw:text-box></draw:frame></draw:page>
         <draw:page draw:name="page2"><draw:frame><draw:text-box><text:p>Second slide</text:p></draw:text-box></draw:frame></draw:page>
       </office:presentation></office:body></office:document>`,
    );
    const result = await new OdpRepository().extract(path);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.sourceFormat).toBe("odp");
    const text = result.data.parts.join("\n");
    expect(text).toContain("## Slide 1");
    expect(text).toContain("First slide");
    expect(text).toContain("## Slide 2");
    expect(text).toContain("Second slide");
    expect(text.indexOf("First slide")).toBeLessThan(text.indexOf("## Slide 2"));
  });

  it("reports empty for a deck with no text", async () => {
    const path = await odsFixture(
      "empty.odp",
      `<office:document><office:body><office:presentation>
         <draw:page draw:name="page1"><draw:frame/></draw:page>
       </office:presentation></office:body></office:document>`,
    );
    const result = await new OdpRepository().extract(path);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.cause).toBe("empty");
  });
});

describe("EpubRepository", () => {
  it("concatenates xhtml parts", async () => {
    const zip = new JSZip();
    zip.file(
      "OEBPS/ch1.xhtml",
      `<?xml version="1.0"?><html><body><p>Chapter one</p></body></html>`,
    );
    zip.file(
      "OEBPS/ch2.xhtml",
      `<?xml version="1.0"?><html><body><p>Chapter two</p></body></html>`,
    );
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const path = await fixture("book.epub", buffer);

    const result = await new EpubRepository().extract(path);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.parts.join("\n")).toContain("Chapter one");
    expect(result.data.parts.join("\n")).toContain("Chapter two");
  });

  it("follows the OPF spine order, not filename order", async () => {
    const zip = new JSZip();
    zip.file(
      "META-INF/container.xml",
      `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    );
    zip.file(
      "OEBPS/content.opf",
      `<?xml version="1.0"?><package version="3.0"><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c2"/><itemref idref="c1"/></spine></package>`,
    );
    zip.file("OEBPS/ch1.xhtml", `<?xml version="1.0"?><html><body><p>Chapter one</p></body></html>`);
    zip.file("OEBPS/ch2.xhtml", `<?xml version="1.0"?><html><body><p>Chapter two</p></body></html>`);
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const path = await fixture("spined.epub", buffer);

    const result = await new EpubRepository().extract(path);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.parts.join("\n").indexOf("Chapter two")).toBeLessThan(result.data.parts.join("\n").indexOf("Chapter one"));
  });

  it("falls back to filename order (with a warning) when there is no OPF", async () => {
    const zip = new JSZip();
    zip.file("OEBPS/b.xhtml", `<?xml version="1.0"?><html><body><p>Bee</p></body></html>`);
    zip.file("OEBPS/a.xhtml", `<?xml version="1.0"?><html><body><p>Ay</p></body></html>`);
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const path = await fixture("noopf.epub", buffer);

    const result = await new EpubRepository().extract(path);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.warnings.some((w) => w.includes("filename order"))).toBe(true);
    expect(result.data.parts.join("\n").indexOf("Ay")).toBeLessThan(result.data.parts.join("\n").indexOf("Bee"));
  });
});

describe("PdfRepository", () => {
  it("maps a missing file to extraction_failed", async () => {
    const result = await new PdfRepository().extract(join(workdir, "nope.pdf"));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.cause).toBe("extraction_failed");
  });

  it("extracts text from a generated minimal PDF", async () => {
    const path = await fixture("hello.pdf", minimalPdf("Hello PDF World"));
    const result = await new PdfRepository().extract(path);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.sourceFormat).toBe("pdf");
    expect(result.data.parts.join("\n")).toContain("Hello PDF World");
  });

  it("reports empty when the PDF has no text operators", async () => {
    const path = await fixture("empty.pdf", minimalPdf(""));
    const result = await new PdfRepository().extract(path);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.cause).toBe("empty");
  });
});

describe("RtfRepository", () => {
  it("strips control words, destinations, and keeps visible text", async () => {
    const rtf = [
      "{\\rtf1\\ansi\\ansicpg1252\\deff0",
      "{\\fonttbl{\\f0 Helvetica;}}",
      "{\\colortbl;\\red0\\green0\\blue0;}",
      "{\\info{\\author Jane Doe}}",
      "\\b Hello\\b0 \\i RTF\\i0  \\u8217? World\\par",
      "Plain \\emdash  text \\\\ with \\{ braces \\}}",
    ].join("\n");
    const path = await fixture("doc.rtf", rtf);
    const result = await new RtfRepository().extract(path);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.sourceFormat).toBe("rtf");
    expect(result.data.parts.join("\n")).toContain("Hello");
    expect(result.data.parts.join("\n")).toContain("RTF");
    expect(result.data.parts.join("\n")).toContain("World");
    expect(result.data.parts.join("\n")).toContain("Plain");
    expect(result.data.parts.join("\n")).toContain("text \\ with { braces }");
    // Destinations (fonttbl/colortbl/info) must not leak their control words.
    expect(result.data.parts.join("\n")).not.toContain("fonttbl");
    expect(result.data.parts.join("\n")).not.toContain("Helvetica");
    expect(result.data.parts.join("\n")).not.toContain("Jane Doe");
  });

  it("reports empty for an RTF with no visible text", async () => {
    const path = await fixture("empty.rtf", "{\\rtf1\\ansi{\\fonttbl{\\f0 Helvetica;}}}");
    const result = await new RtfRepository().extract(path);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.cause).toBe("empty");
  });
});

/** Build a minimal single-page PDF containing `text` as one Tj operator (or none). */
function minimalPdf(text: string): Buffer {
  const content = text.length > 0 ? `BT /F1 12 Tf 72 700 Td (${text}) Tj ET` : `BT /F1 12 Tf ET`;
  const stream = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    stream,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}