"use client";

/**
 * Secure-recovery hardening v1, Part B — shown INSTEAD of the exam
 * content / instead of the tether-launch page's automatic-relaunch view
 * whenever the authoritative recovery state
 * (GET /api/submissions/[id]/recovery-status) is MANUAL_REVIEW_REQUIRED.
 * See src/lib/tetherRecovery.ts's RECOVERY_STATE_COPY for the single
 * source of the exact required title/message text — never duplicated
 * here as a literal, so the two can never drift apart.
 *
 * Deliberately does nothing on its own: no auto-retry, no re-fetch, no
 * SecureClientSession creation — the caller (the exam page / the
 * tether-launch page) is responsible for having already stopped its own
 * automatic retry loop before rendering this. Never exposes installation
 * ids, public keys, fingerprints, signatures, or internal error detail —
 * the exact copy below is the only thing shown.
 */
import { RECOVERY_STATE_COPY } from "@/lib/tetherRecovery";

export function ManualReviewNotice({ pendingCount }: { pendingCount?: number }) {
  const copy = RECOVERY_STATE_COPY.MANUAL_REVIEW_REQUIRED;
  return (
    <div className="mx-auto mt-16 max-w-md rounded border border-amber-200 bg-amber-50 p-6 text-center">
      <div role="status" aria-live="polite">
        <h1 className="text-lg font-medium text-amber-900">Recovery requires support</h1>
        <p className="mt-3 text-sm text-amber-800">{copy.detail}</p>
        {/* Reuses the exact approved product phrase already used by
            RecoveryStatusBanner — pending drafts are never cleared and
            remain queued locally through manual review. */}
        {typeof pendingCount === "number" && pendingCount > 0 && (
          <p className="mt-3 text-xs text-amber-700">{`Changes waiting to save (${pendingCount}).`}</p>
        )}
      </div>
      <a
        href="/student/dashboard"
        className="mt-5 inline-block rounded border border-amber-400 px-4 py-2 text-sm font-medium text-amber-900 focus:outline-none focus:ring-2 focus:ring-amber-500"
      >
        Return to dashboard
      </a>
    </div>
  );
}
