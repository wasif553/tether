/**
 * Answer-Development Provenance v1 — server-only orchestration. See
 * docs/answer-development-provenance-v1.md.
 *
 * Touches Prisma, so it must never be imported from a "use client"
 * component — all pure decision logic lives in src/lib/answerDevelopment.ts
 * and src/lib/answerDevelopmentDiff.ts instead. Concurrency-safe: every
 * mutating entry point runs inside a single Postgres transaction guarded
 * by a transaction-scoped advisory lock keyed on submissionId
 * (`pg_advisory_xact_lock`), mirroring src/lib/aiAssistanceRunner.ts and
 * the screen-evidence route's reservation pattern — safe under Supabase's
 * PgBouncer transaction-mode pooler.
 */
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { parseSecureSettings, questionPoolsActive } from "@/lib/secureExam";
import { resolveEffectiveQuestionIds } from "@/lib/questionDelivery";
import {
  parseAnswerProvenancePolicy,
  isAnswerProvenanceEnabled,
  type AnswerProvenancePolicy,
} from "@/lib/answerProvenancePolicy";
import {
  decideCheckpoint,
  shouldSuppressForCapacity,
  isPastedTextSubstantiallyReplaced,
  computeProcessObservations,
  DEFAULT_EVENT_LEVEL_FOR_TYPE,
  ATTEMPT_LEVEL_ARTIFACT_TYPES,
  type ChangeType,
  type CheckpointSource,
  type DevelopmentEventType,
  type ArtifactType,
} from "@/lib/answerDevelopment";
import { computePasteRetention, diffAnswerText } from "@/lib/answerDevelopmentDiff";
import { ARTIFACT_MAX_CHARACTERS, EVENT_METADATA_MAX_CHARS } from "@/lib/answerDevelopmentThresholds";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ---------------------------------------------------------------------------
// Shared student-route context loading (Part 6) — mirrors
// aiAssistanceRunner.ts's loadValidatedContext pattern exactly: ownership,
// liveness, effective-question-set, and policy-enabled checks all in one
// place, thrown as a typed error the calling route maps to a NextResponse.
// ---------------------------------------------------------------------------

export class AnswerDevelopmentError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type StudentSubmissionContext = {
  submission: {
    id: string;
    examId: string;
    studentId: string;
    status: string;
    currentQuestionIndex: number;
    answerProvenancePolicySnapshotJson: unknown;
  };
  policy: AnswerProvenancePolicy;
  effectiveQuestionIds: string[];
  oneQuestionAtATime: boolean;
};

/**
 * Loads and validates a submission for a student-facing answer-development
 * route. Requires an IN_PROGRESS attempt owned by studentId and an
 * ENABLED provenance policy. If questionId is supplied, also verifies it
 * belongs to the submission's effective question set — and, under
 * one-question-at-a-time delivery, that the student has actually reached
 * it (never a question still ahead of their current position).
 */
export async function loadValidatedStudentContext(
  submissionId: string,
  studentId: string,
  questionId?: string,
): Promise<StudentSubmissionContext> {
  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: { exam: { include: { questions: { orderBy: { order: "asc" } } } } },
  });
  if (!submission || submission.studentId !== studentId) {
    throw new AnswerDevelopmentError(404, "Not found");
  }
  if (submission.status !== "IN_PROGRESS") {
    throw new AnswerDevelopmentError(409, "This submission is no longer active");
  }

  const policy = parseAnswerProvenancePolicy(submission.answerProvenancePolicySnapshotJson);
  if (!isAnswerProvenanceEnabled(policy)) {
    throw new AnswerDevelopmentError(403, "Answer-development provenance is not enabled for this exam");
  }

  const settings = parseSecureSettings(submission.exam.secureSettings);
  const effectiveQuestionIds = resolveEffectiveQuestionIds({
    examQuestionIds: submission.exam.questions.map((q) => q.id),
    stored: submission.questionOrderJson,
    questionPoolsActive: questionPoolsActive(settings),
  });

  if (questionId) {
    const questionIndex = effectiveQuestionIds.indexOf(questionId);
    if (questionIndex === -1) {
      throw new AnswerDevelopmentError(404, "This question is not part of your attempt");
    }
    if (settings.oneQuestionAtATime && questionIndex > submission.currentQuestionIndex) {
      throw new AnswerDevelopmentError(403, "This question is not yet available in your attempt");
    }
  }

  return {
    submission: {
      id: submission.id,
      examId: submission.examId,
      studentId: submission.studentId,
      status: submission.status,
      currentQuestionIndex: submission.currentQuestionIndex,
      answerProvenancePolicySnapshotJson: submission.answerProvenancePolicySnapshotJson,
    },
    policy,
    effectiveQuestionIds,
    oneQuestionAtATime: settings.oneQuestionAtATime,
  };
}

// ---------------------------------------------------------------------------
// Checkpoint creation (Part 4/6) — concurrency-safe, idempotent, server-
// assigned version numbers.
// ---------------------------------------------------------------------------

export type CreateCheckpointParams = {
  submissionId: string;
  questionId: string;
  currentText: string;
  source: CheckpointSource;
  clientRequestId: string | null;
  clientElapsedMs: number | null;
  pasteInsertedChars?: number;
  isManualCheckpoint?: boolean;
  isFinalSubmission?: boolean;
};

export type CheckpointOutcome =
  | { kind: "created"; versionId: string; versionNumber: number; changeType: ChangeType }
  | { kind: "replay"; versionId: string }
  | { kind: "no_change"; reasonCode: string }
  | { kind: "suppressed_for_capacity" };

export async function reserveAndCreateCheckpoint(
  policy: AnswerProvenancePolicy,
  params: CreateCheckpointParams,
): Promise<CheckpointOutcome> {
  const nowMs = Date.now();
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${params.submissionId}))`;

    if (params.clientRequestId) {
      const existing = await tx.answerDevelopmentVersion.findUnique({
        where: { clientRequestId: params.clientRequestId },
        select: { id: true },
      });
      if (existing) return { kind: "replay", versionId: existing.id };
    }

    const latest = await tx.answerDevelopmentVersion.findFirst({
      where: { submissionId: params.submissionId, questionId: params.questionId },
      orderBy: { versionNumber: "desc" },
      select: { versionNumber: true, responseText: true, serverReceivedAt: true, id: true },
    });

    const decision = decideCheckpoint({
      priorText: latest?.responseText ?? null,
      currentText: params.currentText,
      policy,
      requestedSource: params.source,
      lastCheckpointAtMs: latest?.serverReceivedAt ? latest.serverReceivedAt.getTime() : null,
      nowMs,
      pasteInsertedChars: params.pasteInsertedChars,
      isManualCheckpoint: params.isManualCheckpoint,
      isFinalSubmission: params.isFinalSubmission,
    });

    if (!decision.shouldCreate || !decision.changeType) {
      return { kind: "no_change", reasonCode: decision.reasonCode };
    }

    const periodicCount =
      decision.changeType === "PERIODIC_CHECKPOINT"
        ? await tx.answerDevelopmentVersion.count({
            where: { submissionId: params.submissionId, questionId: params.questionId, changeType: "PERIODIC_CHECKPOINT" },
          })
        : 0;
    if (shouldSuppressForCapacity(decision.changeType, periodicCount, policy)) {
      return { kind: "suppressed_for_capacity" };
    }

    const answer = await tx.answer.upsert({
      where: { submissionId_questionId: { submissionId: params.submissionId, questionId: params.questionId } },
      update: { response: params.currentText },
      create: { submissionId: params.submissionId, questionId: params.questionId, response: params.currentText },
    });

    const versionNumber = (latest?.versionNumber ?? 0) + 1;
    const created = await tx.answerDevelopmentVersion.create({
      data: {
        submissionId: params.submissionId,
        answerId: answer.id,
        questionId: params.questionId,
        versionNumber,
        responseText: params.currentText,
        responseLength: params.currentText.length,
        responseHash: sha256(params.currentText),
        previousVersionId: latest?.id ?? null,
        changeType: decision.changeType,
        charactersAdded: decision.diff.charactersAdded,
        charactersRemoved: decision.diff.charactersRemoved,
        changeRatio: decision.diff.changeRatio,
        source: params.source,
        clientRequestId: params.clientRequestId,
        clientElapsedMs: params.clientElapsedMs,
      },
    });

    return { kind: "created", versionId: created.id, versionNumber, changeType: decision.changeType };
  });
}

/**
 * Best-effort, non-blocking check for whether the most recent
 * POST_PASTE_CHECKPOINT for a question has since been substantially
 * replaced by a later checkpoint — emits PASTED_TEXT_SUBSTANTIALLY_REPLACED
 * at most once per paste (skipped if that event already exists for a
 * later checkpoint than the paste itself). Never stores a separate raw
 * clipboard field — the "pasted text" here is derived from the ALREADY-
 * STORED paste checkpoint's own diff against its prior version (Part 3).
 */
export async function checkPasteRetentionAfterCheckpoint(submissionId: string, questionId: string): Promise<void> {
  try {
    const lastPaste = await prisma.answerDevelopmentVersion.findFirst({
      where: { submissionId, questionId, changeType: "POST_PASTE_CHECKPOINT" },
      orderBy: { versionNumber: "desc" },
    });
    if (!lastPaste) return;

    const alreadyChecked = await prisma.answerDevelopmentEvent.findFirst({
      where: {
        submissionId,
        questionId,
        eventType: "PASTED_TEXT_SUBSTANTIALLY_REPLACED",
        serverReceivedAt: { gt: lastPaste.serverReceivedAt },
      },
      select: { id: true },
    });
    if (alreadyChecked) return;

    const latest = await prisma.answerDevelopmentVersion.findFirst({
      where: { submissionId, questionId },
      orderBy: { versionNumber: "desc" },
    });
    if (!latest || latest.id === lastPaste.id) return;

    const priorVersion = lastPaste.previousVersionId
      ? await prisma.answerDevelopmentVersion.findUnique({ where: { id: lastPaste.previousVersionId } })
      : null;
    const pastedSegment = diffAnswerText(priorVersion?.responseText ?? "", lastPaste.responseText)
      .segments.filter((s) => s.type === "added")
      .map((s) => s.text)
      .join("");
    if (pastedSegment.length === 0) return;

    const retention = computePasteRetention(pastedSegment, latest.responseText);
    if (!isPastedTextSubstantiallyReplaced(retention.replacedRatio)) return;

    await prisma.answerDevelopmentEvent.create({
      data: {
        submissionId,
        answerId: latest.answerId,
        questionId,
        eventType: "PASTED_TEXT_SUBSTANTIALLY_REPLACED",
        eventLevel: DEFAULT_EVENT_LEVEL_FOR_TYPE.PASTED_TEXT_SUBSTANTIALLY_REPLACED,
        metadataJson: {
          pastedLength: retention.pastedLength,
          replacedRatio: Number(retention.replacedRatio.toFixed(3)),
        },
      },
    });
  } catch {
    // Best-effort — never blocks the checkpoint that triggered this check.
  }
}

// ---------------------------------------------------------------------------
// Development events (Part 2/6) — structured process metadata that does
// not require a full readable version.
// ---------------------------------------------------------------------------

export type RecordEventParams = {
  submissionId: string;
  answerId: string | null;
  questionId: string | null;
  examAttemptSessionId: string | null;
  eventType: DevelopmentEventType;
  clientRequestId: string | null;
  clientElapsedMs: number | null;
  metadata: Record<string, unknown> | null;
};

export async function recordDevelopmentEvent(params: RecordEventParams): Promise<{ id: string } | { replay: true; id: string }> {
  if (params.clientRequestId) {
    const existing = await prisma.answerDevelopmentEvent.findUnique({
      where: { clientRequestId: params.clientRequestId },
      select: { id: true },
    });
    if (existing) return { replay: true, id: existing.id };
  }

  const boundedMetadata = boundMetadata(params.metadata);
  const created = await prisma.answerDevelopmentEvent.create({
    data: {
      submissionId: params.submissionId,
      answerId: params.answerId,
      questionId: params.questionId,
      examAttemptSessionId: params.examAttemptSessionId,
      eventType: params.eventType,
      eventLevel: DEFAULT_EVENT_LEVEL_FOR_TYPE[params.eventType],
      clientRequestId: params.clientRequestId,
      clientElapsedMs: params.clientElapsedMs,
      metadataJson: boundedMetadata as Prisma.InputJsonValue | undefined,
    },
  });
  return { id: created.id };
}

/** Tightly bounds event metadata (Part 11) — never arbitrary/unlimited JSON, never a raw clipboard field, never individual keystrokes. */
function boundMetadata(metadata: Record<string, unknown> | null): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const serialised = JSON.stringify(metadata);
  if (serialised.length <= EVENT_METADATA_MAX_CHARS) return metadata;
  // Truncate defensively rather than reject outright — never blocks the
  // student's attempt over an oversized (but harmless) metadata payload.
  return { truncated: true, originalLength: serialised.length };
}

// ---------------------------------------------------------------------------
// Artifacts (Part 2/5/11) — outline / calculation working / code working /
// source declarations. One current row per (submission, question-or-null,
// artifactType); history preserved in AnswerDevelopmentArtifactVersion.
// ---------------------------------------------------------------------------

export type UpsertArtifactParams = {
  submissionId: string;
  questionId: string | null;
  answerId: string | null;
  artifactType: ArtifactType;
  content: string;
  clientRequestId: string | null;
};

export type ArtifactOutcome =
  | { kind: "created"; artifactId: string; version: number }
  | { kind: "updated"; artifactId: string; version: number }
  | { kind: "unchanged"; artifactId: string; version: number };

export async function upsertAnswerDevelopmentArtifact(params: UpsertArtifactParams): Promise<ArtifactOutcome> {
  const maxChars = ARTIFACT_MAX_CHARACTERS[params.artifactType] ?? 20_000;
  const content = params.content.length > maxChars ? params.content.slice(0, maxChars) : params.content;
  const contentHash = sha256(content);
  const isAttemptLevel = ATTEMPT_LEVEL_ARTIFACT_TYPES.has(params.artifactType);
  const effectiveQuestionId = isAttemptLevel ? null : params.questionId;

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${params.submissionId}))`;

    const existing = await tx.answerDevelopmentArtifact.findFirst({
      where: { submissionId: params.submissionId, questionId: effectiveQuestionId, artifactType: params.artifactType },
    });

    if (!existing) {
      const created = await tx.answerDevelopmentArtifact.create({
        data: {
          submissionId: params.submissionId,
          questionId: effectiveQuestionId,
          answerId: params.answerId,
          artifactType: params.artifactType,
          content,
          contentHash,
          version: 1,
          clientRequestId: params.clientRequestId,
        },
      });
      await tx.answerDevelopmentArtifactVersion.create({
        data: { artifactId: created.id, versionNumber: 1, content, contentHash, clientRequestId: params.clientRequestId },
      });
      return { kind: "created", artifactId: created.id, version: 1 };
    }

    if (existing.contentHash === contentHash) {
      return { kind: "unchanged", artifactId: existing.id, version: existing.version };
    }

    const nextVersion = existing.version + 1;
    const updated = await tx.answerDevelopmentArtifact.update({
      where: { id: existing.id },
      data: { content, contentHash, version: nextVersion },
    });
    await tx.answerDevelopmentArtifactVersion.create({
      data: { artifactId: existing.id, versionNumber: nextVersion, content, contentHash, clientRequestId: params.clientRequestId },
    });
    return { kind: "updated", artifactId: updated.id, version: nextVersion };
  });
}

// ---------------------------------------------------------------------------
// Source-declaration submission gate (Part 5/6/7)
// ---------------------------------------------------------------------------

export async function isSourceDeclarationSatisfied(submissionId: string, policy: AnswerProvenancePolicy): Promise<boolean> {
  if (!policy.requireAiSourceDeclaration) return true;
  const declaration = await prisma.answerDevelopmentArtifact.findFirst({
    where: { submissionId, artifactType: { in: ["AI_SOURCE_DECLARATION", "GENERAL_SOURCE_DECLARATION"] } },
    select: { id: true },
  });
  return declaration != null;
}

// ---------------------------------------------------------------------------
// Final-submission integration (Part 7) — fire-and-forget, called AFTER
// the grading transaction commits. A provenance failure here must never
// lose the student's final answer — the submission is already finalized
// by the time this runs.
// ---------------------------------------------------------------------------

export async function createFinalDevelopmentRecordsForSubmission(
  submissionId: string,
  effectiveQuestionIds: string[],
): Promise<void> {
  try {
    const submission = await prisma.submission.findUnique({
      where: { id: submissionId },
      select: { answerProvenancePolicySnapshotJson: true, answers: { select: { questionId: true, response: true } } },
    });
    if (!submission) return;
    const policy = parseAnswerProvenancePolicy(submission.answerProvenancePolicySnapshotJson);
    if (!isAnswerProvenanceEnabled(policy)) return;

    const responseByQuestion = new Map(submission.answers.map((a) => [a.questionId, a.response ?? ""]));

    for (const questionId of effectiveQuestionIds) {
      const currentText = responseByQuestion.get(questionId) ?? "";
      try {
        const outcome = await reserveAndCreateCheckpoint(policy, {
          submissionId,
          questionId,
          currentText,
          source: "SUBMISSION",
          clientRequestId: null,
          clientElapsedMs: null,
          isFinalSubmission: true,
        });
        const answer = await prisma.answer.findUnique({
          where: { submissionId_questionId: { submissionId, questionId } },
          select: { id: true },
        });
        await recordDevelopmentEvent({
          submissionId,
          answerId: answer?.id ?? null,
          questionId,
          examAttemptSessionId: null,
          eventType: "FINAL_ANSWER_SUBMITTED",
          clientRequestId: null,
          clientElapsedMs: null,
          metadata: { finalCheckpointOutcome: outcome.kind },
        });
      } catch (err) {
        console.error("[answerDevelopment] final checkpoint failed for question", questionId, err);
        // Never rethrow — the submission itself is already finalized.
      }
    }
  } catch (err) {
    console.error("[answerDevelopment] createFinalDevelopmentRecordsForSubmission failed", err);
  }
}

// ---------------------------------------------------------------------------
// Read models (Part 6/8)
// ---------------------------------------------------------------------------

export async function getStudentAnswerDevelopment(submissionId: string) {
  const [versions, events, artifacts] = await Promise.all([
    prisma.answerDevelopmentVersion.findMany({ where: { submissionId }, orderBy: { versionNumber: "asc" } }),
    prisma.answerDevelopmentEvent.findMany({ where: { submissionId }, orderBy: { serverReceivedAt: "asc" } }),
    prisma.answerDevelopmentArtifact.findMany({ where: { submissionId } }),
  ]);
  return { versions, events, artifacts };
}

export type LecturerQuestionTimelineEntry = {
  atMs: number;
  label: string;
  kind: "version" | "event";
};

/**
 * Assembles the full lecturer-facing picture for one submission: per-
 * question timelines, summary counters, and derived process observations
 * (Part 8/9). Never exposes another student's data (caller must already
 * have verified institution/ownership before calling this).
 */
export async function getLecturerAnswerDevelopment(submissionId: string) {
  const [versions, events, artifacts] = await Promise.all([
    prisma.answerDevelopmentVersion.findMany({ where: { submissionId }, orderBy: { versionNumber: "asc" } }),
    prisma.answerDevelopmentEvent.findMany({ where: { submissionId }, orderBy: { serverReceivedAt: "asc" } }),
    prisma.answerDevelopmentArtifact.findMany({ where: { submissionId } }),
  ]);

  const questionIds = [...new Set(versions.map((v) => v.questionId))];
  const perQuestion = questionIds.map((questionId) => {
    const questionVersions = versions.filter((v) => v.questionId === questionId);
    const questionEvents = events.filter((e) => e.questionId === questionId);
    const pasteEvents = questionVersions
      .filter((v) => v.changeType === "POST_PASTE_CHECKPOINT")
      .map((v) => {
        const replaced = questionEvents.find(
          (e) => e.eventType === "PASTED_TEXT_SUBSTANTIALLY_REPLACED" && e.serverReceivedAt > v.serverReceivedAt,
        );
        const replacedRatio = replaced ? ((replaced.metadataJson as { replacedRatio?: number } | null)?.replacedRatio ?? null) : null;
        return { insertedChars: v.charactersAdded, replacedRatio };
      });
    const substantialEditCount = questionVersions.filter((v) => v.changeType === "SUBSTANTIAL_EDIT").length;
    const firstMeaningful = questionVersions.find((v) => v.changeType === "INITIAL_TEXT");
    const outlineArtifact = artifacts.find((a) => a.artifactType === "OUTLINE" && (a.questionId === questionId || a.questionId === null));
    const workingArtifact = artifacts.find(
      (a) => (a.artifactType === "CALCULATION_WORKING" || a.artifactType === "CODE_WORKING") && (a.questionId === questionId || a.questionId === null),
    );
    const lastVersion = questionVersions[questionVersions.length - 1];
    const secondLastVersion = questionVersions[questionVersions.length - 2];
    const majorLateRewriteRatio =
      lastVersion && secondLastVersion && lastVersion.changeType === "FINAL_SUBMISSION" ? secondLastVersion.changeRatio : null;

    const observations = computeProcessObservations({
      versionCount: questionVersions.length,
      substantialEditCount,
      pasteEvents,
      outlinePrecededFinalResponse: Boolean(outlineArtifact && firstMeaningful && outlineArtifact.createdAt < firstMeaningful.serverReceivedAt),
      workingPrecededFinalResponse: Boolean(workingArtifact && firstMeaningful && workingArtifact.createdAt < firstMeaningful.serverReceivedAt),
      majorLateRewriteRatio,
      requireAiSourceDeclaration: false,
      hasSourceDeclaration: artifacts.some((a) => a.artifactType === "AI_SOURCE_DECLARATION" || a.artifactType === "GENERAL_SOURCE_DECLARATION"),
      hasCodeTestIteration: questionEvents.some((e) => e.eventType === "TEST_RUN_COMPLETED"),
    });

    return { questionId, versions: questionVersions, events: questionEvents, observations };
  });

  return {
    versions,
    events,
    artifacts,
    perQuestion,
    summary: {
      questionsWithData: questionIds.length,
      totalCheckpoints: versions.length,
      pasteEventCount: versions.filter((v) => v.changeType === "POST_PASTE_CHECKPOINT").length,
      substantialEditCount: versions.filter((v) => v.changeType === "SUBSTANTIAL_EDIT").length,
      outlineArtifactCount: artifacts.filter((a) => a.artifactType === "OUTLINE").length,
      calculationWorkingArtifactCount: artifacts.filter((a) => a.artifactType === "CALCULATION_WORKING").length,
      codeWorkingArtifactCount: artifacts.filter((a) => a.artifactType === "CODE_WORKING").length,
      sourceDeclarationCount: artifacts.filter((a) => a.artifactType === "AI_SOURCE_DECLARATION" || a.artifactType === "GENERAL_SOURCE_DECLARATION").length,
      firstMeaningfulInputAt: versions.find((v) => v.changeType === "INITIAL_TEXT")?.serverReceivedAt ?? null,
      finalSubmissionAt: versions.filter((v) => v.changeType === "FINAL_SUBMISSION").at(-1)?.serverReceivedAt ?? null,
    },
  };
}
