/**
 * Self-Service Account Onboarding v1 — see
 * docs/self-service-account-onboarding-v1.md.
 *
 * Pure validation/slug helpers, no Prisma. Account creation does NOT
 * grant exam access — a self-service STUDENT gets institutionId: null
 * (a global Tether identity awaiting later entitlement via Canvas/Tether
 * Course/Standalone Exam Link, none of which are implemented here); a
 * self-service LECTURER always gets a brand-new Institution, never an
 * existing one. Public role choices are exactly STUDENT and LECTURER —
 * PLATFORM_ADMIN, an arbitrary institutionId, or an arbitrary slug are
 * never accepted from the client (the `.strict()` schemas below reject
 * any such extra/unrecognized field outright, rather than silently
 * ignoring it).
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { sanitizeInstitutionSlug } from "@/lib/platformAdmin";

const nameSchema = z.string().trim().min(1, "name is required");
const emailSchema = z.string().trim().toLowerCase().email("a valid email is required");
// Exported so Password Reset v1 (src/lib/passwordReset.ts) enforces the
// exact same minimum as self-service signup — see
// docs/password-reset-v1.md. Keep this the single source of truth for
// Tether's password-strength floor rather than duplicating "8" elsewhere.
export const passwordSchema = z.string().min(8, "password must be at least 8 characters");

export const studentSignupSchema = z
  .object({
    name: nameSchema,
    email: emailSchema,
    password: passwordSchema,
    role: z.literal("STUDENT"),
  })
  .strict();

export const lecturerSignupSchema = z
  .object({
    name: nameSchema,
    email: emailSchema,
    password: passwordSchema,
    role: z.literal("LECTURER"),
    organisationName: z.string().trim().min(1, "organisationName is required"),
  })
  .strict();

// A discriminated union on `role` — a body with role: "PLATFORM_ADMIN" (or
// any other value) matches neither branch and is rejected by zod outright,
// which is what keeps PLATFORM_ADMIN un-self-creatable here without a
// separate explicit check. `.strict()` on each branch means an
// institutionId/slug/plan (or, on the student branch, an
// organisationName) present in the body fails validation as an
// "unrecognized key" rather than being silently dropped.
export const selfServiceSignupSchema = z.discriminatedUnion("role", [
  studentSignupSchema,
  lecturerSignupSchema,
]);

export type StudentSignupInput = z.infer<typeof studentSignupSchema>;
export type LecturerSignupInput = z.infer<typeof lecturerSignupSchema>;

/** Bounded retry count for institution-slug collisions — see generateInstitutionSlugCandidate. */
export const MAX_SLUG_ATTEMPTS = 6;

/**
 * Candidate institution slug for attempt N of creating a self-service
 * lecturer workspace. Attempt 0 is always the sanitized organisation name
 * itself (e.g. "Adelaide College" -> "adelaide-college"); every retry
 * appends a short, server-generated, non-sequential suffix so a second
 * lecturer signing up with the same/similar organisation name gets their
 * own distinct workspace rather than colliding forever or joining the
 * first one. Never derived from anything caller-controlled beyond the
 * organisation name text itself, and never guessable/incrementing.
 */
export function generateInstitutionSlugCandidate(organisationName: string, attempt: number): string {
  const base = sanitizeInstitutionSlug(organisationName) || "workspace";
  if (attempt === 0) return base;
  return `${base}-${randomSlugSuffix()}`;
}

function randomSlugSuffix(): string {
  return randomBytes(4).toString("hex"); // 8 lowercase hex chars — short, URL-safe, unguessable.
}
