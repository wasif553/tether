/**
 * Tether Secure Client Foundation v1 — pure workflow-state helpers for
 * the lecturer Secure-client session page's Safe Exam Browser
 * configuration section. See
 * src/app/lecturer/exams/[id]/secure-client/page.tsx and
 * docs/secure-client-foundation-seb-v1.md.
 *
 * Pure, dependency-free: no Prisma, no Next.js, no browser APIs. Mirrors
 * the pattern in src/lib/secureClientPolicy.ts — UI decision logic lives
 * here as plain functions so it stays testable without any
 * jsdom/React-Testing-Library infrastructure (this repo has none).
 */

export const SEB_CONFIGURATION_WORKFLOW_ACTIONS = ["CREATE", "ACTIVATE", "REVOKE"] as const;
export type SebConfigurationWorkflowAction = (typeof SEB_CONFIGURATION_WORKFLOW_ACTIONS)[number];

/**
 * Decides the single primary action button the SEB configuration section
 * should show, from the current SAFE_EXAM_BROWSER configuration's status
 * (or undefined/null when no such configuration exists yet for this
 * exam).
 *
 *  - No configuration (status is null/undefined): CREATE. This is the
 *    only path that should call PUT .../configuration — it must never
 *    require a Browser Exam Key or Config Key first.
 *  - DRAFT (or any other non-ACTIVE status a configuration could be in):
 *    ACTIVATE. A DRAFT is moved forward, never re-created — the CREATE
 *    action must not be shown again once a configuration exists.
 *  - ACTIVE: REVOKE.
 */
export function resolveSebConfigurationWorkflowAction(status: string | undefined | null): SebConfigurationWorkflowAction {
  if (status == null) return "CREATE";
  if (status === "ACTIVE") return "REVOKE";
  return "ACTIVATE";
}

/**
 * Browser Exam Keys / Config Keys are always optional — never required to
 * create or activate a SEB configuration (see
 * resolveSebConfigurationWorkflowAction, which never depends on key
 * state). This only guards the Add key control against an empty/too-short
 * submission. MIN_SEB_KEY_LENGTH mirrors the server-side bound in
 * src/app/api/lecturer/exams/[examId]/secure-client/seb-keys/route.ts
 * (rawKey: z.string().min(8)) so the button doesn't enable a request the
 * server will reject anyway.
 */
export const MIN_SEB_KEY_LENGTH = 8;

export function isAddSebKeyDisabled(rawKeyValue: string): boolean {
  return rawKeyValue.length < MIN_SEB_KEY_LENGTH;
}
