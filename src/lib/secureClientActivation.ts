/**
 * Tether v1.7.4 pre-exam readiness — the single source of truth for
 * "does a secure-client-required attempt's server-side native-lockdown
 * activation gate allow content/timer exposure yet". See
 * docs/tether-preflight-lifecycle-v1.7.4.md.
 *
 * Pure, dependency-free: no Prisma, no Next.js. Every content-bearing
 * route (GET /api/submissions/[id], the one-question-at-a-time routes,
 * answers, submit) and the new POST /api/submissions/[id]/activate
 * endpoint must go through this module rather than re-deriving the
 * check inline, so the gate can never drift between call sites.
 */
import { deliveryModeRequiresSecureClient, parseSecureClientPolicy, type SecureClientPolicy } from "@/lib/secureClientPolicy";

/**
 * True only for the delivery modes where native lockdown activation is a
 * real prerequisite (TETHER_CLIENT_REQUIRED, SEB_REQUIRED) — every other
 * mode (STANDARD_WEB, MONITORED_WEB, the two OPTIONAL modes) has nothing
 * to gate: `activatedAt` is stamped immediately at submission creation
 * for those (see POST /api/exams/[id]/start), so this predicate — not
 * `activatedAt` alone — is what a caller should branch on when deciding
 * whether the activation flow applies at all.
 */
export function submissionRequiresActivation(policy: Pick<SecureClientPolicy, "deliveryMode">): boolean {
  return deliveryModeRequiresSecureClient(policy.deliveryMode);
}

export type ActivationGateSubmission = {
  activatedAt: Date | null;
  secureClientPolicySnapshotJson: unknown;
};

/**
 * The ONE gate every content-bearing route must pass before returning
 * question text/options/answers/a running deadline, or accepting an
 * answer save/final submission. Reads the attempt's own FROZEN policy
 * snapshot (never live exam settings — the existing immutable-snapshot
 * convention this repo already uses everywhere else), so a lecturer
 * editing an exam's delivery mode after a student has already started
 * can never retroactively change what THIS attempt requires.
 *
 * A malformed/missing snapshot parses to STANDARD_WEB
 * (parseSecureClientPolicy's own fail-safe default), which never
 * requires activation — matching "a null snapshot always means legacy
 * behaviour", the same invariant every other secure-client check in
 * this codebase already relies on.
 */
export function isSubmissionContentAccessible(submission: ActivationGateSubmission): boolean {
  const policy = parseSecureClientPolicy(submission.secureClientPolicySnapshotJson);
  if (!submissionRequiresActivation(policy)) return true;
  return submission.activatedAt != null;
}

/** The bounded, non-content error code every gated route returns instead of question text/options/answers/deadline. Never a 2xx — see each call site for the exact status used. */
export const EXAM_NOT_ACTIVATED_CODE = "EXAM_NOT_ACTIVATED";
export const EXAM_NOT_ACTIVATED_MESSAGE =
  "This examination has not been activated yet. Return to Tether Secure Browser and complete the secure activation step.";
