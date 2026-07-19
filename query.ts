// /wiki-query command: answer a question against the wiki with source citations.
//
// The /wiki-query command only sends the user's question as the user message
// (clean, persistable). Retrieved concepts and instructions are injected into
// the system prompt via the before_agent_start handler in index.ts, which
// calls buildWikiQueryContext() below.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { err, ok, type Result } from "./types.ts";
import { SessionRegistry, type Session } from "./session.ts";
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
 * Owns the pending /wiki-query question between the command handler and the
 * `before_agent_start` event hook. Constructed in `runQuery`, registered in
 * {@link querySessionRegistry}, and consumed by the hook to build the
 * system-prompt context from {@link QuerySession.question}.
 */
export interface QuerySession extends Session {
  readonly question: string;
}

class QuerySessionImpl implements QuerySession {
  readonly id: string;
  constructor(readonly question: string) {
    this.id = `query-${++querySessionCounter}`;
  }
}

let querySessionCounter = 0;

/**
 * The single-slot registry holding the pending /wiki-query session. `runQuery`
 * writes here before sendUserMessage; the `before_agent_start` hook in index.ts
 * calls `take()` and injects the wiki context for {@link QuerySession.question}.
 */
export const querySessionRegistry = new SessionRegistry<QuerySession>();

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
  // Drain any pre-existing pending query session so a second /wiki-query does
  // not silently drop the first (e.g. prior turn aborted / never fired
  // before_agent_start). A pending query session has no side effects to
  // finalize, so just warn and proceed.
  const displacedQuery = querySessionRegistry.take();
  if (displacedQuery !== undefined) {
    ctx.ui.notify(
      "A previous /wiki-query was still pending — replacing it with this one.",
      "warning",
    );
  }

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
  querySessionRegistry.set(new QuerySessionImpl(trimmed));
  pi.sendUserMessage(trimmed);
  return ok(undefined);
}

async function readIndex(wikiRoot: string): Promise<string | null> {
  const result = await readTextFile(`${wikiRoot}/index.md`);
  return result.success ? result.data : null;
}