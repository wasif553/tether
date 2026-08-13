"use client";

/**
 * Tether Secure Exam Recovery and Resilient Autosave v1 — client hook.
 * See docs/tether-secure-resume-recovery-v1.md, "Local pending-save
 * queue" (Part 3) and "Network interruption" (Part 4).
 *
 * Thin, DOM-touching adapter: owns the IndexedDB-backed queue and the
 * retry loop, delegates every actual decision (supersession, staleness,
 * backoff timing, acknowledgement interpretation) to the pure functions
 * in src/lib/pendingSaveQueue.ts — mirrors this codebase's existing
 * useScreenShareLifecycle.ts/useAnswerDevelopmentCapture.ts convention.
 *
 * External contract for `save()` is deliberately unchanged from the
 * plain fetch it replaces: resolves `true` only once the SERVER has
 * actually acknowledged the save (never merely "queued locally") — so
 * every existing caller (the debounced full-paper autosave, and the
 * one-question-mode `flushAnswerNow`, which BLOCKS navigation on
 * `false`) keeps its exact current behaviour. What's new is entirely
 * additive: even a `false` result now means the draft is safely queued
 * in IndexedDB (survives reload/crash) and will keep retrying in the
 * background — never previously true, since the old implementation kept
 * the draft only in React state.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type PendingSaveEntry,
  type LocalSaveStatus,
  type SaveAttemptDiagnostics,
  nextRevision,
  classifyAcknowledgement,
  computeBackoffDelayMs,
  buildSaveAttemptDiagnostics,
  AUTOSAVE_RETRY_MAX_SECONDS,
  PENDING_SAVE_RETENTION_MS,
} from "@/lib/pendingSaveQueue";
import { putEntry, deleteEntry, getAllEntriesForUser, clearAllForSubmission as clearAllForSubmissionInStore, pruneExpired } from "@/lib/pendingSaveQueueStore";
import { consumeFault } from "@/lib/tetherFaultInjection";
import { logClientTetherDiagnostic } from "@/lib/tetherDiagnosticLog";

function generateRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

/** Bounded client-side ceiling on one PATCH /answers attempt (physical acceptance follow-up — the "answer could not be saved" diagnostic gap). Without this, a hung connection would never resolve `attemptSend` at all, leaving `save()` (and therefore navigation, which awaits it) stuck indefinitely with no error and no retry — worse than a clean, retryable FAILED. 15s is generous for a same-origin JSON PATCH; a genuinely healthy request resolves in well under a second. */
const SAVE_ATTEMPT_TIMEOUT_MS = 15_000;

export type ResilientAutosaveOptions = {
  userId: string | null | undefined;
  examId: string;
  submissionId: string;
  enabled: boolean;
  /**
   * Bounded, answer-content-free diagnostics for a FAILED save attempt —
   * see SaveAttemptDiagnostics's own doc comment for the exact field list
   * and the guarantee that answer text, question text, cookies, lease
   * contents, and credentials never flow through this callback. Optional
   * and best-effort: never awaited, never allowed to affect save()'s own
   * result.
   */
  onSaveDiagnostics?: (questionId: string, diagnostics: SaveAttemptDiagnostics) => void;
  /** Fired once a retry succeeds for an entry that had previously failed at least once (retryCount > 0 at the time it resolved) — lets a caller confirm "the local queue held onto it and a later attempt got it through" without guessing from status/pendingCount alone. */
  onRetrySucceeded?: (questionId: string, attemptsBeforeSuccess: number) => void;
};

export type ResilientAutosave = {
  /** Resolves true only once the server has acknowledged — see this module's own doc comment. */
  save: (questionId: string, response: string) => Promise<boolean>;
  pendingCount: number;
  status: LocalSaveStatus | "IDLE";
  /** Attempts to send every currently-queued entry right now (e.g. on `online`, or a manual retry click). */
  flushNow: () => Promise<void>;
  /** Confirmed final submission (Part 3/15) — clears every locally-queued draft for this submission. */
  clearAll: () => Promise<void>;
};

export function useResilientAutosave({ userId, examId, submissionId, enabled, onSaveDiagnostics, onRetrySucceeded }: ResilientAutosaveOptions): ResilientAutosave {
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  // Refs so a diagnostics/retry callback identity change never needs to
  // re-run the effects below or invalidate attemptSend's own useCallback
  // identity — mirrors userIdRef/enabledRef's existing convention.
  const onSaveDiagnosticsRef = useRef(onSaveDiagnostics);
  useEffect(() => {
    onSaveDiagnosticsRef.current = onSaveDiagnostics;
  }, [onSaveDiagnostics]);
  const onRetrySucceededRef = useRef(onRetrySucceeded);
  useEffect(() => {
    onRetrySucceededRef.current = onRetrySucceeded;
  }, [onRetrySucceeded]);

  const userIdRef = useRef(userId);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);

  const queueRef = useRef<Map<string, PendingSaveEntry>>(new Map());
  const revisionsRef = useRef<Record<string, number>>({});
  const [pendingCount, setPendingCount] = useState(0);
  const [status, setStatus] = useState<LocalSaveStatus | "IDLE">("IDLE");

  const syncCount = useCallback(() => setPendingCount(queueRef.current.size), []);

  const attemptSend = useCallback(async (entry: PendingSaveEntry): Promise<{ outcome: "SAVED" | "CONFLICT" | "FAILED"; diagnostics: SaveAttemptDiagnostics | null }> => {
    // Diagnostic classification (physical acceptance follow-up) — every
    // early-return path below builds a real SaveAttemptDiagnostics object
    // instead of the previous bare "FAILED", so a caller can tell "never
    // even attempted (offline)" apart from "server rejected it" apart
    // from "timed out" apart from "the fetch itself threw" — all from
    // safe operational facts only, never answer/question content.
    const startedAtMs = Date.now();
    const failed = (params: { threw: boolean; timedOut: boolean; httpStatus: number | null; serverErrorCode: string | null }) => ({
      outcome: "FAILED" as const,
      diagnostics: buildSaveAttemptDiagnostics({
        threw: params.threw,
        timedOut: params.timedOut,
        httpStatus: params.httpStatus,
        serverErrorCode: params.serverErrorCode,
        durationMs: Date.now() - startedAtMs,
        clientRevision: entry.revision,
        retryCount: entry.retryCount,
        queueRetained: true, // putEntry() in save()/the retry loop always persists BEFORE this ever runs.
      }),
    });

    if (consumeFault("CONNECTION_OFFLINE") || (typeof navigator !== "undefined" && navigator.onLine === false)) {
      return failed({ threw: true, timedOut: false, httpStatus: null, serverErrorCode: null });
    }

    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timeoutHandle = controller ? setTimeout(() => controller.abort(), SAVE_ATTEMPT_TIMEOUT_MS) : null;
    try {
      if (consumeFault("AUTOSAVE_TIMEOUT")) {
        return failed({ threw: false, timedOut: true, httpStatus: null, serverErrorCode: null });
      }
      const res = await fetch(`/api/submissions/${entry.submissionId}/answers`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          questionId: entry.questionId,
          response: entry.response,
          clientRequestId: entry.clientRequestId,
          clientRevision: entry.revision,
        }),
        signal: controller?.signal,
      });
      const httpStatus = consumeFault("AUTOSAVE_HTTP_500") ? 500 : res.status;
      if (httpStatus >= 400) {
        // Only ever the route's own short `code` field, never the free-text
        // `error` message and never the raw body — see
        // SaveAttemptDiagnostics's own doc comment.
        const errorBody: { code?: unknown } = res.ok ? {} : await res.json().catch(() => ({}));
        const serverErrorCode = typeof errorBody.code === "string" ? errorBody.code : null;
        return failed({ threw: false, timedOut: false, httpStatus, serverErrorCode });
      }
      const body: { acknowledgedRevision?: number | null } = await res.json().catch(() => ({}));
      const outcome =
        classifyAcknowledgement(entry.revision, consumeFault("STALE_AUTOSAVE_RESPONSE") ? entry.revision - 1 : (body.acknowledgedRevision ?? null)) === "CONFLICT"
          ? ("CONFLICT" as const)
          : ("SAVED" as const);
      return { outcome, diagnostics: null };
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === "AbortError";
      return failed({ threw: !timedOut, timedOut, httpStatus: null, serverErrorCode: null });
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }, []);

  const resolveOneEntry = useCallback(
    async (entry: PendingSaveEntry): Promise<boolean> => {
      const { outcome, diagnostics } = await attemptSend(entry);
      // Only act if THIS is still the current entry for the question — a
      // newer save may have superseded it while this attempt was in
      // flight (Part 2: "a stale response arriving after a newer save
      // must not regress UI state").
      const current = queueRef.current.get(entry.questionId);
      const isStillCurrent = current?.clientRequestId === entry.clientRequestId;

      if (outcome === "SAVED" || outcome === "CONFLICT") {
        // Physical acceptance follow-up — a retry that succeeds after at
        // least one prior FAILED attempt for this same entry is exactly
        // the "local queue held onto it, and a later attempt got it
        // through" signal callers need; entry.retryCount is only ever
        // bumped on a FAILED resolution below, so >0 here means this
        // exact attempt is a genuine retry, not the first try.
        if (isStillCurrent && entry.retryCount > 0) {
          onRetrySucceededRef.current?.(entry.questionId, entry.retryCount);
        }
        // Correctness pass (post-merge review) — deleteEntry is keyed
        // only by (userId, submissionId, questionId), not by revision or
        // clientRequestId (see pendingSaveQueueStore.ts). If a NEWER
        // entry has already superseded this one in `queueRef` (and, via
        // its own putEntry call, in IndexedDB) while THIS request was
        // still in flight, deleting here would wipe the newer entry's
        // persisted safety net out from under it — a crash/reload before
        // the newer entry's own resolution would then lose that draft
        // entirely, defeating the whole point of the queue. Only delete
        // when this is still the current entry for the question.
        if (isStillCurrent) {
          queueRef.current.delete(entry.questionId);
          syncCount();
          setStatus(outcome);
          await deleteEntry(entry.userId, entry.submissionId, entry.questionId);
        }
        return true;
      }

      // FAILED — surface bounded diagnostics (best-effort, never allowed
      // to affect the return value below), bump retryCount (bounded
      // backoff on the NEXT attempt), and re-persist, but only if still
      // current.
      if (isStillCurrent) {
        if (diagnostics) onSaveDiagnosticsRef.current?.(entry.questionId, diagnostics);
        const retried = { ...entry, retryCount: entry.retryCount + 1 };
        queueRef.current.set(entry.questionId, retried);
        await putEntry(retried);
        setStatus("FAILED");
      }
      return false;
    },
    [attemptSend, syncCount],
  );

  const save = useCallback(
    async (questionId: string, response: string): Promise<boolean> => {
      if (!enabledRef.current || !userIdRef.current) return false;
      const revision = nextRevision(revisionsRef.current[questionId]);
      revisionsRef.current[questionId] = revision;
      const entry: PendingSaveEntry = {
        userId: userIdRef.current,
        examId,
        submissionId,
        questionId,
        response,
        clientRequestId: generateRequestId(),
        revision,
        queuedAtMs: Date.now(),
        retryCount: 0,
      };
      // Persisted to IndexedDB BEFORE the network attempt (Part 3) — a
      // crash/reload between here and the fetch resolving never loses
      // this draft.
      queueRef.current.set(questionId, entry);
      syncCount();
      setStatus("SENDING");
      // Latency profiling (physical acceptance follow-up) — bounded,
      // dev-only timing for the local IndexedDB write specifically, so a
      // slow browser/disk (rather than the network/server) can be told
      // apart from the rest of the click-to-next-question path.
      const putStartedAtMs = performance.now();
      await putEntry(entry);
      logClientTetherDiagnostic("AUTOSAVE_INDEXEDDB_PUT_TIMING", { indexedDbPutMs: Math.round(performance.now() - putStartedAtMs) });
      const patchStartedAtMs = performance.now();
      const acknowledged = await resolveOneEntry(entry);
      logClientTetherDiagnostic("AUTOSAVE_PATCH_TIMING", { patchTotalMs: Math.round(performance.now() - patchStartedAtMs), acknowledged });
      return acknowledged;
    },
    [examId, submissionId, resolveOneEntry, syncCount],
  );

  const flushNow = useCallback(async () => {
    const entries = [...queueRef.current.values()];
    await Promise.all(entries.map((e) => resolveOneEntry(e)));
  }, [resolveOneEntry]);

  const clearAll = useCallback(async () => {
    queueRef.current.clear();
    syncCount();
    if (userIdRef.current) await clearAllForSubmissionInStore(userIdRef.current, submissionId);
  }, [submissionId, syncCount]);

  // Mount-time replay (Part 3: "queued saves survive renderer reload" /
  // Part 6: "replay pending saves idempotently") — restores whatever was
  // left queued from a previous session for THIS user+submission, primes
  // the revision counter so a fresh save() never reuses an old revision,
  // prunes anything past retention, then attempts to flush immediately.
  useEffect(() => {
    if (!enabled || !userId) return;
    let cancelled = false;
    (async () => {
      const survivors = await pruneExpired(userId, submissionId, Date.now(), PENDING_SAVE_RETENTION_MS);
      if (cancelled) return;
      for (const entry of survivors) {
        queueRef.current.set(entry.questionId, entry);
        revisionsRef.current[entry.questionId] = Math.max(revisionsRef.current[entry.questionId] ?? 0, entry.revision);
      }
      syncCount();
      if (survivors.length > 0) {
        setStatus("QUEUED");
        await flushNow();
      }
      void getAllEntriesForUser; // re-exported for tests that want direct read access
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, userId, submissionId]);

  // Background retry loop (Part 4: "retry using bounded exponential
  // backoff; avoid request storms") + `online` event (Part 4: "network
  // restoration triggers retry").
  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      for (const entry of queueRef.current.values()) {
        const dueAtMs = entry.queuedAtMs + computeBackoffDelayMs(entry.retryCount, AUTOSAVE_RETRY_MAX_SECONDS);
        if (Date.now() >= dueAtMs) void resolveOneEntry(entry);
      }
    };
    const interval = setInterval(tick, 5_000);
    const handleOnline = () => {
      consumeFault("CONNECTION_RESTORED");
      void flushNow();
    };
    if (typeof window !== "undefined") window.addEventListener("online", handleOnline);
    return () => {
      clearInterval(interval);
      if (typeof window !== "undefined") window.removeEventListener("online", handleOnline);
    };
  }, [enabled, resolveOneEntry, flushNow]);

  return { save, pendingCount, status, flushNow, clearAll };
}
