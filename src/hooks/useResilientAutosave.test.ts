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
    const resolveIdx = fn.indexOf("const promise = resolveOneEntry(entry);");
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
    const okReturnIdx = fn.lastIndexOf("return { ok: true, payload: result.body.navigation };");
    const deleteIdx = fn.indexOf("await deleteEntry(entry.userId, entry.submissionId, entry.questionId);");
    expect(okReturnIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(okReturnIdx).toBeGreaterThan(deleteIdx);
  });
});
