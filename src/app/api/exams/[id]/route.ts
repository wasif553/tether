import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseSecureSettings, secureSettingsInputSchema } from "@/lib/secureExam";
import { secureClientAvailabilityForInstitution } from "@/lib/secureClientAvailability";
import { isDisplayPolicyCombinationValid, resolveEffectiveDeliveryMode } from "@/lib/secureClientPolicy";
import { applyMandatoryFinalExaminationPolicy, isFinalExaminationPolicyEstablished } from "@/lib/assessmentType";
import type { Prisma } from "@/generated/prisma/client";
import { assertSameInstitution, institutionWhere, institutionErrorResponse, requireInstitutionId } from "@/lib/institutionScope";
import { assertCanAssignExamToCourse, assertStudentsInCourse, CourseAssignmentError } from "@/lib/courseAssignment";
import { createPlatformAuditLog } from "@/lib/platformAdmin";

const updateExamSchema = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    durationMins: z.number().int().positive().optional(),
    published: z.boolean().optional(),
    startsAt: z.string().datetime().optional().nullable(),
    endsAt: z.string().datetime().optional().nullable(),
    secureSettings: secureSettingsInputSchema.optional(),
    // Student Onboarding and Exam Access v1 — see
    // docs/student-onboarding-and-exam-access.md. undefined = leave
    // unchanged, null = clear the code, a string = set a new code.
    accessCode: z.string().min(4).nullable().optional(),
    // Course, Enrolment, Exam Assignment, Scheduling v1 — see
    // docs/course-enrolment-and-exam-assignment.md. courseId: null clears
    // the course link (reverts to a legacy institution-wide exam).
    courseId: z.string().min(1).nullable().optional(),
    assignmentMode: z.enum(["COURSE", "SELECTED_STUDENTS"]).optional(),
    // Replaces the full selected-student list when provided (and
    // assignmentMode is SELECTED_STUDENTS) — not an incremental add.
    selectedStudentIds: z.array(z.string().min(1)).optional(),
    availableFrom: z.string().datetime().nullable().optional(),
    availableUntil: z.string().datetime().nullable().optional(),
  })
  .refine(
    (data) =>
      !data.availableFrom || !data.availableUntil || data.availableUntil > data.availableFrom,
    { message: "availableUntil must be after availableFrom", path: ["availableUntil"] },
  );

/**
 * `secureSettingsInputSchema` is `secureExamSettingsSchema.partial()`, but
 * Zod's `.partial()` does NOT leave a field the caller omitted as
 * `undefined` when that field has a `.default(...)` — it fills it with the
 * schema default instead (confirmed against the zod version this project
 * pins). So `parsed.data.secureSettings` is always a FULL object, and a
 * genuinely partial request body like `{ allowLateSubmit: true }` cannot be
 * told apart from `{ allowLateSubmit: true, assessmentType: "QUIZ_OR_TEST",
 * deliveryMode: "STANDARD_WEB", ... }` by looking at `parsed.data` alone.
 * Spreading that straight over the exam's current settings would silently
 * reset every field the caller never mentioned back to its default. This
 * reads the field names from the RAW (pre-Zod) request body to know what
 * was actually submitted, then picks only those keys from the
 * Zod-validated/coerced values.
 */
function pickSubmittedSecureSettings<T extends object>(parsedSecureSettings: T, rawSecureSettings: unknown): Partial<T> {
  if (rawSecureSettings == null || typeof rawSecureSettings !== "object") return {};
  const submittedKeys = new Set(Object.keys(rawSecureSettings as Record<string, unknown>));
  return Object.fromEntries(
    Object.entries(parsedSecureSettings).filter(([key]) => submittedKeys.has(key)),
  ) as Partial<T>;
}

/** Strips accessCodeHash from any exam object before it's ever sent in a response. */
function omitAccessCodeHash<T extends { accessCodeHash?: string | null }>(
  exam: T,
): Omit<T, "accessCodeHash"> {
  const rest: Partial<T> = { ...exam };
  delete rest.accessCodeHash;
  return rest as Omit<T, "accessCodeHash">;
}

async function getOwnedExam(examId: string, lecturerId: string, session: Parameters<typeof institutionWhere>[0]) {
  return prisma.exam.findFirst({
    where: { id: examId, createdById: lecturerId, ...institutionWhere(session) },
    // Mandatory Tether Delivery for Final Examinations — the publish gate
    // below needs the exam's own institution slug to resolve real
    // secure-client availability, exactly like the student start route
    // already does.
    include: { institution: { select: { slug: true } } },
  });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  try {
    const exam = await prisma.exam.findUnique({
      where: { id },
      include: {
        questions: { orderBy: { order: "asc" } },
        // Question Pools v1 — see docs/question-pools-v1.md. Lecturer-only
        // (stripped from the student-facing response below) — a student
        // must never see pool names/draw counts/which questions are in a
        // pool.
        questionPools: { orderBy: { order: "asc" } },
        // Hardening pass — institution slug drives SEB_REQUIRED
        // availability (see secureClientAvailabilityForInstitution below).
        institution: { select: { slug: true } },
      },
    });

    if (!exam) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Both the lecturer-owner path and the student-view path are direct-ID
    // access — assert institution membership before any role-specific
    // branching below, so a student/lecturer in another institution gets a
    // generic 403/404 rather than reaching the data at all.
    assertSameInstitution(session, exam.institutionId);

    if (session.user.role === "LECTURER" && exam.createdById !== session.user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Secure Exam Mode settings are not sensitive — students need them to
    // know whether fullscreen is required, copy/paste is blocked, etc.
    const secureSettings = parseSecureSettings(exam.secureSettings);
    // Hardening pass (Part 4) — booleans only, no secret material; lets
    // the lecturer settings UI grey out SEB_OPTIONAL/SEB_REQUIRED and show
    // "Compatibility validation required" instead of silently letting a
    // lecturer pick a mode that resolveEffectiveDeliveryMode will
    // downgrade to STANDARD_WEB at attempt start anyway.
    const secureClientAvailability = secureClientAvailabilityForInstitution(exam.institution?.slug ?? null);

    if (session.user.role === "STUDENT") {
      if (!exam.published) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      // Question Pools v1 — a student must never see pool names, draw
      // counts, or which pool a question belongs to (see
      // docs/question-pools-v1.md, "What students see").
      const examWithoutPools = { ...omitAccessCodeHash(exam) } as Partial<typeof exam>;
      delete examWithoutPools.questionPools;
      const sanitized = {
        ...examWithoutPools,
        secureSettings,
        secureClientAvailability,
        questions: exam.questions.map((q) => ({ ...q, correctAnswer: undefined, questionPoolId: undefined })),
      };
      return NextResponse.json(sanitized);
    }

    return NextResponse.json({ ...omitAccessCodeHash(exam), secureSettings, secureClientAvailability });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id } = await params;
    const exam = await getOwnedExam(id, session.user.id, session);
    if (!exam) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const body = await req.json();
    const parsed = updateExamSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const {
      startsAt,
      endsAt,
      secureSettings,
      accessCode,
      courseId,
      assignmentMode,
      selectedStudentIds,
      availableFrom,
      availableUntil,
      ...rest
    } = parsed.data;

    const rawMergedSecureSettings = secureSettings
      ? parseSecureSettings({
          ...parseSecureSettings(exam.secureSettings),
          ...pickSubmittedSecureSettings(secureSettings, (body as { secureSettings?: unknown } | null)?.secureSettings),
        })
      : undefined;

    // Mandatory Tether Delivery for Final Examinations — "automatically
    // normalise during draft save" (the recommended approach): whenever
    // the effective assessmentType is FINAL_EXAMINATION, the delivery/
    // display fields are force-set to the mandatory policy regardless of
    // what the lecturer's draft said — a lecturer can never save a final
    // examination as Standard Web (or any other non-Tether mode) no
    // matter what the request body contains. A complete no-op for every
    // other assessment type, so existing delivery-mode choices for
    // quizzes/practice tests/mid-semester exams are always preserved.
    const mergedSecureSettings = rawMergedSecureSettings
      ? applyMandatoryFinalExaminationPolicy(rawMergedSecureSettings.assessmentType, rawMergedSecureSettings)
      : undefined;

    // Single Display Requirement v1 — server-side authoritative check
    // (never just the lecturer UI's own client-side guard). Validated
    // against the MERGED (and now normalised) settings, not the raw PATCH
    // body alone, so a request that only updates displayPolicy, leaving a
    // previously-saved STANDARD_WEB deliveryMode untouched, is still
    // caught — see isDisplayPolicyCombinationValid in
    // src/lib/secureClientPolicy.ts. Normalisation above already makes
    // this always pass for a final examination; this remains the
    // authoritative check for every other assessment type.
    if (mergedSecureSettings && !isDisplayPolicyCombinationValid(mergedSecureSettings.deliveryMode, mergedSecureSettings.displayPolicy)) {
      return NextResponse.json(
        {
          error:
            "Single display required needs a display-aware exam client (Tether Secure Browser or Safe Exam Browser, required or optional). Change the exam delivery mode first, or choose No display restriction.",
        },
        { status: 400 },
      );
    }

    // Mandatory Tether Delivery for Final Examinations — "reject
    // publication only if the final invariant still cannot be
    // established" (the recommended approach's other half). Normalisation
    // above already guarantees the STORED policy is nominally correct for
    // a final examination; this checks the AVAILABILITY-RESOLVED
    // effective delivery mode, so publishing is refused if Tether Secure
    // Browser has genuinely become unavailable (e.g. the
    // TETHER_CLIENT_REQUIRED_DISABLED emergency kill switch) even though
    // the stored settings still nominally say TETHER_CLIENT_REQUIRED —
    // never a silent downgrade to an ordinary-browser final exam. Reads
    // the settings this update would actually leave in place, whether or
    // not secureSettings was part of THIS request (a request that only
    // flips published:true, leaving a previously-classified final exam's
    // settings untouched, is still gated here).
    const effectivePublished = rest.published !== undefined ? rest.published : exam.published;
    if (effectivePublished) {
      const effectiveSettingsForGate = mergedSecureSettings ?? parseSecureSettings(exam.secureSettings);
      const availabilityForGate = secureClientAvailabilityForInstitution(exam.institution?.slug ?? null);
      const effectiveDeliveryModeForGate = resolveEffectiveDeliveryMode(effectiveSettingsForGate.deliveryMode, availabilityForGate);
      if (!isFinalExaminationPolicyEstablished(effectiveSettingsForGate.assessmentType, effectiveDeliveryModeForGate)) {
        return NextResponse.json(
          {
            error:
              "This exam is classified as a final examination and requires Tether Secure Browser, which is not currently available. Contact your institution administrator, or change the assessment type before publishing.",
            code: "FINAL_EXAMINATION_TETHER_UNAVAILABLE",
          },
          { status: 400 },
        );
      }
    }

    // accessCode: undefined leaves it untouched, null clears it, a string
    // sets a new one. The plaintext code is never stored — only its hash.
    let accessCodeFields: { accessCodeHash: string | null; accessCodeRequired: boolean } | undefined;
    if (accessCode === null) {
      accessCodeFields = { accessCodeHash: null, accessCodeRequired: false };
    } else if (typeof accessCode === "string") {
      accessCodeFields = { accessCodeHash: await bcrypt.hash(accessCode, 12), accessCodeRequired: true };
    }

    // Course/assignment: courseId undefined leaves it untouched, null
    // clears it (reverts to legacy institution-wide exam), a string sets
    // it — but only after verifying the lecturer teaches that course.
    const effectiveCourseId = courseId !== undefined ? courseId : exam.courseId;
    if (courseId) {
      await assertCanAssignExamToCourse(session, courseId);
    }
    if (
      effectiveCourseId &&
      (assignmentMode === "SELECTED_STUDENTS" || (assignmentMode === undefined && exam.assignmentMode === "SELECTED_STUDENTS")) &&
      selectedStudentIds
    ) {
      await assertStudentsInCourse(effectiveCourseId, selectedStudentIds);
    }

    const updated = await prisma.exam.update({
      where: { id },
      data: {
        ...rest,
        ...(accessCodeFields ?? {}),
        ...(courseId !== undefined ? { courseId } : {}),
        ...(assignmentMode !== undefined ? { assignmentMode } : {}),
        ...(startsAt !== undefined ? { startsAt: startsAt ? new Date(startsAt) : null } : {}),
        ...(endsAt !== undefined ? { endsAt: endsAt ? new Date(endsAt) : null } : {}),
        ...(availableFrom !== undefined
          ? { availableFrom: availableFrom ? new Date(availableFrom) : null }
          : {}),
        ...(availableUntil !== undefined
          ? { availableUntil: availableUntil ? new Date(availableUntil) : null }
          : {}),
        ...(mergedSecureSettings
          ? { secureSettings: mergedSecureSettings as Prisma.InputJsonValue }
          : {}),
        // selectedStudentIds replaces the full ExamAssignment set for this
        // exam — deleteMany + create in the same update call via nested
        // writes so it's atomic with the rest of the PATCH.
        ...(selectedStudentIds
          ? {
              assignments: {
                deleteMany: {},
                create: selectedStudentIds.map((studentId) => ({ studentId })),
              },
            }
          : {}),
      },
    });

    // Individual Exam Timing & Accommodations v1 — audit standard-duration
    // edits. This route has no other audit logging today (confirmed: no
    // other PATCH here writes a PlatformAuditLog entry), so this cannot
    // duplicate an existing event. Never blocks the response. Editing the
    // standard duration never touches any existing Submission — see
    // src/lib/assessmentLifecycle.ts's resolveSubmissionTimingPolicy,
    // which freezes each attempt's own duration at start time.
    if (rest.durationMins !== undefined && rest.durationMins !== exam.durationMins) {
      createPlatformAuditLog({
        actorId: session.user.id,
        action: "EXAM_STANDARD_DURATION_UPDATED",
        targetType: "Exam",
        targetId: id,
        institutionId: requireInstitutionId(session),
        metadata: { examId: id, previousDurationMins: exam.durationMins, newDurationMins: rest.durationMins },
      }).catch(() => {});
    }

    return NextResponse.json({
      ...omitAccessCodeHash(updated),
      secureSettings: parseSecureSettings(updated.secureSettings),
    });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    if (err instanceof CourseAssignmentError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id } = await params;
    const exam = await getOwnedExam(id, session.user.id, session);
    if (!exam) return NextResponse.json({ error: "Not found" }, { status: 404 });

    await prisma.exam.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export const dynamic = "force-dynamic";
