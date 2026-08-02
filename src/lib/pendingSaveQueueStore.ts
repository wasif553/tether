/**
 * Tether Secure Exam Recovery and Resilient Autosave v1 — the ONLY file
 * in this feature that touches IndexedDB directly. See
 * docs/tether-secure-resume-recovery-v1.md, "Local pending-save queue"
 * (Part 3). Client-only (browser IndexedDB) — every export is a safe
 * no-op (never throws) when `indexedDB` is unavailable (SSR, an
 * unsupported/locked-down browser, or a private-browsing mode that
 * disables it), matching this codebase's existing "never fail hard on a
 * missing browser capability" convention (see e.g. displayCount
 * feature-detection in the tether-launch page).
 *
 * Stores ONLY what Part 3 allows: user id, exam id, submission id,
 * question id, the answer draft text itself, clientRequestId, revision,
 * queued timestamp, retry count. NEVER passwords, auth tokens, secure-
 * client manifests, attestation challenges, installation keys, DPAPI
 * material, signing keys, camera/microphone data, or a full
 * application-state dump — see this module's own field list below, which
 * is exhaustive.
 *
 * This is plain browser IndexedDB local storage, not encrypted at rest —
 * per Part 3's own guidance ("if local encryption cannot be implemented
 * safely, state clearly that IndexedDB is local application storage and
 * minimise retention rather than inventing weak encryption"), no
 * encryption is attempted here. Retention is bounded
 * (PENDING_SAVE_RETENTION_MS, see pendingSaveQueue.ts) and every entry is
 * scoped to one authenticated user id, so a DIFFERENT OS user account on
 * a shared/lab computer never sees this browser profile's IndexedDB at
 * all (standard browser-profile isolation) — but a second person signed
 * into a DIFFERENT application account within the SAME browser profile
 * could, in principle, inspect this database via devtools; this is the
 * same trust boundary every other client-side draft/cache in a web app
 * accepts, not a new weakness this feature introduces.
 */
import { type PendingSaveEntry, scopedKey, isEntryExpired } from "@/lib/pendingSaveQueue";

const DB_NAME = "ses-pending-save-queue";
const DB_VERSION = 1;
const STORE_NAME = "pendingSaves";

function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
        store.createIndex("byUserSubmission", ["userId", "submissionId"], { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

type StoredRecord = PendingSaveEntry & { key: string };

/** Writes (or replaces) one entry — always called BEFORE the network attempt, so a crash/reload between "queued" and "server acknowledged" never loses the draft (Part 3: "the client must never claim queued local drafts are server-saved" — this function only ever persists locally; nothing here talks to the server). */
export async function putEntry(entry: PendingSaveEntry): Promise<void> {
  if (!isIndexedDbAvailable()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put({ ...entry, key: scopedKey(entry.userId, entry.submissionId, entry.questionId) } satisfies StoredRecord);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Best-effort — a local persistence failure must never block the
    // in-flight network save attempt the caller is also making.
  }
}

/** Removed ONLY after confirmed server success, or confirmed final submission, or retention expiry (Part 3) — never merely because a send was attempted. */
export async function deleteEntry(userId: string, submissionId: string, questionId: string): Promise<void> {
  if (!isIndexedDbAvailable()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(scopedKey(userId, submissionId, questionId));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* best-effort */
  }
}

/** Scoped strictly to the authenticated user id AND this submission — another user on the same computer (a different account signed in later, in the same browser profile) never sees or replays another student's queued drafts (Part 3). */
export async function getAllEntriesForUser(userId: string, submissionId: string): Promise<PendingSaveEntry[]> {
  if (!isIndexedDbAvailable()) return [];
  try {
    const db = await openDb();
    const results = await new Promise<StoredRecord[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const index = tx.objectStore(STORE_NAME).index("byUserSubmission");
      const req = index.getAll(IDBKeyRange.only([userId, submissionId]));
      req.onsuccess = () => resolve(req.result as StoredRecord[]);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return results.map(
      (record): PendingSaveEntry => ({
        userId: record.userId,
        examId: record.examId,
        submissionId: record.submissionId,
        questionId: record.questionId,
        response: record.response,
        clientRequestId: record.clientRequestId,
        revision: record.revision,
        queuedAtMs: record.queuedAtMs,
        retryCount: record.retryCount,
      }),
    );
  } catch {
    return [];
  }
}

/** Confirmed final submission clears all drafts for that submission (Part 3/15) — never left behind once a submission can no longer accept edits. */
export async function clearAllForSubmission(userId: string, submissionId: string): Promise<void> {
  if (!isIndexedDbAvailable()) return;
  try {
    const entries = await getAllEntriesForUser(userId, submissionId);
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      for (const entry of entries) store.delete(scopedKey(entry.userId, entry.submissionId, entry.questionId));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* best-effort */
  }
}

/** Stale queue entries expire (Part 3/15) — removes any entry older than retentionMs for this user+submission, returning the surviving entries. */
export async function pruneExpired(userId: string, submissionId: string, nowMs: number, retentionMs: number): Promise<PendingSaveEntry[]> {
  const entries = await getAllEntriesForUser(userId, submissionId);
  const expired = entries.filter((e) => isEntryExpired(e, nowMs, retentionMs));
  await Promise.all(expired.map((e) => deleteEntry(e.userId, e.submissionId, e.questionId)));
  return entries.filter((e) => !isEntryExpired(e, nowMs, retentionMs));
}
