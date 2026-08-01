// OKF knowledge base extension for Pi.
//
// Commands:
//   /wiki-update — ingest new documents from input/ into the wiki/ bundle.
//   /wiki-query  — answer a question against the wiki with source citations.
//   /wiki-remove — move a concept or a whole directory into the bundle trash.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { runUpdate, intakeSessionRegistry } from "./update.ts";
import { runQuery, querySessionRegistry, buildWikiQueryContext } from "./query.ts";
import { removeFromWiki } from "./remove.ts";

export default function okfExtension(pi: ExtensionAPI): void {
  // After any agent turn, finalize a pending /wiki-update run (if any) so the
  // summary reflects the wiki state *after* the agent finished writing.
  pi.on("agent_end", async (_event, ctx) => {
    const session = intakeSessionRegistry.take();
    if (session === undefined) return;
    await session.finalize(ctx);
  });

  // Before every agent turn, check if the turn was triggered by /wiki-query.
  // If so, retrieve wiki concepts for the user's question and inject them
  // into the system prompt. This keeps the user message clean (just the
  // question) while still giving the agent the full wiki context.
  pi.on("before_agent_start", async (_event, ctx) => {
    const session = querySessionRegistry.take();
    if (session === undefined) return;
    const result = await buildWikiQueryContext(ctx.cwd, session.question);
    if (!result.success) {
      ctx.ui.notify(`/wiki-query: ${result.error.message}`, "warning");
      return;
    }
    const systemPrompt = ctx.getSystemPrompt();
    const augmented = systemPrompt
      ? `${systemPrompt}\n\n${result.data}`
      : result.data;
    return { systemPrompt: augmented };
  });

  pi.registerCommand("wiki-update", {
    description: "Ingest new documents from input/ into the OKF wiki",
    handler: async (_args, ctx) => {
      const result = await runUpdate(pi, ctx);
      if (!result.success) {
        ctx.ui.notify(`/wiki-update failed: ${result.error.message}`, "error");
      }
    },
  });

  pi.registerCommand("wiki-query", {
    description: "Ask a question against the OKF wiki (with sources)",
    handler: async (args, ctx) => {
      const result = await runQuery(pi, ctx, args);
      if (!result.success) {
        ctx.ui.notify(`/wiki-query failed: ${result.error.message}`, "error");
      }
    },
  });

  pi.registerCommand("wiki-remove", {
    description: "Move a concept or directory out of the wiki into wiki/trash/",
    handler: async (args, ctx) => {
      const target = args.trim();
      if (target === "") {
        ctx.ui.notify("Usage: /wiki-remove <concept-path | directory>", "warning");
        return;
      }
      const result = await removeFromWiki(ctx.cwd, target);
      if (!result.success) {
        ctx.ui.notify(`/wiki-remove failed: ${result.error.message}`, "error");
        return;
      }
      const { removed, removedDirectories, rewrittenConcepts } = result.data;
      const parts = [`Removed ${removed.length} concept(s) to wiki/trash/`];
      if (removedDirectories.length > 0) {
        parts.push(`emptied directories: ${removedDirectories.join(", ")}`);
      }
      if (rewrittenConcepts.length > 0) {
        parts.push(`redirected links in ${rewrittenConcepts.length} concept(s)`);
      }
      ctx.ui.notify(parts.join(" — "), "info");
    },
  });
}