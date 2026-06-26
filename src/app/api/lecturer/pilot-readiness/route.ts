import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getRequiredEnvStatus, getLtiEnvStatus, getAiEnvStatus } from "@/lib/env/readiness";
import { countUnmatchedLaunches } from "@/lib/lti/unmatchedLaunches";

type Status = "READY" | "NEEDS_SETUP" | "NOT_CONFIGURED" | "WARNING";

type ReadinessItem = {
  label: string;
  status: Status;
  detail?: string;
};

export async function GET() {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const lecturerId = session.user.id;

  const exams = await prisma.exam.findMany({
    where: { createdById: lecturerId },
    include: {
      questions: { select: { id: true } },
      submissions: { select: { id: true, status: true } },
    },
  });

  const hasExam = exams.length > 0;
  const hasQuestions = exams.some((e) => e.questions.length > 0);
  const hasPublished = exams.some((e) => e.published);
  const hasSubmission = exams.some((e) => e.submissions.length > 0);
  const hasGraded = exams.some((e) => e.submissions.some((s) => s.status === "GRADED"));

  const coreExamFlow: ReadinessItem[] = [
    { label: "Exam creation available", status: hasExam ? "READY" : "NEEDS_SETUP" },
    { label: "Questions available", status: hasQuestions ? "READY" : "NEEDS_SETUP" },
    { label: "Exam published", status: hasPublished ? "READY" : "NEEDS_SETUP" },
    { label: "Student submission tested", status: hasSubmission ? "READY" : "NEEDS_SETUP" },
    { label: "Grading tested", status: hasGraded ? "READY" : "NEEDS_SETUP" },
  ];

  const ltiEnv = getLtiEnvStatus();
  const platform = await prisma.ltiPlatform.findFirst();
  const examLinkCount = await prisma.ltiExamLink.count({
    where: { exam: { createdById: lecturerId } },
  });
  const recentLaunch = await prisma.ltiLaunch.findFirst({ orderBy: { createdAt: "desc" } });
  const launchWithAgs = await prisma.ltiLaunch.findFirst({
    where: { agsScopeJson: { not: "JsonNull" } },
    orderBy: { createdAt: "desc" },
  });
  const passbackCount = await prisma.canvasGradePassback.count();
  const totalLinkedResources = await prisma.ltiExamLink.count();
  const unmatchedCount = await countUnmatchedLaunches();
  const mostRecentSent = await prisma.canvasGradePassback.findFirst({
    where: { status: "SENT" },
    orderBy: { sentAt: "desc" },
  });
  const mostRecentPassback = await prisma.canvasGradePassback.findFirst({
    orderBy: { updatedAt: "desc" },
  });

  const canvasLti: ReadinessItem[] = [
    {
      label: "LTI platform configured",
      status: platform ? "READY" : "NOT_CONFIGURED",
      detail: platform ? platform.issuer : "Run the seed script or register a Canvas platform",
    },
    { label: "JWKS available", status: ltiEnv.checks.find((c) => c.key === "LTI_PUBLIC_KEY")?.present ? "READY" : "NOT_CONFIGURED" },
    { label: "Config URL available", status: ltiEnv.checks.find((c) => c.key === "LTI_PRIVATE_KEY")?.present ? "READY" : "NOT_CONFIGURED" },
    {
      label: "At least one exam linked to a Canvas resource link",
      status: examLinkCount > 0 ? "READY" : "NEEDS_SETUP",
    },
    {
      label: "Linked Canvas resources",
      status: totalLinkedResources > 0 ? "READY" : "NEEDS_SETUP",
      detail: `${totalLinkedResources} resource(s) linked`,
    },
    {
      label: "Unmatched Canvas launches",
      status: unmatchedCount > 0 ? "WARNING" : "READY",
      detail:
        unmatchedCount > 0
          ? `${unmatchedCount} launch(es) waiting to be linked — open Unmatched Canvas Launches`
          : "No unmatched launches waiting",
    },
    {
      label: "Recent LTI launch captured",
      status: recentLaunch ? "READY" : "NEEDS_SETUP",
      detail: recentLaunch ? new Date(recentLaunch.createdAt).toLocaleString() : undefined,
    },
    {
      label: "Canvas AGS claims captured",
      status: launchWithAgs ? "READY" : "NEEDS_SETUP",
    },
    {
      label: "Grade passback status available",
      status: passbackCount > 0 ? "READY" : "NEEDS_SETUP",
      detail: mostRecentPassback
        ? `Most recent: ${mostRecentPassback.status}`
        : undefined,
    },
    {
      label: "Live Canvas passback verified (SENT)",
      status: mostRecentSent ? "READY" : "WARNING",
      detail: mostRecentSent
        ? `Last SENT: ${new Date(mostRecentSent.sentAt ?? mostRecentSent.updatedAt).toLocaleString()}`
        : "Real Canvas validation still required — no passback has reached SENT yet",
    },
  ];

  const integrityCount = await prisma.integrityEvent.count({
    where: { exam: { createdById: lecturerId } },
  });

  const integrityAndAnalytics: ReadinessItem[] = [
    {
      label: "Integrity events enabled",
      status: "READY",
      detail: `${integrityCount} event(s) recorded for your exams`,
    },
    { label: "Analytics page available", status: "READY" },
    { label: "CSV export available", status: "READY" },
  ];

  const aiEnv = getAiEnvStatus();
  const aiFeatures: ReadinessItem[] = [
    {
      label: "ANTHROPIC_API_KEY configured",
      status: aiEnv.allPresent ? "READY" : "WARNING",
      detail: aiEnv.allPresent ? undefined : "AI question generation and essay marking will return a safe error until this is set",
    },
    { label: "AI question generation route available", status: "READY" },
    { label: "AI essay marking route available", status: "READY" },
  ];

  const requiredEnv = getRequiredEnvStatus();
  let databaseConnected = true;
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    databaseConnected = false;
  }

  const deployment: ReadinessItem[] = [
    {
      label: "AUTH_SECRET configured",
      status: requiredEnv.checks.find((c) => c.key === "AUTH_SECRET")?.present ? "READY" : "NOT_CONFIGURED",
    },
    {
      label: "APP_URL configured",
      status: requiredEnv.checks.find((c) => c.key === "APP_URL")?.present ? "READY" : "NOT_CONFIGURED",
    },
    { label: "LTI keys configured", status: ltiEnv.allPresent ? "READY" : "NOT_CONFIGURED" },
    { label: "Database connected", status: databaseConnected ? "READY" : "WARNING" },
    {
      label: "No obvious missing required environment variables",
      status: requiredEnv.allPresent ? "READY" : "NOT_CONFIGURED",
      detail: requiredEnv.allPresent
        ? undefined
        : `Missing: ${requiredEnv.checks.filter((c) => !c.present).map((c) => c.key).join(", ")}`,
    },
  ];

  return NextResponse.json({
    coreExamFlow,
    canvasLti,
    integrityAndAnalytics,
    aiFeatures,
    deployment,
  });
}

export const dynamic = "force-dynamic";
