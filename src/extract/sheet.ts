// SheetRepository — extracts tabular text from .xlsx files using `exceljs`.
//
// Each worksheet is rendered as a markdown table so the agent's term-frequency
// retrieval and reasoning preserve row/column structure. The exceljs workbook
// (Dto) is converted to the `ExtractedText` AppModel and never leaks.

import { ok, type Result } from "../types.ts";
import type { ExtractedText, DocumentExtractorRepository } from "./types.ts";
import { extractionFailure, message } from "./util.ts";

/** Maximum rows rendered per sheet; the agent's `read` tool truncates anyway. */
const MAX_ROWS_PER_SHEET = 5000;

/** exceljs workbook (Dto) — only the slice we touch is typed here. */
interface ExcelWorkbookDto {
  readonly worksheets: ReadonlyArray<ExcelWorksheetDto>;
  eachSheet(callback: (worksheet: ExcelWorksheetDto, sheetId: number) => void): void;
}
interface ExcelWorksheetDto {
  readonly name: string;
  readonly rowCount: number;
  readonly columnCount: number;
  getRow(index: number): { values: ReadonlyArray<unknown> };
}
interface ExcelModuleDto {
  default: { Workbook: new () => ExcelWorkbookDto & { xlsx: { readFile(path: string): Promise<ExcelWorkbookDto> } } };
}

export class SheetRepository implements DocumentExtractorRepository {
  readonly supportedExtensions = [".xlsx"] as const;
  readonly sourceFormat = "xlsx";

  async extract(absolutePath: string): Promise<Result<ExtractedText>> {
    let ExcelJS: ExcelModuleDto["default"];
    try {
      const module = (await import("exceljs")) as ExcelModuleDto;
      ExcelJS = module.default;
    } catch (error) {
      return extractionFailure("extraction_failed", `Failed to load exceljs: ${message(error)}`, absolutePath);
    }

    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(absolutePath);
      const warnings: string[] = [];
      const sheets: string[] = [];
      workbook.eachSheet((worksheet) => {
        const rendered = renderSheet(worksheet, warnings);
        if (rendered.length > 0) sheets.push(rendered);
      });
      const text = sheets.join("\n\n").trim();
      if (text.length === 0) {
        return extractionFailure("empty", "XLSX yielded no cell content.", absolutePath);
      }
      return ok<ExtractedText>({ text, sourceFormat: this.sourceFormat, warnings });
    } catch (error) {
      return extractionFailure("extraction_failed", `XLSX extraction failed: ${message(error)}`, absolutePath);
    }
  }
}

function renderSheet(worksheet: ExcelWorksheetDto, warnings: string[]): string {
  const rowCount = worksheet.rowCount;
  if (rowCount === 0) return "";
  const effectiveRows = Math.min(rowCount, MAX_ROWS_PER_SHEET);
  if (rowCount > MAX_ROWS_PER_SHEET) {
    warnings.push(`Sheet "${worksheet.name}": truncated to ${MAX_ROWS_PER_SHEET} of ${rowCount} rows.`);
  }
  const rows: string[][] = [];
  let width = 0;
  for (let rowIndex = 1; rowIndex <= effectiveRows; rowIndex++) {
    const values = worksheet.getRow(rowIndex).values;
    // exceljs `values` is 1-indexed; index 0 is a placeholder.
    const cells: string[] = [];
    for (let columnIndex = 1; columnIndex < values.length; columnIndex++) {
      cells.push(cellToText(values[columnIndex]));
    }
    width = Math.max(width, cells.length);
    rows.push(cells);
  }
  if (width === 0) return "";
  const header = rows[0] ?? [];
  const body = rows.slice(1);
  const headerLine = `| ${pad(header, width).join(" | ")} |`;
  const separatorLine = `| ${Array<string>(width).fill("---").join(" | ")} |`;
  const bodyLines = body.map((row) => `| ${pad(row, width).join(" | ")} |`);
  return [`## Sheet: ${worksheet.name}`, "", headerLine, separatorLine, ...bodyLines].join("\n");
}

function pad(row: readonly string[], width: number): string[] {
  const padded = row.slice();
  while (padded.length < width) padded.push("");
  return padded;
}

function cellToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    // exceljs wraps formula results / rich text in objects; coerce best-effort.
    const objectValue = value as { text?: unknown; result?: unknown; richText?: unknown };
    if (typeof objectValue.text === "string") return objectValue.text;
    if (objectValue.result !== undefined) return cellToText(objectValue.result);
    if (Array.isArray(objectValue.richText)) {
      return objectValue.richText
        .map((fragment) => cellToText((fragment as { text?: unknown }).text))
        .join("");
    }
  }
  return String(value);
}