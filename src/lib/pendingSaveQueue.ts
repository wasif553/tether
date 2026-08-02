/**
 * Tether Secure Exam Recovery and Resilient Autosave v1 — client-side
 * pending-save queue: pure decision logic only. See
 * docs/tether-secure-resume-recovery-v1.md, "Local pending-save queue"
 * (Part 3) and "Autosave idempotency and revision control" (Part 2).
 *
 * No IndexedDB, no fetch, no React — safe to import from plain vitest.
 * The DOM-touching adapter lives in src/lib/pendingSaveQueueStore.ts
 * (IndexedDB) and src/hooks/useResilientAutosave.ts (React), mirroring
 * this codebase's existing "logic in pure functions, thin DOM-touching
 * adapter" convention (see useScreenShareLifecycle.ts,
 * useAnswerDevelopmentCapture.ts).
 */

// ---------------------------------------------------------------------------
// Client-side default configuration. Mirrors the DEFAULT values of the
// equivalent SERVER env-var resolvers in src/lib/tetherRecoveryConfig.ts
// (TETHER_AUTOSAVE_RETRY_MAX_SECONDS, TETHER_PENDING_SAVE_RETENTION_HOURS)
// for consistency — but these are plain client-bundle constants, not
// literally read from process.env (a browser bundle cannot read
// server-only environment variables, and these values are not secrets
// requiring a NEXT_PUBLIC_ passthrough either — see that file's own doc
// comment for the full rationale/bounds).
// ---------------------------------------------------------------------------
export const AUTOSAVE_RETRY_MAX_SECONDS = 60;
export const PENDING_SAVE_RETENTION_HOURS = 72;
export const PENDING_SAVE_RETENTION_MS = PENDING_SAVE_RETENTION_HOURS * 60 * 60 * 1000;

/** Hard ceiling on how many entries the local queue keeps at once (Part 3: "storage growth is bounded") — one entry per question already keeps this small in practice (collapsed by supersession below), this is a defensive backstop against a pathological exam with an enormous number of questions. */
export const MAX_QUEUE_ENTRIES = 500;

export type PendingSaveEntry = {
  /** Scopes the queue to the authenticated user — see scopedKey below. */
  userId: string;
  examId: string;
  submissionId: string;
  questionId: string;
  response: string;
  clientRequestId: string;
  /** Monotonically increasing per (submissionId, questionId) — never reused, never decreases. */
  revision: number;
  queuedAtMs: number;
  retryCount: number;
};

/** One entry per (user, submission, question) — a newer save for the same question always supersedes rather than queuing alongside (Part 3: "duplicate queued saves for the same revision are collapsed; newer revisions supersede older unsent revisions safely"). */
export function scopedKey(userId: string, submissionId: string, questionId: string): string {
  return `${userId}::${submissionId}::${questionId}`;
}

export function nextRevision(currentHighest: number | null | undefined): number {
  return (currentHighest ?? 0) + 1;
}

/** Whether `incomingRevision` should replace `existing` in the queue — strictly greater only, so a stale/duplicate/out-of-order call can never regress a newer queued draft. Equal revisions are treated as the same logical save (not superseded, not duplicated). */
export function shouldSupersede(existing: { revision: number } | undefined, incomingRevision: number): boolean {
  if (!existing) return true;
  return incomingRevision > existing.revision;
}

export function isEntryExpired(entry: { queuedAtMs: number }, nowMs: number, retentionMs: number = PENDING_SAVE_RETENTION_MS): boolean {
  return nowMs - entry.queuedAtMs > retentionMs;
}

/** Bounded exponential backoff, base 1s, capped at maxDelaySeconds (Part 4: "retry using bounded exponential backoff; avoid request storms"). */
export function computeBackoffDelayMs(retryCount: number, maxDelaySeconds: number = AUTOSAVE_RETRY_MAX_SECONDS): number {
  const BASE_DELAY_MS = 1000;
  const cappedExponent = Math.min(Math.max(retryCount, 0), 10);
  return Math.min(BASE_DELAY_MS * 2 ** cappedExponent, maxDelaySeconds * 1000);
}

export type LocalSaveStatus = "SAVED" | "QUEUED" | "SENDING" | "FAILED" | "CONFLICT";

/**
 * How to interpret a successful server acknowledgement (Part 2: "a stale
 * response arriving after a newer save must not regress UI state"). If
 * the server's acknowledged revision is strictly greater than what THIS
 * request sent, a newer save (from another tab, another device, or a
 * faster-arriving later request) already won — this local entry's own
 * write was accepted as a no-op, never applied, and the UI should show
 * CONFLICT rather than claiming its own (superseded) draft is what's now
 * saved. Equal means this exact request is what's now authoritative:
 * SAVED.
 */
export function classifyAcknowledgement(sentRevision: number, acknowledgedRevision: number | null): LocalSaveStatus {
  if (acknowledgedRevision == null) return "SAVED";
  if (acknowledgedRevision > sentRevision) return "CONFLICT";
  return "SAVED";
}

/** Aggregate counts for the recovery-status UI (Part 3/4/16). */
export function summarizeQueue(entries: ReadonlyArray<{ retryCount: number }>): { pendingCount: number; hasFailedRetries: boolean } {
  return {
    pendingCount: entries.length,
    hasFailedRetries: entries.some((e) => e.retryCount > 0),
  };
}
