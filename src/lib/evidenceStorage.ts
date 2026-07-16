/**
 * On-Device AI Camera Integrity Detection v1 — Evidence Frames storage
 * abstraction. See docs/on-device-ai-integrity-detection-v1.md.
 *
 * Evidence frame bytes are NEVER stored inline in the database (see
 * IntegrityEvidenceAsset in prisma/schema.prisma, which only holds a
 * `storageKey` — an opaque pointer resolved here, never returned to any
 * client). This module is the single choke point for reading/writing
 * those bytes, so swapping providers later means implementing this one
 * interface, not hunting through route handlers.
 *
 * Two providers are implemented:
 *   - `local_dev` — a plain filesystem adapter (gitignored, outside
 *     `public/`) for local development and tests only. NOT viable in a
 *     Vercel production deployment, since serverless function instances
 *     do not share a persistent, writable filesystem across invocations.
 *   - `supabase_storage` — a private Supabase Storage bucket, using
 *     `@supabase/supabase-js` with the server-only service role key
 *     (never exposed to the client — this file is never imported from
 *     client components). This is the provider to use in production,
 *     since this app already deploys on Vercel + Supabase.
 *
 * `vercel_blob` / `s3` remain clearly-stubbed, throwing a descriptive
 * `EvidenceStorageNotConfiguredError` until a real implementation is
 * added — a stub that fails loudly is safer than code that looks like a
 * working integration but silently drops or mis-stores images.
 *
 * See docs/deployment-vercel-supabase.md for the production configuration
 * this feature requires before `captureAiViolationEvidence` may be
 * enabled for any real exam.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

export type EvidenceStorageProviderName = "local_dev" | "vercel_blob" | "supabase_storage" | "s3";

export interface EvidenceStorageAdapter {
  readonly provider: EvidenceStorageProviderName;
  put(key: string, bytes: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

export class EvidenceStorageNotConfiguredError extends Error {
  constructor(provider: EvidenceStorageProviderName) {
    super(
      `Evidence storage provider "${provider}" is not implemented in this deployment. ` +
        `Install/configure the provider's SDK and implement EvidenceStorageAdapter for it in ` +
        `src/lib/evidenceStorage.ts before enabling captureAiViolationEvidence in production. ` +
        `See docs/deployment-vercel-supabase.md.`,
    );
  }
}

/**
 * Local filesystem adapter — local development and tests only. Files live
 * under `.evidence-storage/` at the repo root (gitignored, never under
 * `public/`, never served statically). `key` is expected to already be a
 * safe, opaque, path-traversal-free identifier (see
 * generateEvidenceFrameStorageKey() in src/lib/aiCameraEvidenceFrame.ts) —
 * this adapter defensively re-validates that regardless.
 */
export class LocalDevEvidenceStorageAdapter implements EvidenceStorageAdapter {
  readonly provider = "local_dev" as const;
  private readonly rootDir: string;

  constructor(rootDir = path.join(process.cwd(), ".evidence-storage")) {
    this.rootDir = rootDir;
  }

  private resolvePath(key: string): string {
    // Keys are a single flat folder (see generateEvidenceFrameStorageKey in
    // aiCameraEvidenceFrame.ts, e.g. "ai-camera-evidence/sub123-evt456-abc123.jpg")
    // — the one "/" folder separator is allowed here, but ".." traversal
    // and a leading "/" (which would escape rootDir via path.join) are
    // rejected.
    if (!/^[A-Za-z0-9._/-]+$/.test(key) || key.includes("..") || key.startsWith("/")) {
      throw new Error(`Unsafe evidence storage key: "${key}"`);
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

  async delete(key: string): Promise<void> {
    await rm(this.resolvePath(key), { force: true });
  }
}

function unconfiguredAdapter(provider: EvidenceStorageProviderName): EvidenceStorageAdapter {
  return {
    provider,
    async put() {
      throw new EvidenceStorageNotConfiguredError(provider);
    },
    async get() {
      throw new EvidenceStorageNotConfiguredError(provider);
    },
    async delete() {
      throw new EvidenceStorageNotConfiguredError(provider);
    },
  };
}

/**
 * Private Supabase Storage bucket adapter — server-only. Uses the
 * SERVICE ROLE key (never the anon/public key), so it bypasses bucket
 * RLS policies entirely; this is safe ONLY because this module is never
 * imported from client code (`"use client"` components/routes), and
 * every caller (the upload/view API routes) already enforces its own
 * authentication + institution/ownership checks before ever touching
 * storage. The bucket itself is expected to be created as PRIVATE (not
 * public) — see docs/deployment-vercel-supabase.md for setup steps.
 *
 * `get()` downloads the object server-side and returns raw bytes to the
 * caller (the already-authenticated GET /api/integrity-evidence/[id]
 * route), rather than generating a signed URL — this keeps the "never
 * send a storage reference to the browser" guarantee trivially true
 * (there is no URL to leak) and matches how the local_dev adapter
 * already behaves, so route code doesn't need to branch per provider.
 */
class SupabaseStorageEvidenceAdapter implements EvidenceStorageAdapter {
  readonly provider = "supabase_storage" as const;
  private readonly bucket: string;
  private readonly client: ReturnType<typeof createClient>;

  constructor(supabaseUrl: string, serviceRoleKey: string, bucket: string) {
    this.bucket = bucket;
    this.client = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  // Supabase Storage's `upload()` takes the OBJECT KEY only — never the
  // bucket name (that's `.from(this.bucket)`, kept separate) and never a
  // leading "/" (Supabase rejects that with "Invalid path specified in
  // request URL", which is what a prior deeply-nested key format hit —
  // see the comment on generateEvidenceFrameStorageKey in
  // aiCameraEvidenceFrame.ts). The key is never manually URL-encoded
  // here — the supabase-js client handles that internally.
  private objectKey(key: string): string {
    return key.startsWith("/") ? key.slice(1) : key;
  }

  async put(key: string, bytes: Buffer, contentType?: string): Promise<void> {
    const { error } = await this.client.storage.from(this.bucket).upload(this.objectKey(key), bytes, {
      contentType,
      upsert: false,
    });
    if (error) throw new Error(`Supabase Storage upload failed for "${key}": ${error.message}`);
  }

  async get(key: string): Promise<Buffer | null> {
    const { data, error } = await this.client.storage.from(this.bucket).download(this.objectKey(key));
    if (error || !data) return null;
    const arrayBuffer = await data.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async delete(key: string): Promise<void> {
    await this.client.storage.from(this.bucket).remove([this.objectKey(key)]);
  }
}

export type EvidenceStorageEnv = {
  EVIDENCE_STORAGE_PROVIDER?: string;
  EVIDENCE_STORAGE_BUCKET?: string;
  SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  NODE_ENV?: string;
};

/**
 * Resolves which storage adapter to use, from `EVIDENCE_STORAGE_PROVIDER`.
 * Defaults to `local_dev` outside production. In production, an unset or
 * `local_dev` value fails closed (throws) rather than silently writing to
 * an ephemeral/non-shared filesystem — a real provider must be
 * explicitly configured first. `supabase_storage` fails closed if any of
 * its required env vars (bucket name, Supabase URL, service role key)
 * are missing, rather than guessing or falling back silently — evidence
 * frames are sensitive enough that a misconfiguration should be loud,
 * not silent data loss (or, worse, a silent write to the wrong place).
 */
export function resolveEvidenceStorageAdapter(env: EvidenceStorageEnv = process.env): EvidenceStorageAdapter {
  const configured = env.EVIDENCE_STORAGE_PROVIDER as EvidenceStorageProviderName | undefined;
  const isProduction = env.NODE_ENV === "production";

  if (!configured || configured === "local_dev") {
    if (isProduction) {
      throw new Error(
        "EVIDENCE_STORAGE_PROVIDER is unset (or local_dev) in production. local_dev storage does " +
          "not persist across serverless invocations and must never be used in production — " +
          "configure supabase_storage (or another real provider) first. " +
          "See docs/deployment-vercel-supabase.md.",
      );
    }
    return new LocalDevEvidenceStorageAdapter();
  }

  if (configured === "supabase_storage") {
    const supabaseUrl = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
    const bucket = env.EVIDENCE_STORAGE_BUCKET;
    const missing = [
      !supabaseUrl && "SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)",
      !serviceRoleKey && "SUPABASE_SERVICE_ROLE_KEY",
      !bucket && "EVIDENCE_STORAGE_BUCKET",
    ].filter((v): v is string => Boolean(v));
    if (missing.length > 0) {
      throw new Error(
        `EVIDENCE_STORAGE_PROVIDER is "supabase_storage" but required env var(s) are missing: ` +
          `${missing.join(", ")}. See docs/deployment-vercel-supabase.md.`,
      );
    }
    return new SupabaseStorageEvidenceAdapter(supabaseUrl!, serviceRoleKey!, bucket!);
  }

  if (configured === "vercel_blob" || configured === "s3") {
    return unconfiguredAdapter(configured);
  }

  throw new Error(`Unknown EVIDENCE_STORAGE_PROVIDER: "${configured}"`);
}

/** A short random suffix, safe to embed in a storage key/filename. */
export function randomStorageSuffix(): string {
  return randomBytes(8).toString("hex");
}
