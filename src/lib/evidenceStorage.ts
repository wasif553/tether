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
 * No object-storage SDK (Vercel Blob, Supabase Storage, AWS S3, etc.) is
 * installed in this repo today. Rather than hand-roll an unverified HTTP
 * integration against a provider this environment cannot actually test,
 * this module ships:
 *   - a fully-working `local_dev` adapter (plain filesystem, gitignored,
 *     outside `public/`) — safe for local development and tests, but
 *     fundamentally NOT viable in a Vercel production deployment, since
 *     serverless function instances do not share a persistent, writable
 *     filesystem across invocations;
 *   - clearly-stubbed adapters for `vercel_blob` / `supabase_storage` /
 *     `s3` that throw a descriptive `EvidenceStorageNotConfiguredError`
 *     until a real implementation + the provider's SDK are added. This
 *     is deliberate: a stub that fails loudly is safer than code that
 *     looks like a working integration but silently drops or
 *     mis-stores images.
 *
 * See docs/deployment-vercel-supabase.md for the production configuration
 * this feature requires before `captureAiViolationEvidence` may be
 * enabled for any real exam.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type EvidenceStorageProviderName = "local_dev" | "vercel_blob" | "supabase_storage" | "s3";

export interface EvidenceStorageAdapter {
  readonly provider: EvidenceStorageProviderName;
  put(key: string, bytes: Buffer): Promise<void>;
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
class LocalDevEvidenceStorageAdapter implements EvidenceStorageAdapter {
  readonly provider = "local_dev" as const;
  private readonly rootDir: string;

  constructor(rootDir = path.join(process.cwd(), ".evidence-storage")) {
    this.rootDir = rootDir;
  }

  private resolvePath(key: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(key) || key.includes("..")) {
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
 * Resolves which storage adapter to use, from `EVIDENCE_STORAGE_PROVIDER`.
 * Defaults to `local_dev` outside production. In production, an unset or
 * `local_dev` value fails closed (throws) rather than silently writing to
 * an ephemeral/non-shared filesystem — a real provider must be
 * explicitly configured first. Never guesses a provider is "probably
 * fine" — evidence frames are sensitive enough that a misconfiguration
 * should be loud, not silent data loss.
 */
export function resolveEvidenceStorageAdapter(
  env: { EVIDENCE_STORAGE_PROVIDER?: string; NODE_ENV?: string } = process.env,
): EvidenceStorageAdapter {
  const configured = env.EVIDENCE_STORAGE_PROVIDER as EvidenceStorageProviderName | undefined;
  const isProduction = env.NODE_ENV === "production";

  if (!configured || configured === "local_dev") {
    if (isProduction) {
      throw new Error(
        "EVIDENCE_STORAGE_PROVIDER is unset (or local_dev) in production. local_dev storage does " +
          "not persist across serverless invocations and must never be used in production — " +
          "configure a real provider (vercel_blob, supabase_storage, or s3) first. " +
          "See docs/deployment-vercel-supabase.md.",
      );
    }
    return new LocalDevEvidenceStorageAdapter();
  }

  if (configured === "vercel_blob" || configured === "supabase_storage" || configured === "s3") {
    return unconfiguredAdapter(configured);
  }

  throw new Error(`Unknown EVIDENCE_STORAGE_PROVIDER: "${configured}"`);
}

/** A short random suffix, safe to embed in a storage key/filename. */
export function randomStorageSuffix(): string {
  return randomBytes(8).toString("hex");
}
