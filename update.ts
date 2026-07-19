// /wiki-update command: ingest new documents from input/ into the wiki bundle.
//
// Deterministic work (scan, classify, take over conformant files) runs
// synchronously in the command handler. Non-conformant files are delegated to
// the agent via pi.sendUserMessage. Finalization (snapshot diff, index/log
// regeneration, leftover detection, summary widget) runs in the agent_end
// event so it always sees the wiki state *after* the agent finished — not a
// racy pre-turn snapshot.

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  type IgnoreReason,
  type InputFile,
  type Result,
  type UpdateReport,
  type WikiSnapshot,
} from "./types.ts";
import { ok, err } from "./types.ts";
import { parseDocument } from "./frontmatter.ts";
import {
  ensureDir,
  listFiles,
  moveFile,
  pathExists,
  readTextFile,
  resolveArchiveTarget,
  writeTextFile,
} from "./files.ts";
import {
  appendLogMd,
  buildStructurePreview,
  conceptIdFromRelativePath,
  diffSnapshots,
  loadAllConcepts,
  snapshotWiki,
  wikiPaths,
  writeIndexMd,
  type WikiPaths,
} from "./wiki.ts";
import { buildUpdatePrompt } from "./prompts.ts";
import {
  EXTRACTABLE_EXTENSIONS,
  IMAGE_EXTENSIONS,
  TEXT_READABLE_EXTENSIONS,
} from "./extract/registry.ts";
import {
  archiveExtractedText,
  cleanExtractionTemp,
  cleanupExtractionTemp,
  extractToTempFile,
  type ExtractedArtifact,
} from "./extract/service.ts";

const RESERVED_INPUT = new Set(["index.md", "log.md"]);

interface FinalizeState {
  readonly paths: WikiPaths;
  readonly beforeSnapshot: WikiSnapshot;
  readonly beforeCount: number;
  readonly conformantImported: readonly string[];
  readonly nonConformant: readonly InputFile[];
  readonly ignored: ReadonlyArray<{ path: string; reason: IgnoreReason; detail?: string }>;
  readonly warnings: readonly string[];
  readonly today: string;
  readonly hadAgentTurn: boolean;
}

// Set when /wiki-update hands off to the agent; consumed by the agent_end handler.
let pendingFinalize: FinalizeState | null = null;

export async function runUpdate(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<Result<UpdateReport>> {
  const paths = wikiPaths(ctx.cwd);
  const today = new Date().toISOString().slice(0, 10);

  // Clear any summary from a previous run while this one is in progress.
  ctx.ui.setWidget("okf-update", undefined);

  const dirsOk = await ensureAllDirs(paths);
  if (!dirsOk.success) return dirsOk;

  const beforeSnapshot = await snapshotWiki(paths.wiki);
  if (!beforeSnapshot.success) return beforeSnapshot;
  const beforeCount = beforeSnapshot.data.entries.size;

  const inputFiles = await collectInputFiles(paths.input);
  if (!inputFiles.success) return inputFiles;

  const runWarnings: string[] = [];

  if (inputFiles.data.length === 0) {
    ctx.ui.notify("input/ is empty — nothing to update.", "info");
    return ok(emptyReport(beforeCount));
  }

  const classified = classifyInput(inputFiles.data);
  let ignored: InputFile[] = classified.filter(
    (file) => file.classification === "ignored",
  );
  const conformant = classified.filter(
    (file) => file.classification === "conformant",
  );
  let nonConformant = classified.filter(
    (file) => file.classification === "non-conformant",
  );

  // 0. Extract binary/structured formats (pdf, docx, xlsx, pptx, odt, epub,
  //    html) to a temp `<stem>-extracted.txt` the agent reads instead of the
  //    binary. Clean any stale temp from an interrupted previous run first.
  //    (Non-fatal: a failure here just means stale temp may survive until the
  //    next run; listFiles skips `.okf-extract` and tempRelativeNameFor
  //    overwrites same-named files, so ingestion still works.)
  const cleaned = await cleanExtractionTemp(paths.input);
  if (!cleaned.success) {
    runWarnings.push(`Could not clean extraction temp: ${cleaned.error.message}`);
  }
  const extraction = await runExtractionPass(paths, nonConformant);
  nonConformant = [...extraction.nonConformant];
  ignored = [...ignored, ...extraction.ignored];

  // 1. Conformant candidates: confirm by parsing frontmatter. A .md that turns
  //    out to lack frontmatter/type is NOT ignored — it is non-conformant and
  //    must be handed to the agent (hybrid ingestion).
  const conformantImported: string[] = [];
  const deferredNonConformant: InputFile[] = [];
  for (const file of conformant) {
    const result = await importConformant(file, paths);
    if (result.success) {
      conformantImported.push(result.data);
    } else if (result.error.cause === "non-conformant") {
      deferredNonConformant.push({ ...file, classification: "non-conformant" });
    } else {
      ignored.push({
        ...file,
        classification: "ignored",
        ignoreReason: "io_failed",
        ignoreDetail: result.error.message,
      });
    }
  }
  const allNonConformant = [...nonConformant, ...deferredNonConformant];

  const ignoredEntries = ignored.map((file) => ({
    path: file.relativePath,
    reason: file.ignoreReason ?? "unsupported",
    detail: file.ignoreDetail,
  }));

  // 2. Non-conformant files: delegate to the agent, finalize on agent_end.
  if (allNonConformant.length > 0) {
    const conceptsBefore = await loadAllConcepts(paths.wiki);
    const structure = conceptsBefore.success
      ? buildStructurePreview(conceptsBefore.data)
      : { directories: [], types: [], conceptIds: [] };

    const prompt = buildUpdatePrompt({
      inputFiles: await Promise.all(
        allNonConformant.map(async (file) => ({
          relativePath: file.relativePath,
          absolutePath: file.absolutePath,
          archiveTarget: await resolveArchiveTarget(paths.archive, file.relativePath),
          extractedTextPath: file.extractedTextPath,
          sourceFormat: file.sourceFormat,
        })),
      ),
      archiveDir: paths.archive,
      wikiDir: paths.wiki,
      structure,
    });

    pendingFinalize = {
      paths,
      beforeSnapshot: beforeSnapshot.data,
      beforeCount,
      conformantImported,
      nonConformant: allNonConformant,
      ignored: ignoredEntries,
      warnings: runWarnings,
      today,
      hadAgentTurn: true,
    };

    pi.sendUserMessage(prompt);
    ctx.ui.setStatus(
      "okf-update",
      "Agent transforms non-conformant input — summary appears on completion",
    );
    return ok(emptyReport(beforeCount));
  }

  // 3. No agent turn: finalize synchronously now.
  const report = await finalizeUpdate(ctx, {
    paths,
    beforeSnapshot: beforeSnapshot.data,
    beforeCount,
    conformantImported,
    nonConformant: allNonConformant,
    ignored: ignoredEntries,
    warnings: runWarnings,
    today,
    hadAgentTurn: false,
  });
  return ok(report);
}

/** Called from the agent_end handler; finalizes a pending /wiki-update run. */
export async function finalizePendingUpdate(ctx: ExtensionContext): Promise<void> {
  const state = pendingFinalize;
  if (state === null) return;
  pendingFinalize = null;
  await finalizeUpdate(ctx, state);
}

async function finalizeUpdate(
  ctx: ExtensionContext,
  state: FinalizeState,
): Promise<UpdateReport> {
  const { paths, beforeSnapshot, beforeCount, conformantImported, nonConformant, ignored, warnings: stateWarnings, today } = state;
  const warnings: string[] = [...stateWarnings];

  const afterSnapshot = await snapshotWiki(paths.wiki);
  const afterEntries = afterSnapshot.success ? afterSnapshot.data.entries : new Map<string, string>();
  const diff = diffSnapshots(beforeSnapshot, { entries: afterEntries });

  const allConcepts = await loadAllConcepts(paths.wiki);
  if (allConcepts.success) {
    await writeIndexMd(paths.wiki, allConcepts.data);
  }
  await appendLogMd(paths.wiki, today, diff);

  const leftover = await detectLeftover(paths.input, nonConformant);
  const leftoverSet = new Set(leftover);

  // Archive the extracted text for every file the agent successfully archived
  // (i.e. not leftover). Leftover originals keep their temp text only until the
  // cleanup below removes it — it is regenerated on the next run.
  for (const file of nonConformant) {
    if (file.tempRelativeName === undefined) continue;
    if (leftoverSet.has(file.relativePath)) continue;
    const archived = await archiveExtractedText(paths.input, paths.archive, file.tempRelativeName, resolveArchiveTarget);
    if (!archived.success) {
      warnings.push(`Could not archive extracted text for ${file.relativePath}: ${archived.error.message}`);
    }
  }
  const cleaned = await cleanupExtractionTemp(paths.input);
  if (!cleaned.success) {
    warnings.push(`Could not clean extraction temp: ${cleaned.error.message}`);
  }

  const report: UpdateReport = {
    conformantImported,
    nonConformantHandedToAgent: nonConformant.map((file) => file.relativePath),
    ignored,
    leftover,
    createdConcepts: diff.created,
    updatedConcepts: diff.updated,
    wikiConceptCountBefore: beforeCount,
    wikiConceptCountAfter: afterEntries.size,
    hadAgentTurn: state.hadAgentTurn,
    warnings,
  };

  ctx.ui.setStatus("okf-update", "");
  showSummary(ctx, report);
  return report;
}

async function ensureAllDirs(paths: WikiPaths): Promise<Result<void>> {
  for (const dir of [paths.input, paths.archive, paths.wiki]) {
    const result = await ensureDir(dir);
    if (!result.success) return result;
  }
  return ok(undefined);
}

async function collectInputFiles(
  inputRoot: string,
): Promise<Result<readonly InputFile[]>> {
  if (!(await pathExists(inputRoot))) return ok([]);
  const files = await listFiles(inputRoot);
  if (!files.success) return files;
  return ok(
    files.data.map((file) => ({
      relativePath: file.relativePath,
      absolutePath: file.absolutePath,
      classification: "non-conformant" as const,
    })),
  );
}

function classifyInput(files: readonly InputFile[]): InputFile[] {
  return files.map((file) => classifyOne(file));
}

function classifyOne(file: InputFile): InputFile {
  const name = basename(file.relativePath);
  if (RESERVED_INPUT.has(name)) {
    return { ...file, classification: "ignored", ignoreReason: "reserved" };
  }
  const lower = file.relativePath.toLowerCase();
  if (lower.endsWith(".md")) {
    // Conformance is confirmed in importConformant by parsing frontmatter.
    return { ...file, classification: "conformant" };
  }
  if (
    matchesAny(lower, TEXT_READABLE_EXTENSIONS) ||
    matchesAny(lower, IMAGE_EXTENSIONS) ||
    matchesAny(lower, EXTRACTABLE_EXTENSIONS)
  ) {
    // Extractable formats are refined by runExtractionPass below (they become
    // non-conformant with an `extractedTextPath`, or ignored on extraction
    // failure). Text-readable and image formats are read directly by the agent.
    return { ...file, classification: "non-conformant" };
  }
  return { ...file, classification: "ignored", ignoreReason: "unsupported" };
}

/**
 * Run extractors for every non-conformant file whose extension is extractable.
 * Success -> attach the temp `extractedTextPath` (agent reads that instead of
 * the binary). Failure -> demote to `ignored` with a stable cause code.
 */
async function runExtractionPass(
  paths: WikiPaths,
  files: readonly InputFile[],
): Promise<{ readonly nonConformant: readonly InputFile[]; readonly ignored: readonly InputFile[] }> {
  const refined: InputFile[] = [];
  const newlyIgnored: InputFile[] = [];
  for (const file of files) {
    if (!matchesAny(file.relativePath.toLowerCase(), EXTRACTABLE_EXTENSIONS)) {
      refined.push(file);
      continue;
    }
    const result = await extractToTempFile(paths.input, file.relativePath, file.absolutePath);
    if (result.success) {
      const artifact: ExtractedArtifact = result.data;
      refined.push({
        ...file,
        extractedTextPath: artifact.extractedTextPath,
        tempRelativeName: artifact.tempRelativeName,
        sourceFormat: artifact.sourceFormat,
      });
    } else {
      newlyIgnored.push({
        ...file,
        classification: "ignored",
        ignoreReason: asIgnoreReason(result.error.cause) ?? "extraction_failed",
        ignoreDetail: result.error.message,
      });
    }
  }
  return { nonConformant: refined, ignored: newlyIgnored };
}

function matchesAny(lowerPath: string, extensions: readonly string[]): boolean {
  return extensions.some((extension) => lowerPath.endsWith(extension));
}

function asIgnoreReason(cause: string | undefined): IgnoreReason | undefined {
  // Only extraction-related causes flow through this path; `io_failed` is set
  // directly by importConformant and never arrives here.
  if (cause === "encrypted" || cause === "extraction_failed" || cause === "empty") {
    return cause;
  }
  return undefined;
}

/** Short English phrase for the summary widget. The structured report keeps the code. */
function describeIgnoreReason(reason: IgnoreReason): string {
  switch (reason) {
    case "unsupported":
      return "unsupported file type";
    case "reserved":
      return "reserved filename";
    case "encrypted":
      return "encrypted document";
    case "extraction_failed":
      return "extraction failed";
    case "empty":
      return "no extractable text";
    case "io_failed":
      return "read/write failed";
  }
}

async function importConformant(
  file: InputFile,
  paths: WikiPaths,
): Promise<Result<string>> {
  const content = await readTextFile(file.absolutePath);
  if (!content.success) return content;
  const parsed = parseDocument(content.data);
  if (!parsed.frontmatter || !parsed.frontmatter.type) {
    return err<string>("missing frontmatter or type field", {
      path: file.relativePath,
      cause: "non-conformant",
    });
  }
  const targetPath = `${paths.wiki}/${file.relativePath}`;
  const writeResult = await writeTextFile(targetPath, content.data);
  if (!writeResult.success) return writeResult;
  // Archive collision-safe: never overwrite an existing archive file.
  const archivePath = await resolveArchiveTarget(paths.archive, file.relativePath);
  const moveResult = await moveFile(file.absolutePath, archivePath);
  if (!moveResult.success) return moveResult;
  return ok(conceptIdFromRelativePath(file.relativePath));
}

async function detectLeftover(
  inputRoot: string,
  nonConformant: readonly InputFile[],
): Promise<readonly string[]> {
  const expected = new Set(nonConformant.map((file) => file.relativePath));
  const files = await listFiles(inputRoot);
  if (!files.success) return [];
  return files.data
    .filter((file) => expected.has(file.relativePath))
    .map((file) => file.relativePath)
    .sort();
}

function emptyReport(conceptCount: number): UpdateReport {
  return {
    conformantImported: [],
    nonConformantHandedToAgent: [],
    ignored: [],
    leftover: [],
    createdConcepts: [],
    updatedConcepts: [],
    wikiConceptCountBefore: conceptCount,
    wikiConceptCountAfter: conceptCount,
    hadAgentTurn: false,
    warnings: [],
  };
}

function showSummary(ctx: ExtensionContext, report: UpdateReport): void {
  const lines: string[] = [
    "OKF /wiki-update summary",
    `  Conformant imported:   ${report.conformantImported.length}`,
    `  Agent-transformed:     ${report.nonConformantHandedToAgent.length - report.leftover.length} (of ${report.nonConformantHandedToAgent.length})`,
    `  Ignored:               ${report.ignored.length}`,
    `  Leftover (failed):     ${report.leftover.length}`,
    `  Concepts created:      ${report.createdConcepts.length}`,
    `  Concepts updated:      ${report.updatedConcepts.length}`,
    `  Wiki size:             ${report.wikiConceptCountBefore} -> ${report.wikiConceptCountAfter}`,
  ];
  if (report.conformantImported.length > 0) {
    lines.push("  Imported concept IDs:");
    for (const conceptId of report.conformantImported) lines.push(`    + ${conceptId}`);
  }
  if (report.createdConcepts.length > 0) {
    lines.push("  Created by agent:");
    for (const conceptId of report.createdConcepts) lines.push(`    + ${conceptId}`);
  }
  if (report.updatedConcepts.length > 0) {
    lines.push("  Updated by agent:");
    for (const conceptId of report.updatedConcepts) lines.push(`    ~ ${conceptId}`);
  }
  if (report.ignored.length > 0) {
    lines.push("  Ignored:");
    for (const entry of report.ignored) {
      const detail = entry.detail ? `: ${entry.detail}` : "";
      lines.push(`    - ${entry.path} (${describeIgnoreReason(entry.reason)}${detail})`);
    }
  }
  if (report.leftover.length > 0) {
    lines.push("  Leftover in input/ (agent did not finish):");
    for (const path of report.leftover) lines.push(`    ! ${path}`);
  }
  if (report.warnings.length > 0) {
    lines.push("  Warnings:");
    for (const warning of report.warnings) lines.push(`    ! ${warning}`);
  }
  ctx.ui.setWidget("okf-update", lines);
  ctx.ui.notify(
    `/wiki-update done: ${report.createdConcepts.length + report.conformantImported.length} new, ${report.updatedConcepts.length} updated, ${report.leftover.length} leftover.`,
    "info",
  );
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}