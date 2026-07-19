import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Extractors read real files from a temp dir; run sequentially to keep
    // assertions deterministic and avoid fs races in the tiny fixtures.
    fileParallelism: false,
  },
});