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
import { ok } from "./types.ts";
import { SessionRegistry, type Session } from "./session.ts";
import {
  ensureDir,
  listFiles,
  pathExists,
  resolveArchiveTarget,
} from "./files.ts";
import {
  appendLogMd,
  buildStructurePreview,
  diffSnapshots,
  loadAllConcepts,
  snapshotWiki,
  wikiPaths,
  writeIndexMd,
  type WikiPaths,
} from "./wiki.ts";
import { buildUpdatePrompt } from "./prompts.ts";
import {
  archiveExtractedText,
  cleanExtractionTemp,
  cleanupExtractionTemp,
} from "./extract/service.ts";
import {
  createClassifier,
  type IgnoredEntry,
} from "./classifier.ts";

/**
 * Immutable snapshot of the deterministic-phase state an IntakeSession owns.
 * The `hadAgentTurn` flag is set later by {@link IntakeSession.handoffToAgent}.
 */
interface IntakeSessionState {
  readonly paths: WikiPaths;
  readonly beforeSnapshot: WikiSnapshot;
  readonly beforeCount: number;
  readonly conformantImported: readonly string[];
  readonly nonConformant: readonly InputFile[];
  readonly ignored: readonly IgnoredEntry[];
  readonly warnings: readonly string[];
  readonly today: string;
}

/**
 * Owns the /wiki-update handoff state between the command handler and the
 * `agent_end` event hook. Constructed from the deterministic-phase state,
 * registered in {@link intakeSessionRegistry}, and finalized by the hook.
 * For the no-agent-turn path a session is still built and finalized
 * synchronously, just not registered.
 */
export interface IntakeSession extends Session {
  /** Records that an agent turn is in flight (called before sendUserMessage). */
  handoffToAgent(): void;
  /** Run the post-agent finalize (snapshot diff, index/log, summary). */
  finalize(ctx: ExtensionContext): Promise<UpdateReport>;
}

class IntakeSessionImpl implements IntakeSession {
  readonly id: string;
  private hadAgentTurn = false;
  private readonly paths: WikiPaths;
  private readonly beforeSnapshot: WikiSnapshot;
  private readonly beforeCount: number;
  private readonly conformantImported: readonly string[];
  private readonly nonConformant: readonly InputFile[];
  private readonly ignored: readonly IgnoredEntry[];
  private readonly warnings: readonly string[];
  private readonly today: string;

  constructor(state: IntakeSessionState) {
    this.id = `intake-${++intakeSessionCounter}`;
    this.paths = state.paths;
    this.beforeSnapshot = state.beforeSnapshot;
    this.beforeCount = state.beforeCount;
    this.conformantImported = state.conformantImported;
    this.nonConformant = state.nonConformant;
    this.ignored = state.ignored;
    this.warnings = state.warnings;
    this.today = state.today;
  }

  handoffToAgent(): void {
    this.hadAgentTurn = true;
  }

  async finalize(ctx: ExtensionContext): Promise<UpdateReport> {
    const warnings: string[] = [...this.warnings];

    const afterSnapshot = await snapshotWiki(this.paths.wiki);
    const afterEntries = afterSnapshot.success
      ? afterSnapshot.data.entries
      : new Map<string, string>();
    const diff = diffSnapshots(this.beforeSnapshot, { entries: afterEntries });

    const allConcepts = await loadAllConcepts(this.paths.wiki);
    if (allConcepts.success) {
      await writeIndexMd(this.paths.wiki, allConcepts.data);
    }
    await appendLogMd(this.paths.wiki, this.today, diff);

    const leftover = await detectLeftover(this.paths.input, this.nonConformant);
    const leftoverSet = new Set(leftover);

    // Archive the extracted text for every file the agent successfully archived
    // (i.e. not leftover). Leftover originals keep their temp text only until the
    // cleanup below removes it — it is regenerated on the next run.
    for (const file of this.nonConformant) {
      if (file.tempRelativeName === undefined) continue;
      if (leftoverSet.has(file.relativePath)) continue;
      const archived = await archiveExtractedText(
        this.paths.input,
        this.paths.archive,
        file.tempRelativeName,
        resolveArchiveTarget,
      );
      if (!archived.success) {
        warnings.push(
          `Could not archive extracted text for ${file.relativePath}: ${archived.error.message}`,
        );
      }
    }
    const cleaned = await cleanupExtractionTemp(this.paths.input);
    if (!cleaned.success) {
      warnings.push(`Could not clean extraction temp: ${cleaned.error.message}`);
    }

    const report: UpdateReport = {
      conformantImported: this.conformantImported,
      nonConformantHandedToAgent: this.nonConformant.map((file) => file.relativePath),
      ignored: this.ignored,
      leftover,
      createdConcepts: diff.created,
      updatedConcepts: diff.updated,
      wikiConceptCountBefore: this.beforeCount,
      wikiConceptCountAfter: afterEntries.size,
      hadAgentTurn: this.hadAgentTurn,
      warnings,
    };

    ctx.ui.setStatus("okf-update", "");
    showSummary(ctx, report);
    return report;
  }
}

let intakeSessionCounter = 0;

/**
 * The single-slot registry holding the pending /wiki-update intake session.
 * `runUpdate` writes here when it hands off to the agent; the `agent_end` hook
 * in index.ts calls `take()` and finalizes the session (if any).
 */
export const intakeSessionRegistry = new SessionRegistry<IntakeSession>();

export async function runUpdate(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<Result<UpdateReport>> {
  const paths = wikiPaths(ctx.cwd);
  const today = new Date().toISOString().slice(0, 10);

  // Clear any summary from a previously-completed run before this one starts (and
  // before the displaced-session drain below, so a finalized orphan's summary
  // survives and is not immediately wiped).
  ctx.ui.setWidget("okf-update", undefined);

  // Drain any pre-existing pending intake session before starting this run.
  // This covers two orphan scenarios: a second /wiki-update issued while a
  // prior agent turn was still in flight, and a prior turn that never fired
  // agent_end (agent crash / user abort). Finalizing the displaced session
  // compares *its* (old) beforeSnapshot to the *current* wiki state, which
  // captures whatever the prior agent actually wrote. This run then takes its
  // own fresh beforeSnapshot of the now-current state below — correct ordering.
  const displacedIntake = intakeSessionRegistry.take();
  if (displacedIntake !== undefined) {
    ctx.ui.notify(
      "A previous /wiki-update was still pending — finalizing it before starting this run.",
      "warning",
    );
    await displacedIntake.finalize(ctx);
  }

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

  // 0. Classification owns the full input -> bucket pipeline AND the
  //    deterministic conformant intake: tentative classification, the
  //    extraction pass (which stages extracted text under
  //    input/.okf-extract/), and pass 3 (read + verify + write to wiki/ +
  //    archive original for conformant `.md`). It emits the three final
  //    buckets — conformantImported / forAgent / ignored — once. Clean any
  //    stale extraction temp from an interrupted previous run first, exactly
  //    once per run, before the classifier extracts. (Non-fatal: a failure
  //    here just means stale temp may survive until the next run; listFiles
  //    skips `.okf-extract` and tempRelativeNameFor overwrites same-named
  //    files, so ingestion still works.)
  const cleaned = await cleanExtractionTemp(paths.input);
  if (!cleaned.success) {
    runWarnings.push(`Could not clean extraction temp: ${cleaned.error.message}`);
  }
  const classifier = createClassifier(paths);
  const classified = await classifier.classify(inputFiles.data);
  if (!classified.success) return classified;
  const { conformantImported, forAgent, ignored } = classified.data;

  // 1. Build the intake-session state. The classifier already deterministically
  //    imported the conformant `.md` files (write to wiki/ + archive original),
  //    so there is nothing more to do for them here. `forAgent` already
  //    includes any deferred `.md` (ones that lacked frontmatter/type).
  const allNonConformant = forAgent;
  const allIgnored = ignored;

  const sessionState: IntakeSessionState = {
    paths,
    beforeSnapshot: beforeSnapshot.data,
    beforeCount,
    conformantImported,
    nonConformant: allNonConformant,
    ignored: allIgnored,
    warnings: runWarnings,
    today,
  };

  if (allNonConformant.length > 0) {
    // 2. Non-conformant files: delegate to the agent, finalize on agent_end.
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

    const session = new IntakeSessionImpl(sessionState);
    session.handoffToAgent();
    // Slot is guaranteed empty: we drained any pending session at entry.
    intakeSessionRegistry.set(session);
    pi.sendUserMessage(prompt);
    ctx.ui.setStatus(
      "okf-update",
      "Agent transforms non-conformant input — summary appears on completion",
    );
    return ok(emptyReport(beforeCount));
  }

  // 2. No agent turn: finalize synchronously now.
  const session = new IntakeSessionImpl(sessionState);
  const report = await session.finalize(ctx);
  return ok(report);
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