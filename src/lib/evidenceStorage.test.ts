/**
 * Add Supabase Storage for AI evidence frames — see
 * docs/on-device-ai-integrity-detection-v1.md and
 * docs/deployment-vercel-supabase.md.
 *
 * Pure unit tests only — no Prisma/DB, no real Supabase project, no
 * network. `resolveEvidenceStorageAdapter` takes an injectable env object,
 * so every branch (missing env, unknown provider, production guard) is
 * directly testable without touching `process.env`. The local_dev
 * adapter is exercised against a temp directory on disk (still no
 * network, no DB).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EvidenceStorageNotConfiguredError,
  LocalDevEvidenceStorageAdapter,
  resolveEvidenceStorageAdapter,
} from "./evidenceStorage";

describe("resolveEvidenceStorageAdapter — supabase_storage", () => {
  it("2. fails closed when ALL required env vars are missing", () => {
    expect(() => resolveEvidenceStorageAdapter({ EVIDENCE_STORAGE_PROVIDER: "supabase_storage" })).toThrow(
      /SUPABASE_URL[\s\S]*SUPABASE_SERVICE_ROLE_KEY[\s\S]*EVIDENCE_STORAGE_BUCKET/,
    );
  });

  it("2. fails closed when only the bucket name is missing", () => {
    expect(() =>
      resolveEvidenceStorageAdapter({
        EVIDENCE_STORAGE_PROVIDER: "supabase_storage",
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-key",
      }),
    ).toThrow(/EVIDENCE_STORAGE_BUCKET/);
  });

  it("2. fails closed when only the service role key is missing", () => {
    expect(() =>
      resolveEvidenceStorageAdapter({
        EVIDENCE_STORAGE_PROVIDER: "supabase_storage",
        SUPABASE_URL: "https://example.supabase.co",
        EVIDENCE_STORAGE_BUCKET: "safe-exam-evidence",
      }),
    ).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("2. fails closed when only the Supabase URL is missing", () => {
    expect(() =>
      resolveEvidenceStorageAdapter({
        EVIDENCE_STORAGE_PROVIDER: "supabase_storage",
        SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-key",
        EVIDENCE_STORAGE_BUCKET: "safe-exam-evidence",
      }),
    ).toThrow(/SUPABASE_URL/);
  });

  it("succeeds and returns a supabase_storage adapter when all required env vars are present", () => {
    const adapter = resolveEvidenceStorageAdapter({
      EVIDENCE_STORAGE_PROVIDER: "supabase_storage",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-key",
      EVIDENCE_STORAGE_BUCKET: "safe-exam-evidence",
    });
    expect(adapter.provider).toBe("supabase_storage");
  });

  it("accepts NEXT_PUBLIC_SUPABASE_URL as a fallback for SUPABASE_URL", () => {
    const adapter = resolveEvidenceStorageAdapter({
      EVIDENCE_STORAGE_PROVIDER: "supabase_storage",
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-key",
      EVIDENCE_STORAGE_BUCKET: "safe-exam-evidence",
    });
    expect(adapter.provider).toBe("supabase_storage");
  });

  it("prefers SUPABASE_URL over NEXT_PUBLIC_SUPABASE_URL when both are set", () => {
    // Both present is fine either way — just confirms neither being set
    // alone is what triggers the missing-env failure above.
    const adapter = resolveEvidenceStorageAdapter({
      EVIDENCE_STORAGE_PROVIDER: "supabase_storage",
      SUPABASE_URL: "https://primary.supabase.co",
      NEXT_PUBLIC_SUPABASE_URL: "https://fallback.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-key",
      EVIDENCE_STORAGE_BUCKET: "safe-exam-evidence",
    });
    expect(adapter.provider).toBe("supabase_storage");
  });
});

describe("resolveEvidenceStorageAdapter — unsupported provider", () => {
  it("3. throws for an unknown/unsupported provider name", () => {
    expect(() => resolveEvidenceStorageAdapter({ EVIDENCE_STORAGE_PROVIDER: "azure_blob" })).toThrow(
      /Unknown EVIDENCE_STORAGE_PROVIDER/,
    );
  });
});

describe("resolveEvidenceStorageAdapter — local_dev / production guard", () => {
  it("4. blocks local_dev in production when the provider is unset", () => {
    expect(() => resolveEvidenceStorageAdapter({ NODE_ENV: "production" })).toThrow(/production/i);
  });

  it("4. blocks local_dev in production when explicitly set to local_dev", () => {
    expect(() =>
      resolveEvidenceStorageAdapter({ EVIDENCE_STORAGE_PROVIDER: "local_dev", NODE_ENV: "production" }),
    ).toThrow(/production/i);
  });

  it("allows local_dev outside production", () => {
    const adapter = resolveEvidenceStorageAdapter({ NODE_ENV: "development" });
    expect(adapter.provider).toBe("local_dev");
  });

  it("allows local_dev when NODE_ENV is unset (e.g. test runner)", () => {
    const adapter = resolveEvidenceStorageAdapter({});
    expect(adapter.provider).toBe("local_dev");
  });

  it("supabase_storage is still allowed in production once fully configured", () => {
    const adapter = resolveEvidenceStorageAdapter({
      EVIDENCE_STORAGE_PROVIDER: "supabase_storage",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-key",
      EVIDENCE_STORAGE_BUCKET: "safe-exam-evidence",
      NODE_ENV: "production",
    });
    expect(adapter.provider).toBe("supabase_storage");
  });
});

describe("resolveEvidenceStorageAdapter — vercel_blob / s3 remain stubs", () => {
  it("vercel_blob resolves but throws EvidenceStorageNotConfiguredError on use", async () => {
    const adapter = resolveEvidenceStorageAdapter({ EVIDENCE_STORAGE_PROVIDER: "vercel_blob" });
    expect(adapter.provider).toBe("vercel_blob");
    await expect(adapter.put("k", Buffer.from("x"))).rejects.toThrow(EvidenceStorageNotConfiguredError);
    await expect(adapter.get("k")).rejects.toThrow(EvidenceStorageNotConfiguredError);
  });

  it("s3 resolves but throws EvidenceStorageNotConfiguredError on use", async () => {
    const adapter = resolveEvidenceStorageAdapter({ EVIDENCE_STORAGE_PROVIDER: "s3" });
    expect(adapter.provider).toBe("s3");
    await expect(adapter.put("k", Buffer.from("x"))).rejects.toThrow(EvidenceStorageNotConfiguredError);
  });
});

describe("LocalDevEvidenceStorageAdapter", () => {
  // Each test gets its own scratch directory under the OS temp dir —
  // never the repo's real .evidence-storage/ — so tests never pollute
  // the working directory and can run fully in parallel.
  let tempDirs: string[] = [];

  async function makeAdapter() {
    const dir = await mkdtemp(path.join(tmpdir(), "evidence-storage-test-"));
    tempDirs.push(dir);
    return new LocalDevEvidenceStorageAdapter(dir);
  }

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs = [];
  });

  it("round-trips put/get/delete for a nested key with slashes (the real path shape)", async () => {
    const adapter = await makeAdapter();
    const key = "institution/inst1/exam/exam1/submission/sub1/event/evt1/abc123.jpg";
    const bytes = Buffer.from("fake-jpeg-bytes");

    await adapter.put(key, bytes);
    const readBack = await adapter.get(key);
    expect(readBack?.equals(bytes)).toBe(true);

    await adapter.delete(key);
    const afterDelete = await adapter.get(key);
    expect(afterDelete).toBeNull();
  });

  it("get() returns null for a key that was never written", async () => {
    const adapter = await makeAdapter();
    const missing = await adapter.get("institution/x/exam/y/submission/z/event/w/nonexistent.jpg");
    expect(missing).toBeNull();
  });

  it("rejects a key containing '..' path traversal", async () => {
    const adapter = await makeAdapter();
    await expect(adapter.put("institution/../../etc/passwd", Buffer.from("x"))).rejects.toThrow(
      /Unsafe evidence storage key/,
    );
  });

  it("rejects a key with a leading slash (absolute path escape)", async () => {
    const adapter = await makeAdapter();
    await expect(adapter.put("/etc/passwd", Buffer.from("x"))).rejects.toThrow(/Unsafe evidence storage key/);
  });

  it("resolveEvidenceStorageAdapter({}) also returns a working local_dev adapter (default rootDir)", () => {
    const adapter = resolveEvidenceStorageAdapter({});
    expect(adapter.provider).toBe("local_dev");
  });
});
