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
import { EXTRACTION_TEMP_DIR } from "./extract/service.ts";
import {
  ensureDir,
  listFiles,
  pathExists,
  readTextFile,
  removeEmptyDirs,
  removeJunkFiles,
  resolveArchiveTarget,
  writeTextFile,
} from "./files.ts";
import {
  appendLogMd,
  buildStructurePreview,
  diffSnapshots,
  loadAllConcepts,
  relativePosix,
  snapshotWiki,
  wikiPaths,
  writeIndexMd,
  type WikiPaths,
} from "./wiki.ts";
import { buildUpdatePrompt, type UpdatePromptInput } from "./prompts.ts";
import {
  archiveExtractedText,
  cleanExtractionTemp,
  cleanupExtractionTemp,
} from "./extract/service.ts";
import {
  createClassifier,
  type IgnoredEntry,
} from "./classifier.ts";
import { compileArchiveRewriter } from "./links.ts";

/**
 * Skip predicate shared by the input walkers: hide the extraction temp dir
 * staged inside `input/`. Hoisted to module level so every call site passes
 * the same identity instead of allocating a fresh closure.
 */
const skipExtractionTemp = (name: string, _isDirectory: boolean): boolean =>
  name === EXTRACTION_TEMP_DIR;

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
  /**
   * Snapshot of the wiki taken AFTER the deterministic classifier run (so it
   * already contains the conformant imports) but BEFORE the agent turn. The
   * finalize citation-link rewriter diffs this against the post-agent snapshot
   * to get EXACTLY the concepts the agent wrote — excluding conformant imports
   * the classifier copied verbatim (which never cite this run's archive) AND
   * catching the case where the agent UPDATES a concept that was also
   * conformant-imported this run (which a naive `diff(beforeSnapshot, after)`
   * + conformant-skip would miss).
   */
  readonly preAgentSnapshot: WikiSnapshot;
  /**
   * Original input relative path (posix) -> actual archive-relative path
   * (posix, post-rename) for every non-conformant file handed to the agent.
   * Used by the finalize rewrite to fix `/archive/<input-relative-path>`
   * placeholder citation links to the renamed archive path. Computed once in
   * `runUpdate` from the same `resolveArchiveTarget` call that feeds the
   * prompt, so the agent and the rewriter agree on the destination.
   */
  readonly archiveTargets: ReadonlyMap<string, string>;
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
  private readonly preAgentSnapshot: WikiSnapshot;
  private readonly archiveTargets: ReadonlyMap<string, string>;

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
    this.preAgentSnapshot = state.preAgentSnapshot;
    this.archiveTargets = state.archiveTargets;
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

    // Rewrite `/archive/<input-relative-path>` placeholder citation links
    // in agent-written concepts to the actual (collision-renamed) archive
    // paths. Only concepts the agent wrote/updated this run are touched —
    // conformant imports are copied verbatim and do not cite this run's
    // archive. Failures are non-fatal (logged as warnings): a missed rewrite
    // leaves a placeholder link, which is still a valid (if unresolvable)
    // markdown link and never breaks the wiki. The concept set is the AGENT's
    // writes this run: the diff of the post-classification snapshot against the
    // post-agent snapshot (NOT the user-facing before/after `diff`, which would
    // also include the classifier's conformant imports and could miss an agent
    // update of a just-imported concept).
    const agentDiff = diffSnapshots(this.preAgentSnapshot, { entries: afterEntries });
    const rewriteWarnings = await rewriteArchiveCitationsInConcepts(
      this.paths.wiki,
      new Set([...agentDiff.created, ...agentDiff.updated]),
      this.archiveTargets,
    );
    for (const warning of rewriteWarnings) warnings.push(warning);

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

    // Prune now-empty directories the agent left behind in input/ after
    // moving every original to the archive. The temp dir is already gone
    // (see cleanup above), but `skip` guards against a stale one anyway.
    const pruned = await removeEmptyDirs(this.paths.input, skipExtractionTemp);
    if (!pruned.success) {
      warnings.push(`Could not prune empty input folders: ${pruned.error.message}`);
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
 * Rewrite `/archive/<input-relative-path>` placeholder citation links in the
 * given concept ids to the actual renamed archive paths, writing the changed
 * files back under `wikiDir`. `conceptIds` MUST be the set of concepts the
 * AGENT wrote this run (not the full before/after diff — that would include
 * conformant imports the classifier copied verbatim and never cite this run's
 * archive). The caller derives it by diffing a post-classification snapshot
 * against the post-agent snapshot. Returns non-fatal warning strings (one per
 * failed IO); a missed rewrite leaves a placeholder link, which is still
 * valid markdown.
 */
export async function rewriteArchiveCitationsInConcepts(
  wikiDir: string,
  conceptIds: ReadonlySet<string>,
  archiveTargets: ReadonlyMap<string, string>,
): Promise<string[]> {
  if (archiveTargets.size === 0 || conceptIds.size === 0) return [];
  // Compile the alternation regex ONCE for the whole run, not per concept.
  const rewriter = compileArchiveRewriter(archiveTargets);
  if (!rewriter.hasMappings) return [];
  const warnings: string[] = [];
  for (const conceptId of conceptIds) {
    const absolutePath = `${wikiDir}/${conceptId}.md`;
    const read = await readTextFile(absolutePath);
    if (!read.success) {
      // The diff lists a concept the agent reported but no longer wrote, or a
      // read race — non-fatal, the placeholder link simply stays.
      warnings.push(
        `Could not read ${absolutePath} for archive-link rewrite: ${read.error.message}`,
      );
      continue;
    }
    const { content, changed } = rewriter.rewrite(read.data);
    if (!changed) continue;
    const write = await writeTextFile(absolutePath, content);
    if (!write.success) {
      warnings.push(
        `Could not write ${absolutePath} after archive-link rewrite: ${write.error.message}`,
      );
    }
  }
  return warnings;
}

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

  // Drop OS / file-manager metadata junk (.DS_Store, Thumbs.db, desktop.ini,
  // AppleDouble `._*` sidecars) BEFORE collecting input files. Two reasons:
  //  (1) these are not documents and would otherwise show up as "unsupported
  //      file type" noise in the summary;
  //  (2) a lone `.DS_Store` keeps its folder non-empty, which would block the
  //      post-ingest empty-folder prune and leave `input/` cluttered.
  // Non-fatal: a failure just means the junk survives this run.
  const runWarnings: string[] = [];
  const junkRemoved = await removeJunkFiles(paths.input, skipExtractionTemp);
  if (!junkRemoved.success) {
    runWarnings.push(`Could not remove junk files: ${junkRemoved.error.message}`);
  }

  const inputFiles = await collectInputFiles(paths.input);
  if (!inputFiles.success) return inputFiles;

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

  // Snapshot the wiki AFTER the deterministic classifier run (conformant imports
  // are already on disk) but BEFORE the agent turn. The finalize citation-link
  // rewriter diffs this against the post-agent snapshot to isolate exactly the
  // concepts the agent wrote — excluding conformant imports and catching the
  // case where the agent updates a just-imported concept.
  const preAgentSnapshot = await snapshotWiki(paths.wiki);
  if (!preAgentSnapshot.success) return preAgentSnapshot;

  // 1. Build the intake-session state. The classifier already deterministically
  //    imported the conformant `.md` files (write to wiki/ + archive original),
  //    so there is nothing more to do for them here. `forAgent` already
  //    includes any deferred `.md` (ones that lacked frontmatter/type).
  const allNonConformant = forAgent;
  const allIgnored = ignored;

  // Resolve every non-conformant original's collision-free archive destination
  // ONCE, here, before the agent runs (after a move the same call would return
  // a different, timestamped name). The absolute target feeds the prompt and
  // the archive-relative form feeds the finalize citation-link rewriter, so
  // the agent's `/archive/<input-relative-path>` placeholders are rewritten to
  // the renamed path the UI can actually open. The prompt's `inputFiles` is
  // built in the SAME loop so there is exactly one resolve per file and no
  // fallback that could silently feed the agent a non-archive path.
  const archiveTargets = new Map<string, string>();
  const promptInputFiles: UpdatePromptInput["inputFiles"][number][] = [];
  for (const file of allNonConformant) {
    const target = await resolveArchiveTarget(paths.archive, file.relativePath);
    archiveTargets.set(file.relativePath, relativePosix(paths.archive, target));
    promptInputFiles.push({
      relativePath: file.relativePath,
      absolutePath: file.absolutePath,
      archiveTarget: target,
      extractedTextPath: file.extractedTextPath,
      sourceFormat: file.sourceFormat,
    });
  }

  const sessionState: IntakeSessionState = {
    paths,
    beforeSnapshot: beforeSnapshot.data,
    beforeCount,
    conformantImported,
    nonConformant: allNonConformant,
    ignored: allIgnored,
    warnings: runWarnings,
    today,
    preAgentSnapshot: preAgentSnapshot.data,
    archiveTargets,
  };

  if (allNonConformant.length > 0) {
    // 2. Non-conformant files: delegate to the agent, finalize on agent_end.
    const conceptsBefore = await loadAllConcepts(paths.wiki);
    const structure = conceptsBefore.success
      ? buildStructurePreview(conceptsBefore.data)
      : { directories: [], types: [], conceptIds: [] };

    const prompt = buildUpdatePrompt({
      inputFiles: promptInputFiles,
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
    // This synchronous return is a PLACEHOLDER: the agent turn is in flight
    // (hadAgentTurn is recorded on the session, not here) and the real report
    // is produced by `agent_end` -> `IntakeSession.finalize` later. Callers that
    // need the final state must read it from the hook, not from this return.
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
  const files = await listFiles(inputRoot, skipExtractionTemp);
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
  const files = await listFiles(inputRoot, skipExtractionTemp);
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
