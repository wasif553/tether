import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Dedicated Vitest config for *.disposable.test.ts files only — see
 * src/lib/secureClientRunner.disposable.test.ts's header. These are
 * excluded from the default vitest.config.ts (and therefore from
 * `npm test`/CI) because they require a disposable, migrated Postgres
 * database and must never run against the shared Supabase DATABASE_URL
 * from .env.
 *
 * Usage:
 *   DATABASE_URL="postgresql://...disposable..." npx vitest run --config vitest.disposable.config.ts
 */
export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    fileParallelism: false,
    include: ["**/*.disposable.test.ts"],
    exclude: ["**/node_modules/**", "**/.git/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
