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

// ---------------------------------------------------------------------------
// Physical acceptance follow-up — save/next latency diagnosis. Pure
// extraction of the "which of the three navigation strategies applies"
// decision inline in navigateQuestion() (src/app/student/exams/[id]/
// page.tsx) — a testability-only extraction, not a behavior change: the
// call site still computes the exact same three inputs from
// resilientAutosave.isAcknowledged/getInFlightSave and calls this instead
// of repeating the boolean expression inline.
// ---------------------------------------------------------------------------

export type NavigationSaveStrategy =
  /** Nothing to save (question never touched, or already exactly what the server last acknowledged) — a single navigation-only request. */
  | "SKIP_SAVE"
  /** An identical-content save is already in flight (e.g. the debounced autosave just fired) — await/reuse it, then navigation-only. Never a duplicate save. */
  | "REUSE_IN_FLIGHT_SAVE"
  /** A genuinely dirty, not-yet-acknowledged answer — ONE combined save-and-navigate request. */
  | "COMBINED_SAVE_AND_NAVIGATE";

/**
 * Mirrors navigateQuestion()'s own three-way split exactly: `response`
 * undefined means the question was never touched this session (SKIP_SAVE
 * — flushAnswerNow/save() resolves instantly with nothing queued);
 * `isAcknowledged` true means the current content already matches the
 * last genuine server acknowledgement (SKIP_SAVE); `hasInFlightSave` true
 * means an identical-content save is already outstanding
 * (REUSE_IN_FLIGHT_SAVE — awaited, never duplicated); otherwise the
 * answer is genuinely dirty (COMBINED_SAVE_AND_NAVIGATE — the single
 * round-trip PR #25 path). SKIP_SAVE and REUSE_IN_FLIGHT_SAVE both end up
 * calling the same flushAnswerNow -> navigation-only path at the call
 * site — they are kept as distinct outcomes here (rather than merged into
 * one "not dirty" boolean) purely so a test/log can tell the two apart,
 * exactly as this diagnosis task requires distinguishing them.
 */
export function classifyNavigationSaveStrategy(params: {
  responseIsDefined: boolean;
  isAcknowledged: boolean;
  hasInFlightSave: boolean;
}): NavigationSaveStrategy {
  if (!params.responseIsDefined || params.isAcknowledged) return "SKIP_SAVE";
  if (params.hasInFlightSave) return "REUSE_IN_FLIGHT_SAVE";
  return "COMBINED_SAVE_AND_NAVIGATE";
}

/** Aggregate counts for the recovery-status UI (Part 3/4/16). */
export function summarizeQueue(entries: ReadonlyArray<{ retryCount: number }>): { pendingCount: number; hasFailedRetries: boolean } {
  return {
    pendingCount: entries.length,
    hasFailedRetries: entries.some((e) => e.retryCount > 0),
  };
}

// ---------------------------------------------------------------------------
// Bounded save-failure diagnostics (physical acceptance follow-up —
// "answer could not be saved" symptom). Before this, attemptSend in
// useResilientAutosave.ts collapsed every non-2xx response, timeout, and
// thrown network exception into the SAME generic FAILED outcome, with
// nothing retained to tell them apart — making the physical symptom
// impossible to diagnose after the fact. These are pure, DOM-free, and
// operate ONLY on already-safe operational facts about the request
// (status code, timing, a short server-provided error code) — NEVER the
// answer text, question text, cookies, lease contents, or credentials,
// none of which are ever passed into this module at all.
// ---------------------------------------------------------------------------

export type SaveFailureCategory = "TIMEOUT" | "NETWORK_ERROR" | "HTTP_CLIENT_ERROR" | "HTTP_SERVER_ERROR" | "UNKNOWN";

/** Bounded, answer-content-free record of why one save attempt failed. Every field is either a small number, a boolean, or a short enum-like string — safe to log or send as integrity-event metadata as-is. */
export type SaveAttemptDiagnostics = {
  category: SaveFailureCategory;
  httpStatus: number | null;
  /** The route's own short `code` field (e.g. TETHER_CONTENT_ACCESS_REQUIRED, EXAM_NOT_ACTIVATED) when the response body included one — never the free-text `error` message, and never the raw body. */
  serverErrorCode: string | null;
  durationMs: number;
  threw: boolean;
  timedOut: boolean;
  clientRevision: number;
  retryCount: number;
  /** Always true in practice — the entry is persisted to IndexedDB before every network attempt (Part 3) — retained here as an explicit, independently-checkable fact rather than an assumption baked silently into the caller. */
  queueRetained: boolean;
};

/** Pure classification — never re-derives anything from a response body beyond the plain facts the caller already extracted (status/threw/timedOut). */
export function classifySaveFailureCategory(params: { threw: boolean; timedOut: boolean; httpStatus: number | null }): SaveFailureCategory {
  if (params.timedOut) return "TIMEOUT";
  if (params.threw) return "NETWORK_ERROR";
  if (params.httpStatus == null) return "UNKNOWN";
  if (params.httpStatus >= 500) return "HTTP_SERVER_ERROR";
  if (params.httpStatus >= 400) return "HTTP_CLIENT_ERROR";
  return "UNKNOWN";
}

export function buildSaveAttemptDiagnostics(params: {
  threw: boolean;
  timedOut: boolean;
  httpStatus: number | null;
  serverErrorCode: string | null;
  durationMs: number;
  clientRevision: number;
  retryCount: number;
  queueRetained: boolean;
}): SaveAttemptDiagnostics {
  return {
    category: classifySaveFailureCategory({ threw: params.threw, timedOut: params.timedOut, httpStatus: params.httpStatus }),
    httpStatus: params.httpStatus,
    serverErrorCode: params.serverErrorCode,
    durationMs: params.durationMs,
    threw: params.threw,
    timedOut: params.timedOut,
    clientRevision: params.clientRevision,
    retryCount: params.retryCount,
    queueRetained: params.queueRetained,
  };
}
