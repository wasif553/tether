import { describe, expect, it } from "vitest";
import { putEntry, deleteEntry, getAllEntriesForUser, clearAllForSubmission, pruneExpired } from "./pendingSaveQueueStore";

/**
 * This project's default vitest environment is plain Node (see
 * vitest.config.ts — no `environment: "jsdom"`), so `indexedDB` is
 * genuinely undefined here, exactly like a server-side render. These
 * tests exercise exactly that: every exported function must be a SAFE
 * NO-OP (never throw) when IndexedDB is unavailable — see
 * pendingSaveQueueStore.ts's own top-level doc comment. Real persistence
 * behaviour requires an actual browser (or a DOM/IndexedDB test
 * environment this project does not currently install) and is instead
 * exercised indirectly through the pure supersession/expiry/backoff
 * logic in pendingSaveQueue.test.ts, which every store function
 * delegates to.
 */
describe("pendingSaveQueueStore — safe no-op outside a browser", () => {
  const entry = {
    userId: "u1",
    examId: "e1",
    submissionId: "s1",
    questionId: "q1",
    response: "answer",
    clientRequestId: "req-1",
    revision: 1,
    queuedAtMs: Date.now(),
    retryCount: 0,
  };

  it("putEntry never throws when indexedDB is unavailable", async () => {
    await expect(putEntry(entry)).resolves.toBeUndefined();
  });

  it("deleteEntry never throws when indexedDB is unavailable", async () => {
    await expect(deleteEntry("u1", "s1", "q1")).resolves.toBeUndefined();
  });

  it("getAllEntriesForUser returns an empty array when indexedDB is unavailable — never throws, never returns undefined", async () => {
    await expect(getAllEntriesForUser("u1", "s1")).resolves.toEqual([]);
  });

  it("clearAllForSubmission never throws when indexedDB is unavailable", async () => {
    await expect(clearAllForSubmission("u1", "s1")).resolves.toBeUndefined();
  });

  it("pruneExpired returns an empty array when indexedDB is unavailable", async () => {
    await expect(pruneExpired("u1", "s1", Date.now(), 1000)).resolves.toEqual([]);
  });
});
