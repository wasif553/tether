"use client";

/**
 * VOIDED-attempt recovery v1 — see docs/voided-submission-recovery-v1.md.
 * Shown INSTEAD of exam content whenever GET /api/submissions/[id]
 * rejects with SECURE_POLICY_MISMATCH_RESTART_REQUIRED — the student
 * reached an IN_PROGRESS attempt (via the dashboard's "Continue" link, a
 * standalone-invite join link, or a direct/bookmarked URL) whose frozen
 * secure-client policy can no longer satisfy the exam's current
 * TETHER_CLIENT_REQUIRED configuration. Reuses the exact approved
 * message SECURE_POLICY_MISMATCH_RESTART_REQUIRED_MESSAGE
 * (secureClientPolicy.ts) — never duplicated here as a literal, so the
 * copy shown here and the one POST /api/exams/[id]/start already returns
 * can never drift apart. Read-only and inert on its own: no auto-retry,
 * no submission mutation — recovery still requires the lecturer's
 * explicit "Void technical attempt and allow restart" action.
 */
import { SECURE_POLICY_MISMATCH_RESTART_REQUIRED_MESSAGE } from "@/lib/secureClientPolicy";

export function SecurePolicyMismatchNotice() {
  return (
    <div className="mx-auto mt-16 max-w-md rounded border border-amber-200 bg-amber-50 p-6 text-center">
      <div role="status" aria-live="polite">
        <h1 className="text-lg font-medium text-amber-900">This attempt cannot be resumed</h1>
        <p className="mt-3 text-sm text-amber-800">{SECURE_POLICY_MISMATCH_RESTART_REQUIRED_MESSAGE}</p>
      </div>
      <a
        href="/student"
        className="mt-5 inline-block rounded border border-amber-400 px-4 py-2 text-sm font-medium text-amber-900 focus:outline-none focus:ring-2 focus:ring-amber-500"
      >
        Return to dashboard
      </a>
    </div>
  );
}
