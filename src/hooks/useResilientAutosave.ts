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
  nextRevision,
  classifyAcknowledgement,
  computeBackoffDelayMs,
  AUTOSAVE_RETRY_MAX_SECONDS,
  PENDING_SAVE_RETENTION_MS,
} from "@/lib/pendingSaveQueue";
import { putEntry, deleteEntry, getAllEntriesForUser, clearAllForSubmission as clearAllForSubmissionInStore, pruneExpired } from "@/lib/pendingSaveQueueStore";
import { consumeFault } from "@/lib/tetherFaultInjection";

function generateRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

export type ResilientAutosaveOptions = {
  userId: string | null | undefined;
  examId: string;
  submissionId: string;
  enabled: boolean;
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

export function useResilientAutosave({ userId, examId, submissionId, enabled }: ResilientAutosaveOptions): ResilientAutosave {
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const userIdRef = useRef(userId);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);

  const queueRef = useRef<Map<string, PendingSaveEntry>>(new Map());
  const revisionsRef = useRef<Record<string, number>>({});
  const [pendingCount, setPendingCount] = useState(0);
  const [status, setStatus] = useState<LocalSaveStatus | "IDLE">("IDLE");

  const syncCount = useCallback(() => setPendingCount(queueRef.current.size), []);

  const attemptSend = useCallback(async (entry: PendingSaveEntry): Promise<"SAVED" | "CONFLICT" | "FAILED"> => {
    if (consumeFault("CONNECTION_OFFLINE")) return "FAILED";
    if (typeof navigator !== "undefined" && navigator.onLine === false) return "FAILED";
    try {
      if (consumeFault("AUTOSAVE_TIMEOUT")) throw new Error("simulated autosave timeout (fault injection)");
      const res = await fetch(`/api/submissions/${entry.submissionId}/answers`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          questionId: entry.questionId,
          response: entry.response,
          clientRequestId: entry.clientRequestId,
          clientRevision: entry.revision,
        }),
      });
      if (consumeFault("AUTOSAVE_HTTP_500") || !res.ok) return "FAILED";
      const body: { acknowledgedRevision?: number | null } = await res.json().catch(() => ({}));
      return classifyAcknowledgement(entry.revision, consumeFault("STALE_AUTOSAVE_RESPONSE") ? entry.revision - 1 : (body.acknowledgedRevision ?? null)) === "CONFLICT"
        ? "CONFLICT"
        : "SAVED";
    } catch {
      return "FAILED";
    }
  }, []);

  const resolveOneEntry = useCallback(
    async (entry: PendingSaveEntry): Promise<boolean> => {
      const outcome = await attemptSend(entry);
      // Only act if THIS is still the current entry for the question — a
      // newer save may have superseded it while this attempt was in
      // flight (Part 2: "a stale response arriving after a newer save
      // must not regress UI state").
      const current = queueRef.current.get(entry.questionId);
      const isStillCurrent = current?.clientRequestId === entry.clientRequestId;

      if (outcome === "SAVED" || outcome === "CONFLICT") {
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

      // FAILED — bump retryCount (bounded backoff on the NEXT attempt)
      // and re-persist, but only if still current.
      if (isStillCurrent) {
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
      await putEntry(entry);
      return resolveOneEntry(entry);
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
