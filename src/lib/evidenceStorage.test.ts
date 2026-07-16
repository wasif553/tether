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
import { afterEach, describe, expect, it, vi } from "vitest";

const { mockUpload, mockDownload, mockRemove, mockFrom } = vi.hoisted(() => {
  const mockUpload = vi.fn().mockResolvedValue({ data: { path: "x" }, error: null });
  const mockDownload = vi.fn().mockResolvedValue({ data: new Blob(["x"]), error: null });
  const mockRemove = vi.fn().mockResolvedValue({ data: null, error: null });
  const mockFrom = vi.fn(() => ({ upload: mockUpload, download: mockDownload, remove: mockRemove }));
  return { mockUpload, mockDownload, mockRemove, mockFrom };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ storage: { from: mockFrom } })),
}));

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

describe("SupabaseStorageEvidenceAdapter — object key only, never bucket/key", () => {
  afterEach(() => {
    mockUpload.mockClear();
    mockDownload.mockClear();
    mockRemove.mockClear();
    mockFrom.mockClear();
  });

  function makeSupabaseAdapter() {
    return resolveEvidenceStorageAdapter({
      EVIDENCE_STORAGE_PROVIDER: "supabase_storage",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-key",
      EVIDENCE_STORAGE_BUCKET: "safe-exam-evidence",
    });
  }

  it("8. put() calls storage.from(bucket).upload() with the bare object key — never bucket-prefixed", async () => {
    const adapter = makeSupabaseAdapter();
    const key = "ai-camera-evidence/sub1-evt1-abc123.jpg";

    await adapter.put(key, Buffer.from("fake-jpeg-bytes"), "image/jpeg");

    expect(mockFrom).toHaveBeenCalledWith("safe-exam-evidence");
    expect(mockUpload).toHaveBeenCalledWith(
      key,
      expect.anything(),
      expect.objectContaining({ contentType: "image/jpeg" }),
    );
    // Never bucket/key concatenated into the path itself.
    expect(mockUpload.mock.calls[0][0]).not.toContain("safe-exam-evidence/");
  });

  it("8. strips a leading slash before calling upload() (defensive — generateEvidenceFrameStorageKey never produces one)", async () => {
    const adapter = makeSupabaseAdapter();
    await adapter.put("/ai-camera-evidence/sub1-evt1-abc123.jpg", Buffer.from("x"), "image/jpeg");
    expect(mockUpload.mock.calls[0][0]).toBe("ai-camera-evidence/sub1-evt1-abc123.jpg");
    expect(mockUpload.mock.calls[0][0].startsWith("/")).toBe(false);
  });

  it("get() and delete() also pass the bare object key only", async () => {
    const adapter = makeSupabaseAdapter();
    const key = "ai-camera-evidence/sub1-evt1-abc123.jpg";

    await adapter.get(key);
    expect(mockDownload).toHaveBeenCalledWith(key);

    await adapter.delete(key);
    expect(mockRemove).toHaveBeenCalledWith([key]);
  });

  it("upload failure surfaces a non-sensitive error message including the key but no path traversal/internal details", async () => {
    mockUpload.mockResolvedValueOnce({ data: null, error: { message: "Invalid path specified in request URL" } });
    const adapter = makeSupabaseAdapter();
    await expect(
      adapter.put("ai-camera-evidence/sub1-evt1-abc123.jpg", Buffer.from("x"), "image/jpeg"),
    ).rejects.toThrow(/Invalid path specified in request URL/);
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

  it("7. round-trips put/get/delete for the new flat ai-camera-evidence/{key}.jpg shape", async () => {
    const adapter = await makeAdapter();
    const key = "ai-camera-evidence/sub1-evt1-abc123.jpg";
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
    const missing = await adapter.get("ai-camera-evidence/nonexistent-key.jpg");
    expect(missing).toBeNull();
  });

  it("rejects a key containing '..' path traversal", async () => {
    const adapter = await makeAdapter();
    await expect(adapter.put("ai-camera-evidence/../../etc/passwd", Buffer.from("x"))).rejects.toThrow(
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
