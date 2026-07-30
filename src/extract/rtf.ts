// RtfRepository — strips RTF control words/groups to plain text without a
// third-party library. The RTF byte stream (Dto) is converted to the
// `ExtractedText` AppModel and never leaks. This is a pragmatic stripper, not a
// full RTF renderer: it discards destination groups (fonttbl, colortbl,
// stylesheet, info, pict, `\*`, …), resolves control words/symbols, and keeps
// visible text with paragraph breaks — good enough for agent ingestion.

import { readFile } from "node:fs/promises";

import { ok, type Result } from "../types.ts";
import type { ExtractedText, DocumentExtractorRepository } from "./types.ts";
import { extractionFailure, message } from "./util.ts";

/** RTF destination control words whose whole group is discarded. */
const SKIP_DESTINATIONS = new Set([
  "fonttbl", "colortbl", "stylesheet", "info", "pict", "header", "footer",
  "footnote", "comment", "object", "fldinst", "filetbl", "listtable",
  "overridetable", "rsidtbl", "generator", "operator", "category", "title",
  "subject", "author", "manager", "company", "keywords", "annotation",
  "nonshppict", "themedata", "datastore", "listpicture", "userprops",
  "wbirddt", "wpnspInstances", "latentstyles",
]);

/** Control words that render as whitespace. */
const WHITESPACE_WORDS: ReadonlyMap<string, string> = new Map([
  ["par", "\n"], ["line", "\n"], ["page", "\n"], ["sect", "\n"],
  ["row", "\n"], ["nestrow", "\n"], ["cell", "\t"], ["nestcell", "\t"],
  ["tab", "\t"],
]);

/** Control words that render as a specific character. */
const SYMBOL_WORDS: ReadonlyMap<string, string> = new Map([
  ["emdash", "—"], ["endash", "—"], ["ldblquote", "“"], ["rdblquote", "”"],
  ["lquote", "‘"], ["rquote", "’"], ["bullet", "•"], ["alpha", "α"],
  ["beta", "β"], ["gamma", "γ"], ["delta", "δ"], ["pi", "π"],
  ["trademark", "™"], ["copyright", "©"], ["reg", "®"], ["deg", "°"],
]);

export class RtfRepository implements DocumentExtractorRepository {
  readonly supportedExtensions = [".rtf"] as const;
  readonly sourceFormat = "rtf";

  async extract(absolutePath: string): Promise<Result<ExtractedText>> {
    let buffer: Buffer;
    try {
      buffer = await readFile(absolutePath);
    } catch (error) {
      return extractionFailure("extraction_failed", `Failed to read RTF: ${message(error)}`, absolutePath);
    }
    try {
      const text = stripRtf(buffer.toString("latin1")).replace(/\n{3,}/g, "\n\n").trim();
      if (text.length === 0) {
        return extractionFailure("empty", "RTF yielded no text.", absolutePath);
      }
      return ok<ExtractedText>({ parts: [text], sourceFormat: this.sourceFormat, warnings: [] });
    } catch (error) {
      return extractionFailure("extraction_failed", `RTF extraction failed: ${message(error)}`, absolutePath);
    }
  }
}

interface Frame {
  skip: boolean;
  anyContent: boolean;
}

function stripRtf(rtf: string): string {
  const out: string[] = [];
  const stack: Frame[] = [];
  let skipCount = 0;
  const currentlySkipping = () => skipCount > 0;

  let i = 0;
  while (i < rtf.length) {
    const char = rtf[i];
    if (char === "{") {
      stack.push({ skip: currentlySkipping(), anyContent: false });
      if (currentlySkipping()) skipCount++;
      i++;
      continue;
    }
    if (char === "}") {
      const frame = stack.pop();
      if (frame !== undefined && frame.skip) skipCount--;
      i++;
      continue;
    }
    if (char !== "\\") {
      if (!currentlySkipping() && char !== "\r" && char !== "\n") out.push(char);
      i++;
      continue;
    }

    // Control sequence.
    i++;
    const next = rtf[i];
    if (next === undefined) break;

    // Control symbol: single non-alpha char.
    if (!isLetter(next)) {
      const frame = stack[stack.length - 1];
      if (next === "*" && frame !== undefined && !frame.skip && !frame.anyContent) {
        // `\*` discard group: mark the current frame for skipping.
        frame.skip = true;
        skipCount++;
      }
      if (!currentlySkipping()) {
        if (next === "\\" || next === "{" || next === "}") out.push(next);
        else if (next === "~") out.push("\u00a0");
        else if (next === "-" || next === "_" || next === ":") {
          // optional hyphen / non-breaking hyphen / sub-entry — drop
        }
      }
      i++;
      markContent(stack);
      continue;
    }

    // Control word: letters, optional numeric parameter, optional space delim.
    let word = "";
    while (i < rtf.length && isLetter(rtf[i])) {
      word += rtf[i];
      i++;
    }
    let param: string | undefined;
    if (rtf[i] === "-" || isDigit(rtf[i])) {
      param = "";
      if (rtf[i] === "-") { param += rtf[i]; i++; }
      while (isDigit(rtf[i])) { param += rtf[i]; i++; }
    }
    if (rtf[i] === " ") i++; // delimiter space consumed

    const frame = stack[stack.length - 1];
    if (frame !== undefined && !frame.skip && !frame.anyContent && (word === "*" || SKIP_DESTINATIONS.has(word))) {
      frame.skip = true;
      skipCount++;
      markContent(stack);
      continue;
    }
    markContent(stack);

    if (currentlySkipping()) continue;

    if (word === "u" && param !== undefined) {
      const code = Number(param) & 0xffff;
      out.push(safeFromCodePoint(code));
      // Skip the ANSI fallback char that follows `\uN`.
      if (rtf[i] === " ") i++;
      if (rtf[i] !== undefined && rtf[i] !== "\\" && rtf[i] !== "{" && rtf[i] !== "}") i++;
      continue;
    }
    if (word === "'" && param !== undefined) {
      out.push(String.fromCharCode(parseInt(param, 16)));
      continue;
    }
    const asWhitespace = WHITESPACE_WORDS.get(word);
    if (asWhitespace !== undefined) {
      out.push(asWhitespace);
      continue;
    }
    const asSymbol = SYMBOL_WORDS.get(word);
    if (asSymbol !== undefined) {
      out.push(asSymbol);
      continue;
    }
    // Unknown control word (formatting): drop silently.
  }
  return out.join("");
}

function markContent(stack: Frame[]): void {
  const frame = stack[stack.length - 1];
  if (frame !== undefined) frame.anyContent = true;
}

function isLetter(char: string | undefined): boolean {
  if (char === undefined) return false;
  return (char >= "a" && char <= "z") || (char >= "A" && char <= "Z");
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}