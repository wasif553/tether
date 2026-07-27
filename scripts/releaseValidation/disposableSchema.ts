/**
 * Disposable-database schema setup for `npm run release:validate`. See
 * docs/release-validation.md, "Disposable schema setup" / "Synthetic seed
 * setup" / "Partial-index setup".
 *
 * Narrowly scoped: applies the CURRENT prisma/schema.prisma (via `prisma
 * db push`, permitted only because this targets a disposable local
 * Docker database — never the shared Preview/Production Supabase
 * database), the synthetic seed, and ONLY the specific partial indexes
 * that `prisma db push` cannot express (Prisma's schema DSL has no
 * partial/conditional-unique-index equivalent — see the comments in
 * prisma/schema.prisma and docs/migration-ledger.md for each one). This
 * deliberately does NOT replay every historical shared-database migration
 * file — those CREATE TABLE/ALTER TABLE statements are already covered by
 * `prisma db push` against the current schema; only the handful of
 * indexes db push cannot create are replayed here, sourced from the two
 * migration files the ledger marks as actually applied to the shared
 * database (rows 13/14 in docs/migration-ledger.md):
 *   - docs/answer-development-provenance-v1-migration.sql
 *   - docs/secure-client-foundation-seb-v1-migration.sql
 */
import { Client } from "pg";
import { requireDisposableDatabaseUrl } from "./dbSafetyGuard";
import { runInherit } from "./processUtil";

/**
 * Every partial index the current test suite relies on that `prisma db
 * push` cannot create. Each entry names the migration file it was
 * transcribed from, so a future reader can verify it against the source
 * rather than trusting this list blindly.
 */
export const REQUIRED_PARTIAL_INDEXES: ReadonlyArray<{ name: string; sourceMigration: string; sql: string }> = [
  {
    name: "AnswerDevelopmentArtifact_answer_type_key",
    sourceMigration: "docs/answer-development-provenance-v1-migration.sql",
    sql: `CREATE UNIQUE INDEX "AnswerDevelopmentArtifact_answer_type_key" ON "AnswerDevelopmentArtifact" ("answerId", "artifactType") WHERE "answerId" IS NOT NULL;`,
  },
  {
    name: "AnswerDevelopmentArtifact_submission_type_key",
    sourceMigration: "docs/answer-development-provenance-v1-migration.sql",
    sql: `CREATE UNIQUE INDEX "AnswerDevelopmentArtifact_submission_type_key" ON "AnswerDevelopmentArtifact" ("submissionId", "artifactType") WHERE "answerId" IS NULL;`,
  },
  {
    name: "SecureClientConfiguration_exam_provider_active_key",
    sourceMigration: "docs/secure-client-foundation-seb-v1-migration.sql",
    sql: `CREATE UNIQUE INDEX "SecureClientConfiguration_exam_provider_active_key" ON "SecureClientConfiguration" ("examId", "provider") WHERE "status" = 'ACTIVE';`,
  },
  {
    name: "SecureClientSession_submission_nonterminal_key",
    sourceMigration: "docs/secure-client-foundation-seb-v1-migration.sql",
    sql: `CREATE UNIQUE INDEX "SecureClientSession_submission_nonterminal_key" ON "SecureClientSession" ("submissionId") WHERE "status" NOT IN ('ENDED', 'REJECTED');`,
  },
];

/**
 * Applies prisma/schema.prisma to the disposable database via `prisma db
 * push`. Re-validates the URL immediately before running the command —
 * this is the one place in the whole runner that can mutate schema, so it
 * re-checks rather than trusting a value computed earlier in the process.
 */
export async function pushSchemaToDisposableDatabase(disposableDatabaseUrl: string, expectedPort: number, log: (msg: string) => void): Promise<void> {
  const parsed = requireDisposableDatabaseUrl(disposableDatabaseUrl, expectedPort);
  log(`Applying schema to disposable PostgreSQL on ${parsed.hostname}.`);
  const result = await runInherit("npx", ["prisma", "db", "push", "--url", disposableDatabaseUrl, "--accept-data-loss"], {
    env: { ...process.env, DATABASE_URL: disposableDatabaseUrl },
  });
  if (result.code !== 0) {
    throw new Error(`prisma db push failed (exit code ${result.code}).`);
  }
}

/**
 * Runs prisma/seed.ts against the disposable database only. Deliberately
 * does NOT pass tsx's `--env-file` flag (unlike the repository's own
 * `npm run seed` script) — that flag would load the real `.env` and set
 * DATABASE_URL from it before this process's own env is considered,
 * which is exactly the accidental-fallback this workflow must never
 * allow. The disposable URL is passed only via the child process's `env`.
 */
/**
 * Synthetic, obviously-fake LTI platform configuration — prisma/seed.ts's
 * seedCanvasPlatform() only ever stores these as plain string columns
 * (issuer/clientId/endpoints), it never makes a real network call against
 * them at seed time (see src/lib/lti/seedPlatform.ts). Supplying clear
 * placeholders here means this workflow never depends on real Canvas
 * credentials, matching "optional integrations must use their existing
 * deterministic mocks" — there is nothing to mock, so a synthetic value
 * plays the same role.
 */
const SYNTHETIC_LTI_ENV: Record<string, string> = {
  LTI_PLATFORM_ISSUER: "https://lti-disposable.release-validate.invalid",
  LTI_CLIENT_ID: "release-validate-disposable-client-id",
  LTI_PLATFORM_OIDC_AUTH: "https://lti-disposable.release-validate.invalid/auth",
  LTI_TOKEN_ENDPOINT: "https://lti-disposable.release-validate.invalid/token",
  LTI_PLATFORM_JWKS: "https://lti-disposable.release-validate.invalid/jwks",
  LTI_DEPLOYMENT_ID: "release-validate-disposable-deployment",
};

export async function seedDisposableDatabase(disposableDatabaseUrl: string, expectedPort: number, log: (msg: string) => void): Promise<void> {
  requireDisposableDatabaseUrl(disposableDatabaseUrl, expectedPort);
  log("Running prisma/seed.ts against the disposable database (default Institution + synthetic LTI platform fixture).");
  const result = await runInherit("npx", ["tsx", "prisma/seed.ts"], {
    env: {
      ...process.env,
      ...SYNTHETIC_LTI_ENV,
      DATABASE_URL: disposableDatabaseUrl,
      // No real platform-admin account is ever created for a disposable
      // database — explicitly blank regardless of what the ambient
      // environment might otherwise provide.
      PLATFORM_ADMIN_EMAIL: "",
      PLATFORM_ADMIN_PASSWORD: "",
    },
  });
  if (result.code !== 0) {
    throw new Error(`Disposable-database seed failed (exit code ${result.code}).`);
  }
}

/**
 * Applies exactly the partial indexes listed in REQUIRED_PARTIAL_INDEXES
 * — nothing else. Connects directly via `pg` (not `docker exec psql`) so
 * this works identically regardless of what client tools the Postgres
 * image happens to ship with.
 */
export async function applyRequiredPartialIndexes(disposableDatabaseUrl: string, expectedPort: number, log: (msg: string) => void): Promise<void> {
  requireDisposableDatabaseUrl(disposableDatabaseUrl, expectedPort);
  const client = new Client({ connectionString: disposableDatabaseUrl });
  await client.connect();
  try {
    for (const index of REQUIRED_PARTIAL_INDEXES) {
      log(`Applying partial index ${index.name} (from ${index.sourceMigration}).`);
      await client.query(index.sql);
    }
  } finally {
    await client.end();
  }
}

/** Read-only confirmation that every required partial index actually exists, with its WHERE clause intact (genuinely partial, not a plain index) — used for the post-setup summary, never to decide pass/fail on its own. */
export async function verifyPartialIndexesExist(disposableDatabaseUrl: string): Promise<{ name: string; exists: boolean }[]> {
  const client = new Client({ connectionString: disposableDatabaseUrl });
  await client.connect();
  try {
    const results: { name: string; exists: boolean }[] = [];
    for (const index of REQUIRED_PARTIAL_INDEXES) {
      const { rows } = await client.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE indexname = $1`,
        [index.name],
      );
      results.push({ name: index.name, exists: rows.length === 1 && rows[0].indexdef.includes("WHERE") });
    }
    return results;
  } finally {
    await client.end();
  }
}
