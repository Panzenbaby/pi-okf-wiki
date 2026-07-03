// OKF knowledge base extension for Pi.
//
// Commands:
//   /wiki-update — ingest new documents from input/ into the wiki/ bundle.
//   /wiki-query  — answer a question against the wiki with source citations.
//
// See CONTEXT.md and docs/adr/0001-okf-extension-architecture.md for the
// design rationale.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { runUpdate, finalizePendingUpdate } from "./update.ts";
import { runQuery } from "./query.ts";

export default function okfExtension(pi: ExtensionAPI): void {
  // After any agent turn, finalize a pending /wiki-update run (if any) so the
  // summary reflects the wiki state *after* the agent finished writing.
  pi.on("agent_end", async (_event, ctx) => {
    await finalizePendingUpdate(ctx);
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
}