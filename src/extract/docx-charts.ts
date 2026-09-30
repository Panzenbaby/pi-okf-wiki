// Extract cached values and document context from native DOCX chart objects.
// Many Word charts are DrawingML parts rather than raster images, so Mammoth's
// image converter cannot expose them. This repository helper converts their
// legible cached categories/series values into searchable source text; the
// original chart remains embedded in the archived DOCX.

import { readFile } from "node:fs/promises";

interface ZipFileDto {
  readonly name: string;
  readonly _data?: { readonly uncompressedSize?: number };
  async(type: "string"): Promise<string>;
}
interface ZipDto {
  loadAsync(data: Uint8Array): Promise<ZipDto>;
  file(path: string): ZipFileDto | null;
  file(pattern: RegExp): ReadonlyArray<ZipFileDto>;
}
interface ZipModuleDto {
  default: new () => ZipDto;
}

export interface DocxChartExtraction {
  readonly text: string;
  readonly warnings: readonly string[];
}

const MAX_CHART_XML_BYTES = 2 * 1024 * 1024;
const MAX_CHART_TOTAL_XML_BYTES = 12 * 1024 * 1024;
const MAX_DOCX_CHART_COUNT = 24;

interface ChartReference {
  readonly relationshipId: string;
  readonly context?: string;
  readonly location: string;
}

export async function extractDocxCharts(absolutePath: string): Promise<DocxChartExtraction> {
  const warnings: string[] = [];
  try {
    const { default: JSZip } = await import("jszip") as unknown as ZipModuleDto;
    const zip = await new JSZip().loadAsync(new Uint8Array(await readFile(absolutePath)));
    const references = await chartReferences(zip, warnings);
    const allCharts = zip.file(/^word\/charts\/chart\d+\.xml$/)
      .slice()
      .sort((left, right) => chartNumber(left.name) - chartNumber(right.name));
    for (const chart of allCharts) {
      if ((chart._data?.uncompressedSize ?? 0) > MAX_CHART_XML_BYTES) {
        warnings.push(`DOCX: skipped oversized chart data in ${chart.name}; image analysis is unavailable for this chart.`);
      }
    }
    const charts = allCharts.filter((chart) => (chart._data?.uncompressedSize ?? 0) <= MAX_CHART_XML_BYTES);
    if (charts.length === 0) return { text: "", warnings };
    if (charts.length > MAX_DOCX_CHART_COUNT) {
      warnings.push(`DOCX: chart workload has ${charts.length} charts; only the first ${MAX_DOCX_CHART_COUNT} will be inspected.`);
    }

    const candidateCharts = charts.slice(0, MAX_DOCX_CHART_COUNT);
    const candidateNames = new Set(candidateCharts.map((chart) => chart.name));
    const byName = new Map(candidateCharts.map((chart) => [chart.name, chart] as const));
    const textBlocks: string[] = [];
    const seen = new Set<string>();
    let totalChartBytes = 0;
    let unassociatedCount = 0;
    for (const reference of references) {
      const target = await chartTarget(zip, reference.relationshipId);
      if (target === undefined) continue;
      const chart = byName.get(target);
      if (chart === undefined || !candidateNames.has(chart.name) || seen.has(chart.name)) continue;
      seen.add(chart.name);
      const chartXml = await chart.async("string");
      if (chartXml.length > MAX_CHART_XML_BYTES || totalChartBytes + chartXml.length > MAX_CHART_TOTAL_XML_BYTES) {
        warnings.push(`DOCX: skipped oversized chart data in ${chart.name}; image analysis is unavailable for this chart.`);
        continue;
      }
      totalChartBytes += chartXml.length;
      textBlocks.push(renderChart(chartXml, chart.name, reference));
    }
    for (const chart of candidateCharts) {
      if (seen.has(chart.name)) continue;
      unassociatedCount++;
      const chartXml = await chart.async("string");
      if (chartXml.length > MAX_CHART_XML_BYTES || totalChartBytes + chartXml.length > MAX_CHART_TOTAL_XML_BYTES) {
        warnings.push(`DOCX: skipped oversized chart data in ${chart.name}; image analysis is unavailable for this chart.`);
        continue;
      }
      totalChartBytes += chartXml.length;
      textBlocks.push(renderChart(chartXml, chart.name, {
        relationshipId: "",
        location: "Uncertain location in document",
      }));
    }
    if (unassociatedCount > 0) {
      warnings.push(`DOCX: ${unassociatedCount} chart(s) could not be associated with a surrounding document section; context is marked uncertain.`);
    }
    return { text: textBlocks.join("\n\n"), warnings };
  } catch (error) {
    return {
      text: "",
      warnings: [`DOCX: native chart extraction failed: ${error instanceof Error ? error.message : String(error)}.`],
    };
  }
}

async function chartReferences(zip: ZipDto, warnings: string[]): Promise<ChartReference[]> {
  const document = zip.file("word/document.xml");
  if (document === null) return [];
  const documentXml = await document.async("string");
  const relationshipsXml = await zip.file("word/_rels/document.xml.rels")?.async("string") ?? "";
  const relationships = new Map<string, string>();
  for (const match of relationshipsXml.matchAll(/<Relationship\b(?=[^>]*\bId="([^"]+)")(?=[^>]*\bTarget="([^"]+)")[^>]*>/g)) {
    const id = match[1];
    const target = match[2];
    if (id !== undefined && target !== undefined) relationships.set(id, resolveTarget("word/document.xml", target));
  }

  const references: ChartReference[] = [];
  let precedingHeading = "";
  let paragraphNumber = 0;
  for (const match of documentXml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)) {
    const paragraph = match[0] ?? "";
    paragraphNumber++;
    const paragraphText = [...paragraph.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
      .map((textMatch) => decodeXml(textMatch[1] ?? ""))
      .join("")
      .trim();
    if (/\bw:val="Heading\d+"/i.test(paragraph) && paragraphText.length > 0) precedingHeading = paragraphText;
    for (const chartMatch of paragraph.matchAll(/<c:chart\b[^>]*\br:id="([^"]+)"/g)) {
      const relationshipId = chartMatch[1];
      if (relationshipId === undefined || !relationships.has(relationshipId)) {
        warnings.push(`DOCX: chart in paragraph ${paragraphNumber} has an unresolved document relationship.`);
        continue;
      }
      const context = [precedingHeading, paragraphText].filter((value) => value.length > 0).join(" — ");
      references.push({
        relationshipId,
        ...(context.length === 0 ? {} : { context }),
        location: precedingHeading.length > 0
          ? `Section: ${precedingHeading}`
          : paragraphText.length > 0
            ? `Near paragraph ${paragraphNumber}; section uncertain`
            : `Paragraph ${paragraphNumber}; section uncertain`,
      });
    }
  }
  return references;
}

async function chartTarget(zip: ZipDto, relationshipId: string): Promise<string | undefined> {
  const relsXml = await zip.file("word/_rels/document.xml.rels")?.async("string") ?? "";
  for (const match of relsXml.matchAll(/<Relationship\b(?=[^>]*\bId="([^"]+)")(?=[^>]*\bTarget="([^"]+)")[^>]*>/g)) {
    if (match[1] !== relationshipId || match[2] === undefined) continue;
    return resolveTarget("word/document.xml", match[2]);
  }
  return undefined;
}

function renderChart(xml: string, name: string, reference: ChartReference): string {
  const chartNumberValue = chartNumber(name);
  const title = [...xml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)]
    .map((match) => decodeXml(match[1] ?? ""))
    .join(" ")
    .trim();
  const seriesBlocks = [...xml.matchAll(/<c:ser\b[^>]*>([\s\S]*?)<\/c:ser>/g)];
  const seriesText: string[] = [];
  for (const series of seriesBlocks) {
    const body = series[1] ?? "";
    const label = valuesWithin(body.match(/<c:tx\b[^>]*>([\s\S]*?)<\/c:tx>/)?.[1] ?? "");
    const categories = valuesWithin(body.match(/<c:cat\b[^>]*>([\s\S]*?)<\/c:cat>/)?.[1] ?? "");
    const values = valuesWithin(body.match(/<c:val\b[^>]*>([\s\S]*?)<\/c:val>/)?.[1] ?? "");
    const labelText = label.length > 0 ? label.join(" ") : `Series ${seriesText.length + 1}`;
    const categoryText = categories.length > 0 ? `; categories: ${categories.join(", ")}` : "";
    const valueText = values.length > 0 ? `; values: ${values.join(", ")}` : "; cached values unavailable (visual values uncertain)";
    seriesText.push(`${labelText}${categoryText}${valueText}`);
  }
  const heading = title.length > 0 ? title : `Chart ${chartNumberValue}`;
  const lines = [`## Embedded chart ${chartNumberValue}: ${heading}`, `Context: ${reference.location}`];
  if (reference.context !== undefined) lines.push(`Surrounding text: ${reference.context}`);
  lines.push(...seriesText.map((series) => `- ${series}`));
  if (seriesText.length === 0) lines.push("- Chart series or values are unreadable from the document data; do not infer them.");
  return lines.join("\n");
}

function valuesWithin(xml: string): string[] {
  const cachedValues = [...xml.matchAll(/<c:v\b[^>]*>([\s\S]*?)<\/c:v>/g)]
    .map((match) => decodeXml(match[1] ?? "").trim())
    .filter((value) => value.length > 0);
  if (cachedValues.length > 0) return cachedValues;
  return [...xml.matchAll(/<c:pt\b[^>]*\bidx="([^"]+)"[^>]*>[\s\S]*?<c:v\b[^>]*>([\s\S]*?)<\/c:v>[\s\S]*?<\/c:pt>/g)]
    .map((match) => `#${match[1]} ${decodeXml(match[2] ?? "").trim()}`);
}

function resolveTarget(source: string, target: string): string {
  const directory = source.includes("/") ? source.slice(0, source.lastIndexOf("/") + 1) : "";
  const parts: string[] = [];
  for (const part of `${directory}${target}`.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "" && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

function chartNumber(path: string): number {
  return Number(path.match(/chart(\d+)\.xml$/i)?.[1] ?? 0);
}

function decodeXml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
