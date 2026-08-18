/**
 * Tether Course Invitation + Acceptance v1 hardening — see
 * docs/tether-course-invitation-acceptance-v1.md. Course invitation
 * acceptance changes User.institutionId in the database (null -> a
 * course's institution), but a JWT session strategy means the currently
 * authenticated browser's token keeps whatever institutionId it was
 * minted with until the token is refreshed — without this, a student
 * could accept an invitation and still be treated as unaffiliated by
 * requireInstitutionId()/institutionWhere() (src/lib/institutionScope.ts)
 * until they log out and back in.
 *
 * Deliberately narrow: only runs when the client explicitly calls
 * `useSession().update()` (trigger === "update") — an ordinary request
 * never triggers a database read here, exactly the existing behavior.
 * `id` is read from the ALREADY-TRUSTED token (set once, at sign-in, by
 * src/auth.ts's jwt callback from the authorize() result) — never from
 * the client-supplied `session` update payload, which this function
 * doesn't even accept as a parameter. There is therefore no code path by
 * which a caller of `update(data)` can inject an arbitrary
 * institutionId: whatever DB value the User row currently holds for
 * this exact, already-authenticated user id is the only source of truth
 * written back into the token.
 *
 * A separate module (rather than living inline in src/auth.ts) purely
 * so it can be unit-tested without instantiating the full NextAuth
 * config (which requires provider/secret setup irrelevant to this
 * logic).
 */
import { prisma } from "@/lib/prisma";

export async function applyJwtUpdate(
  token: Record<string, unknown>,
  trigger: "signIn" | "signUp" | "update" | undefined,
): Promise<Record<string, unknown>> {
  if (trigger !== "update") return token;
  const id = token.id as string | undefined;
  if (!id) return token;
  const fresh = await prisma.user.findUnique({ where: { id }, select: { institutionId: true } });
  if (fresh) {
    token.institutionId = fresh.institutionId;
  }
  return token;
}
