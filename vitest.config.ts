import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // Several test files share one local dev Postgres instance. Running
    // them concurrently has caused intermittent prepared-statement/race
    // errors against that (SQLite-emulated) dev server — run files
    // sequentially to keep the DB-backed tests deterministic.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
