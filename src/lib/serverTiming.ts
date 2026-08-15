/**
 * Physical acceptance follow-up — save/next latency diagnosis. Pure,
 * DOM/network-free helpers for exposing BOUNDED, NON-SECRET per-stage
 * timing to a controlled physical test, via the standard `Server-Timing`
 * response header (https://www.w3.org/TR/server-timing/) — visible in any
 * browser's Network tab / `PerformanceResourceTiming.serverTiming`,
 * needing no console access inside the packaged Tether renderer.
 *
 * Deliberately SEPARATE from src/lib/tetherDiagnosticLog.ts's own
 * `TETHER_DIAGNOSTIC_LOGGING_ENABLED` gate (which is hardcoded OFF in
 * `production` — see that file's own doc comment): a physical acceptance
 * test runs against a genuine production-mode build, so a gate that
 * excludes `production` outright would make this unusable for exactly the
 * environment it exists to diagnose. `TETHER_TIMING_HEADERS_ENABLED` has
 * no such exclusion — it is off by default everywhere (an unset/non-"true"
 * value never attaches the header) and must be deliberately set for a
 * bounded test window, in ANY environment including production.
 *
 * Every stage name is a short, hardcoded, enum-like identifier chosen by
 * the caller (e.g. "authMs", "submissionLookupMs") and every value is a
 * plain non-negative duration in milliseconds — never a request id,
 * question id, answer/question text, cookie, token, or any other
 * request-specific value. There is no free-text field anywhere in this
 * module's public surface for a caller to accidentally route something
 * unsafe through.
 */

export type TimingCollector = {
  /** Records one stage's duration. Safe to call multiple times with the same name (e.g. a stage that only sometimes runs) — later calls simply add another entry, never overwrite; `entries()` returns every recorded entry in the order they were recorded. */
  record: (name: string, durationMs: number) => void;
  entries: () => ReadonlyArray<{ name: string; durationMs: number }>;
};

/** A fresh, empty collector — one per request. Never shared across requests/users. */
export function createTimingCollector(): TimingCollector {
  const entries: Array<{ name: string; durationMs: number }> = [];
  return {
    record(name, durationMs) {
      entries.push({ name, durationMs: Math.max(0, durationMs) });
    },
    entries: () => entries,
  };
}

/** Times a synchronous or async span and records it under `name` — the span's own return value passes through unchanged. */
export async function timeSpan<T>(collector: TimingCollector | undefined, name: string, fn: () => Promise<T> | T): Promise<T> {
  if (!collector) return fn();
  const startedAtMs = performance.now();
  try {
    return await fn();
  } finally {
    collector.record(name, performance.now() - startedAtMs);
  }
}

/** Only [A-Za-z0-9_-]+ survives — the Server-Timing header's own grammar (a `token`) rejects anything else, and this also guarantees no request-specific content can ever reach the header even if a future caller passed something unexpected as `name`. */
function sanitizeTimingName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60) || "stage";
}

/**
 * Builds a `Server-Timing` header value from a collector's entries —
 * `name;dur=12.3, name2;dur=45.6`. Durations are rounded to 1 decimal
 * place (the spec's own convention) and clamped non-negative. Returns
 * `""` (never attach an empty header) when there is nothing to report.
 */
export function buildServerTimingHeaderValue(entries: ReadonlyArray<{ name: string; durationMs: number }>): string {
  return entries
    .map((e) => `${sanitizeTimingName(e.name)};dur=${Math.max(0, e.durationMs).toFixed(1)}`)
    .join(", ");
}

/**
 * Off by default in every environment, including production — must be
 * deliberately set to the literal string "true" for the duration of a
 * controlled physical acceptance test, then unset again. Unlike
 * isServerTetherDiagnosticLoggingEnabled (tetherDiagnosticLog.ts), this
 * intentionally has NO `env !== "production"` exclusion — see this
 * module's own doc comment for why.
 */
export function isServerTimingHeaderEnabled(envFlag: string | undefined): boolean {
  return envFlag === "true";
}

/** Attaches the Server-Timing header to `response` when enabled and there is at least one recorded stage — a no-op otherwise (never throws, never removes/overwrites an unrelated header). */
export function attachServerTimingHeader(response: { headers: { set: (name: string, value: string) => void } }, collector: TimingCollector, envFlag: string | undefined): void {
  if (!isServerTimingHeaderEnabled(envFlag)) return;
  const value = buildServerTimingHeaderValue(collector.entries());
  if (value) response.headers.set("Server-Timing", value);
}

/**
 * Physical acceptance follow-up — Server-Timing headers alone are only
 * ever visible inside a browser's own DevTools/Network tab, which is not
 * guaranteed to be available while physically testing a packaged Tether
 * build. This builds the SAME data as one bounded, structured, single-
 * line JSON record instead — durations/counts/a fixed route name only,
 * never a submission id, student id, answer/question content, cookie,
 * token, or any other request-specific value (every field comes straight
 * from the same TimingCollector Server-Timing already uses, which never
 * accepts anything else — see createTimingCollector's own doc comment).
 * `route` is one of a small fixed set of route-name literals the caller
 * passes in, never derived from request input.
 */
export function buildBoundedTimingLogRecord(route: string, collector: TimingCollector): Record<string, unknown> {
  const record: Record<string, unknown> = { event: "TETHER_NAVIGATION_TIMING", route };
  for (const entry of collector.entries()) {
    record[sanitizeTimingName(entry.name)] = Math.round(entry.durationMs * 100) / 100;
  }
  return record;
}

/**
 * Emits exactly one bounded log record (via console.log, as a single JSON
 * line — greppable in a Vercel function log without any extra tooling)
 * per foreground navigation request, ONLY when TETHER_TIMING_HEADERS_ENABLED
 * is set — the identical gate attachServerTimingHeader uses, so a
 * physical test that turns the flag on gets both the header AND this log
 * line together, and turning it off silences both. A no-op when nothing
 * was recorded (mirrors attachServerTimingHeader's own "never an empty
 * header" rule).
 */
export function logBoundedNavigationTiming(route: string, collector: TimingCollector, envFlag: string | undefined): void {
  if (!isServerTimingHeaderEnabled(envFlag)) return;
  if (collector.entries().length === 0) return;
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(buildBoundedTimingLogRecord(route, collector)));
}
