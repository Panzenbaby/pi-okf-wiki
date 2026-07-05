// /wiki-query command: answer a question against the wiki with source citations.
//
// The /wiki-query command only sends the user's question as the user message
// (clean, persistable). Retrieved concepts and instructions are injected into
// the system prompt via the before_agent_start handler in index.ts, which
// calls buildWikiQueryContext() below.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { err, ok, type Result } from "./types.ts";
import { pathExists, readTextFile } from "./files.ts";
import {
  loadAllConcepts,
  renderWikiTree,
  retrieveConcepts,
  wikiPaths,
} from "./wiki.ts";
import { buildQuerySystemContext } from "./prompts.ts";

const RETRIEVAL_LIMIT = 10;

/**
 * Build the wiki-query system-prompt context (retrieval + instructions) for a
 * given question. Called from the before_agent_start handler so the /wiki-query
 * command itself can keep the user message clean.
 *
 * Returns the context string on success, or an error if the wiki is missing/empty.
 */
export async function buildWikiQueryContext(
  cwd: string,
  question: string,
): Promise<Result<string>> {
  const paths = wikiPaths(cwd);
  if (!(await pathExists(paths.wiki))) {
    return err<string>("No wiki/ folder yet. Run /wiki-update first.");
  }
  const concepts = await loadAllConcepts(paths.wiki);
  if (!concepts.success) return concepts;
  if (concepts.data.length === 0) {
    return err<string>("wiki/ has no concepts yet. Run /wiki-update first.");
  }

  const retrieved = retrieveConcepts(concepts.data, question, RETRIEVAL_LIMIT);
  const indexContent = await readIndex(paths.wiki);
  const wikiTree = renderWikiTree(concepts.data);

  return ok(
    buildQuerySystemContext({
      retrieved: retrieved.map((entry) => ({
        conceptId: entry.conceptId,
        content: entry.content,
      })),
      wikiTree,
      indexMd: indexContent,
    }),
  );
}

export async function runQuery(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  question: string,
): Promise<Result<void>> {
  const trimmed = question.trim();
  if (trimmed === "") {
    ctx.ui.notify("Usage: /wiki-query <question>", "warning");
    return ok(undefined);
  }

  const paths = wikiPaths(ctx.cwd);
  if (!(await pathExists(paths.wiki))) {
    ctx.ui.notify("No wiki/ folder yet. Run /wiki-update first.", "warning");
    return ok(undefined);
  }

  const concepts = await loadAllConcepts(paths.wiki);
  if (!concepts.success) return concepts;
  if (concepts.data.length === 0) {
    ctx.ui.notify("wiki/ has no concepts yet. Run /wiki-update first.", "warning");
    return ok(undefined);
  }

  const retrieved = retrieveConcepts(concepts.data, trimmed, RETRIEVAL_LIMIT);
  ctx.ui.setStatus("okf-query", `Querying wiki (${retrieved.length} hits)…`);

  // Set the session display name to the user's question (so the session
  // list shows it instead of the expanded prompt). Then send only the
  // question as the clean user message — the retrieved context is injected
  // into the system prompt by the before_agent_start handler in index.ts.
  pi.setSessionName(trimmed);
  _pendingQuery = trimmed;
  pi.sendUserMessage(trimmed);
  return ok(undefined);
}

/**
 * Internal flag: set by /wiki-query before sendUserMessage, consumed by the
 * before_agent_start handler to inject wiki context into the system prompt.
 */
let _pendingQuery: string | undefined;

/** Consume and return the pending wiki-query question, or undefined. */
export function consumePendingQuery(): string | undefined {
  const q = _pendingQuery;
  _pendingQuery = undefined;
  return q;
}

async function readIndex(wikiRoot: string): Promise<string | null> {
  const result = await readTextFile(`${wikiRoot}/index.md`);
  return result.success ? result.data : null;
}