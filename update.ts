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
  READABLE_NON_MD_EXTENSIONS,
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

const RESERVED_INPUT = new Set(["index.md", "log.md"]);

interface FinalizeState {
  readonly paths: WikiPaths;
  readonly beforeSnapshot: WikiSnapshot;
  readonly beforeCount: number;
  readonly conformantImported: readonly string[];
  readonly nonConformant: readonly InputFile[];
  readonly ignored: ReadonlyArray<{ path: string; reason: string }>;
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

  if (inputFiles.data.length === 0) {
    ctx.ui.notify("input/ is empty — nothing to update.", "info");
    return ok(emptyReport(beforeCount));
  }

  const classified = classifyInput(inputFiles.data);
  const ignored: InputFile[] = classified.filter(
    (file) => file.classification === "ignored",
  );
  const conformant = classified.filter(
    (file) => file.classification === "conformant",
  );
  const nonConformant = classified.filter(
    (file) => file.classification === "non-conformant",
  );

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
        ignoreReason: result.error.message,
      });
    }
  }
  const allNonConformant = [...nonConformant, ...deferredNonConformant];

  const ignoredEntries = ignored.map((file) => ({
    path: file.relativePath,
    reason: file.ignoreReason ?? "unknown",
  }));

  // 2. Non-conformant files: delegate to the agent, finalize on agent_end.
  if (allNonConformant.length > 0) {
    const conceptsBefore = await loadAllConcepts(paths.wiki);
    const structure = conceptsBefore.success
      ? buildStructurePreview(conceptsBefore.data)
      : { directories: [], types: [], sampleConceptIds: [] };

    const prompt = buildUpdatePrompt({
      inputFiles: allNonConformant.map((file) => ({
        relativePath: file.relativePath,
        absolutePath: file.absolutePath,
      })),
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
  const { paths, beforeSnapshot, beforeCount, conformantImported, nonConformant, ignored, today } = state;

  const afterSnapshot = await snapshotWiki(paths.wiki);
  const afterEntries = afterSnapshot.success ? afterSnapshot.data.entries : new Map<string, string>();
  const diff = diffSnapshots(beforeSnapshot, { entries: afterEntries });

  const allConcepts = await loadAllConcepts(paths.wiki);
  if (allConcepts.success) {
    await writeIndexMd(paths.wiki, allConcepts.data);
  }
  await appendLogMd(paths.wiki, today, diff);

  const leftover = await detectLeftover(paths.input, nonConformant);

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
    return { ...file, classification: "ignored", ignoreReason: "reserved filename" };
  }
  if (file.relativePath.endsWith(".md")) {
    // Conformance is confirmed in importConformant by parsing frontmatter.
    return { ...file, classification: "conformant" };
  }
  if (READABLE_NON_MD_EXTENSIONS.some((ext) => file.relativePath.toLowerCase().endsWith(ext))) {
    return { ...file, classification: "non-conformant" };
  }
  return { ...file, classification: "ignored", ignoreReason: "unsupported file type" };
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
  const archivePath = `${paths.archive}/${file.relativePath}`;
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
    for (const entry of report.ignored) lines.push(`    - ${entry.path} (${entry.reason})`);
  }
  if (report.leftover.length > 0) {
    lines.push("  Leftover in input/ (agent did not finish):");
    for (const path of report.leftover) lines.push(`    ! ${path}`);
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