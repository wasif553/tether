/**
 * Evidence Backup/Recovery v1 — archive storage abstraction. See
 * docs/tether-evidence-archive-plan.md.
 *
 * Deliberately a SEPARATE interface from EvidenceStorageAdapter
 * (src/lib/evidenceStorage.ts, unmodified by this pass) — the archive
 * adapter has NO delete/remove/purge capability at all, at the type
 * level. The backup path must never have any application-level ability
 * to remove an archive object; the only thing that can ever shrink the
 * archive is an operator acting directly against the provider outside
 * this codebase.
 *
 * Two providers, mirroring evidenceStorage.ts's own provider split:
 *   - `local_dev` — a plain filesystem adapter for local development and
 *     tests only, writing under a directory separate from the primary
 *     adapter's `.evidence-storage/` so the two are never confused.
 *   - `supabase_storage` — a private bucket in a SEPARATE Supabase
 *     project from the primary one, using that project's own service
 *     role key (ARCHIVE_SUPABASE_SERVICE_ROLE_KEY — never the primary
 *     SUPABASE_SERVICE_ROLE_KEY). See assertProductionArchiveSafe in
 *     evidenceArchive.ts for the machine-enforced check that the archive
 *     project can never resolve to the same project as the primary.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

export type EvidenceArchiveStorageProviderName = "local_dev" | "supabase_storage";

/**
 * No delete(). Deliberately narrower than EvidenceStorageAdapter — see
 * this module's own doc comment above.
 */
export interface EvidenceArchiveStorageAdapter {
  readonly provider: EvidenceArchiveStorageProviderName;
  put(key: string, bytes: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
}

export class EvidenceArchiveStorageNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`Evidence archive storage provider "${provider}" is not implemented. See docs/tether-evidence-archive-plan.md.`);
  }
}

/**
 * Local filesystem adapter — local development and tests only. Files
 * live under `.evidence-archive-storage/` at the repo root (gitignored,
 * never under `public/`), kept entirely separate from the primary
 * adapter's `.evidence-storage/` directory so a test can never confuse
 * "the primary copy" with "the archive copy" by accident. Re-validates
 * that `key` is a safe, opaque, path-traversal-free identifier, mirroring
 * LocalDevEvidenceStorageAdapter's own defensive check.
 */
export class LocalDevEvidenceArchiveStorageAdapter implements EvidenceArchiveStorageAdapter {
  readonly provider = "local_dev" as const;
  private readonly rootDir: string;

  constructor(rootDir = path.join(process.cwd(), ".evidence-archive-storage")) {
    this.rootDir = rootDir;
  }

  private resolvePath(key: string): string {
    if (!/^[A-Za-z0-9._/-]+$/.test(key) || key.includes("..") || key.startsWith("/")) {
      throw new Error(`Unsafe evidence archive storage key: "${key}"`);
    }
    return path.join(this.rootDir, key);
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const filePath = this.resolvePath(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, bytes);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.resolvePath(key));
    } catch {
      return null;
    }
  }
}

/**
 * Private Supabase Storage bucket in a SEPARATE Supabase project —
 * server/operator-only. Uses that project's own service role key, which
 * bypasses that project's RLS entirely (same shape of trust boundary as
 * the primary adapter — see evidenceStorage.ts's own doc comment), but
 * because it is a different project, a compromise of the PRIMARY service
 * role key does not reach this bucket at all — that separation is the
 * entire point of this module existing.
 *
 * `get()` never generates a signed/public URL, exactly like the primary
 * adapter — bytes are read server-side only, by the manual archive/
 * restore CLI, never sent to a browser.
 */
class SupabaseEvidenceArchiveStorageAdapter implements EvidenceArchiveStorageAdapter {
  readonly provider = "supabase_storage" as const;
  private readonly bucket: string;
  private readonly client: ReturnType<typeof createClient>;

  constructor(supabaseUrl: string, serviceRoleKey: string, bucket: string) {
    this.bucket = bucket;
    this.client = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  private objectKey(key: string): string {
    return key.startsWith("/") ? key.slice(1) : key;
  }

  // Fixed, bounded error message on failure — never the provider's raw
  // error.message. Mirrors the sanitization already applied to the
  // primary adapter's delete() (evidence retention deletion safety v1):
  // Tether cannot guarantee a future provider message never embeds an
  // object key, bucket/path detail, or other internal information, and
  // this method's outcome can end up in operator-facing CLI output.
  async put(key: string, bytes: Buffer, contentType?: string): Promise<void> {
    const { error } = await this.client.storage.from(this.bucket).upload(this.objectKey(key), bytes, {
      contentType,
      upsert: false,
    });
    if (error) throw new Error("Supabase archive storage upload failed.");
  }

  async get(key: string): Promise<Buffer | null> {
    const { data, error } = await this.client.storage.from(this.bucket).download(this.objectKey(key));
    if (error || !data) return null;
    const arrayBuffer = await data.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}

export type EvidenceArchiveStorageEnv = {
  ARCHIVE_STORAGE_PROVIDER?: string;
  ARCHIVE_STORAGE_BUCKET?: string;
  ARCHIVE_SUPABASE_URL?: string;
  ARCHIVE_SUPABASE_SERVICE_ROLE_KEY?: string;
  NODE_ENV?: string;
};

/**
 * Resolves which archive adapter to use, from ARCHIVE_STORAGE_PROVIDER.
 * Mirrors resolveEvidenceStorageAdapter's own fail-closed contract:
 * missing/misconfigured required env vars throw immediately rather than
 * guessing, and `local_dev` (which does not persist across serverless
 * invocations) is refused whenever NODE_ENV is "production" — this tool
 * is intended to be run manually from an operator workstation, never as
 * a deployed Vercel function, but this guard costs nothing and matches
 * the primary adapter's own established precedent.
 */
export function resolveEvidenceArchiveStorageAdapter(env: EvidenceArchiveStorageEnv = process.env): EvidenceArchiveStorageAdapter {
  const configured = env.ARCHIVE_STORAGE_PROVIDER as EvidenceArchiveStorageProviderName | undefined;
  const isProduction = env.NODE_ENV === "production";

  if (!configured || configured === "local_dev") {
    if (isProduction) {
      throw new Error(
        "ARCHIVE_STORAGE_PROVIDER is unset (or local_dev) while NODE_ENV=production. local_dev archive " +
          "storage does not persist across serverless invocations and must never be used for a real " +
          "archive run — configure supabase_storage first. See docs/tether-evidence-archive-plan.md.",
      );
    }
    return new LocalDevEvidenceArchiveStorageAdapter();
  }

  if (configured === "supabase_storage") {
    const supabaseUrl = env.ARCHIVE_SUPABASE_URL;
    const serviceRoleKey = env.ARCHIVE_SUPABASE_SERVICE_ROLE_KEY;
    const bucket = env.ARCHIVE_STORAGE_BUCKET;
    const missing = [
      !supabaseUrl && "ARCHIVE_SUPABASE_URL",
      !serviceRoleKey && "ARCHIVE_SUPABASE_SERVICE_ROLE_KEY",
      !bucket && "ARCHIVE_STORAGE_BUCKET",
    ].filter((v): v is string => Boolean(v));
    if (missing.length > 0) {
      throw new Error(
        `ARCHIVE_STORAGE_PROVIDER is "supabase_storage" but required env var(s) are missing: ` +
          `${missing.join(", ")}. See docs/tether-evidence-archive-plan.md.`,
      );
    }
    return new SupabaseEvidenceArchiveStorageAdapter(supabaseUrl!, serviceRoleKey!, bucket!);
  }

  throw new Error(`Unknown ARCHIVE_STORAGE_PROVIDER: "${configured}"`);
}

/**
 * Extracts a Supabase project ref (the subdomain component, e.g.
 * "abcdefgh" from "https://abcdefgh.supabase.co") from a project URL.
 * Used ONLY to compare "is this the same project as that one" — never
 * printed alongside the full URL, and the full URL/credential is never
 * logged anywhere this value is used. Returns null for anything that
 * isn't a parseable URL with a non-empty hostname.
 */
export function extractSupabaseProjectRef(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const { hostname } = new URL(url);
    const firstLabel = hostname.split(".")[0];
    return firstLabel && firstLabel.length > 0 ? firstLabel : null;
  } catch {
    return null;
  }
}
