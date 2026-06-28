/**
 * Multi-Tenant Architecture v1 — institution scoping helpers.
 * See docs/multi-tenant-migration.md for the migration plan and
 * docs/known-limitations.md for what v1 does and does not isolate.
 *
 * institutionId is nullable at the database level (see prisma/schema.prisma)
 * but treated as required by application code via requireInstitutionId().
 * A null institutionId on an active session is a data-integrity problem,
 * not a "no scoping" fallback — every helper here fails loudly rather than
 * silently returning an unscoped result.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const DEFAULT_INSTITUTION_SLUG = "default";

type SessionLike = {
  user?: {
    institutionId?: string | null;
    role?: string | null;
  } | null;
} | null;

/** Returns the caller's institutionId, or null if absent (e.g. a stale session minted before this field existed). Never throws. */
export function getSessionInstitutionId(session: SessionLike): string | null {
  return session?.user?.institutionId ?? null;
}

/**
 * True only for the PLATFORM_ADMIN role. This is the single choke point
 * every cross-institution bypass goes through — never inline a role check
 * against "PLATFORM_ADMIN" anywhere else, so an audit only has to read
 * this one function to find every place admin status is determined.
 */
export function isPlatformAdmin(session: SessionLike): boolean {
  return session?.user?.role === "PLATFORM_ADMIN";
}

/**
 * Throws if the session has no institutionId. Use at the top of any route
 * that must not proceed with ambiguous tenancy. Returns the institutionId
 * on success. A thrown error here should be mapped by the caller to a
 * "Please log in again to continue" response — it most commonly means an
 * old JWT was minted before institutionId existed.
 */
export function requireInstitutionId(session: SessionLike): string {
  const id = getSessionInstitutionId(session);
  if (!id) {
    throw new MissingInstitutionError();
  }
  return id;
}

export class MissingInstitutionError extends Error {
  constructor() {
    super("Session is missing institutionId — please log in again to continue.");
  }
}

/**
 * A Prisma `where` fragment for institution filtering, or `{}` (no filter)
 * for a PLATFORM_ADMIN. Spread into any findMany/findFirst where clause:
 * `where: { ...institutionWhere(session), published: true }`.
 */
export function institutionWhere(session: SessionLike): { institutionId?: string } {
  if (isPlatformAdmin(session)) return {};
  return { institutionId: requireInstitutionId(session) };
}

/**
 * Throws InstitutionAccessError unless the given institutionId matches the
 * session's institution, or the session is a PLATFORM_ADMIN. Always calls
 * requireInstitutionId() first (rather than comparing possibly-null values
 * directly) so a session with no institutionId fails loudly with
 * MissingInstitutionError every time — never silently passes by matching
 * `null === null` against an unbackfilled resource.
 */
export function assertSameInstitution(session: SessionLike, institutionId: string | null): void {
  if (isPlatformAdmin(session)) return;
  if (requireInstitutionId(session) !== institutionId) {
    throw new InstitutionAccessError();
  }
}

export class InstitutionAccessError extends Error {
  constructor() {
    super("Resource belongs to a different institution");
  }
}

/**
 * Fetches the exam by id and asserts institution access. Returns null if
 * not found (caller maps to 404); throws InstitutionAccessError if found
 * but in a different institution (caller maps to 403, with a generic
 * message — never confirm the resource's existence to an attacker probing
 * IDs across institutions).
 */
export async function scopedExamFetch(session: SessionLike, examId: string) {
  const exam = await prisma.exam.findUnique({ where: { id: examId } });
  if (!exam) return null;
  assertSameInstitution(session, exam.institutionId);
  return exam;
}

/**
 * Fetches the submission (with its exam included) by id and asserts
 * institution access via submission.exam.institutionId — Submission has
 * no institutionId column of its own by design (see
 * docs/multi-tenant-migration.md, "what does and does not get
 * institutionId").
 */
export async function scopedSubmissionFetch(session: SessionLike, submissionId: string) {
  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: { exam: true },
  });
  if (!submission) return null;
  assertSameInstitution(session, submission.exam.institutionId);
  return submission;
}

/**
 * Maps the institution-scoping errors above to a NextResponse, or returns
 * null if the error isn't one of ours (caller should rethrow/handle it).
 * Use in a catch block: `const res = institutionErrorResponse(err); if (res) return res; throw err;`
 */
export function institutionErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof MissingInstitutionError) {
    return NextResponse.json({ error: "Please log in again to continue." }, { status: 401 });
  }
  if (err instanceof InstitutionAccessError) {
    return NextResponse.json({ error: "Not found" }, { status: 403 });
  }
  return null;
}
