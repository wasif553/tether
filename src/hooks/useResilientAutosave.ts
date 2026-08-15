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

/** Bounded client-side ceiling on one save attempt (physical acceptance follow-up — the "answer could not be saved" diagnostic gap). Without this, a hung connection would never resolve, leaving `save()`/`saveAndNavigate()` (and therefore navigation, which awaits them) stuck indefinitely with no error and no retry — worse than a clean, retryable FAILED. 15s is generous for a same-origin JSON request; a genuinely healthy one resolves in well under a second. */
const SAVE_ATTEMPT_TIMEOUT_MS = 15_000;

type SendJsonOutcome<T> =
  | { ok: true; body: T; fetchMs: number; jsonParseMs: number; serverTiming: string | null }
  | { ok: false; diagnostics: SaveAttemptDiagnostics };

/**
 * Question-navigation performance follow-up (single-round-trip
 * save+navigate) — the low-level "POST/PATCH JSON with a bounded timeout,
 * classify however it fails" logic shared by attemptSend (PATCH
 * /answers) and attemptSaveAndNavigate (POST /save-and-navigate) below,
 * so the two never drift into two independently-maintained copies of the
 * SAME offline/timeout/thrown-exception/HTTP-failure classification.
 * Module-level (not a useCallback) — pure I/O with no dependency on any
 * component/hook state.
 */
async function sendJsonWithTimeout<T>(params: {
  url: string;
  method: "PATCH" | "POST";
  body: unknown;
  clientRevision: number;
  retryCount: number;
}): Promise<SendJsonOutcome<T>> {
  const startedAtMs = Date.now();
  const failed = (p: { threw: boolean; timedOut: boolean; httpStatus: number | null; serverErrorCode: string | null }): SendJsonOutcome<T> => ({
    ok: false,
    diagnostics: buildSaveAttemptDiagnostics({
      threw: p.threw,
      timedOut: p.timedOut,
      httpStatus: p.httpStatus,
      serverErrorCode: p.serverErrorCode,
      durationMs: Date.now() - startedAtMs,
      clientRevision: params.clientRevision,
      retryCount: params.retryCount,
      queueRetained: true, // putEntry() always persists BEFORE this ever runs — see every caller below.
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
    // Physical acceptance follow-up — save/next latency diagnosis.
    // fetchMs is click-to-response-headers (network + full server
    // processing); jsonParseMs is the separate body-parse cost, so the
    // two are never conflated into one opaque "request" number.
    // serverTiming is the RAW Server-Timing header value this same-origin
    // response carries (only ever present when the server opted in via
    // TETHER_TIMING_HEADERS_ENABLED — see serverTiming.ts) — bounded to
    // short stage-name;dur=N.N pairs by that module, never parsed/
    // interpreted here, just passed through for the caller to log.
    const fetchStartedAtMs = performance.now();
    const res = await fetch(params.url, {
      method: params.method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params.body),
      signal: controller?.signal,
    });
    const fetchMs = performance.now() - fetchStartedAtMs;
    const serverTiming = res.headers.get("Server-Timing");
    const httpStatus = consumeFault("AUTOSAVE_HTTP_500") ? 500 : res.status;
    if (httpStatus >= 400) {
      // Only ever the route's own short `code` field, never the free-text
      // `error` message and never the raw body — see
      // SaveAttemptDiagnostics's own doc comment.
      const errorBody: { code?: unknown } = res.ok ? {} : await res.json().catch(() => ({}));
      const serverErrorCode = typeof errorBody.code === "string" ? errorBody.code : null;
      return failed({ threw: false, timedOut: false, httpStatus, serverErrorCode });
    }
    const jsonParseStartedAtMs = performance.now();
    const body = (await res.json().catch(() => ({}))) as T;
    const jsonParseMs = performance.now() - jsonParseStartedAtMs;
    return { ok: true, body, fetchMs, jsonParseMs, serverTiming };
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === "AbortError";
    return failed({ threw: !timedOut, timedOut, httpStatus: null, serverErrorCode: null });
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * PR #25 review fix — the exact same SAVED-vs-CONFLICT classification
 * (and STALE_AUTOSAVE_RESPONSE fault-injection hook, for test
 * determinism) that attemptSend already used, now shared with
 * saveAndNavigate below so the two can never drift into two different
 * ideas of what counts as "acknowledged". A 2xx response is not
 * automatically a win for the text THIS caller sent — the server may
 * have safely no-opped a stale/duplicate write in favour of an already-
 * newer stored answer (see classifyAcknowledgement's own doc comment).
 */
function classifySaveOutcome(sentRevision: number, acknowledgedRevision: number | null | undefined): "SAVED" | "CONFLICT" {
  // classifyAcknowledgement's declared return type is the broader
  // LocalSaveStatus (it's reused for other UI-status purposes elsewhere)
  // even though it only ever actually returns "SAVED" or "CONFLICT" —
  // narrow explicitly rather than widening this function's own contract.
  return classifyAcknowledgement(sentRevision, consumeFault("STALE_AUTOSAVE_RESPONSE") ? sentRevision - 1 : (acknowledgedRevision ?? null)) === "CONFLICT"
    ? "CONFLICT"
    : "SAVED";
}

/**
 * PR #25 review fix — exported (unlike the rest of this hook's internals)
 * specifically so this decision is directly, behaviorally unit-testable
 * without needing a DOM/React-rendering harness this repo doesn't have
 * (see useResilientAutosave.test.ts's own doc comment): a 2xx response
 * from POST /save-and-navigate does not always mean the text THIS call
 * submitted is now authoritative — the server may have safely no-opped a
 * stale/duplicate write in favour of an already-newer stored answer (see
 * tetherRecovery.routes.test.ts's save-and-navigate stale-revision test).
 * On SAVED, the submitted text won and is authoritative. On CONFLICT, the
 * server's OWN returned answer.response is authoritative — the rejected
 * local text must never be cached as "acknowledged" or it would make
 * isAcknowledged() wrongly true for content the server never actually
 * accepted.
 */
export function resolveSaveAndNavigateAcknowledgement(params: {
  sentRevision: number;
  submittedResponse: string;
  serverAcknowledgedRevision: number | null | undefined;
  serverResponse: string;
}): { acknowledgement: "SAVED" | "CONFLICT"; authoritativeResponse: string } {
  const acknowledgement = classifySaveOutcome(params.sentRevision, params.serverAcknowledgedRevision);
  return {
    acknowledgement,
    authoritativeResponse: acknowledgement === "SAVED" ? params.submittedResponse : params.serverResponse,
  };
}

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

/**
 * The minimal shape this hook itself reads from the save-and-navigate
 * response (to seed the next question's own acknowledged-response
 * cache) — deliberately NOT importing the richer OneQuestionPayload type
 * from src/lib/submissionQuestionPayload.ts (a server-only module): this
 * hook stays decoupled from that server type's exact shape, and the
 * caller (which already declares its own client-side OneQuestionPayload
 * type for the other navigation routes' JSON responses) is responsible
 * for treating `payload` as that same shape.
 */
type NavigationPayloadShape = { question: { id: string }; existingResponse: string | null };

export type SaveAndNavigateResult<TPayload extends NavigationPayloadShape = NavigationPayloadShape> =
  | {
      ok: true;
      payload: TPayload;
      /**
       * PR #25 review fix — POST /save-and-navigate can legitimately
       * return 200 for a safe stale-revision no-op (a newer answer
       * already won server-side); "acknowledged: SAVED" means the text
       * the caller just sent is now genuinely authoritative, while
       * "CONFLICT" means it was NOT — the caller must reconcile against
       * `authoritativeResponse` instead of trusting its own submitted
       * text, exactly like resolveOneEntry already does for the plain
       * PATCH path.
       */
      acknowledgement: "SAVED" | "CONFLICT";
      /** The question the save was FOR (not the newly-navigated-to one) — lets the caller correct its own local draft state on CONFLICT. */
      questionId: string;
      /** On SAVED, the same text the caller sent. On CONFLICT, the server's own authoritative stored answer.response for that question — never the rejected local text. */
      authoritativeResponse: string;
      /**
       * Physical acceptance follow-up — save/next latency diagnosis. The
       * raw Server-Timing header value from this same response (see
       * sendJsonWithTimeout's own doc comment) — null whenever the server
       * didn't opt in (TETHER_TIMING_HEADERS_ENABLED unset, the default).
       * Passed through unparsed/unmodified so the caller can log it
       * alongside its own click-to-visible measurement for one complete,
       * bounded latency picture per navigation.
       */
      serverTiming: string | null;
    }
  | { ok: false };

export type ResilientAutosave<TPayload extends NavigationPayloadShape = NavigationPayloadShape> = {
  /** Resolves true only once the server has acknowledged — see this module's own doc comment. Now also short-circuits to `true` with NO network call at all when `response` is already the last genuinely acknowledged content (see isAcknowledged below) — see that field's own doc comment. */
  save: (questionId: string, response: string) => Promise<boolean>;
  /**
   * Question-navigation performance follow-up — single-round-trip
   * save+navigate for a DIRTY (not yet acknowledged) current answer.
   * POSTs to /save-and-navigate instead of PATCH /answers followed by a
   * separate question-progress request. Persists to IndexedDB BEFORE the
   * network attempt exactly like save(), and the local pending entry is
   * only removed once the server has actually acknowledged this exact
   * revision — a failure/timeout leaves it queued for the existing
   * background retry loop, exactly like a plain save() failure.
   */
  saveAndNavigate: (questionId: string, response: string, targetIndex: number) => Promise<SaveAndNavigateResult<TPayload>>;
  /**
   * True only when `response` is EXACTLY the last genuinely
   * server-acknowledged content for `questionId` AND nothing is
   * currently queued/in-flight for it — never a guess from React state
   * alone (Part 2: "must correspond to a genuine server
   * acknowledgement"). A caller (e.g. Next/Previous) uses this to skip
   * an entirely redundant save when nothing has changed.
   */
  isAcknowledged: (questionId: string, response: string) => boolean;
  /**
   * Seeds the "server-acknowledged" cache from a value the caller
   * independently knows came from the server — e.g. a freshly loaded
   * question payload's own `existingResponse` — never from unconfirmed
   * local edits. Lets isAcknowledged recognise a question the student
   * never touched THIS session but which already had a stored answer
   * from a previous one.
   */
  noteAcknowledged: (questionId: string, response: string) => void;
  /**
   * The in-flight save promise for `questionId`, if one is currently
   * outstanding for EXACTLY this response text (e.g. the debounced
   * autosave already fired and is awaiting its server response) — lets a
   * caller await/reuse it instead of starting a duplicate PATCH. Returns
   * null when nothing matches.
   */
  getInFlightSave: (questionId: string, response: string) => Promise<boolean> | null;
  pendingCount: number;
  status: LocalSaveStatus | "IDLE";
  /** Attempts to send every currently-queued entry right now (e.g. on `online`, or a manual retry click). */
  flushNow: () => Promise<void>;
  /** Confirmed final submission (Part 3/15) — clears every locally-queued draft for this submission. */
  clearAll: () => Promise<void>;
};

export function useResilientAutosave<TPayload extends NavigationPayloadShape = NavigationPayloadShape>({
  userId,
  examId,
  submissionId,
  enabled,
  onSaveDiagnostics,
  onRetrySucceeded,
}: ResilientAutosaveOptions): ResilientAutosave<TPayload> {
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
  // Question-navigation performance follow-up (Part 2 — skip a redundant
  // save when the current content is already what the server last
  // genuinely acknowledged).
  const acknowledgedResponseRef = useRef<Record<string, string>>({});
  // Question-navigation performance follow-up (Part 2B — reuse rather
  // than duplicate an in-flight save for the exact same content).
  const inFlightRef = useRef<Record<string, { response: string; promise: Promise<boolean> }>>({});
  const [pendingCount, setPendingCount] = useState(0);
  const [status, setStatus] = useState<LocalSaveStatus | "IDLE">("IDLE");

  const syncCount = useCallback(() => setPendingCount(queueRef.current.size), []);

  const noteAcknowledged = useCallback((questionId: string, response: string) => {
    acknowledgedResponseRef.current[questionId] = response;
  }, []);

  const isAcknowledged = useCallback(
    (questionId: string, response: string) => !queueRef.current.has(questionId) && acknowledgedResponseRef.current[questionId] === response,
    [],
  );

  const getInFlightSave = useCallback((questionId: string, response: string): Promise<boolean> | null => {
    const existing = inFlightRef.current[questionId];
    return existing && existing.response === response ? existing.promise : null;
  }, []);

  const attemptSend = useCallback(async (entry: PendingSaveEntry): Promise<{ outcome: "SAVED" | "CONFLICT" | "FAILED"; diagnostics: SaveAttemptDiagnostics | null }> => {
    const result = await sendJsonWithTimeout<{ acknowledgedRevision?: number | null }>({
      url: `/api/submissions/${entry.submissionId}/answers`,
      method: "PATCH",
      body: { questionId: entry.questionId, response: entry.response, clientRequestId: entry.clientRequestId, clientRevision: entry.revision },
      clientRevision: entry.revision,
      retryCount: entry.retryCount,
    });
    if (!result.ok) return { outcome: "FAILED", diagnostics: result.diagnostics };
    const outcome = classifySaveOutcome(entry.revision, result.body.acknowledgedRevision);
    return { outcome, diagnostics: null };
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
          // Part 2 — only SAVED means the content WE sent is what's now
          // authoritative; CONFLICT means a newer save (another
          // tab/device) already won, so we don't actually know its text
          // and must never cache it as "acknowledged".
          if (outcome === "SAVED") acknowledgedResponseRef.current[entry.questionId] = entry.response;
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

      // Part 2 — already acknowledged and unchanged: no PATCH, no
      // IndexedDB write, nothing — the caller can proceed straight to
      // whatever comes after a successful save (e.g. navigation).
      if (isAcknowledged(questionId, response)) return true;

      // Part 2B — an identical-content save is already in flight (e.g.
      // the debounced autosave fired moments before this call): await
      // and reuse that SAME promise instead of issuing a duplicate PATCH.
      const inFlight = inFlightRef.current[questionId];
      if (inFlight && inFlight.response === response) return inFlight.promise;

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

      // PR #25 review fix (narrow race) — the in-flight promise now
      // covers IndexedDB persistence AND the network send TOGETHER, and
      // is registered in inFlightRef synchronously (an async IIFE runs
      // up to its first `await` before ever yielding control back here,
      // so the registration below happens with no gap). Without this, a
      // second save() call for the SAME question+content arriving during
      // the (usually few-millisecond) window between starting and
      // finishing putEntry would see nothing registered yet and start a
      // genuinely duplicate request. Ordering is unchanged: persistence
      // still always completes before the network attempt — only the
      // BOOKKEEPING moved earlier, not the sequence itself.
      const attempt = (async (): Promise<boolean> => {
        const putStartedAtMs = performance.now();
        await putEntry(entry);
        logClientTetherDiagnostic("AUTOSAVE_INDEXEDDB_PUT_TIMING", { indexedDbPutMs: Math.round(performance.now() - putStartedAtMs) });
        const patchStartedAtMs = performance.now();
        const acknowledged = await resolveOneEntry(entry);
        logClientTetherDiagnostic("AUTOSAVE_PATCH_TIMING", { patchTotalMs: Math.round(performance.now() - patchStartedAtMs), acknowledged });
        return acknowledged;
      })();
      inFlightRef.current[questionId] = { response, promise: attempt };
      try {
        return await attempt;
      } finally {
        if (inFlightRef.current[questionId]?.promise === attempt) delete inFlightRef.current[questionId];
      }
    },
    [examId, submissionId, resolveOneEntry, syncCount, isAcknowledged],
  );

  const saveAndNavigate = useCallback(
    async (questionId: string, response: string, targetIndex: number): Promise<SaveAndNavigateResult<TPayload>> => {
      if (!enabledRef.current || !userIdRef.current) return { ok: false };

      const revision = nextRevision(revisionsRef.current[questionId]);
      revisionsRef.current[questionId] = revision;
      const clientRequestId = generateRequestId();
      const entry: PendingSaveEntry = {
        userId: userIdRef.current,
        examId,
        submissionId,
        questionId,
        response,
        clientRequestId,
        revision,
        queuedAtMs: Date.now(),
        retryCount: 0,
      };
      // Part 5 req 1 — persisted to IndexedDB BEFORE the network attempt,
      // exactly like save() — a crash/reload between here and the
      // request resolving never loses this draft.
      queueRef.current.set(questionId, entry);
      syncCount();
      setStatus("SENDING");
      const putStartedAtMs = performance.now();
      await putEntry(entry);
      logClientTetherDiagnostic("AUTOSAVE_INDEXEDDB_PUT_TIMING", { indexedDbPutMs: Math.round(performance.now() - putStartedAtMs) });

      type SaveAndNavigateBody = {
        answer: { questionId: string; response: string; acknowledgedRevision: number | null; acknowledgedRequestId: string | null };
        navigation: TPayload;
      };

      const requestStartedAtMs = performance.now();
      const result = await sendJsonWithTimeout<SaveAndNavigateBody>({
        url: `/api/submissions/${submissionId}/save-and-navigate`,
        method: "POST",
        body: { questionId, response, clientRequestId, clientRevision: revision, currentIndex: targetIndex },
        clientRevision: revision,
        retryCount: entry.retryCount,
      });
      // Physical acceptance follow-up — save/next latency diagnosis.
      // fetchMs/jsonParseMs split the single "requestMs" number this log
      // used to report into network+server-processing vs. body-parse;
      // serverTiming (present only when the server opted in — see
      // sendJsonWithTimeout's own doc comment) gives the exact server-side
      // stage breakdown for the SAME response, with no separate request.
      logClientTetherDiagnostic("SAVE_AND_NAVIGATE_REQUEST_TIMING", {
        requestMs: Math.round(performance.now() - requestStartedAtMs),
        fetchMs: result.ok ? Math.round(result.fetchMs) : null,
        jsonParseMs: result.ok ? Math.round(result.jsonParseMs) : null,
        serverTiming: result.ok ? result.serverTiming : null,
        acknowledged: result.ok,
      });

      // Only act if THIS is still the current entry for the question —
      // same supersession guard resolveOneEntry uses (Part 2: "a stale
      // response arriving after a newer save must not regress UI state").
      const current = queueRef.current.get(questionId);
      const isStillCurrent = current?.clientRequestId === clientRequestId;

      if (!result.ok) {
        // Part 5 req 4 — leave the answer queued (bumped retryCount for
        // bounded backoff on the next attempt, exactly like a plain PATCH
        // failure) so the existing background retry loop and IndexedDB
        // safety net still apply; the caller never advances.
        if (isStillCurrent) {
          onSaveDiagnosticsRef.current?.(questionId, result.diagnostics);
          const retried = { ...entry, retryCount: entry.retryCount + 1 };
          queueRef.current.set(questionId, retried);
          await putEntry(retried);
          setStatus("FAILED");
        }
        return { ok: false };
      }

      // PR #25 review fix — classify SAVED vs CONFLICT from the server's
      // own acknowledgedRevision, exactly like resolveOneEntry does for
      // the plain PATCH path, instead of treating every 2xx as an
      // automatic win for the text THIS call sent. See
      // resolveSaveAndNavigateAcknowledgement's own doc comment.
      const { acknowledgement, authoritativeResponse } = resolveSaveAndNavigateAcknowledgement({
        sentRevision: revision,
        submittedResponse: response,
        serverAcknowledgedRevision: result.body.answer.acknowledgedRevision,
        serverResponse: result.body.answer.response,
      });

      if (isStillCurrent) {
        queueRef.current.delete(questionId);
        syncCount();
        setStatus(acknowledgement);
        await deleteEntry(entry.userId, entry.submissionId, entry.questionId);
        acknowledgedResponseRef.current[questionId] = authoritativeResponse;
        // The NEW current question (from the navigation payload) may
        // already have its own previously-stored answer — seed that as
        // acknowledged too, exactly like a freshly loaded question
        // payload would, so an immediate subsequent Next with no edits
        // skips its save as well.
        if (result.body.navigation.existingResponse != null) {
          acknowledgedResponseRef.current[result.body.navigation.question.id] = result.body.navigation.existingResponse;
        }
      }
      return { ok: true, payload: result.body.navigation, acknowledgement, questionId, authoritativeResponse, serverTiming: result.serverTiming };
    },
    [examId, submissionId, syncCount],
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

  return { save, saveAndNavigate, isAcknowledged, noteAcknowledged, getInFlightSave, pendingCount, status, flushNow, clearAll };
}
