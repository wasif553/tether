import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getRequiredEnvStatus, getLtiEnvStatus, getAiEnvStatus } from "@/lib/env/readiness";
import { countUnmatchedLaunches } from "@/lib/lti/unmatchedLaunches";
import { institutionWhere, requireInstitutionId, isPlatformAdmin, institutionErrorResponse } from "@/lib/institutionScope";

type Status = "READY" | "NEEDS_SETUP" | "NOT_CONFIGURED" | "WARNING";

type ReadinessItem = {
  label: string;
  status: Status;
  detail?: string;
};

/**
 * Core secure exam readiness (Part A) must never depend on Canvas/LTI or AI
 * configuration — SES is a standalone secure exam platform first (see
 * docs/secure-exam-threat-model.md and docs/deployment-vercel-supabase.md).
 * Canvas and AI are always reported as separate optional modules (Parts B/C)
 * so a missing API key or platform link never marks the whole app "not
 * ready".
 */
export async function GET() {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const lecturerId = session.user.id;

  let exams;
  try {
    exams = await prisma.exam.findMany({
      where: { createdById: lecturerId, ...institutionWhere(session) },
      include: {
        questions: { select: { id: true } },
        submissions: { select: { id: true, status: true } },
      },
    });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const requiredEnv = getRequiredEnvStatus();
  const ltiEnv = getLtiEnvStatus();
  const aiEnv = getAiEnvStatus();

  let databaseConnected = true;
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    databaseConnected = false;
  }

  const authSecretConfigured = requiredEnv.checks.find((c) => c.key === "AUTH_SECRET")?.present ?? false;
  const appUrlConfigured = requiredEnv.checks.find((c) => c.key === "APP_URL")?.present ?? false;

  const hasExam = exams.length > 0;
  const hasQuestions = exams.some((e) => e.questions.length > 0);
  const hasPublished = exams.some((e) => e.published);
  const hasSubmission = exams.some((e) => e.submissions.length > 0);
  const hasGraded = exams.some((e) => e.submissions.some((s) => s.status === "GRADED"));
  const hasSecureModeConfigured = exams.some((e) => {
    const settings = e.secureSettings as { secureModeEnabled?: boolean } | null;
    return Boolean(settings?.secureModeEnabled);
  });
  const integrityCount = await prisma.integrityEvent.count({
    where: { exam: { createdById: lecturerId, ...institutionWhere(session) } },
  });

  // --- A. Core secure exam readiness (required) ---
  const core: ReadinessItem[] = [
    { label: "Database connected", status: databaseConnected ? "READY" : "NEEDS_SETUP" },
    { label: "Auth secret configured", status: authSecretConfigured ? "READY" : "NEEDS_SETUP" },
    { label: "App URL configured", status: appUrlConfigured ? "READY" : "NEEDS_SETUP" },
    {
      label: "Secure exam flow available",
      status: hasExam && hasQuestions && hasPublished && hasSubmission && hasGraded ? "READY" : "NEEDS_SETUP",
      detail: hasSecureModeConfigured
        ? "Secure Exam Mode configured on at least one exam"
        : "Secure Exam Mode available but not yet enabled on any exam",
    },
    {
      label: "Integrity events available",
      status: "READY",
      detail: `${integrityCount} event(s) recorded for your exams`,
    },
    { label: "Analytics available", status: "READY" },
    { label: "Evidence report available", status: "READY" },
  ];
  const coreReady = core.every((i) => i.status === "READY");

  // --- B. Optional Canvas readiness ---
  // All Canvas-related counts here are scoped to the caller's institution
  // (PLATFORM_ADMIN sees platform-wide totals) — these were previously
  // unscoped global counts, a cross-tenant leak (see
  // docs/multi-tenant-migration.md).
  const institutionFilter = isPlatformAdmin(session)
    ? {}
    : { institutionId: requireInstitutionId(session) };
  const platform = await prisma.ltiPlatform.findFirst({ where: institutionFilter });
  const totalLinkedResources = await prisma.ltiExamLink.count({
    where: { platform: institutionFilter },
  });
  const examLinkCount = await prisma.ltiExamLink.count({
    where: { exam: { createdById: lecturerId, ...institutionWhere(session) } },
  });
  const recentLaunch = await prisma.ltiLaunch.findFirst({
    where: { platform: institutionFilter },
    orderBy: { createdAt: "desc" },
  });
  const unmatchedCount = await countUnmatchedLaunches(session);
  const mostRecentSent = await prisma.canvasGradePassback.findFirst({
    where: { status: "SENT", submission: { exam: { ...institutionWhere(session) } } },
    orderBy: { sentAt: "desc" },
  });

  const canvasConfigured = ltiEnv.allPresent;
  const canvasOptional: ReadinessItem[] = [
    {
      label: "LTI keys configured",
      status: canvasConfigured ? "READY" : "NOT_CONFIGURED",
      detail: canvasConfigured ? undefined : "Optional Canvas module not configured",
    },
    {
      label: "Canvas platform configured",
      status: platform ? "READY" : "NOT_CONFIGURED",
      detail: platform ? platform.issuer : "Optional Canvas module not configured",
    },
    {
      label: "Linked Canvas resources",
      status: totalLinkedResources > 0 ? "READY" : "NOT_CONFIGURED",
      detail:
        totalLinkedResources > 0
          ? `${examLinkCount} of your exam(s) linked, ${totalLinkedResources} total`
          : "Optional Canvas module not configured",
    },
    {
      label: "LTI launch captured",
      status: recentLaunch ? "READY" : "NOT_CONFIGURED",
      detail: recentLaunch
        ? new Date(recentLaunch.createdAt).toLocaleString()
        : "Optional Canvas module not configured",
    },
    {
      label: "Canvas passback SENT",
      status: mostRecentSent ? "READY" : "WARNING",
      detail: mostRecentSent
        ? `Last SENT: ${new Date(mostRecentSent.sentAt ?? mostRecentSent.updatedAt).toLocaleString()}`
        : "Canvas validation pending — no passback has reached SENT yet",
    },
    {
      label: "Unmatched Canvas launches",
      status: unmatchedCount > 0 ? "WARNING" : "READY",
      detail:
        unmatchedCount > 0
          ? `${unmatchedCount} launch(es) waiting to be linked — open Unmatched Canvas Launches`
          : "No unmatched launches waiting",
    },
  ];

  // --- C. Optional AI readiness ---
  const aiOptional: ReadinessItem[] = [
    {
      label: "Anthropic key configured",
      status: aiEnv.allPresent ? "READY" : "NOT_CONFIGURED",
      detail: aiEnv.allPresent
        ? undefined
        : "AI assistance unavailable until API key is configured",
    },
    { label: "AI question generation available", status: "READY" },
    { label: "AI draft marking available", status: "READY" },
  ];

  // --- D. Deployment readiness (required) ---
  const deployment: ReadinessItem[] = [
    { label: "Production database configured", status: databaseConnected ? "READY" : "NEEDS_SETUP" },
    { label: "Public app URL configured", status: appUrlConfigured ? "READY" : "NEEDS_SETUP" },
    { label: "Auth secret configured", status: authSecretConfigured ? "READY" : "NEEDS_SETUP" },
    { label: "Health check available", status: "READY" },
    {
      label: "No required secret missing for standalone mode",
      status: requiredEnv.allPresent ? "READY" : "NEEDS_SETUP",
      detail: requiredEnv.allPresent
        ? undefined
        : `Missing: ${requiredEnv.checks.filter((c) => !c.present).map((c) => c.key).join(", ")}`,
    },
  ];

  return NextResponse.json({
    core,
    canvasOptional,
    aiOptional,
    deployment,
    coreReady,
    summary: {
      corePlatform: coreReady ? "Core platform ready" : "Core platform needs setup",
      canvas: canvasConfigured ? "Canvas module configured" : "Optional Canvas module not configured",
      ai: aiEnv.allPresent ? "AI module configured" : "Optional AI module not configured",
    },
  });
}

export const dynamic = "force-dynamic";
