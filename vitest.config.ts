import { configDefaults, defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // Several test files share one local dev Postgres instance. Running
    // them concurrently has caused intermittent prepared-statement/race
    // errors against that (SQLite-emulated) dev server — run files
    // sequentially to keep the DB-backed tests deterministic.
    fileParallelism: false,
    // *.disposable.test.ts files require a migrated, disposable Postgres
    // database (never the shared Preview/Production Supabase instance —
    // see docs/migration-ledger.md and the header of any such file) and
    // are therefore never part of the default `vitest run` used by `npm
    // test` / CI. Run them explicitly with DATABASE_URL pointed at a
    // throwaway database, e.g.:
    //   DATABASE_URL="postgresql://...disposable..." npx vitest run src/lib/secureClientRunner.disposable.test.ts
    exclude: [...configDefaults.exclude, "**/*.disposable.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
