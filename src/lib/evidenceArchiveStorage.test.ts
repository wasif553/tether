/**
 * Evidence Backup/Recovery v1 — archive storage adapter unit tests. See
 * docs/tether-evidence-archive-plan.md.
 *
 * Pure unit tests only — no Prisma/DB, no real Supabase project, no
 * network. Mirrors src/lib/evidenceStorage.test.ts's own conventions.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { mockUpload, mockDownload, mockFrom } = vi.hoisted(() => {
  const mockUpload = vi.fn().mockResolvedValue({ data: { path: "x" }, error: null });
  const mockDownload = vi.fn().mockResolvedValue({ data: new Blob(["x"]), error: null });
  const mockFrom = vi.fn(() => ({ upload: mockUpload, download: mockDownload }));
  return { mockUpload, mockDownload, mockFrom };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ storage: { from: mockFrom } })),
}));

import {
  EvidenceArchiveStorageNotConfiguredError,
  LocalDevEvidenceArchiveStorageAdapter,
  resolveEvidenceArchiveStorageAdapter,
  extractSupabaseProjectRef,
} from "./evidenceArchiveStorage";

describe("resolveEvidenceArchiveStorageAdapter — supabase_storage", () => {
  it("configured separate destination succeeds", () => {
    const adapter = resolveEvidenceArchiveStorageAdapter({
      ARCHIVE_STORAGE_PROVIDER: "supabase_storage",
      ARCHIVE_SUPABASE_URL: "https://archive-project.supabase.co",
      ARCHIVE_SUPABASE_SERVICE_ROLE_KEY: "fake-archive-service-role-key",
      ARCHIVE_STORAGE_BUCKET: "safe-exam-evidence-archive",
    });
    expect(adapter.provider).toBe("supabase_storage");
  });

  it("fails closed when ALL required env vars are missing", () => {
    expect(() => resolveEvidenceArchiveStorageAdapter({ ARCHIVE_STORAGE_PROVIDER: "supabase_storage" })).toThrow(
      /ARCHIVE_SUPABASE_URL[\s\S]*ARCHIVE_SUPABASE_SERVICE_ROLE_KEY[\s\S]*ARCHIVE_STORAGE_BUCKET/,
    );
  });

  it("fails closed when only the bucket name is missing", () => {
    expect(() =>
      resolveEvidenceArchiveStorageAdapter({
        ARCHIVE_STORAGE_PROVIDER: "supabase_storage",
        ARCHIVE_SUPABASE_URL: "https://archive-project.supabase.co",
        ARCHIVE_SUPABASE_SERVICE_ROLE_KEY: "fake-archive-service-role-key",
      }),
    ).toThrow(/ARCHIVE_STORAGE_BUCKET/);
  });

  it("fails closed when only the service role key is missing", () => {
    expect(() =>
      resolveEvidenceArchiveStorageAdapter({
        ARCHIVE_STORAGE_PROVIDER: "supabase_storage",
        ARCHIVE_SUPABASE_URL: "https://archive-project.supabase.co",
        ARCHIVE_STORAGE_BUCKET: "safe-exam-evidence-archive",
      }),
    ).toThrow(/ARCHIVE_SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("fails closed when only the URL is missing", () => {
    expect(() =>
      resolveEvidenceArchiveStorageAdapter({
        ARCHIVE_STORAGE_PROVIDER: "supabase_storage",
        ARCHIVE_SUPABASE_SERVICE_ROLE_KEY: "fake-archive-service-role-key",
        ARCHIVE_STORAGE_BUCKET: "safe-exam-evidence-archive",
      }),
    ).toThrow(/ARCHIVE_SUPABASE_URL/);
  });

  it("throws for an unknown/unsupported provider name", () => {
    expect(() => resolveEvidenceArchiveStorageAdapter({ ARCHIVE_STORAGE_PROVIDER: "azure_blob" })).toThrow(/Unknown ARCHIVE_STORAGE_PROVIDER/);
  });
});

describe("resolveEvidenceArchiveStorageAdapter — local_dev / production guard", () => {
  it("blocks local_dev when NODE_ENV=production and the provider is unset", () => {
    expect(() => resolveEvidenceArchiveStorageAdapter({ NODE_ENV: "production" })).toThrow(/production/i);
  });

  it("blocks local_dev when NODE_ENV=production and explicitly set to local_dev", () => {
    expect(() => resolveEvidenceArchiveStorageAdapter({ ARCHIVE_STORAGE_PROVIDER: "local_dev", NODE_ENV: "production" })).toThrow(/production/i);
  });

  it("allows local_dev outside production", () => {
    const adapter = resolveEvidenceArchiveStorageAdapter({ NODE_ENV: "development" });
    expect(adapter.provider).toBe("local_dev");
  });

  it("allows local_dev when NODE_ENV is unset (e.g. test runner)", () => {
    const adapter = resolveEvidenceArchiveStorageAdapter({});
    expect(adapter.provider).toBe("local_dev");
  });
});

describe("SupabaseEvidenceArchiveStorageAdapter — object key only, no delete capability", () => {
  afterEach(() => {
    mockUpload.mockClear();
    mockDownload.mockClear();
    mockFrom.mockClear();
  });

  function makeArchiveAdapter() {
    return resolveEvidenceArchiveStorageAdapter({
      ARCHIVE_STORAGE_PROVIDER: "supabase_storage",
      ARCHIVE_SUPABASE_URL: "https://archive-project.supabase.co",
      ARCHIVE_SUPABASE_SERVICE_ROLE_KEY: "fake-archive-service-role-key",
      ARCHIVE_STORAGE_BUCKET: "safe-exam-evidence-archive",
    });
  }

  it("has no delete/remove/purge method at runtime — the archive path has no application capability to delete an archive object", () => {
    const adapter = makeArchiveAdapter();
    expect((adapter as unknown as Record<string, unknown>).delete).toBeUndefined();
    expect((adapter as unknown as Record<string, unknown>).remove).toBeUndefined();
    expect((adapter as unknown as Record<string, unknown>).purge).toBeUndefined();
  });

  it("put() calls storage.from(bucket).upload() with the bare object key — never bucket-prefixed", async () => {
    const adapter = makeArchiveAdapter();
    const key = "evidence/v1/asset-abc123.jpg";
    await adapter.put(key, Buffer.from("fake-jpeg-bytes"), "image/jpeg");
    expect(mockFrom).toHaveBeenCalledWith("safe-exam-evidence-archive");
    expect(mockUpload).toHaveBeenCalledWith(key, expect.anything(), expect.objectContaining({ contentType: "image/jpeg", upsert: false }));
  });

  it("get() passes the bare object key only and returns null when missing/errored", async () => {
    const adapter = makeArchiveAdapter();
    const key = "evidence/v1/asset-abc123.jpg";
    await adapter.get(key);
    expect(mockDownload).toHaveBeenCalledWith(key);

    mockDownload.mockResolvedValueOnce({ data: null, error: { message: "not found" } });
    const missing = await adapter.get(key);
    expect(missing).toBeNull();
  });

  it("upload failure surfaces a fixed, sanitized message — never the raw provider error", async () => {
    mockUpload.mockResolvedValueOnce({
      data: null,
      error: { message: "failed uploading evidence/v1/asset-abc123.jpg to https://internal.example.supabase.co?token=fake-secret-abc123" },
    });
    const adapter = makeArchiveAdapter();
    const key = "evidence/v1/asset-abc123.jpg";
    try {
      await adapter.put(key, Buffer.from("x"), "image/jpeg");
      expect.unreachable("put() should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(key);
      expect(message).not.toContain("safe-exam-evidence-archive");
      expect(message).not.toContain("internal.example.supabase.co");
      expect(message).not.toContain("token=fake-secret-abc123");
      expect(message).not.toContain("fake-archive-service-role-key");
      expect(message).toBe("Supabase archive storage upload failed.");
    }
  });
});

describe("LocalDevEvidenceArchiveStorageAdapter", () => {
  let tempDirs: string[] = [];

  async function makeAdapter() {
    const dir = await mkdtemp(path.join(tmpdir(), "evidence-archive-storage-test-"));
    tempDirs.push(dir);
    return new LocalDevEvidenceArchiveStorageAdapter(dir);
  }

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs = [];
  });

  it("has no delete method", async () => {
    const adapter = await makeAdapter();
    expect((adapter as unknown as Record<string, unknown>).delete).toBeUndefined();
  });

  it("round-trips put/get for a deterministic evidence/v1/{id}.jpg key", async () => {
    const adapter = await makeAdapter();
    const key = "evidence/v1/asset-abc123.jpg";
    const bytes = Buffer.from("fake-jpeg-bytes");
    await adapter.put(key, bytes);
    const readBack = await adapter.get(key);
    expect(readBack?.equals(bytes)).toBe(true);
  });

  it("get() returns null for a key that was never written", async () => {
    const adapter = await makeAdapter();
    const missing = await adapter.get("evidence/v1/nonexistent.jpg");
    expect(missing).toBeNull();
  });

  it("rejects a key containing '..' path traversal", async () => {
    const adapter = await makeAdapter();
    await expect(adapter.put("evidence/v1/../../etc/passwd", Buffer.from("x"))).rejects.toThrow(/Unsafe evidence archive storage key/);
  });

  it("rejects a key with a leading slash (absolute path escape)", async () => {
    const adapter = await makeAdapter();
    await expect(adapter.put("/etc/passwd", Buffer.from("x"))).rejects.toThrow(/Unsafe evidence archive storage key/);
  });
});

describe("EvidenceArchiveStorageNotConfiguredError", () => {
  it("carries a descriptive message naming the provider", () => {
    const err = new EvidenceArchiveStorageNotConfiguredError("azure_blob");
    expect(err.message).toContain("azure_blob");
  });
});

describe("extractSupabaseProjectRef", () => {
  it("extracts the project ref (subdomain) from a Supabase URL", () => {
    expect(extractSupabaseProjectRef("https://abcdefgh.supabase.co")).toBe("abcdefgh");
  });

  it("distinguishes two different project refs", () => {
    const a = extractSupabaseProjectRef("https://primary-project.supabase.co");
    const b = extractSupabaseProjectRef("https://archive-project.supabase.co");
    expect(a).not.toBe(b);
  });

  it("returns null for undefined/empty/unparseable input", () => {
    expect(extractSupabaseProjectRef(undefined)).toBeNull();
    expect(extractSupabaseProjectRef(null)).toBeNull();
    expect(extractSupabaseProjectRef("")).toBeNull();
    expect(extractSupabaseProjectRef("not a url")).toBeNull();
  });
});
