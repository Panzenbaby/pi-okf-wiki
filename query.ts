// /wiki-query command: answer a question against the wiki with source citations.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { ok, type Result } from "./types.ts";
import { pathExists, readTextFile } from "./files.ts";
import {
  loadAllConcepts,
  renderWikiTree,
  retrieveConcepts,
  wikiPaths,
} from "./wiki.ts";
import { buildQueryPrompt } from "./prompts.ts";

const RETRIEVAL_LIMIT = 10;

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
  const indexContent = await readIndex(paths.wiki);
  const wikiTree = renderWikiTree(concepts.data);

  const prompt = buildQueryPrompt({
    question: trimmed,
    retrieved: retrieved.map((entry) => ({
      conceptId: entry.conceptId,
      content: entry.content,
    })),
    wikiTree,
    indexMd: indexContent,
  });

  ctx.ui.setStatus("okf-query", `Querying wiki (${retrieved.length} hits)…`);
  pi.sendUserMessage(prompt);
  return ok(undefined);
}

async function readIndex(wikiRoot: string): Promise<string | null> {
  const result = await readTextFile(`${wikiRoot}/index.md`);
  return result.success ? result.data : null;
}