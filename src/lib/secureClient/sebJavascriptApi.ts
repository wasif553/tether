"use client";

/**
 * Tether Secure Client Foundation v1 — Safe Exam Browser JavaScript API
 * bridge. See docs/secure-client-foundation-seb-v1.md and Part 5 of the
 * spec.
 *
 * Client-side (browser) module. Feature-detects the official SEB
 * JavaScript API (`window.SafeExamBrowser`) and requests only version,
 * platform, and the Browser Exam Key / Config Key verification values —
 * never assumes the API is present, and distinguishes an ordinary
 * browser from a supported-SEB-with-API, a SEB where verification
 * information is unavailable, and a genuine API-call failure. Results
 * are ALWAYS sent to the server for authenticated validation — this
 * module never makes a trust decision on its own, and never has access
 * to (and therefore cannot expose) any server-side allowed-key value.
 */

export type SebJsApiDetectionResult =
  | { kind: "NOT_SEB" }
  | { kind: "SEB_API_AVAILABLE"; version: string | null; browserExamKey: string | null; configKey: string | null }
  | { kind: "SEB_API_UNAVAILABLE" }
  | { kind: "API_CALL_FAILED"; error: string };

type SafeExamBrowserGlobal = {
  version?: string;
  security?: {
    browserExamKey?: string;
    configKey?: string;
    updateKeys?: (callback: (browserExamKey: string, configKey: string) => void) => void;
  };
};

declare global {
  interface Window {
    SafeExamBrowser?: SafeExamBrowserGlobal;
  }
}

const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Detects and queries the official SEB JavaScript API, if present. Never
 * rejects — every outcome (including a timeout or thrown error from the
 * SEB-provided callback) resolves to one of the four distinguishable
 * result kinds above.
 */
export function detectSebJavascriptApi(timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<SebJsApiDetectionResult> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") {
      resolve({ kind: "NOT_SEB" });
      return;
    }
    const seb = window.SafeExamBrowser;
    if (!seb) {
      resolve({ kind: "NOT_SEB" });
      return;
    }
    if (!seb.security?.updateKeys) {
      // SEB is present (the global object exists) but this build/version
      // does not expose the key-verification API — a real, distinguishable
      // state, never conflated with "ordinary browser".
      resolve({ kind: "SEB_API_UNAVAILABLE" });
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ kind: "API_CALL_FAILED", error: "SEB updateKeys() did not respond in time" });
    }, timeoutMs);

    try {
      seb.security.updateKeys((browserExamKey, configKey) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          kind: "SEB_API_AVAILABLE",
          version: seb.version ?? null,
          browserExamKey: browserExamKey ?? null,
          configKey: configKey ?? null,
        });
      });
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ kind: "API_CALL_FAILED", error: err instanceof Error ? err.message : "Unknown SEB API error" });
    }
  });
}

/**
 * Compatibility adapter (Part 5) — combines the outcome of header-based
 * validation (decided server-side, from the request that loaded this
 * page) with the JavaScript-API outcome above into ONE internal
 * verification signal to send to the server. Client-side classification
 * only; the server independently re-validates whatever is reported here
 * (Part 5: "do not trust client results without server validation").
 */
export type SebClientVerificationSignal = {
  source: "HEADER" | "JAVASCRIPT_API" | "NONE";
  jsApiResult: SebJsApiDetectionResult;
};

export function buildSebClientVerificationSignal(headerValidationAttempted: boolean, jsApiResult: SebJsApiDetectionResult): SebClientVerificationSignal {
  if (jsApiResult.kind === "SEB_API_AVAILABLE") return { source: "JAVASCRIPT_API", jsApiResult };
  if (headerValidationAttempted) return { source: "HEADER", jsApiResult };
  return { source: "NONE", jsApiResult };
}
