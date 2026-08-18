/**
 * Canvas/LTI identity-collision hardening v1 — see
 * docs/lti-identity-collision-hardening-v1.md.
 *
 * Fixes a real defect: if a Canvas launch has no existing canvasUserId
 * mapping but supplies an email that already belongs to an existing
 * Tether User (typically a self-service account), the launch route used
 * to call `prisma.user.create({data: {email, ...}})` unconditionally —
 * colliding with `User.email`'s unique constraint and crashing with an
 * unhandled P2002.
 *
 * This module is called ONLY after that exact collision is detected
 * (Canvas email matches an existing User with no canvasUserId match) —
 * see the launch route's own "Step B" comment for where. It never
 * creates a User; it only decides whether the CURRENT browser session
 * proves ownership of the existing account and, if so, safely binds the
 * Canvas identity to it.
 *
 * Security model: email alone is never sufficient to link accounts
 * (self-service emails are not verified strongly enough for that). The
 * only accepted proof of ownership is: the browser making this exact
 * launch request is ALREADY authenticated (via the normal Tether/
 * Auth.js session cookie) as the exact existing User whose email
 * matches. A signed Canvas launch alone proves the Canvas identity; an
 * authenticated Tether session alone proves Tether-account control;
 * together, on the SAME request, they prove the person deliberately
 * connected the two. Neither the Canvas email nor any client-supplied
 * value is ever trusted to determine which existing User is linked —
 * only `currentSessionUserId`, which the caller must derive from
 * `auth()` (the server-verified session), never from a request body or
 * query string.
 */
import { prisma } from "@/lib/prisma";

export type LtiCollisionOutcome =
  | { kind: "requires_login" }
  | { kind: "wrong_account" }
  | { kind: "role_mismatch" }
  | { kind: "different_institution" }
  | { kind: "canvas_id_taken" }
  | { kind: "linked"; userId: string };

class CanvasIdConflictError extends Error {
  constructor() {
    super("canvasUserId is already bound to a different User in this scope");
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "P2002"
  );
}

export async function resolveLtiEmailCollision(params: {
  /** The User.id found by looking up the Canvas-supplied email — the collision candidate. */
  existingUserId: string;
  canvasUserId: string;
  derivedRole: "LECTURER" | "STUDENT";
  /** LtiPlatform.institutionId — nullable; see the null-platform handling below. */
  platformInstitutionId: string | null;
  /** The id of the User the CURRENT browser session (from auth(), never a client-supplied value) is authenticated as, or null if unauthenticated. */
  currentSessionUserId: string | null;
}): Promise<LtiCollisionOutcome> {
  if (!params.currentSessionUserId) {
    return { kind: "requires_login" };
  }
  if (params.currentSessionUserId !== params.existingUserId) {
    return { kind: "wrong_account" };
  }

  // Ownership confirmed — everything from here on is one atomic
  // transaction. If anything after a write fails, the write must roll
  // back too; see the throw/catch around the canvasUserId bind below.
  const outcome = await prisma
    .$transaction(async (tx): Promise<LtiCollisionOutcome> => {
      const existing = await tx.user.findUnique({ where: { id: params.existingUserId } });
      if (!existing) return { kind: "wrong_account" };

      // Rule 9 — never silently change STUDENT <-> LECTURER because
      // Canvas reports a different role. No write has happened yet, so
      // an early return here is safe.
      if (existing.role !== params.derivedRole) {
        return { kind: "role_mismatch" };
      }

      // Upfront canvasUserId-ownership check — same scoping fallback the
      // existing mapped-user lookup already uses (src/app/api/lti/launch/route.ts):
      // scoped to the platform's institution when known, otherwise a
      // broad fallback. This is the fast path; the P2002 catch below on
      // the actual bind is the race-safety backstop (see docs).
      const canvasIdOwner = params.platformInstitutionId
        ? await tx.user.findUnique({
            where: {
              institutionId_canvasUserId: {
                institutionId: params.platformInstitutionId,
                canvasUserId: params.canvasUserId,
              },
            },
          })
        : await tx.user.findFirst({ where: { canvasUserId: params.canvasUserId } });
      if (canvasIdOwner && canvasIdOwner.id !== existing.id) {
        return { kind: "canvas_id_taken" };
      }

      // Institution compatibility (rules 6-8). No write has happened
      // yet in any branch below except the conditional claim, which is
      // itself a no-op if it doesn't match — so every early return here
      // is still safe without an explicit rollback.
      if (
        existing.institutionId != null &&
        params.platformInstitutionId != null &&
        existing.institutionId !== params.platformInstitutionId
      ) {
        // Rule 6 — never move an account between institutions.
        return { kind: "different_institution" };
      }

      if (existing.institutionId == null && params.platformInstitutionId != null) {
        // Rule 7 — the only institutionId write this module ever makes:
        // null -> platform's institution, and only after ownership is
        // confirmed. Atomic conditional claim (mirrors Tether Course
        // Invitation + Acceptance v1's own User-row claim in
        // src/app/api/course-invitations/[invitationId]/[token]/accept/route.ts)
        // so two concurrent collisions for two DIFFERENT institutions on
        // the same null-institution account can never both succeed.
        const claim = await tx.user.updateMany({
          where: { id: existing.id, institutionId: null },
          data: { institutionId: params.platformInstitutionId },
        });
        if (claim.count !== 1) {
          const fresh = await tx.user.findUnique({
            where: { id: existing.id },
            select: { institutionId: true },
          });
          if (fresh?.institutionId !== params.platformInstitutionId) {
            // A different institution won the race — nothing written by
            // this branch (0 rows matched), safe to return directly.
            return { kind: "different_institution" };
          }
          // else: already exactly this institution — idempotent, fall through.
        }
      }
      // If platformInstitutionId is null: rule 5's carve-out — the
      // platform hasn't been institution-backfilled. Preserve existing
      // compatibility (the pre-existing mapped-user launch path already
      // tolerates this with zero institution enforcement) and do not
      // invent institution membership: institutionId is left exactly as
      // it was, in every case, including when the existing account
      // already has a non-null institutionId of its own.

      try {
        const updated = await tx.user.update({
          where: { id: existing.id },
          data: { canvasUserId: params.canvasUserId },
        });
        return { kind: "linked", userId: updated.id };
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          // Race-safety backstop: a concurrent request bound this exact
          // canvasUserId (in this exact institution scope) to a
          // different User between our upfront check and this write.
          // MUST throw (not return) so any institutionId claim already
          // committed earlier in this same transaction rolls back too.
          throw new CanvasIdConflictError();
        }
        throw err;
      }
    })
    .catch((err) => {
      if (err instanceof CanvasIdConflictError) {
        return { kind: "canvas_id_taken" as const };
      }
      throw err;
    });

  return outcome;
}
