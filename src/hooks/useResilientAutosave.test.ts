/**
 * Physical acceptance follow-up ("answer could not be saved" symptom,
 * question-navigation latency review). See
 * src/app/student/exams/[id]/tether-launch/page.test.ts's own doc comment
 * for the established precedent this file follows — no DOM/testing-
 * library dependency in this repo; a stateful hook using useRef/useState/
 * useEffect cannot be called directly like a pure function outside a real
 * React render either, so these are source-level structural assertions
 * proving the actual control flow (ordering, which branches persist vs.
 * discard the local queue entry) rather than guessing from a render this
 * repo has no harness for. The purely-functional decision logic this hook
 * delegates to (classifySaveFailureCategory, buildSaveAttemptDiagnostics,
 * shouldSupersede, classifyAcknowledgement, ...) is behaviorally unit
 * tested directly in src/lib/pendingSaveQueue.test.ts.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// PR #25 review fix — resolveSaveAndNavigateAcknowledgement is a plain,
// side-effect-free function (no React hook invocation, no DOM/browser
// API at module load time), so — unlike the stateful hook itself — it
// CAN be imported and genuinely behaviorally tested directly, the same
// way src/lib/pendingSaveQueue.ts's pure functions already are.
import { resolveSaveAndNavigateAcknowledgement } from "./useResilientAutosave";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, "useResilientAutosave.ts"), "utf8");

/**
 * `declMarker` only needs to uniquely locate where the function's
 * declaration STARTS — the actual body-open brace is found by scanning
 * forward for the arrow's own `=> {`, never the first `{` after the
 * marker. That specifically avoids anchoring on a brace that belongs to a
 * generic return-type annotation instead (e.g. attemptSend's own
 * `Promise<{ outcome: ...; diagnostics: ... }>` — a naive "first brace
 * after the marker" search would treat that type's brace as the body).
 */
function extractFunctionBody(declMarker: string): string {
  const start = source.indexOf(declMarker);
  if (start === -1) throw new Error(`Could not locate "${declMarker}" in useResilientAutosave.ts`);
  const arrowIdx = source.indexOf("=> {", start);
  if (arrowIdx === -1) throw new Error(`Could not locate arrow-function body start after "${declMarker}"`);
  const braceStart = arrowIdx + "=> ".length;
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Unbalanced braces extracting "${declMarker}"`);
}

describe("PART 3 — a failed immediate save never loses the answer: IndexedDB persistence happens before, and survives, every network outcome", () => {
  it("save() persists the entry to IndexedDB (putEntry) BEFORE ever attempting the network send (resolveOneEntry/attemptSend)", () => {
    const fn = extractFunctionBody("const save = useCallback(");
    const putIdx = fn.indexOf("await putEntry(entry);");
    const resolveIdx = fn.indexOf("const acknowledged = await resolveOneEntry(entry);");
    expect(putIdx).toBeGreaterThan(-1);
    expect(resolveIdx).toBeGreaterThan(putIdx);
  });

  it("a FAILED outcome re-persists the entry (bumped retryCount) and never calls deleteEntry — the draft stays in the local queue for the retry loop to pick up", () => {
    const fn = extractFunctionBody("const resolveOneEntry = useCallback(");
    const failedBranchIdx = fn.indexOf("// FAILED");
    expect(failedBranchIdx).toBeGreaterThan(-1);
    const failedBranch = fn.slice(failedBranchIdx);
    expect(failedBranch).toContain("retryCount: entry.retryCount + 1");
    expect(failedBranch).toContain("await putEntry(retried);");
    expect(failedBranch).not.toContain("deleteEntry(");
    expect(failedBranch).toContain("return false;");
  });

  it("only a SAVED or CONFLICT outcome ever calls deleteEntry — and only when the entry is still the current one for that question", () => {
    const fn = extractFunctionBody("const resolveOneEntry = useCallback(");
    const deleteIdx = fn.indexOf("await deleteEntry(");
    const failedCommentIdx = fn.indexOf("// FAILED");
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeLessThan(failedCommentIdx); // the only deleteEntry call site is in the SAVED/CONFLICT branch, textually before the FAILED branch
    const savedBranch = fn.slice(fn.indexOf('if (outcome === "SAVED" || outcome === "CONFLICT") {'), failedCommentIdx);
    expect(savedBranch).toContain("if (isStillCurrent) {");
  });

  it("a background retry loop exists and is bounded by exponential backoff — a failed save is retried automatically, not left stranded", () => {
    expect(source).toContain("const dueAtMs = entry.queuedAtMs + computeBackoffDelayMs(entry.retryCount, AUTOSAVE_RETRY_MAX_SECONDS);");
    expect(source).toContain("if (Date.now() >= dueAtMs) void resolveOneEntry(entry);");
  });
});

describe("physical acceptance follow-up — a hung request cannot leave save() unresolved forever", () => {
  // sendJsonWithTimeout is a plain `async function`, not an arrow
  // function — extractFunctionBody's brace-matching (anchored on `=> {`)
  // is built for the useCallback arrow functions elsewhere in this file
  // and doesn't apply here, and its own parameter list is itself an
  // object type (braces that would confuse a naive "first brace after
  // the marker" search). These search the whole source instead — safe
  // because every string checked below is unique to this one function.
  it("sendJsonWithTimeout uses a bounded AbortController timeout on the fetch, not an unbounded await", () => {
    expect(source).toContain("new AbortController()");
    expect(source).toContain("controller.abort()");
    expect(source).toContain("signal: controller?.signal");
    expect(source).toMatch(/const SAVE_ATTEMPT_TIMEOUT_MS = \d+/);
  });

  it("every early-return path in sendJsonWithTimeout builds real diagnostics instead of a bare failure — offline, timeout, thrown exception, and HTTP >=400 are all distinguishable", () => {
    expect(source).toContain('failed({ threw: true, timedOut: false, httpStatus: null, serverErrorCode: null })'); // offline
    expect(source).toContain('failed({ threw: false, timedOut: true, httpStatus: null, serverErrorCode: null })'); // simulated timeout fault
    expect(source).toContain("const timedOut = err instanceof DOMException && err.name === \"AbortError\";");
    expect(source).toContain("failed({ threw: !timedOut, timedOut, httpStatus: null, serverErrorCode: null })");
    expect(source).toMatch(/if \(httpStatus >= 400\) \{/);
  });

  it("diagnostics are never derived from the answer/question text — only status/timing/booleans/a short server code ever reach buildSaveAttemptDiagnostics", () => {
    expect(source).not.toMatch(/buildSaveAttemptDiagnostics\(\s*\{[^}]*\bresponse\s*:/);
    expect(source).toContain('typeof errorBody.code === "string" ? errorBody.code : null'); // only the short `code` field, never the free-text `error` message
  });

  it("Question-navigation performance follow-up — attemptSend (PATCH /answers) and saveAndNavigate (POST /save-and-navigate) both DELEGATE to the SAME sendJsonWithTimeout, never a second independent copy of the offline/timeout/diagnostics logic", () => {
    const attemptSendFn = extractFunctionBody("const attemptSend = useCallback(async (entry: PendingSaveEntry)");
    expect(attemptSendFn).toContain("await sendJsonWithTimeout<");
    expect(attemptSendFn).toContain('method: "PATCH"');
    expect(attemptSendFn).toContain("/answers`");

    const saveAndNavigateFn = extractFunctionBody("const saveAndNavigate = useCallback(");
    expect(saveAndNavigateFn).toContain("await sendJsonWithTimeout<");
    expect(saveAndNavigateFn).toContain('method: "POST"');
    expect(saveAndNavigateFn).toContain("/save-and-navigate`");
  });
});

describe("PART 2 — skip a redundant save when the current content is already server-acknowledged, and reuse an in-flight save instead of duplicating it", () => {
  it("save() checks isAcknowledged() and short-circuits BEFORE ever touching IndexedDB or the network", () => {
    const fn = extractFunctionBody("const save = useCallback(");
    const ackCheckIdx = fn.indexOf("if (isAcknowledged(questionId, response)) return true;");
    const putIdx = fn.indexOf("await putEntry(entry);");
    expect(ackCheckIdx).toBeGreaterThan(-1);
    expect(putIdx).toBeGreaterThan(ackCheckIdx);
  });

  it("save() checks for an in-flight save with identical content and reuses it, BEFORE creating a new entry", () => {
    const fn = extractFunctionBody("const save = useCallback(");
    const inFlightCheckIdx = fn.indexOf("if (inFlight && inFlight.response === response) return inFlight.promise;");
    const newEntryIdx = fn.indexOf("const entry: PendingSaveEntry = {");
    expect(inFlightCheckIdx).toBeGreaterThan(-1);
    expect(newEntryIdx).toBeGreaterThan(inFlightCheckIdx);
  });

  it("isAcknowledged is never true merely because React state says so — it requires nothing queued AND an exact match against a value that came from a genuine server acknowledgement", () => {
    const fn = extractFunctionBody("const isAcknowledged = useCallback(");
    expect(fn).toContain("!queueRef.current.has(questionId)");
    expect(fn).toContain("acknowledgedResponseRef.current[questionId] === response");
  });

  it("the resolveOneEntry (PATCH) success path only caches the acknowledged response for a genuine SAVED outcome, never for CONFLICT (a newer save elsewhere already won, so its real text is unknown)", () => {
    const resolveOneEntryFn = extractFunctionBody("const resolveOneEntry = useCallback(");
    expect(resolveOneEntryFn).toContain('if (outcome === "SAVED") acknowledgedResponseRef.current[entry.questionId] = entry.response;');
  });
});

describe("PART 3/5 — a failed/timed-out save-and-navigate leaves the answer queued in IndexedDB and never advances", () => {
  it("saveAndNavigate persists to IndexedDB BEFORE the network attempt, exactly like save()", () => {
    const fn = extractFunctionBody("const saveAndNavigate = useCallback(");
    const putIdx = fn.indexOf("await putEntry(entry);");
    const requestIdx = fn.indexOf("await sendJsonWithTimeout<SaveAndNavigateBody>(");
    expect(putIdx).toBeGreaterThan(-1);
    expect(requestIdx).toBeGreaterThan(putIdx);
  });

  it("a FAILED saveAndNavigate re-persists the entry (bumped retryCount) for the existing background retry loop, and never calls deleteEntry", () => {
    const fn = extractFunctionBody("const saveAndNavigate = useCallback(");
    const failedBranchIdx = fn.indexOf("if (!result.ok) {");
    const failedReturnIdx = fn.indexOf("return { ok: false };", failedBranchIdx);
    expect(failedBranchIdx).toBeGreaterThan(-1);
    expect(failedReturnIdx).toBeGreaterThan(failedBranchIdx);
    const failedBranch = fn.slice(failedBranchIdx, failedReturnIdx + "return { ok: false };".length);
    expect(failedBranch).toContain("retryCount: entry.retryCount + 1");
    expect(failedBranch).toContain("await putEntry(retried);");
    expect(failedBranch).not.toContain("deleteEntry(");
  });

  it("saveAndNavigate only ever deletes the local entry and returns ok:true AFTER a successful (2xx) server response — never before", () => {
    const fn = extractFunctionBody("const saveAndNavigate = useCallback(");
    const okReturnIdx = fn.lastIndexOf(
      "return { ok: true, payload: result.body.navigation, acknowledgement, questionId, authoritativeResponse, serverTiming: result.serverTiming };",
    );
    const deleteIdx = fn.indexOf("await deleteEntry(entry.userId, entry.submissionId, entry.questionId);");
    expect(okReturnIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(okReturnIdx).toBeGreaterThan(deleteIdx);
  });
});

/**
 * PR #25 review fix — POST /save-and-navigate can legitimately return a
 * 2xx for a safe stale-revision no-op (a newer answer already won
 * server-side); the hook must not blindly treat every 2xx as an
 * acknowledgement of the text IT sent. resolveSaveAndNavigateAcknowledgement
 * is exported specifically so this decision is genuinely,
 * behaviorally unit-tested (real inputs, real assertions on the output) —
 * not merely grepped for — without needing a DOM/React-rendering harness.
 */
describe("PR #25 review fix — saveAndNavigate correctly distinguishes SAVED from CONFLICT, exactly like the plain PATCH path already does", () => {
  it("stale revision: the server already holds a NEWER acknowledged answer -> CONFLICT, and the authoritative value is the server's own stored text, never the rejected local stale text", () => {
    const result = resolveSaveAndNavigateAcknowledgement({
      sentRevision: 1,
      submittedResponse: "revision one (stale)",
      serverAcknowledgedRevision: 2,
      serverResponse: "revision two",
    });
    expect(result.acknowledgement).toBe("CONFLICT");
    expect(result.authoritativeResponse).toBe("revision two");
    expect(result.authoritativeResponse).not.toBe("revision one (stale)");
  });

  it("normal save: the server's acknowledged revision matches what was sent -> SAVED, and the authoritative value is the submitted response", () => {
    const result = resolveSaveAndNavigateAcknowledgement({
      sentRevision: 1,
      submittedResponse: "my answer",
      serverAcknowledgedRevision: 1,
      serverResponse: "my answer",
    });
    expect(result.acknowledgement).toBe("SAVED");
    expect(result.authoritativeResponse).toBe("my answer");
  });

  it("a null/undefined acknowledgedRevision (a caller that predates revision tracking) is treated as SAVED, matching classifyAcknowledgement's own documented default", () => {
    expect(resolveSaveAndNavigateAcknowledgement({ sentRevision: 1, submittedResponse: "x", serverAcknowledgedRevision: null, serverResponse: "x" }).acknowledgement).toBe("SAVED");
    expect(resolveSaveAndNavigateAcknowledgement({ sentRevision: 1, submittedResponse: "x", serverAcknowledgedRevision: undefined, serverResponse: "x" }).acknowledgement).toBe("SAVED");
  });

  it("saveAndNavigate itself calls resolveSaveAndNavigateAcknowledgement (not an inline duplicate of the classification logic) and seeds the acknowledged-response cache with the AUTHORITATIVE value, never the raw submitted response directly", () => {
    const fn = extractFunctionBody("const saveAndNavigate = useCallback(");
    expect(fn).toContain("resolveSaveAndNavigateAcknowledgement({");
    expect(fn).toContain("sentRevision: revision");
    expect(fn).toContain("submittedResponse: response");
    expect(fn).toContain("serverAcknowledgedRevision: result.body.answer.acknowledgedRevision");
    expect(fn).toContain("serverResponse: result.body.answer.response");
    // The cache write uses the resolved authoritative value, not `response` directly.
    expect(fn).toContain("acknowledgedResponseRef.current[questionId] = authoritativeResponse;");
    expect(fn).not.toContain("acknowledgedResponseRef.current[questionId] = response;");
    // Local status reflects the real classification too, not a hardcoded "SAVED".
    expect(fn).toContain("setStatus(acknowledgement);");
  });

  it("attemptSend (the plain PATCH path) and saveAndNavigate both delegate to the SAME classifySaveOutcome/resolveSaveAndNavigateAcknowledgement logic — never two independently-drifting ideas of SAVED vs CONFLICT", () => {
    const attemptSendFn = extractFunctionBody("const attemptSend = useCallback(async (entry: PendingSaveEntry)");
    expect(attemptSendFn).toContain("classifySaveOutcome(entry.revision, result.body.acknowledgedRevision)");
    expect(source).toContain("resolveSaveAndNavigateAcknowledgement(params: {");
    expect(source).toMatch(/function resolveSaveAndNavigateAcknowledgement[\s\S]*?classifySaveOutcome\(params\.sentRevision, params\.serverAcknowledgedRevision\)/);
  });
});

describe("PR #25 review fix — save() registers its in-flight promise with no gap a concurrent call could slip through", () => {
  it("the in-flight promise covers IndexedDB persistence AND the network send together, and is registered in inFlightRef BEFORE it is ever awaited", () => {
    const fn = extractFunctionBody("const save = useCallback(");
    const iifeStartIdx = fn.indexOf("const attempt = (async (): Promise<boolean> => {");
    const putInsideIifeIdx = fn.indexOf("await putEntry(entry);", iifeStartIdx);
    const registerIdx = fn.indexOf("inFlightRef.current[questionId] = { response, promise: attempt };");
    const firstAwaitOnAttemptIdx = fn.indexOf("return await attempt;");
    expect(iifeStartIdx).toBeGreaterThan(-1);
    // putEntry is INSIDE the IIFE (still runs before the network attempt).
    expect(putInsideIifeIdx).toBeGreaterThan(iifeStartIdx);
    // Registration happens AFTER the IIFE is constructed (so it has a
    // Promise to store) but the IIFE itself starts running synchronously
    // up to its first internal `await` — so this registration line is
    // reached with no `await` of this function's own in between,
    // meaning no other save() call can interleave before it.
    expect(registerIdx).toBeGreaterThan(iifeStartIdx);
    const betweenIifeAndRegister = fn.slice(iifeStartIdx, registerIdx);
    // The only `await` textually between constructing the IIFE and
    // registering it must be INSIDE the IIFE's own body (already
    // confirmed above by putInsideIifeIdx) — there is no top-level
    // `await` of this function's own execution in that gap.
    const iifeBodyEndIdx = fn.indexOf("})();", iifeStartIdx) + "})();".length;
    expect(registerIdx).toBeGreaterThanOrEqual(iifeBodyEndIdx);
    expect(betweenIifeAndRegister.slice(iifeBodyEndIdx - iifeStartIdx)).not.toMatch(/await /);
    expect(firstAwaitOnAttemptIdx).toBeGreaterThan(registerIdx);
  });
});
