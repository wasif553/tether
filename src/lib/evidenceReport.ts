import { prisma } from "@/lib/prisma";
import { computeRiskScore, riskLevelForScore, type RiskLevel } from "@/lib/integrityRisk";
import { labelForEventType } from "@/lib/integrityEventLabels";
import { isPlatformAdmin, requireInstitutionId } from "@/lib/institutionScope";
import { networkReviewSignal, type NetworkReviewSignal } from "@/lib/networkEvidence";
import { parseScreenSharePolicy, isScreenShareRequired } from "@/lib/screenSharePolicy";
import type { Session } from "next-auth";

export const EVIDENCE_DISCLAIMER =
  "Integrity events are signals for human review and are not automatic misconduct determinations.";

export const NETWORK_EVIDENCE_DISCLAIMER =
  "IP-based location is approximate and may be affected by VPNs, mobile networks, campus networks, " +
  "or ISP routing. Treat as an integrity signal, not proof of misconduct. SES does not use GPS " +
  "location. Network evidence is for lecturer review only and is never an automatic determination.";

// Optional Student Verification + On-Device AI Camera Integrity
// Detection v1 — see docs/on-device-ai-integrity-detection-v1.md.
export const AI_CAMERA_INTEGRITY_DISCLAIMER =
  "AI camera signals are indicators for review. They are not automatic misconduct decisions.";

// Screen-share Evidence Mode v1 — see docs/screen-share-evidence-v1.md.
export const SCREEN_SHARE_EVIDENCE_DISCLAIMER =
  "Screen-share signals and evidence frames are indicators for human review. They are not " +
  "automatic misconduct decisions, and browser/operating-system limitations apply — see " +
  "docs/screen-share-evidence-v1.md.";

const AI_CAMERA_EVENT_TYPES = [
  "POSSIBLE_PHONE_VISIBLE",
  "POSSIBLE_SECOND_PERSON_VISIBLE",
  "NO_PERSON_VISIBLE",
  "CAMERA_VIEW_BLOCKED",
  "CAMERA_TOO_DARK",
] as const;

const SCREEN_SHARE_EVENT_TYPES = [
  "SCREEN_SHARE_STARTED",
  "SCREEN_SHARE_PERMISSION_DENIED",
  "SCREEN_SHARE_UNAVAILABLE",
  "SCREEN_SHARE_SURFACE_REJECTED",
  "SCREEN_SHARE_INTERRUPTED",
  "SCREEN_SHARE_RESTORED",
  "SCREEN_SHARE_EVIDENCE_CAPTURED",
  "SCREEN_SHARE_EVIDENCE_CAPTURE_FAILED",
] as const;

export class EvidenceNotFoundError extends Error {}
export class EvidenceForbiddenError extends Error {}

export type EvidenceReportEventEvidenceFrame = {
  id: string;
  kind: string;
  contentType: string;
  byteSize: number;
  capturedAt: string;
} | null;

export type EvidenceReportEvidenceFrame = {
  id: string;
  eventId: string;
  eventType: string;
  kind: string;
  occurredAt: string;
  contentType: string;
  byteSize: number;
  capturedAt: string;
};

export type EvidenceReport = {
  submissionId: string;
  student: { name: string; email: string };
  exam: { id: string; title: string };
  status: string;
  startedAt: string;
  submittedAt: string | null;
  gradedAt: string | null;
  totalScore: number | null;
  riskScore: number;
  riskLevel: RiskLevel;
  events: Array<{
    id: string;
    eventType: string;
    eventLabel: string;
    severity: string;
    message: string;
    occurredAt: string;
    resolvedAt: string | null;
    resolvedByName: string | null;
    resolutionNote: string | null;
    confidenceBand: string | null;
    // On-Device AI Camera Integrity Detection v1 — Evidence Frames
    // (additive, opt-in) — see docs/on-device-ai-integrity-detection-v1.md.
    // Present only for POSSIBLE_PHONE_VISIBLE/POSSIBLE_SECOND_PERSON_VISIBLE
    // events that actually have a captured frame (captureAiViolationEvidence
    // enabled at the time this event fired). Never includes the image
    // itself or the raw storageKey — only display-safe metadata; the
    // image bytes are resolved separately via the authenticated, audited
    // GET /api/integrity-evidence/[id] route, using evidenceFrame.id.
    evidenceFrame: EvidenceReportEventEvidenceFrame;
  }>;
  // Top-level, denormalized list of every saved camera evidence frame for
  // this submission — lets the lecturer evidence report page surface a
  // dedicated "Camera evidence frames" section above the (potentially
  // hundreds-of-rows-long) event timeline, rather than requiring a
  // lecturer to scan the whole timeline to find them. Newest first. Never
  // includes storageKey or any raw storage reference.
  evidenceFrames: EvidenceReportEvidenceFrame[];
  aiCameraIntegritySummary: {
    possiblePhoneCount: number;
    possibleSecondPersonCount: number;
    noPersonCount: number;
    cameraBlockedOrDarkCount: number;
    disclaimer: string;
  } | null;
  // Screen-share Evidence Mode v1 — see docs/screen-share-evidence-v1.md.
  // Null unless screen sharing was required for this attempt (per the
  // IMMUTABLE snapshot taken at attempt start — never the exam's current,
  // possibly since-changed, settings).
  screenShareIntegritySummary: {
    startedCount: number;
    interruptedCount: number;
    restoredCount: number;
    surfaceRejectedCount: number;
    permissionDeniedCount: number;
    unavailableCount: number;
    evidenceFrameCount: number;
    evidenceCaptureFailedCount: number;
    // The policy actually in effect for THIS attempt — never the exam's
    // current settings, which may have changed since.
    policy: {
      mode: "OFF" | "REQUIRED";
      captureEvidence: boolean;
      evidenceIntervalSeconds: number;
      maxEvidenceFrames: number;
    };
    disclaimer: string;
  } | null;
  canvasPassback: {
    status: string;
    scoreGiven: number | null;
    sentAt: string | null;
    errorMessage: string | null;
  } | null;
  aiMarking: {
    answeredEssayCount: number;
    aiDraftedCount: number;
  } | null;
  networkEvidence: {
    start: {
      ipAddress: string | null;
      country: string | null;
      region: string | null;
      city: string | null;
      timezone: string | null;
      locationAccuracy: string;
      userAgent: string | null;
      browserName: string | null;
      osName: string | null;
      vpnOrProxySignal: boolean;
      capturedAt: string;
    } | null;
    submit: {
      ipAddress: string | null;
      country: string | null;
      region: string | null;
      city: string | null;
      timezone: string | null;
      locationAccuracy: string;
      userAgent: string | null;
      browserName: string | null;
      osName: string | null;
      vpnOrProxySignal: boolean;
      networkChanged: boolean;
      capturedAt: string;
    } | null;
    reviewSignal: NetworkReviewSignal;
    networkEvidenceDisclaimer: string;
  };
  disclaimer: string;
};

export async function buildEvidenceReport(
  submissionId: string,
  session: Session,
): Promise<EvidenceReport> {
  const lecturerId = session.user.id;
  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: {
      student: { select: { name: true, email: true } },
      exam: { select: { id: true, title: true, createdById: true, institutionId: true } },
      integrityEvents: {
        include: {
          resolvedBy: { select: { name: true } },
          evidenceAsset: { select: { id: true, kind: true, contentType: true, byteSize: true, capturedAt: true } },
        },
        // Newest first — a lecturer reviewing a submission cares most
        // about the most recent signals, not the oldest; also matches the
        // "Camera evidence frames" section below, which is naturally
        // newest-first from the same underlying query.
        orderBy: { occurredAt: "desc" },
      },
      gradePassback: true,
      answers: { include: { question: { select: { type: true } } } },
      networkEvidence: { orderBy: { createdAt: "asc" } },
    },
  });

  if (!submission) throw new EvidenceNotFoundError(`Submission ${submissionId} not found`);
  // This is the single choke point for evidence access — both the JSON and
  // CSV evidence routes call this function, so fixing institution scoping
  // here covers both (see docs/multi-tenant-migration.md).
  if (!isPlatformAdmin(session) && submission.exam.createdById !== lecturerId) {
    throw new EvidenceForbiddenError("Not the owner of this exam");
  }
  if (!isPlatformAdmin(session) && requireInstitutionId(session) !== submission.exam.institutionId) {
    throw new EvidenceForbiddenError("Submission belongs to a different institution");
  }

  const riskScore = computeRiskScore(submission.integrityEvents);
  const riskLevel = riskLevelForScore(riskScore);

  const essayAnswers = submission.answers.filter((a) => a.question.type === "ESSAY");
  const aiMarking = essayAnswers.length
    ? {
        answeredEssayCount: essayAnswers.filter((a) => a.response != null && a.response !== "").length,
        aiDraftedCount: essayAnswers.filter((a) => a.aiGradedAt != null).length,
      }
    : null;

  const startNe = submission.networkEvidence.find((e) => e.source === "EXAM_START") ?? null;
  const submitNe = submission.networkEvidence.find((e) => e.source === "EXAM_SUBMIT") ?? null;

  const aiCameraEvents = submission.integrityEvents.filter((e) =>
    (AI_CAMERA_EVENT_TYPES as readonly string[]).includes(e.eventType),
  );
  const aiCameraIntegritySummary = aiCameraEvents.length
    ? {
        possiblePhoneCount: aiCameraEvents.filter((e) => e.eventType === "POSSIBLE_PHONE_VISIBLE").length,
        possibleSecondPersonCount: aiCameraEvents.filter(
          (e) => e.eventType === "POSSIBLE_SECOND_PERSON_VISIBLE",
        ).length,
        noPersonCount: aiCameraEvents.filter((e) => e.eventType === "NO_PERSON_VISIBLE").length,
        cameraBlockedOrDarkCount: aiCameraEvents.filter(
          (e) => e.eventType === "CAMERA_VIEW_BLOCKED" || e.eventType === "CAMERA_TOO_DARK",
        ).length,
        disclaimer: AI_CAMERA_INTEGRITY_DISCLAIMER,
      }
    : null;

  const screenSharePolicy = parseScreenSharePolicy(submission.screenSharePolicySnapshotJson);
  const screenShareEvents = submission.integrityEvents.filter((e) =>
    (SCREEN_SHARE_EVENT_TYPES as readonly string[]).includes(e.eventType),
  );
  const screenShareIntegritySummary = isScreenShareRequired(screenSharePolicy)
    ? {
        startedCount: screenShareEvents.filter((e) => e.eventType === "SCREEN_SHARE_STARTED").length,
        interruptedCount: screenShareEvents.filter((e) => e.eventType === "SCREEN_SHARE_INTERRUPTED").length,
        restoredCount: screenShareEvents.filter((e) => e.eventType === "SCREEN_SHARE_RESTORED").length,
        surfaceRejectedCount: screenShareEvents.filter((e) => e.eventType === "SCREEN_SHARE_SURFACE_REJECTED").length,
        permissionDeniedCount: screenShareEvents.filter((e) => e.eventType === "SCREEN_SHARE_PERMISSION_DENIED").length,
        unavailableCount: screenShareEvents.filter((e) => e.eventType === "SCREEN_SHARE_UNAVAILABLE").length,
        evidenceFrameCount: screenShareEvents.filter((e) => e.eventType === "SCREEN_SHARE_EVIDENCE_CAPTURED").length,
        evidenceCaptureFailedCount: screenShareEvents.filter((e) => e.eventType === "SCREEN_SHARE_EVIDENCE_CAPTURE_FAILED").length,
        policy: {
          mode: screenSharePolicy.mode,
          captureEvidence: screenSharePolicy.captureEvidence,
          evidenceIntervalSeconds: screenSharePolicy.evidenceIntervalSeconds,
          maxEvidenceFrames: screenSharePolicy.maxEvidenceFrames,
        },
        disclaimer: SCREEN_SHARE_EVIDENCE_DISCLAIMER,
      }
    : null;

  return {
    submissionId: submission.id,
    student: { name: submission.student.name, email: submission.student.email },
    exam: { id: submission.exam.id, title: submission.exam.title },
    status: submission.status,
    startedAt: submission.startedAt.toISOString(),
    submittedAt: submission.submittedAt?.toISOString() ?? null,
    gradedAt: submission.gradedAt?.toISOString() ?? null,
    totalScore: submission.totalScore,
    riskScore,
    riskLevel,
    events: submission.integrityEvents.map((e) => {
      const metadata = e.metadataJson as Record<string, unknown> | null;
      const confidenceBand =
        metadata && typeof metadata.confidenceBand === "string" ? metadata.confidenceBand : null;
      return {
        id: e.id,
        eventType: e.eventType,
        eventLabel: labelForEventType(e.eventType),
        severity: e.severity,
        message: e.message,
        occurredAt: e.occurredAt.toISOString(),
        resolvedAt: e.resolvedAt?.toISOString() ?? null,
        resolvedByName: e.resolvedBy?.name ?? null,
        resolutionNote: e.resolutionNote,
        confidenceBand,
        evidenceFrame: e.evidenceAsset
          ? {
              id: e.evidenceAsset.id,
              kind: e.evidenceAsset.kind,
              contentType: e.evidenceAsset.contentType,
              byteSize: e.evidenceAsset.byteSize,
              capturedAt: e.evidenceAsset.capturedAt.toISOString(),
            }
          : null,
      };
    }),
    evidenceFrames: submission.integrityEvents
      .filter((e) => e.evidenceAsset != null)
      .map((e) => ({
        id: e.evidenceAsset!.id,
        kind: e.evidenceAsset!.kind,
        eventId: e.id,
        eventType: e.eventType,
        occurredAt: e.occurredAt.toISOString(),
        contentType: e.evidenceAsset!.contentType,
        byteSize: e.evidenceAsset!.byteSize,
        capturedAt: e.evidenceAsset!.capturedAt.toISOString(),
      })),
    aiCameraIntegritySummary,
    screenShareIntegritySummary,
    canvasPassback: submission.gradePassback
      ? {
          status: submission.gradePassback.status,
          scoreGiven: submission.gradePassback.scoreGiven,
          sentAt: submission.gradePassback.sentAt?.toISOString() ?? null,
          errorMessage: submission.gradePassback.errorMessage,
        }
      : null,
    aiMarking,
    networkEvidence: {
      start: startNe
        ? {
            ipAddress: startNe.ipAddress,
            country: startNe.country,
            region: startNe.region,
            city: startNe.city,
            timezone: startNe.timezone,
            locationAccuracy: startNe.locationAccuracy,
            userAgent: startNe.userAgent,
            browserName: startNe.browserName,
            osName: startNe.osName,
            vpnOrProxySignal: startNe.vpnOrProxySignal,
            capturedAt: startNe.createdAt.toISOString(),
          }
        : null,
      submit: submitNe
        ? {
            ipAddress: submitNe.ipAddress,
            country: submitNe.country,
            region: submitNe.region,
            city: submitNe.city,
            timezone: submitNe.timezone,
            locationAccuracy: submitNe.locationAccuracy,
            userAgent: submitNe.userAgent,
            browserName: submitNe.browserName,
            osName: submitNe.osName,
            vpnOrProxySignal: submitNe.vpnOrProxySignal,
            networkChanged: submitNe.networkChanged,
            capturedAt: submitNe.createdAt.toISOString(),
          }
        : null,
      reviewSignal: networkReviewSignal(
        startNe
          ? { country: startNe.country, ipAddress: startNe.ipAddress }
          : null,
        submitNe
          ? {
              country: submitNe.country,
              ipAddress: submitNe.ipAddress,
              networkChanged: submitNe.networkChanged,
            }
          : null,
      ),
      networkEvidenceDisclaimer: NETWORK_EVIDENCE_DISCLAIMER,
    },
    disclaimer: EVIDENCE_DISCLAIMER,
  };
}

export function evidenceReportToCsv(report: EvidenceReport): string {
  const lines: string[] = [];
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;

  lines.push("Field,Value");
  lines.push(`Student,${esc(report.student.name)}`);
  lines.push(`Email,${esc(report.student.email)}`);
  lines.push(`Exam,${esc(report.exam.title)}`);
  lines.push(`Status,${esc(report.status)}`);
  lines.push(`Started At,${esc(report.startedAt)}`);
  lines.push(`Submitted At,${esc(report.submittedAt ?? "")}`);
  lines.push(`Score,${esc(report.totalScore != null ? String(report.totalScore) : "")}`);
  lines.push(`Risk Score,${esc(String(report.riskScore))}`);
  lines.push(`Risk Level,${esc(report.riskLevel)}`);
  lines.push("");
  lines.push("Event Type,Severity,Message,Occurred At,Resolved At,Resolved By,Note,Confidence Band");
  for (const e of report.events) {
    lines.push(
      [
        esc(e.eventLabel),
        esc(e.severity),
        esc(e.message),
        esc(e.occurredAt),
        esc(e.resolvedAt ?? ""),
        esc(e.resolvedByName ?? ""),
        esc(e.resolutionNote ?? ""),
        esc(e.confidenceBand ?? ""),
      ].join(","),
    );
  }
  if (report.aiCameraIntegritySummary) {
    lines.push("");
    lines.push("AI-assisted camera integrity signals");
    const ai = report.aiCameraIntegritySummary;
    lines.push(`Possible phone visible,${esc(String(ai.possiblePhoneCount))}`);
    lines.push(`Possible additional person visible,${esc(String(ai.possibleSecondPersonCount))}`);
    lines.push(`No person visible,${esc(String(ai.noPersonCount))}`);
    lines.push(`Camera blocked/dark,${esc(String(ai.cameraBlockedOrDarkCount))}`);
    lines.push(esc(ai.disclaimer));
  }
  lines.push("");
  lines.push("Network Evidence");
  const ne = report.networkEvidence;
  const neRow = (label: string, value: string | null | boolean | undefined) =>
    lines.push(`${esc(label)},${esc(value != null ? String(value) : "")}`);
  neRow("Network review signal", ne.reviewSignal);
  neRow("Exam opened — IP", ne.start?.ipAddress ?? null);
  neRow("Exam opened — Country", ne.start?.country ?? null);
  neRow("Exam opened — Region", ne.start?.region ?? null);
  neRow("Exam opened — City", ne.start?.city ?? null);
  neRow("Exam opened — Timezone", ne.start?.timezone ?? null);
  neRow("Exam opened — Location accuracy", ne.start?.locationAccuracy ?? null);
  neRow("Exam opened — Browser", ne.start?.browserName ?? null);
  neRow("Exam opened — OS", ne.start?.osName ?? null);
  neRow("Exam opened — VPN/proxy signal", ne.start?.vpnOrProxySignal ?? null);
  neRow("Exam opened — Captured at", ne.start?.capturedAt ?? null);
  neRow("Exam submitted — IP", ne.submit?.ipAddress ?? null);
  neRow("Exam submitted — Country", ne.submit?.country ?? null);
  neRow("Exam submitted — Region", ne.submit?.region ?? null);
  neRow("Exam submitted — City", ne.submit?.city ?? null);
  neRow("Exam submitted — Timezone", ne.submit?.timezone ?? null);
  neRow("Exam submitted — Location accuracy", ne.submit?.locationAccuracy ?? null);
  neRow("Exam submitted — Browser", ne.submit?.browserName ?? null);
  neRow("Exam submitted — OS", ne.submit?.osName ?? null);
  neRow("Exam submitted — VPN/proxy signal", ne.submit?.vpnOrProxySignal ?? null);
  neRow("Exam submitted — Network changed", ne.submit?.networkChanged ?? null);
  neRow("Exam submitted — Captured at", ne.submit?.capturedAt ?? null);
  lines.push(esc(ne.networkEvidenceDisclaimer));
  lines.push("");
  lines.push(esc(report.disclaimer));

  return lines.join("\n");
}
