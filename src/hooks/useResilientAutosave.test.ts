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
    const resolveIdx = fn.indexOf("await resolveOneEntry(entry);");
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
  it("attemptSend uses a bounded AbortController timeout on the fetch, not an unbounded await", () => {
    const fn = extractFunctionBody("const attemptSend = useCallback(async (entry: PendingSaveEntry)");
    expect(fn).toContain("new AbortController()");
    expect(fn).toContain("controller.abort()");
    expect(fn).toContain("signal: controller?.signal");
    expect(source).toMatch(/const SAVE_ATTEMPT_TIMEOUT_MS = \d+/);
  });

  it("every early-return path in attemptSend builds real diagnostics instead of a bare FAILED — offline, timeout, thrown exception, and HTTP >=400 are all distinguishable", () => {
    const fn = extractFunctionBody("const attemptSend = useCallback(async (entry: PendingSaveEntry)");
    expect(fn).toContain('failed({ threw: true, timedOut: false, httpStatus: null, serverErrorCode: null })'); // offline
    expect(fn).toContain('failed({ threw: false, timedOut: true, httpStatus: null, serverErrorCode: null })'); // simulated timeout fault
    expect(fn).toContain("const timedOut = err instanceof DOMException && err.name === \"AbortError\";");
    expect(fn).toContain("failed({ threw: !timedOut, timedOut, httpStatus: null, serverErrorCode: null })");
    expect(fn).toMatch(/if \(httpStatus >= 400\) \{/);
  });

  it("diagnostics are never derived from the answer/question text — only status/timing/booleans/a short server code ever reach buildSaveAttemptDiagnostics", () => {
    const fn = extractFunctionBody("const attemptSend = useCallback(async (entry: PendingSaveEntry)");
    expect(fn).not.toMatch(/buildSaveAttemptDiagnostics\([^)]*response/);
    expect(fn).not.toMatch(/buildSaveAttemptDiagnostics\([^)]*entry\.response/);
    expect(fn).toContain('typeof errorBody.code === "string" ? errorBody.code : null'); // only the short `code` field, never the free-text `error` message
  });
});
