/**
 * Controlled AI Brainstorming Assistance v1 — intermittent-failure
 * follow-up. See docs/controlled-ai-brainstorming-assistance-v1.md.
 *
 * Shared, pure Anthropic-error classification and bounded transient-error
 * retry, used by BOTH src/lib/aiAssistanceGenerator.ts and
 * src/lib/aiAssistanceVerifier.ts so their retry/backoff/classification
 * behaviour can never drift apart between the two services.
 *
 * Classification reads only the Anthropic SDK's own documented, stable
 * public error shape — `status`/`type` (see
 * node_modules/@anthropic-ai/sdk/resources/shared.d.ts's ErrorType union:
 * 'rate_limit_error' | 'overloaded_error' | 'timeout_error' | 'api_error' |
 * 'authentication_error' | 'permission_error' | ...) for a real API
 * response, or `instanceof` for the two connection-error subclasses that
 * carry neither (no response was ever received) — NEVER the error's own
 * `.message`, which can include raw response bodies / rate-limit details
 * that must never reach a log line (the same precaution
 * aiAssistanceGenerator.ts's existing catch block already documents).
 *
 * The Anthropic SDK's own `maxRetries` client option is deliberately set
 * to 0 by both callers of this module — that retry is opaque (no hook to
 * classify or log an individual attempt) and, left on top of the retry
 * loop here, would silently multiply attempts. This module is the ONE
 * place retry/backoff/classification policy lives for both Anthropic
 * calls this feature makes.
 */
import { APIConnectionError, APIConnectionTimeoutError } from "@anthropic-ai/sdk";

export type AiProviderErrorCategory =
  | "RATE_LIMITED"
  | "OVERLOADED"
  | "TIMEOUT"
  | "CONNECTION_ERROR"
  | "SERVER_ERROR"
  | "PARSE_ERROR"
  | "SCHEMA_ERROR"
  | "EMPTY_RESPONSE"
  | "CONFIG_MISSING"
  | "UNKNOWN";

/**
 * Classifies a thrown error from an Anthropic SDK call. Never throws
 * itself — an unrecognised shape resolves to "UNKNOWN" rather than
 * propagating a classification failure on top of the original error.
 */
export function classifyProviderError(err: unknown): AiProviderErrorCategory {
  // Checked via instanceof, not status/type: both connection-error
  // classes have status === undefined and type === null (no HTTP
  // response was ever received to carry either), so they cannot be
  // distinguished from each other — or from a generic UNKNOWN — any
  // other way. APIConnectionTimeoutError extends APIConnectionError, so
  // the more specific check must run first.
  if (err instanceof APIConnectionTimeoutError) return "TIMEOUT";
  if (err instanceof APIConnectionError) return "CONNECTION_ERROR";

  if (!(err instanceof Error)) return "UNKNOWN";
  const shaped = err as { status?: number; type?: string | null };

  if (shaped.type === "rate_limit_error" || shaped.status === 429) return "RATE_LIMITED";
  if (shaped.type === "overloaded_error" || shaped.status === 529) return "OVERLOADED";
  if (shaped.type === "timeout_error") return "TIMEOUT";
  if (shaped.type === "authentication_error" || shaped.type === "permission_error" || shaped.status === 401 || shaped.status === 403) {
    return "CONFIG_MISSING";
  }
  if (shaped.type === "api_error" || (typeof shaped.status === "number" && shaped.status >= 500)) return "SERVER_ERROR";
  return "UNKNOWN";
}

const TRANSIENT_CATEGORIES: ReadonlySet<AiProviderErrorCategory> = new Set([
  "RATE_LIMITED",
  "OVERLOADED",
  "TIMEOUT",
  "CONNECTION_ERROR",
  "SERVER_ERROR",
]);

/**
 * Only these five categories are ever retried. A configuration/
 * authorization error, a deterministic parsing/schema failure, or an
 * empty completion is never retried — retrying cannot fix any of those,
 * and doing so would only add latency before the same inevitable
 * failure.
 */
export function isTransientProviderErrorCategory(category: AiProviderErrorCategory): boolean {
  return TRANSIENT_CATEGORIES.has(category);
}

/**
 * Reads a bounded, capped delay from a rate-limited/overloaded response's
 * own retry-after guidance (the SDK exposes both the informal
 * `retry-after-ms` and the standard `retry-after` — in seconds — response
 * headers). Honoured but never trusted beyond MAX_HONOURED_RETRY_AFTER_MS,
 * so a provider header can never itself make a request wait
 * unboundedly — this is what keeps total response time bounded even
 * under sustained provider guidance to wait longer. Returns null when
 * absent/unparseable, so the caller falls back to its own backoff.
 */
const MAX_HONOURED_RETRY_AFTER_MS = 5_000;

export function retryAfterMsFromError(err: unknown): number | null {
  const headers = (err as { headers?: { get?: (name: string) => string | null } } | null)?.headers;
  if (!headers || typeof headers.get !== "function") return null;

  const msHeader = headers.get("retry-after-ms");
  if (msHeader != null) {
    const ms = Number(msHeader);
    if (Number.isFinite(ms) && ms >= 0) return Math.min(ms, MAX_HONOURED_RETRY_AFTER_MS);
  }
  const secHeader = headers.get("retry-after");
  if (secHeader != null) {
    const sec = Number(secHeader);
    if (Number.isFinite(sec) && sec >= 0) return Math.min(sec * 1000, MAX_HONOURED_RETRY_AFTER_MS);
  }
  return null;
}

/** One structured, safe-to-log record per physical call attempt — never the request/response content itself. */
export type ProviderCallAttemptLog = {
  attempt: number;
  outcome: "SUCCESS" | AiProviderErrorCategory;
  durationMs: number;
};

const BASE_BACKOFF_DELAY_MS = 300;
const MAX_BACKOFF_DELAY_MS = 3_000;

/** Bounded exponential backoff with +-20% jitter (avoids many concurrent students' retries re-colliding on the same schedule). */
function backoffDelayMs(retryIndex: number): number {
  const exponential = Math.min(BASE_BACKOFF_DELAY_MS * 2 ** retryIndex, MAX_BACKOFF_DELAY_MS);
  return Math.round(exponential * (0.8 + Math.random() * 0.4));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls `fn` up to `maxAttempts` times total (the initial attempt plus up
 * to `maxAttempts - 1` additional retries), retrying ONLY when the
 * thrown error classifies as transient. Bounded exponential backoff
 * between attempts, honouring (and capping) a provider's own retry-after
 * guidance when present. Every attempt — success or failure — is
 * reported via `onAttempt`, in order, for structured diagnostic logging.
 * The error ultimately thrown (if every attempt fails, or a non-transient
 * error is hit) is always the LAST attempt's own error, never swallowed
 * or replaced with a synthesized one.
 */
export async function callWithTransientRetry<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts: number; onAttempt?: (log: ProviderCallAttemptLog) => void },
): Promise<T> {
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    const startedAtMs = Date.now();
    try {
      const result = await fn();
      opts.onAttempt?.({ attempt, outcome: "SUCCESS", durationMs: Date.now() - startedAtMs });
      return result;
    } catch (err) {
      const category = classifyProviderError(err);
      opts.onAttempt?.({ attempt, outcome: category, durationMs: Date.now() - startedAtMs });

      const isLastAttempt = attempt === opts.maxAttempts;
      if (isLastAttempt || !isTransientProviderErrorCategory(category)) {
        throw err;
      }
      await sleep(retryAfterMsFromError(err) ?? backoffDelayMs(attempt - 1));
    }
  }
  // Unreachable: maxAttempts >= 1 guarantees the loop above always
  // either returns or throws on its final iteration.
  throw new Error("callWithTransientRetry: unreachable");
}
