/**
 * Self-Service Account Onboarding v1 — see
 * docs/self-service-account-onboarding-v1.md.
 *
 * Public, unauthenticated. Account creation does NOT grant exam access —
 * see that doc for the full model. STUDENT gets institutionId: null (no
 * institution, no DEFAULT_INSTITUTION_SLUG membership, no course
 * enrolment, no ExamAssignment). LECTURER gets a brand-new Institution +
 * User created atomically — never an existing institution, never a
 * caller-chosen slug. PLATFORM_ADMIN can never be self-created (rejected
 * by the schema itself, since the request body must discriminate on
 * role: "STUDENT" | "LECTURER").
 */
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import {
  selfServiceSignupSchema,
  generateInstitutionSlugCandidate,
  MAX_SLUG_ATTEMPTS,
  type LecturerSignupInput,
} from "@/lib/selfServiceSignup";

function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "P2002"
  );
}

async function createStudent(input: { name: string; email: string; password: string }) {
  const passwordHash = await bcrypt.hash(input.password, 12);
  try {
    const user = await prisma.user.create({
      data: {
        name: input.name,
        email: input.email,
        passwordHash,
        role: "STUDENT",
        // Deliberately no institutionId lookup/default here — a
        // self-service student is a global Tether identity awaiting
        // later entitlement (Canvas / Tether Course / Standalone Exam
        // Link), never auto-joined to any institution.
        institutionId: null,
      },
      select: { id: true, email: true },
    });
    return NextResponse.json({ id: user.id, email: user.email }, { status: 201 });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return NextResponse.json({ error: "Email already registered" }, { status: 409 });
    }
    throw err;
  }
}

async function createLecturerWorkspace(input: LecturerSignupInput) {
  const passwordHash = await bcrypt.hash(input.password, 12);

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const slug = generateInstitutionSlugCandidate(input.organisationName, attempt);
    try {
      const { lecturer } = await prisma.$transaction(async (tx) => {
        // Institution + Lecturer created inside one transaction — never
        // an institution without a lecturer, never a lecturer without
        // an institution. `plan: "pilot"` matches every other
        // self-service/manually-created institution's default in this
        // codebase (see src/lib/platformAdmin.ts's validateInstitutionPayload).
        const institution = await tx.institution.create({
          data: { name: input.organisationName, slug, plan: "pilot", active: true },
        });
        const lecturer = await tx.user.create({
          data: {
            name: input.name,
            email: input.email,
            passwordHash,
            role: "LECTURER",
            institutionId: institution.id,
          },
          select: { id: true, email: true },
        });
        // Auditability (Section 6) — actor is the newly-created lecturer
        // themselves (no admin performed this action); metadata is
        // limited to non-secret display fields, never the password or
        // its hash. Same transaction as the institution/user rows, so
        // this can never exist without them or vice versa.
        await tx.platformAuditLog.create({
          data: {
            actorId: lecturer.id,
            action: "institution.self_service_create",
            targetType: "Institution",
            targetId: institution.id,
            institutionId: institution.id,
            metadata: { name: institution.name, slug: institution.slug },
          },
        });
        return { institution, lecturer };
      });

      return NextResponse.json({ id: lecturer.id, email: lecturer.email }, { status: 201 });
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;

      // A P2002 inside this transaction is either an email race (another
      // request registered the same email between our pre-check and this
      // write) or a slug collision (two organisations sanitizing to the
      // same base slug, or an extremely unlucky suffix collision).
      // Re-check which one actually happened rather than parsing
      // Postgres/Prisma error internals — robust across driver/error
      // shape differences, and never leaks a raw Prisma error to the
      // client either way.
      const emailNowExists = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
      if (emailNowExists) {
        return NextResponse.json({ error: "Email already registered" }, { status: 409 });
      }
      // Otherwise treat it as a slug collision and retry with a new
      // server-generated suffix — never a 500 for this ordinary case.
    }
  }

  return NextResponse.json(
    { error: "Could not create your workspace right now. Please try again." },
    { status: 500 },
  );
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = selfServiceSignupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  // Pre-check, same convention as the existing invite-lecturer/invite-
  // student routes — a clean, fast 409 for the ordinary case; the P2002
  // handling above is the race-condition backstop, not the primary path.
  const existing = await prisma.user.findUnique({ where: { email: parsed.data.email }, select: { id: true } });
  if (existing) {
    return NextResponse.json({ error: "Email already registered" }, { status: 409 });
  }

  if (parsed.data.role === "STUDENT") {
    return createStudent(parsed.data);
  }
  return createLecturerWorkspace(parsed.data);
}

export const dynamic = "force-dynamic";
