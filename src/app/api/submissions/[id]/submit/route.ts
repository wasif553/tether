import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { pushGradeToCanvas } from "@/lib/lti/gradePassback";
import { parseSecureSettings, questionPoolsActive, severityFor } from "@/lib/secureExam";
import { Prisma } from "@/generated/prisma/client";
import { captureNetworkEvidence, getClientIpFromRequest } from "@/lib/networkEvidence";
import { canAcceptSubmit, submissionDeadline } from "@/lib/assessmentLifecycle";
import { resolveEffectiveQuestionIds } from "@/lib/questionDelivery";
import { recordSimpleActivityEvent } from "@/lib/answerActivityTelemetry";
import { endExamAttemptSessionsForSubmission } from "@/lib/examAttemptSessionRunner";
import { parseAnswerProvenancePolicy, isAnswerProvenanceEnabled } from "@/lib/answerProvenancePolicy";
import { isSourceDeclarationSatisfied, createFinalDevelopmentRecordsWithTx } from "@/lib/answerDevelopmentRunner";

function studentSubmitResponse(submission: {
  id: string;
  status: string;
  submittedAt: Date | null;
  attemptNumber: number;
  exam?: { marksReleasedAt?: Date | null } | null;
  totalScore?: number | null;
}) {
  const marksReleased = submission.exam?.marksReleasedAt != null;
  return {
    id: submission.id,
    status: submission.status,
    submittedAt: submission.submittedAt,
    attemptNumber: submission.attemptNumber,
    totalScore: marksReleased ? (submission.totalScore ?? null) : null,
    marksReleased,
  };
}

/** Thrown inside the finalisation transaction when another request has already finalized the submission — never a real failure, just routes to the same ALREADY_FINALIZED response as the P2025 fallback below. */
class AlreadyFinalizedError extends Error {}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const body = await req.json().catch(() => ({}));
    const systemAutoSubmit = body?.systemAutoSubmit === true;

    // --- Reads outside any transaction: submission + exam + questions.
    // Deadline/declaration gates and the effective question set are all
    // decided from this snapshot. Answers themselves are re-read FRESH
    // inside the transaction below (see "final checkpoints exactly match
    // the authoritative submitted answers" — grading and provenance must
    // use identical, transaction-time data, never a possibly-stale outer
    // read that a concurrent autosave could have already superseded).
    const submission = await prisma.submission.findUnique({
      where: { id },
      include: { exam: { include: { questions: true } } },
    });

    if (!submission || submission.studentId !== session.user.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (submission.status !== "IN_PROGRESS") {
      return NextResponse.json({
        ...studentSubmitResponse(submission),
        code: "ALREADY_FINALIZED",
      });
    }

    const settings = parseSecureSettings(submission.exam.secureSettings);
    const deadline = submissionDeadline(submission.startedAt, submission.exam.durationMins);
    if (!canAcceptSubmit({ now: new Date(), deadline, settings, systemAutoSubmit })) {
      await prisma.integrityEvent.create({
        data: {
          submissionId: id,
          examId: submission.examId,
          studentId: submission.studentId,
          eventType: "SUBMIT_AFTER_DEADLINE",
          severity: severityFor("SUBMIT_AFTER_DEADLINE", settings),
          message: "A submission attempt was made after the exam deadline.",
          occurredAt: new Date(),
        },
      });
      return NextResponse.json(
        {
          code: "DEADLINE_PASSED",
          error: "The deadline for this exam has passed and late submission is not allowed",
        },
        { status: 409 },
      );
    }

    // Answer-Development Provenance v1 — see
    // docs/answer-development-provenance-v1.md. A required source/AI-use
    // declaration blocks finalisation ONLY when the immutable policy says
    // so (Part 5/6/7) — never for an OFF/optional policy. Checked before
    // any grading/write happens, so a missing declaration never wastes a
    // grading pass just to be rejected.
    const provenancePolicy = parseAnswerProvenancePolicy(submission.answerProvenancePolicySnapshotJson);
    if (isAnswerProvenanceEnabled(provenancePolicy) && provenancePolicy.requireAiSourceDeclaration) {
      const declared = await isSourceDeclarationSatisfied(id, provenancePolicy);
      if (!declared) {
        return NextResponse.json(
          {
            code: "SOURCE_DECLARATION_REQUIRED",
            error: "A source/AI-use declaration is required before this exam can be submitted.",
          },
          { status: 400 },
        );
      }
    }

    // Question Pools v1 — see docs/question-pools-v1.md. Grade only the
    // question set this submission was actually given: when pools are
    // active, that's the persisted selected subset, not every question
    // in the exam/pools. A student is never penalised for a pool
    // question they were never shown, and totalScore/max-possible-marks
    // only ever reflect their own selected set. Falls back to the full
    // exam question set unchanged when pools aren't active.
    const effectiveQuestionIds = resolveEffectiveQuestionIds({
      examQuestionIds: submission.exam.questions.map((q) => q.id),
      stored: submission.questionOrderJson,
      questionPoolsActive: questionPoolsActive(settings),
    });
    const effectiveQuestionIdSet = new Set(effectiveQuestionIds);
    const questionsToGrade = submission.exam.questions.filter((q) => effectiveQuestionIdSet.has(q.id));

    // --- Everything below (grading, submission-status update, and — when
    // provenance is enabled — the final answer-development checkpoints/
    // events) runs inside ONE transaction, guarded by the same
    // submission-scoped advisory lock the rest of this feature uses.
    // Hardening (Part 1, "final submission" spec): a provenance write
    // failure here throws, which rolls back grading and the status
    // update too — the submission is left genuinely still IN_PROGRESS,
    // never "marked successfully submitted" alongside a lost checkpoint.
    // Autosaved Answer.response rows are never touched by a rollback of
    // THIS transaction (they were written by the separate, independent
    // autosave/checkpoint routes already), so a retry always has the
    // student's latest work available. No response is ever returned to
    // the client until this whole transaction has resolved.
    let hasEssay = false;
    let autoScore = 0;
    let finalizedSubmission: Awaited<ReturnType<typeof prisma.submission.update>>;
    try {
      finalizedSubmission = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;

        // Re-check status INSIDE the transaction — belt-and-suspenders
        // against a genuine race between the outer read above and lock
        // acquisition (two near-simultaneous submit requests: the advisory
        // lock serializes them, and the loser must see the winner's
        // already-committed status here, never re-grade or re-checkpoint).
        const fresh = await tx.submission.findUnique({ where: { id }, select: { status: true } });
        if (!fresh || fresh.status !== "IN_PROGRESS") {
          throw new AlreadyFinalizedError();
        }

        // Fresh, transaction-time answers — the SAME data used for both
        // grading and the final provenance checkpoints below, so the two
        // can never disagree with each other or with what's actually
        // stored.
        const freshAnswers = await tx.answer.findMany({ where: { submissionId: id } });
        const answersByQuestion = new Map(freshAnswers.map((a) => [a.questionId, a]));

        autoScore = 0;
        hasEssay = false;
        for (const question of questionsToGrade) {
          if (question.type === "ESSAY") {
            hasEssay = true;
            continue;
          }
          const answer = answersByQuestion.get(question.id);
          const correct =
            !!answer?.response &&
            !!question.correctAnswer &&
            answer.response.trim().toLowerCase() === question.correctAnswer.trim().toLowerCase();
          const score = correct ? question.points : 0;
          autoScore += score;

          if (answer) {
            await tx.answer.update({ where: { id: answer.id }, data: { score, isCorrect: correct } });
          } else {
            const created = await tx.answer.create({
              data: { submissionId: id, questionId: question.id, score, isCorrect: correct },
            });
            answersByQuestion.set(question.id, created);
          }
        }

        const now = new Date();
        const updatedSubmission = await tx.submission.update({
          where: { id, status: "IN_PROGRESS" },
          data: {
            status: hasEssay ? "SUBMITTED" : "GRADED",
            submittedAt: now,
            gradedAt: hasEssay ? null : now,
            totalScore: hasEssay ? null : autoScore,
          },
        });

        // Answer-Development Provenance v1 — see
        // docs/answer-development-provenance-v1.md. AWAITED, inside this
        // same transaction: a failure here throws, which rolls back
        // grading and the status update above too. No-ops entirely when
        // the policy is OFF for this attempt — legacy/OFF behaviour is
        // completely unchanged.
        if (isAnswerProvenanceEnabled(provenancePolicy)) {
          await createFinalDevelopmentRecordsWithTx(
            tx,
            provenancePolicy,
            id,
            effectiveQuestionIds,
            [...answersByQuestion.values()].map((a) => ({ id: a.id, questionId: a.questionId, response: a.response })),
          );
        }

        return updatedSubmission;
      });
    } catch (err) {
      if (err instanceof AlreadyFinalizedError || (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025")) {
        const current = await prisma.submission.findUnique({
          where: { id },
          include: { exam: { select: { marksReleasedAt: true } } },
        });
        if (current) {
          return NextResponse.json({ ...studentSubmitResponse(current), code: "ALREADY_FINALIZED" });
        }
      }
      // A real grading/provenance failure: the transaction rolled back in
      // full — the submission is still IN_PROGRESS, autosaved answers are
      // untouched, and the student can safely retry. Never partially
      // applied.
      throw err;
    }

    if (!hasEssay) {
      pushGradeToCanvas(id).catch(console.error);
    }

    // Exam Session Binding + Time Anomaly Review v1 — best-effort,
    // fire-and-forget: never blocks or affects the submission itself.
    recordSimpleActivityEvent({ submissionId: id, eventType: "ATTEMPT_SUBMITTED" }).catch(() => {});
    endExamAttemptSessionsForSubmission(id).catch(() => {});

    // Academic Integrity Network Evidence v1 — compare IP with EXAM_START
    // to detect network change. Fire-and-forget; never blocks submission.
    const startEvidence = await prisma.networkEvidence.findFirst({
      where: { submissionId: id, source: "EXAM_START" },
      orderBy: { createdAt: "asc" },
      select: { ipAddress: true, country: true, institutionId: true },
    });
    captureNetworkEvidence({
      req,
      submissionId: id,
      examId: submission.examId,
      studentId: submission.studentId,
      institutionId: startEvidence?.institutionId ?? submission.exam.institutionId ?? "",
      source: "EXAM_SUBMIT",
      priorIp: startEvidence?.ipAddress ?? null,
      priorCountry: startEvidence?.country ?? null,
    }).catch(() => {/* evidence capture is best-effort */});

    // Optionally flag country change as a review-worthy integrity event.
    const submitIp = getClientIpFromRequest(req);
    if (
      startEvidence?.country &&
      startEvidence.country !== null &&
      submitIp &&
      startEvidence.ipAddress !== submitIp
    ) {
      // Only create a MANUAL_WARNING if country evidence will differ —
      // we don't know country yet (geo is async), so we flag IP change only.
      await prisma.integrityEvent.create({
        data: {
          submissionId: id,
          examId: submission.examId,
          studentId: submission.studentId,
          eventType: "MANUAL_WARNING",
          severity: "LOW",
          message:
            "Network address changed between exam open and submission. Review network evidence for context.",
          occurredAt: new Date(),
        },
      }).catch(() => {/* never block submit */});
    }

    return NextResponse.json(studentSubmitResponse({ ...finalizedSubmission, exam: submission.exam }));
  } catch (error) {
    console.error("[submit] error:", error);
    // A P2025 here means another concurrent request already finalized
    // this submission — that's a benign race, not a failure; return the
    // current (already finalized) submission instead of a 500. (The
    // primary handling for this race is now inside the transaction above
    // — this remains as a defensive fallback for any P2025 raised outside
    // it, e.g. from the deadline-check IntegrityEvent write.)
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      const current = await prisma.submission.findUnique({
        where: { id },
        include: { exam: { select: { marksReleasedAt: true } } },
      });
      if (current) {
        return NextResponse.json({
          ...studentSubmitResponse(current),
          code: "ALREADY_FINALIZED",
        });
      }
    }
    return NextResponse.json({ error: "Failed to submit exam" }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";
