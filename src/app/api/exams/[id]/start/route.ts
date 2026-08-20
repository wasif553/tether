import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { assertSameInstitution, institutionErrorResponse } from "@/lib/institutionScope";
import { captureNetworkEvidence } from "@/lib/networkEvidence";
import { canCreateAttempt, nextAttemptNumber } from "@/lib/assessmentLifecycle";
import { parseSecureSettings, questionPoolsActive } from "@/lib/secureExam";
import {
  buildOptionOrders,
  buildQuestionOrder,
  buildSelectedQuestionIds,
  type StoredQuestionOrder,
} from "@/lib/questionDelivery";
import { createPlatformAuditLog } from "@/lib/platformAdmin";
import { recordSimpleActivityEvent } from "@/lib/answerActivityTelemetry";
import { buildExamPolicySnapshot, type ExamPolicySnapshot } from "@/lib/examPolicy";
import { buildAiAssistancePolicySnapshot } from "@/lib/aiAssistancePolicy";
import { buildScreenSharePolicySnapshot } from "@/lib/screenSharePolicy";
import { buildAnswerProvenancePolicySnapshot } from "@/lib/answerProvenancePolicy";
import {
  buildSecureClientPolicySnapshot,
  resolveEffectiveDeliveryMode,
  DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
  DEFAULT_HEARTBEAT_GRACE_SECONDS,
  type DeliveryMode,
  type SecureClientAvailability,
} from "@/lib/secureClientPolicy";
import { secureClientAvailabilityForInstitution, isTetherSecureClientBypassAllowed } from "@/lib/secureClientAvailability";
import { getCurrentSessionForSubmission, resolvePriorSessionTrust } from "@/lib/secureClientRunner";
import { resolveSecureClientStartGate, buildTetherLaunchPagePath } from "@/lib/secureClientStartGate";
import { isFinalExaminationPolicyEstablished } from "@/lib/assessmentType";
import { systemCheckMode } from "@/lib/systemCheckConfig";
import { evaluateFinalExamSystemCheckGate } from "@/lib/systemCheck/readiness";
import { parseAttestationRequirement } from "@/lib/tetherAttestationConfig";
import { resolveTrustedTetherVerification } from "@/lib/tetherRecovery";
import { resolveOfflineContinueMs } from "@/lib/tetherRecoveryConfig";
import { submissionRequiresActivation } from "@/lib/secureClientActivation";
import {
  resolveEffectiveExamDurationMins,
  buildExamTimeAccommodationSnapshot,
  isValidExamTimeAccommodationMode,
  InvalidExamTimeAccommodationError,
  type ExamTimeAccommodationAdjustment,
} from "@/lib/examTimeAccommodation";
import { resolveTrustedRequestSource } from "@/lib/security/clientSource";
import { reserveExamAccessCodeSlot, releaseExamAccessCodeSlot } from "@/lib/security/examAccessCodeRateLimit";

// Tether launch/install flow v1 — Requirement 9 ("Production start
// protection"). Additive response field: `{required: false}` for every
// non-Tether exam (the overwhelming majority today), so existing
// callers reading only submission fields (id, examId, etc.) are
// completely unaffected. Only ever computed for TETHER_CLIENT_REQUIRED —
// see resolveSecureClientStartGate, which never touches STANDARD_WEB,
// MONITORED_WEB or any SEB mode.
type SecureClientLaunchField = { required: false } | { required: true; kind: "ALLOW" | "REDIRECT_TO_TETHER_LAUNCH"; redirectTo: string | null };

async function resolveSecureClientLaunchField(params: {
  deliveryMode: DeliveryMode;
  availability: SecureClientAvailability;
  submissionId: string;
  examId: string;
  institutionSlug: string | null;
}): Promise<SecureClientLaunchField> {
  const effectiveDeliveryMode = resolveEffectiveDeliveryMode(params.deliveryMode, params.availability);
  if (effectiveDeliveryMode !== "TETHER_CLIENT_REQUIRED") return { required: false };

  const currentSession = await getCurrentSessionForSubmission(params.submissionId);
  // Secure Client Attestation v2 — see
  // src/lib/tetherAttestationConfig.ts for the full LEGACY/DUAL/V2_REQUIRED
  // truth table this implements. Reads the SESSION's own immutable
  // requirement snapshot (attestationRequirement, set once at session
  // creation) — never the live environment variable, and never any
  // client-supplied version. Tether Secure Exam Recovery v1 — wraps this
  // in resolveTrustedTetherVerification (src/lib/tetherRecovery.ts)
  // rather than calling resolveEffectiveTetherVerification directly, so a
  // session verified before a crash/kill/relaunch eventually stops being
  // trusted once contact has genuinely gone stale (see that function's
  // own doc comment for the exact boundary) — an ordinary short reconnect
  // never crosses it. Uses the DEFAULT heartbeat interval/grace (this
  // function only receives deliveryMode, not the full frozen per-attempt
  // policy) rather than the exact per-exam configured cadence — a
  // deliberately small, documented imprecision; TETHER_OFFLINE_CONTINUE_MINUTES
  // (minimum 2 minutes) dominates the total staleness window regardless.
  // Secure-recovery hardening v1, Part A — resolved unconditionally; see
  // the matching call site in src/app/api/submissions/[id]/route.ts for
  // why this is always safe to compute (falls through to the existing,
  // unmodified truth table for an ordinary non-recovery session).
  const priorSessionTrust = await resolvePriorSessionTrust(currentSession?.recoveryOfSessionId ?? null);
  const hasVerifiedTetherSession = resolveTrustedTetherVerification({
    sessionRequirement: parseAttestationRequirement(currentSession?.attestationRequirement ?? null),
    legacyVerified: currentSession?.verificationStatus === "VERIFIED",
    v2Verified: currentSession?.installationAttestationVerified === true,
    lastHeartbeatAtMs: currentSession?.lastHeartbeatAt?.getTime() ?? null,
    sessionStartedAtMs: currentSession?.startedAt?.getTime() ?? 0,
    nowMs: Date.now(),
    heartbeatPolicy: { heartbeatIntervalSeconds: DEFAULT_HEARTBEAT_INTERVAL_SECONDS, heartbeatGraceSeconds: DEFAULT_HEARTBEAT_GRACE_SECONDS },
    offlineContinueMs: resolveOfflineContinueMs(),
    isRecoverySession: Boolean(currentSession?.recoveryOfSessionId),
    priorSessionTrustedInstallationId: priorSessionTrust.trustedInstallationId,
    priorSessionEverVerified: priorSessionTrust.everVerified,
    priorSessionAttestationRequirement: priorSessionTrust.attestationRequirement,
  });
  const devBypassAllowed = isTetherSecureClientBypassAllowed(params.institutionSlug);
  const gate = resolveSecureClientStartGate({ effectiveDeliveryMode, hasVerifiedTetherSession, devBypassAllowed });
  return {
    required: true,
    kind: gate.kind,
    redirectTo: gate.kind === "REDIRECT_TO_TETHER_LAUNCH" ? buildTetherLaunchPagePath(params.examId) : null,
  };
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const exam = await prisma.exam.findUnique({
    where: { id },
    include: {
      questions: { orderBy: { order: "asc" } },
      // Question Pools v1 — see docs/question-pools-v1.md.
      questionPools: true,
      // Hardening pass — SEB_OPTIONAL/SEB_REQUIRED availability is
      // institution-scoped (see isSebRequiredAllowed below); the exam's
      // OWN institution slug is what matters here, never the requesting
      // student's (they are always the same institution by this point —
      // assertSameInstitution below — but the exam's is the semantically
      // correct value to key the allowlist on).
      institution: { select: { slug: true } },
    },
  });
  if (!exam || !exam.published) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Standalone Exam Link v1 — see docs/standalone-exam-link-v1.md. Same
  // reasoning as GET /api/exams/[id]/access-check: a STANDALONE exam's
  // entitlement is an existing per-student ExamAssignment row, never
  // institution membership — assertSameInstitution is skipped entirely
  // for this mode (it would incorrectly throw for a null-institution
  // student, who is exactly who this mode exists to serve).
  if (exam.assignmentMode === "STANDALONE") {
    const assigned = await prisma.examAssignment.findUnique({
      where: { examId_studentId: { examId: id, studentId: session.user.id } },
    });
    if (!assigned) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  } else {
    try {
      assertSameInstitution(session, exam.institutionId);
    } catch (err) {
      const res = institutionErrorResponse(err);
      if (res) return res;
      throw err;
    }

    // Course, Enrolment, Exam Assignment, Scheduling v1 — see
    // docs/course-enrolment-and-exam-assignment.md. A courseId: null exam
    // is a legacy institution-wide exam and needs no further check here —
    // institution membership above is sufficient, exactly as before this
    // feature. Otherwise the student must be enrolled in the exam's course
    // (assignmentMode COURSE) or directly assigned (SELECTED_STUDENTS).
    if (exam.courseId) {
      const [enrolled, assigned] = await Promise.all([
        exam.assignmentMode === "COURSE"
          ? prisma.courseEnrollment.findUnique({
              where: { courseId_userId: { courseId: exam.courseId, userId: session.user.id } },
            })
          : Promise.resolve(null),
        exam.assignmentMode === "SELECTED_STUDENTS"
          ? prisma.examAssignment.findUnique({
              where: { examId_studentId: { examId: id, studentId: session.user.id } },
            })
          : Promise.resolve(null),
      ]);
      const hasAccess =
        (exam.assignmentMode === "COURSE" && enrolled?.role === "STUDENT") ||
        (exam.assignmentMode === "SELECTED_STUDENTS" && assigned != null);
      if (!hasAccess) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
    }
  }

  const now = new Date();
  // availableFrom/availableUntil are the new explicit scheduling fields;
  // startsAt/endsAt are the pre-existing ones. Both are honored — either
  // set restricts the window, neither set means no restriction.
  const opensAt = exam.availableFrom ?? exam.startsAt ?? null;
  const closesAt = exam.availableUntil ?? exam.endsAt ?? null;
  if (opensAt && now < opensAt) {
    return NextResponse.json({ error: "Exam has not started yet" }, { status: 403 });
  }
  if (closesAt && now > closesAt) {
    return NextResponse.json({ error: "Exam window has closed" }, { status: 403 });
  }

  const settings = parseSecureSettings(exam.secureSettings);
  // Tether Secure Client Foundation + Safe Exam Browser Compatibility v1
  // — see docs/secure-client-foundation-seb-v1.md. Computed once, up
  // front, so both the idempotent-resume branch below and the
  // submission-creation path further down share the exact same
  // availability result. TETHER_CLIENT_OPTIONAL/REQUIRED are downgraded
  // to STANDARD_WEB (not silently allowed) when not actually available
  // — never a frontend query parameter.
  const secureClientAvailabilityForExam = secureClientAvailabilityForInstitution(exam.institution?.slug ?? null);

  const existingInProgress = await prisma.submission.findFirst({
    where: { examId: id, studentId: session.user.id, status: "IN_PROGRESS" },
    orderBy: [{ attemptNumber: "desc" }, { startedAt: "desc" }],
  });
  if (existingInProgress) {
    const secureClientLaunch = await resolveSecureClientLaunchField({
      deliveryMode: settings.deliveryMode,
      availability: secureClientAvailabilityForExam,
      submissionId: existingInProgress.id,
      examId: id,
      institutionSlug: exam.institution?.slug ?? null,
    });
    return NextResponse.json({ ...existingInProgress, secureClientLaunch });
  }
  const attempts = await prisma.submission.findMany({
    where: { examId: id, studentId: session.user.id },
    select: { attemptNumber: true, status: true },
    orderBy: { attemptNumber: "desc" },
  });
  const finalizedAttemptCount = attempts.filter((attempt) => attempt.status !== "IN_PROGRESS").length;
  if (!canCreateAttempt({ finalizedAttemptCount, maxAttempts: settings.maxAttempts })) {
    return NextResponse.json({ error: "No attempts remaining for this exam." }, { status: 409 });
  }
  const attemptNumber = nextAttemptNumber(attempts);

  // Body is read once, up-front, for both the access code (below) and the
  // policy acknowledgement (Exam Design Policy v1 — see
  // docs/exam-design-policy-v1.md). Every new attempt requires both,
  // exactly once each — resuming an existing in-progress attempt (the
  // idempotency check above) never re-prompts for either.
  const body = await req.json().catch(() => ({}));

  // Student Onboarding and Exam Access v1 — see
  // docs/student-onboarding-and-exam-access.md.
  if (exam.accessCodeRequired) {
    // Auth and Token Abuse Protection v1 — a source+studentId+examId
    // bucket guards this comparison against high-volume access-code
    // guessing, reserved BEFORE the bcrypt comparison and released only
    // on a correct code (security review v2 — keying on the
    // authenticated student, not just source+examId, means one
    // student's wrong guesses can never lock out a different student
    // behind the same shared exam-room network; reserve-before-compare
    // closes a concurrent-burst bypass the first pass's peek-based
    // check allowed — see examAccessCodeRateLimit.ts). Checked only when
    // a code is actually required (never for exams without one).
    // Purely additive: no other exam-start behavior below this block is
    // touched.
    const sourceIp = resolveTrustedRequestSource(req);
    const reservation = await reserveExamAccessCodeSlot(sourceIp, session.user.id, id);
    if (reservation.status === "blocked") {
      return NextResponse.json(
        { error: "Too many attempts. Please try again shortly." },
        { status: 429, headers: { "Retry-After": String(reservation.retryAfterSeconds) } },
      );
    }
    if (reservation.status === "infrastructure_error") {
      // Fail closed without ever comparing the supplied code, so a
      // limiter outage can never become an access-code oracle.
      return NextResponse.json({ error: "Temporarily unavailable. Please try again shortly." }, { status: 503 });
    }

    const accessCode = typeof body?.accessCode === "string" ? body.accessCode : "";
    const valid =
      accessCode.length > 0 &&
      exam.accessCodeHash != null &&
      (await bcrypt.compare(accessCode, exam.accessCodeHash));
    if (!valid) {
      return NextResponse.json(
        { error: "Valid access code required to start this exam." },
        { status: 403 },
      );
    }
    await releaseExamAccessCodeSlot(sourceIp, session.user.id, id, reservation.windowStartMs);
  }

  // Exam Design Policy v1 (Part 7/8) — see docs/exam-design-policy-v1.md.
  // The student must not start a new attempt until acknowledgement is
  // recorded. The acknowledgement timestamp is captured here (server
  // time, not client-supplied) and embedded directly into the immutable
  // policy snapshot built below — there is no separate acknowledgement
  // table in v1.
  if (body?.policyAcknowledged !== true) {
    return NextResponse.json(
      { error: "You must acknowledge the exam conditions before starting this exam." },
      { status: 400 },
    );
  }
  const policyAcknowledgedAt = new Date();

  // Two near-simultaneous "start exam" requests from the same student (e.g.
  // a double-click, or a flaky network retry) can both pass the check above
  // before either has created a row. The @@unique([examId, studentId])
  // constraint then rejects the loser — recover by returning the winner's
  // submission instead of a 500, so starting is idempotent under races.
  // One-Question-At-A-Time Exam Delivery v1 — see
  // docs/one-question-delivery-v1.md. The stable per-submission
  // question/option order is generated exactly once, here, at attempt
  // creation — using real crypto-backed randomness (Math.random is fine
  // server-side for this; not security-sensitive, just needs to differ
  // per submission), then persisted. It is never recomputed on
  // subsequent requests — "stable across refresh" is a property of this
  // persisted value, not of a reproducible seed, so there is no seed to
  // ever expose to the client. Left null when both randomisation
  // settings are off, in which case the original Question.order is used
  // at read time (see resolveQuestionOrder in questionDelivery.ts).
  // Question Pools v1 — see docs/question-pools-v1.md. When active, the
  // selected/ordered question SUBSET is computed here (and only here,
  // exactly once) and stored in `selectedQuestionIds`; `questionIds`
  // (the plain full-exam reorder field) is left unused in this branch.
  const poolsActive = questionPoolsActive(settings);
  let poolDrawSummary: Array<{ poolId: string; drawCount: number | null; selectedCount: number }> | null = null;

  const questionOrderJson: StoredQuestionOrder | null = poolsActive
    ? (() => {
        const selectedQuestionIds = buildSelectedQuestionIds({
          questions: exam.questions.map((q) => ({
            id: q.id,
            questionPoolId: q.questionPoolId,
            order: q.order,
          })),
          pools: exam.questionPools.map((p) => ({ id: p.id, drawCount: p.drawCount })),
          randomiseQuestionOrder: settings.randomiseQuestionOrder,
        });
        const selectedSet = new Set(selectedQuestionIds);
        poolDrawSummary = exam.questionPools.map((p) => ({
          poolId: p.id,
          drawCount: p.drawCount,
          selectedCount: exam.questions.filter((q) => q.questionPoolId === p.id && selectedSet.has(q.id)).length,
        }));
        return {
          questionIds: [],
          selectedQuestionIds,
          optionOrders: buildOptionOrders({
            questions: exam.questions
              .filter((q) => selectedSet.has(q.id))
              .map((q) => ({ id: q.id, type: q.type, options: q.options as string[] | null })),
            randomiseMcqOptionOrder: settings.randomiseMcqOptionOrder,
          }),
        };
      })()
    : settings.randomiseQuestionOrder || settings.randomiseMcqOptionOrder
      ? {
          questionIds: buildQuestionOrder({
            questionIds: exam.questions.map((q) => q.id),
            randomiseQuestionOrder: settings.randomiseQuestionOrder,
          }),
          optionOrders: buildOptionOrders({
            questions: exam.questions.map((q) => ({
              id: q.id,
              type: q.type,
              options: q.options as string[] | null,
            })),
            randomiseMcqOptionOrder: settings.randomiseMcqOptionOrder,
          }),
        }
      : null;

  // Individual Exam Timing & Accommodations v1 — resolved ONLY here, for
  // a brand-new attempt, from the student's current
  // ExamTimeAccommodation row (if any) and the exam's CURRENT standard
  // duration. See src/lib/examTimeAccommodation.ts, the single source of
  // truth for this resolution. The existing IN_PROGRESS resume path
  // above returns well before this point and never re-resolves an
  // accommodation — an attempt's effective duration is frozen exactly
  // once, at creation. Falls back to the standard duration (never blocks
  // exam start) if the stored row is somehow malformed — this should
  // never happen since only the validated lecturer API below ever writes
  // this table, but a data issue must never prevent a student from
  // starting their exam.
  const accommodationRow = await prisma.examTimeAccommodation.findUnique({
    where: { examId_studentId: { examId: id, studentId: session.user.id } },
  });
  let accommodationAdjustment: ExamTimeAccommodationAdjustment | null = null;
  if (accommodationRow && isValidExamTimeAccommodationMode(accommodationRow.adjustmentMode)) {
    accommodationAdjustment = {
      adjustmentMode: accommodationRow.adjustmentMode,
      adjustmentValue: accommodationRow.adjustmentValue,
    };
  }
  let effectiveDurationMins = exam.durationMins;
  try {
    effectiveDurationMins = resolveEffectiveExamDurationMins({
      standardDurationMins: exam.durationMins,
      accommodation: accommodationAdjustment,
    });
  } catch (err) {
    if (!(err instanceof InvalidExamTimeAccommodationError)) throw err;
    console.error("Invalid ExamTimeAccommodation row — falling back to standard duration", { examId: id, studentId: session.user.id, err });
    accommodationAdjustment = null;
    effectiveDurationMins = exam.durationMins;
  }
  // Optional, backward-compatible, additive-only metadata — answers "what
  // standard duration and accommodation produced this attempt's
  // duration?" without ever needing to re-read the (possibly since
  // changed/removed) ExamTimeAccommodation row. Never includes
  // diagnosis/reason/health information. null for every attempt without
  // an accommodation, including every pre-existing snapshot.
  const timeAccommodationSnapshot = buildExamTimeAccommodationSnapshot({
    standardDurationMins: exam.durationMins,
    accommodation: accommodationAdjustment,
  });

  // Exam Design Policy v1 — the immutable snapshot for THIS attempt,
  // built once here from the exam's settings as they exist right now.
  // Never recomputed or overwritten later — changing the exam afterwards
  // never changes this attempt's snapshot (see
  // docs/exam-design-policy-v1.md).
  const policySnapshot: ExamPolicySnapshot = {
    ...buildExamPolicySnapshot(
      {
        examMode: settings.examMode,
        calculatorAllowed: settings.calculatorAllowed,
        notesAllowed: settings.notesAllowed,
        internetAllowed: settings.internetAllowed,
        aiToolsAllowed: settings.aiToolsAllowed,
      },
      {
        secureModeEnabled: settings.secureModeEnabled,
        requireFullscreen: settings.requireFullscreen,
        blockCopyPaste: settings.blockCopyPaste,
        trackWindowBlur: settings.trackWindowBlur,
        requireCamera: settings.requireCamera,
        enableAiCameraIntegrityChecks: settings.enableAiCameraIntegrityChecks,
      },
      // Freeze timing policy for active exam attempts — captured once,
      // here, from the exam's CURRENT duration/late-submit/auto-submit
      // settings, with any individual time accommodation already
      // resolved into durationMins above. Never recomputed for this
      // attempt afterwards, even if the lecturer edits
      // Exam.durationMins, this student's accommodation, or these
      // secureSettings — see resolveSubmissionTimingPolicy in
      // assessmentLifecycle.ts, the only function that should ever read
      // it back.
      {
        durationMins: effectiveDurationMins,
        allowLateSubmit: settings.allowLateSubmit,
        autoSubmitOnTimerEnd: settings.autoSubmitOnTimerEnd,
      },
      policyAcknowledgedAt,
      new Date(),
    ),
    // Individual Exam Timing & Accommodations v1 — formally declared,
    // optional field on ExamPolicySnapshot itself (see examPolicy.ts),
    // alongside timingPolicy, for audit/explainability only. Nothing
    // downstream reads this for enforcement; resolveSubmissionTimingPolicy
    // only ever reads timingPolicy.durationMins above.
    timeAccommodation: timeAccommodationSnapshot,
  };

  // Controlled AI Brainstorming Assistance v1 — see
  // docs/controlled-ai-brainstorming-assistance-v1.md. Same immutable-
  // snapshot pattern as policySnapshot above: built once here from the
  // exam's CURRENT settings, then never recomputed for this attempt even
  // if the lecturer changes aiAssistance* settings afterwards.
  const aiAssistancePolicySnapshot = buildAiAssistancePolicySnapshot({
    aiAssistanceMode: settings.aiAssistanceMode,
    aiAssistanceMaxPromptsPerQuestion: settings.aiAssistanceMaxPromptsPerQuestion,
    aiAssistanceMaxPromptsPerAttempt: settings.aiAssistanceMaxPromptsPerAttempt,
    aiAssistanceMaxResponseCharacters: settings.aiAssistanceMaxResponseCharacters,
    aiAssistanceAllowConceptExplanations: settings.aiAssistanceAllowConceptExplanations,
    aiAssistanceAllowAnswerPlanning: settings.aiAssistanceAllowAnswerPlanning,
    aiAssistanceAllowReasoningFeedback: settings.aiAssistanceAllowReasoningFeedback,
    aiAssistanceAllowProgrammingConceptHelp: settings.aiAssistanceAllowProgrammingConceptHelp,
  });

  // Screen-share Evidence Mode v1 — see docs/screen-share-evidence-v1.md.
  // Same immutable-snapshot pattern as the two snapshots above.
  const screenSharePolicySnapshot = buildScreenSharePolicySnapshot({
    screenShareMode: settings.screenShareMode,
    screenShareCaptureEvidence: settings.screenShareCaptureEvidence,
    screenShareEvidenceIntervalSeconds: settings.screenShareEvidenceIntervalSeconds,
    screenShareMaxEvidenceFrames: settings.screenShareMaxEvidenceFrames,
  });

  // Answer-Development Provenance v1 — see
  // docs/answer-development-provenance-v1.md. Same immutable-snapshot
  // pattern as the snapshots above.
  const answerProvenancePolicySnapshot = buildAnswerProvenancePolicySnapshot({
    answerProvenanceMode: settings.answerProvenanceMode,
    answerVersionIntervalSeconds: settings.answerVersionIntervalSeconds,
    answerVersionMinimumCharacterChange: settings.answerVersionMinimumCharacterChange,
    answerVersionMaximumPerQuestion: settings.answerVersionMaximumPerQuestion,
    capturePasteMetadata: settings.capturePasteMetadata,
    captureDeletionRewriteMetadata: settings.captureDeletionRewriteMetadata,
    enableOutlineWorkspace: settings.enableOutlineWorkspace,
    enableCalculationWorkspace: settings.enableCalculationWorkspace,
    enableCodeWorkspace: settings.enableCodeWorkspace,
    captureCodeRunHistory: settings.captureCodeRunHistory,
    requireAiSourceDeclaration: settings.requireAiSourceDeclaration,
    allowStudentDevelopmentReview: settings.allowStudentDevelopmentReview,
  });

  // Same immutable-snapshot pattern as the snapshots above — reuses
  // secureClientAvailabilityForExam computed up front.
  const effectiveDeliveryMode = resolveEffectiveDeliveryMode(settings.deliveryMode, secureClientAvailabilityForExam);

  // Mandatory Tether Delivery for Final Examinations — the last-resort
  // server-side gate (Part 5: "reject... if the final invariant still
  // cannot be established"). A final exam's settings are always
  // normalised to TETHER_CLIENT_REQUIRED on save (see PATCH
  // /api/exams/[id]), so this should never trigger in the ordinary case
  // — it exists to catch a legacy exam that predates this feature, or
  // the TETHER_CLIENT_REQUIRED_DISABLED emergency kill switch being
  // thrown after publish. Never a query-parameter or user-agent bypass —
  // this reuses the same server-computed effectiveDeliveryMode as every
  // other gate in this route. Only ever applies to a BRAND NEW attempt;
  // an existing IN_PROGRESS submission (handled above) always resumes
  // through its own already-frozen, independently-safe policy snapshot,
  // never re-evaluated against live settings.
  if (!isFinalExaminationPolicyEstablished(settings.assessmentType, effectiveDeliveryMode)) {
    return NextResponse.json(
      {
        error: "This final examination requires Tether Secure Browser, which is not currently available. Contact your lecturer or institution administrator.",
        code: "FINAL_EXAMINATION_TETHER_UNAVAILABLE",
      },
      { status: 409 },
    );
  }

  // Tether System Check and Exam Readiness v1 — see
  // docs/tether-system-check-v1.md. REQUIRE mode only ever applies to a
  // BRAND NEW attempt for a final examination — never to resuming an
  // existing IN_PROGRESS submission (handled in the idempotency branch
  // above, well before this point), so a student already mid-exam can
  // never be locked out by a since-expired system-check record. This
  // gate only decides whether the student may proceed to the (unchanged)
  // Tether launch flow — it never itself authorises exam content, and
  // the real secure-client verification below still runs exactly as
  // before regardless of this record.
  if (settings.assessmentType === "FINAL_EXAMINATION") {
    const mode = systemCheckMode();
    if (mode === "REQUIRE") {
      const latestRun = await prisma.tetherSystemCheckRun.findFirst({
        where: { userId: session.user.id },
        orderBy: { checkedAt: "desc" },
        select: { overallStatus: true, expiresAt: true },
      });
      const gate = evaluateFinalExamSystemCheckGate({
        mode,
        isFinalExamination: true,
        latestRun: latestRun ? { overallStatus: latestRun.overallStatus as "READY" | "READY_WITH_WARNINGS" | "NOT_READY", expiresAtMs: latestRun.expiresAt.getTime() } : null,
        nowMs: Date.now(),
      });
      if (!gate.allowed) {
        return NextResponse.json(
          {
            error: "Please run the system check before starting this final examination.",
            code: gate.reason,
          },
          { status: 409 },
        );
      }
    }
  }

  if (effectiveDeliveryMode === "SEB_REQUIRED") {
    const activeSebConfig = await prisma.secureClientConfiguration.findFirst({
      where: { examId: id, provider: "SAFE_EXAM_BROWSER", status: "ACTIVE" },
      select: { id: true },
    });
    if (!activeSebConfig) {
      return NextResponse.json(
        { error: "This exam requires Safe Exam Browser, but no active configuration has been set up yet. Contact your lecturer.", code: "SEB_NOT_CONFIGURED" },
        { status: 409 },
      );
    }
  }
  const secureClientPolicySnapshot = buildSecureClientPolicySnapshot(
    {
      deliveryMode: settings.deliveryMode,
      allowedSebPlatforms: settings.allowedSebPlatforms,
      allowedSebVersions: settings.allowedSebVersions,
      requireSebBrowserExamKey: settings.requireSebBrowserExamKey,
      requireSebConfigKey: settings.requireSebConfigKey,
      allowSebHeaderValidation: settings.allowSebHeaderValidation,
      allowSebJavascriptApiValidation: settings.allowSebJavascriptApiValidation,
      secureLaunchTokenTtlSeconds: settings.secureLaunchTokenTtlSeconds,
      secureClientHeartbeatIntervalSeconds: settings.secureClientHeartbeatIntervalSeconds,
      secureClientHeartbeatGraceSeconds: settings.secureClientHeartbeatGraceSeconds,
      requireDisplayCheck: settings.requireDisplayCheck,
      secureClientMaximumDisplays: settings.secureClientMaximumDisplays,
      displayPolicy: settings.displayPolicy,
      requireRemoteSessionCheck: settings.requireRemoteSessionCheck,
      requireVirtualMachineCheck: settings.requireVirtualMachineCheck,
      requireProcessCheck: settings.requireProcessCheck,
      requireCaptureProtectionCheck: settings.requireCaptureProtectionCheck,
      blockCopyPaste: settings.blockCopyPaste,
      secureClientAllowPrinting: settings.secureClientAllowPrinting,
      secureClientAllowExternalNavigation: settings.secureClientAllowExternalNavigation,
      secureClientAllowApplicationSwitching: settings.secureClientAllowApplicationSwitching,
      secureClientAllowRecovery: settings.secureClientAllowRecovery,
      secureClientEventRetentionDays: settings.secureClientEventRetentionDays,
      secureClientLecturerOverrideAllowed: settings.secureClientLecturerOverrideAllowed,
    },
    secureClientAvailabilityForExam,
  );

  try {
    // v1.7.4 pre-exam readiness — activatedAt is the new authoritative
    // "is this attempt's timed clock/content actually unlocked" marker
    // (see prisma/schema.prisma's own doc comment and
    // src/lib/secureClientActivation.ts). For every delivery mode that
    // does NOT require secure-client activation, there is nothing to
    // gate — stamped immediately, identical to today's behaviour (the
    // attempt is fully live from creation, exactly as before this
    // column existed). Only TETHER_CLIENT_REQUIRED/SEB_REQUIRED
    // attempts start PREPARING (null) — POST /api/submissions/[id]/activate
    // is the ONLY thing that may ever set it for those, once native
    // lockdown is confirmed ACTIVE.
    const requiresActivation = submissionRequiresActivation(secureClientPolicySnapshot);
    const submission = await prisma.submission.create({
      data: {
        examId: id,
        studentId: session.user.id,
        attemptNumber,
        questionOrderJson: questionOrderJson ?? Prisma.DbNull,
        examPolicySnapshotJson: policySnapshot as unknown as Prisma.InputJsonValue,
        aiAssistancePolicySnapshotJson: aiAssistancePolicySnapshot as unknown as Prisma.InputJsonValue,
        screenSharePolicySnapshotJson: screenSharePolicySnapshot as unknown as Prisma.InputJsonValue,
        answerProvenancePolicySnapshotJson: answerProvenancePolicySnapshot as unknown as Prisma.InputJsonValue,
        secureClientPolicySnapshotJson: secureClientPolicySnapshot as unknown as Prisma.InputJsonValue,
        activatedAt: requiresActivation ? null : new Date(),
      },
    });

    // Academic Integrity Network Evidence v1 — captured fire-and-forget
    // after the submission row exists. Never blocks exam start.
    //
    // Standalone Exam Link v1 bug fix — see docs/standalone-exam-link-v1.md.
    // This used to be `requireInstitutionId(session)`, which throws for
    // any session with institutionId: null. That is now a normal,
    // supported case (a null-institution student taking a STANDALONE
    // exam via an accepted ExamAssignment) reaching this line AFTER
    // prisma.submission.create above has already durably succeeded — an
    // uncaught throw here would surface as an unhandled 500 on an attempt
    // that was, in fact, already created. exam.institutionId is the
    // correct value regardless: it's the exam's own tenancy owner (always
    // populated for a real published exam), not the requesting student's
    // session institution, which for STANDALONE mode is allowed to be
    // absent.
    const institutionId = exam.institutionId;

    // Exam Design Policy v1 — audit both the acknowledgement and the
    // snapshot creation. Never blocks exam start. institutionId here may
    // be null (createPlatformAuditLog's own institutionId param accepts
    // string | null | undefined) — audit logs remain best-effort and are
    // never a gate on exam start.
    createPlatformAuditLog({
      actorId: session.user.id,
      action: "EXAM_POLICY_ACKNOWLEDGED",
      targetType: "Submission",
      targetId: submission.id,
      institutionId,
      metadata: { examId: id, examMode: policySnapshot.examMode, policyVersion: policySnapshot.policyVersion },
    }).catch(() => {});
    createPlatformAuditLog({
      actorId: session.user.id,
      action: "EXAM_POLICY_SNAPSHOT_CREATED",
      targetType: "Submission",
      targetId: submission.id,
      institutionId,
      metadata: { examId: id, examMode: policySnapshot.examMode, policyVersion: policySnapshot.policyVersion },
    }).catch(() => {});
    // captureNetworkEvidence's institutionId param is typed as a required
    // (non-nullable) string — see src/lib/networkEvidence.ts. Guarded
    // rather than widened, since every other caller legitimately always
    // has one; this is the one call site where it can be null in
    // practice (a STANDALONE exam somehow created with no institution),
    // and evidence capture is already documented as best-effort/
    // never-blocking.
    if (institutionId) {
      captureNetworkEvidence({
        req,
        submissionId: submission.id,
        examId: id,
        studentId: session.user.id,
        institutionId,
        source: "EXAM_START",
      }).catch(() => {/* evidence capture is best-effort */});
    }

    // Exam Session Binding + Time Anomaly Review v1 — coarse telemetry
    // marker only. Session BINDING itself (cookies, device token) is
    // created on the exam page's first heartbeat, not here — see
    // src/lib/examAttemptSessionRunner.ts.
    recordSimpleActivityEvent({ submissionId: submission.id, eventType: "ATTEMPT_STARTED" }).catch(() => {});

    // Question Pools v1 — lightweight, best-effort audit summary. Never
    // includes question text — only ids, counts, and the per-pool draw
    // summary computed above.
    if (poolsActive && questionOrderJson?.selectedQuestionIds) {
      createPlatformAuditLog({
        actorId: session.user.id,
        action: "QUESTION_POOL_SELECTION_GENERATED",
        targetType: "Submission",
        targetId: submission.id,
        institutionId,
        metadata: {
          examId: id,
          selectedCount: questionOrderJson.selectedQuestionIds.length,
          poolDrawSummary,
        },
      }).catch(() => {
        // Audit logging is best-effort — never blocks exam start.
      });
    }

    const secureClientLaunch = await resolveSecureClientLaunchField({
      deliveryMode: settings.deliveryMode,
      availability: secureClientAvailabilityForExam,
      submissionId: submission.id,
      examId: id,
      institutionSlug: exam.institution?.slug ?? null,
    });
    return NextResponse.json({ ...submission, secureClientLaunch }, { status: 201 });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await prisma.submission.findFirst({
        where: { examId: id, studentId: session.user.id, status: "IN_PROGRESS" },
        orderBy: [{ attemptNumber: "desc" }, { startedAt: "desc" }],
      });
      if (winner) {
        const secureClientLaunch = await resolveSecureClientLaunchField({
          deliveryMode: settings.deliveryMode,
          availability: secureClientAvailabilityForExam,
          submissionId: winner.id,
          examId: id,
          institutionSlug: exam.institution?.slug ?? null,
        });
        return NextResponse.json({ ...winner, secureClientLaunch });
      }
    }
    throw err;
  }
}

export const dynamic = "force-dynamic";
