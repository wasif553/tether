/**
 * Auto-submit server-backstop v1 — the ONE authoritative place a
 * Submission ever transitions IN_PROGRESS -> SUBMITTED/GRADED. Extracted
 * from POST /api/submissions/[id]/submit's own transaction body so that a
 * SECOND caller with no live student request at all (POST
 * /api/exams/[id]/start's existing-attempt resume path, and the scheduled
 * overdue-submission sweep) can finalize an attempt through the exact
 * same grading/status/provenance/locking mechanics — never a second,
 * independently-reimplemented finalization algorithm.
 *
 * What this module OWNS (per-call, inside one transaction):
 *   - the submission-scoped pg_advisory_xact_lock
 *   - a FRESH in-transaction status re-read (never trusts an outer read)
 *   - optional finalResponses persistence (via the same
 *     saveAnswerWithIdempotency idempotent write path ordinary autosave
 *     uses)
 *   - fresh answer loading, grading, essay/non-essay status selection,
 *     totalScore, submittedAt/gradedAt
 *   - the Answer-Development Provenance final checkpoint (when enabled)
 *   - the conditional IN_PROGRESS -> SUBMITTED/GRADED transition
 *   - for SERVER_BACKSTOP only: one PlatformAuditLog row
 *     (SUBMISSION_SERVER_BACKSTOP_FINALIZED), written in the SAME
 *     transaction — never a fire-and-forget best-effort call — so the
 *     audit trail and the status transition can never disagree about
 *     whether server-triggered finalization happened.
 *
 * What this module DELIBERATELY DOES NOT own (caller policy, not
 * finalization mechanics — kept in each call site so it can differ):
 *   - "may this request finalize at all" (POST /submit's own
 *     canAcceptSubmit deadline gate + SUBMIT_AFTER_DEADLINE integrity
 *     event; the backstop's own shouldServerBackstopFinalize check)
 *   - the content-access-lease / activation / ownership gates
 *   - the Answer-Development source-declaration REQUIREMENT gate
 *     (isSourceDeclarationSatisfied) — this blocks a STUDENT from
 *     submitting without declaring; the server backstop has no student to
 *     prompt, and MUST still be able to finalize an abandoned attempt, so
 *     it deliberately does not enforce this. Provenance CHECKPOINTS
 *     themselves (createFinalDevelopmentRecordsWithTx) are still written
 *     when the policy has provenance enabled at all — only the "block
 *     finalization until declared" requirement is skipped for the
 *     backstop.
 *   - post-transaction side effects (Canvas passback, network evidence,
 *     activity telemetry, session teardown) — see runPostFinalizationEffects
 *     below, called by the caller only when didFinalize is true.
 */
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { parseSecureSettings, questionPoolsActive } from "@/lib/secureExam";
import { resolveEffectiveQuestionIds } from "@/lib/questionDelivery";
import { saveAnswerWithIdempotency } from "@/lib/answerSaveRunner";
import { parseAnswerProvenancePolicy, isAnswerProvenanceEnabled } from "@/lib/answerProvenancePolicy";
import { createFinalDevelopmentRecordsWithTx } from "@/lib/answerDevelopmentRunner";
import { createPlatformAuditLog } from "@/lib/platformAdmin";
import { recordSimpleActivityEvent } from "@/lib/answerActivityTelemetry";
import { endExamAttemptSessionsForSubmission } from "@/lib/examAttemptSessionRunner";
import { pushGradeToCanvas } from "@/lib/lti/gradePassback";
import { captureNetworkEvidence, getClientIpFromRequest } from "@/lib/networkEvidence";

export type FinalizationTrigger = "STUDENT_SUBMIT" | "SERVER_BACKSTOP";

/** Thrown inside the transaction when another request already finalized this submission — never a real failure, just routes to the ALREADY_FINALIZED result below, exactly like the pre-extraction P2025/status-recheck handling in the submit route. */
class AlreadyFinalizedError extends Error {}

export type FinalizeSubmissionResult =
  | { kind: "NOT_FOUND" }
  | { kind: "INVALID_FINAL_RESPONSE_QUESTION" }
  | {
      kind: "ALREADY_FINALIZED";
      didFinalize: false;
      submission: Awaited<ReturnType<typeof prisma.submission.findUniqueOrThrow>>;
      exam: { institutionId: string | null; marksReleasedAt: Date | null };
    }
  | {
      kind: "FINALIZED";
      didFinalize: true;
      submission: Awaited<ReturnType<typeof prisma.submission.update>>;
      exam: { institutionId: string | null; marksReleasedAt: Date | null };
      hasEssay: boolean;
    };

/**
 * Bounded, shape-only validation of the client's optional final-answer
 * snapshot — identical contract to the pre-extraction submit route's own
 * parseFinalResponses. `undefined`/omitted always means "no snapshot" ({}),
 * which is exactly what every SERVER_BACKSTOP caller passes (see the
 * module doc comment above — a backstop can only ever finalize on
 * whatever autosave already persisted).
 */
export function parseFinalResponses(raw: unknown): { ok: true; value: Record<string, string> } | { ok: false } {
  if (raw === undefined) return { ok: true, value: {} };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 500) return { ok: false };
  const value: Record<string, string> = {};
  for (const [questionId, response] of entries) {
    if (typeof response !== "string") return { ok: false };
    value[questionId] = response;
  }
  return { ok: true, value };
}

/**
 * The one authoritative finalization mechanism. Safe to call whenever a
 * caller has already decided (via its OWN policy gate — see the module
 * doc comment) that this submission should be finalized right now.
 * Idempotent: a submission already SUBMITTED/GRADED by the time this
 * runs (a genuine race against another finalizer) resolves to
 * `{ kind: "ALREADY_FINALIZED", didFinalize: false, ... }`, never a
 * second grading pass.
 */
export async function finalizeSubmission(params: {
  submissionId: string;
  finalResponses: Record<string, string>;
  submissionRequestId: string | null;
  triggeredBy: FinalizationTrigger;
  /**
   * Required (and only meaningful) for triggeredBy === "SERVER_BACKSTOP" —
   * relayed verbatim into the SUBMISSION_SERVER_BACKSTOP_FINALIZED audit
   * metadata below. The caller must compute this from the attempt's own
   * frozen timing policy (submissionDeadline(startedAt,
   * resolveSubmissionTimingPolicy(...).durationMins)) — this module never
   * computes or re-derives a deadline itself.
   */
  deadline?: Date;
}): Promise<FinalizeSubmissionResult> {
  const { submissionId: id, finalResponses, submissionRequestId, triggeredBy, deadline } = params;

  const submission = await prisma.submission.findUnique({
    where: { id },
    include: { exam: { include: { questions: true } } },
  });
  if (!submission) return { kind: "NOT_FOUND" };

  if (submission.status !== "IN_PROGRESS") {
    return {
      kind: "ALREADY_FINALIZED",
      didFinalize: false,
      submission,
      exam: { institutionId: submission.exam.institutionId, marksReleasedAt: submission.exam.marksReleasedAt },
    };
  }

  const settings = parseSecureSettings(submission.exam.secureSettings);
  const provenancePolicy = parseAnswerProvenancePolicy(submission.answerProvenancePolicySnapshotJson);

  const effectiveQuestionIds = resolveEffectiveQuestionIds({
    examQuestionIds: submission.exam.questions.map((q) => q.id),
    stored: submission.questionOrderJson,
    questionPoolsActive: questionPoolsActive(settings),
  });
  const effectiveQuestionIdSet = new Set(effectiveQuestionIds);
  const questionsToGrade = submission.exam.questions.filter((q) => effectiveQuestionIdSet.has(q.id));

  const invalidFinalResponseQuestionIds = Object.keys(finalResponses).filter((qid) => !effectiveQuestionIdSet.has(qid));
  if (invalidFinalResponseQuestionIds.length > 0) {
    return { kind: "INVALID_FINAL_RESPONSE_QUESTION" };
  }

  try {
    let hasEssay = false;
    const updatedSubmission = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;

      const fresh = await tx.submission.findUnique({ where: { id }, select: { status: true } });
      if (!fresh || fresh.status !== "IN_PROGRESS") {
        throw new AlreadyFinalizedError();
      }

      for (const [questionId, response] of Object.entries(finalResponses)) {
        const finalSaveResult = await saveAnswerWithIdempotency(tx, {
          submissionId: id,
          examId: submission.examId,
          questionId,
          response,
          clientRequestId: `${submissionRequestId ?? id}:${questionId}:final`,
          clientRevision: null,
        });
        if (finalSaveResult.kind === "invalid_question") {
          // Defensive only — every id was already validated against
          // effectiveQuestionIdSet above.
          throw new Error(`finalResponses referenced an invalid question: ${questionId}`);
        }
      }

      const freshAnswers = await tx.answer.findMany({ where: { submissionId: id } });
      const answersByQuestion = new Map(freshAnswers.map((a) => [a.questionId, a]));

      let autoScore = 0;
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
      const result = await tx.submission.update({
        where: { id, status: "IN_PROGRESS" },
        data: {
          status: hasEssay ? "SUBMITTED" : "GRADED",
          submittedAt: now,
          gradedAt: hasEssay ? null : now,
          totalScore: hasEssay ? null : autoScore,
          finalSubmissionRequestId: submissionRequestId ?? undefined,
        },
      });

      if (isAnswerProvenanceEnabled(provenancePolicy)) {
        await createFinalDevelopmentRecordsWithTx(
          tx,
          provenancePolicy,
          id,
          effectiveQuestionIds,
          [...answersByQuestion.values()].map((a) => ({ id: a.id, questionId: a.questionId, response: a.response })),
        );
      }

      // Server-backstop audit — MUST be atomic with the status transition
      // above (same transaction, awaited, never a fire-and-forget
      // best-effort call like every other audit log in this codebase): a
      // reader must never be able to observe a server-finalized
      // submission with no corresponding audit row, or vice versa.
      if (triggeredBy === "SERVER_BACKSTOP") {
        await createPlatformAuditLog(
          {
            actorId: null,
            action: "SUBMISSION_SERVER_BACKSTOP_FINALIZED",
            targetType: "Submission",
            targetId: id,
            institutionId: submission.exam.institutionId,
            metadata: {
              submissionId: id,
              examId: submission.examId,
              studentId: submission.studentId,
              deadline: deadline ? deadline.toISOString() : null,
              finalizedAt: now.toISOString(),
              trigger: "deadline_backstop",
            },
          },
          tx,
        );
      }

      return result;
    });

    return {
      kind: "FINALIZED",
      didFinalize: true,
      submission: updatedSubmission,
      exam: { institutionId: submission.exam.institutionId, marksReleasedAt: submission.exam.marksReleasedAt },
      hasEssay,
    };
  } catch (err) {
    if (err instanceof AlreadyFinalizedError || (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025")) {
      const current = await prisma.submission.findUnique({
        where: { id },
        include: { exam: { select: { institutionId: true, marksReleasedAt: true } } },
      });
      if (current) {
        return {
          kind: "ALREADY_FINALIZED",
          didFinalize: false,
          submission: current,
          exam: { institutionId: current.exam.institutionId, marksReleasedAt: current.exam.marksReleasedAt },
        };
      }
    }
    throw err;
  }
}

/**
 * Post-transaction side effects — called ONLY when the caller's own
 * finalizeSubmission() result has didFinalize===true (the transaction
 * that actually performed IN_PROGRESS -> SUBMITTED/GRADED), so a
 * concurrent loser (ALREADY_FINALIZED) never re-runs any of these.
 * Shared by every trigger so student-submit and server-backstop
 * finalization never diverge in what happens afterward — the one
 * deliberate difference is request/IP-attributed evidence, which only
 * ever runs for a genuine student HTTP request (see `req` below).
 */
export async function runPostFinalizationEffects(params: {
  submissionId: string;
  examId: string;
  studentId: string;
  hasEssay: boolean;
  /** Present only for a genuine student-initiated HTTP request — omitted for SERVER_BACKSTOP, which has no request/IP to honestly attribute evidence to. */
  req?: Request;
}): Promise<void> {
  const { submissionId, examId, studentId, hasEssay, req } = params;

  if (!hasEssay) {
    pushGradeToCanvas(submissionId).catch(console.error);
  }

  recordSimpleActivityEvent({ submissionId, eventType: "ATTEMPT_SUBMITTED" }).catch(() => {});
  // Ensures an expired/finalized attempt cannot remain — or re-enter —
  // logically ACTIVE: the same teardown the student-submit path has
  // always run, now shared so a server-backstop finalization closes the
  // attempt's session binding identically. Awaited (unlike the
  // fire-and-forget telemetry/passback calls around it) — "an expired
  // attempt cannot remain ACTIVE" is a guarantee this function must
  // actually keep before returning, not a best-effort side effect racing
  // the caller's own response.
  await endExamAttemptSessionsForSubmission(submissionId).catch(() => {});

  if (req) {
    const startEvidence = await prisma.networkEvidence.findFirst({
      where: { submissionId, source: "EXAM_START" },
      orderBy: { createdAt: "asc" },
      select: { ipAddress: true, country: true, institutionId: true },
    });
    captureNetworkEvidence({
      req,
      submissionId,
      examId,
      studentId,
      institutionId: startEvidence?.institutionId ?? "",
      source: "EXAM_SUBMIT",
      priorIp: startEvidence?.ipAddress ?? null,
      priorCountry: startEvidence?.country ?? null,
    }).catch(() => {});

    const submitIp = getClientIpFromRequest(req);
    if (startEvidence?.country && submitIp && startEvidence.ipAddress !== submitIp) {
      await prisma.integrityEvent
        .create({
          data: {
            submissionId,
            examId,
            studentId,
            eventType: "MANUAL_WARNING",
            severity: "LOW",
            message: "Network address changed between exam open and submission. Review network evidence for context.",
            occurredAt: new Date(),
          },
        })
        .catch(() => {});
    }
  }
}
