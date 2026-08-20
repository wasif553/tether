import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isPlatformAdmin, requireInstitutionId, institutionErrorResponse } from "@/lib/institutionScope";

const linkSchema = z.object({
  examId: z.string().min(1),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  // Cross-Tenant Isolation Fix v1 — LtiLaunch has no institutionId column of
  // its own; institution scoping is applied at THIS fetch, through the
  // platform relation, exactly like the sibling GET /unmatched-launches
  // route and countUnmatchedLaunches (src/lib/lti/unmatchedLaunches.ts).
  // Knowledge of a launch id alone is never treated as authorization — a
  // launch belonging to another institution simply fails to match this
  // query, giving the exact same "not found" outcome as a launch that
  // genuinely doesn't exist, below. Never split these into different
  // responses (e.g. 403 "different institution") — that would turn this
  // route into a cross-tenant existence oracle.
  let launch;
  try {
    launch = await prisma.ltiLaunch.findFirst({
      where: {
        id,
        ...(isPlatformAdmin(session) ? {} : { platform: { institutionId: requireInstitutionId(session) } }),
      },
    });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }

  if (!launch || !launch.resourceLinkId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json();
  const parsed = linkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  // createdById alone is sufficient institution scoping here — Exam.createdById
  // is unique to one lecturer, and a lecturer's own institutionId is fixed at
  // account creation, so this already fully constrains the match to an exam
  // in the caller's own institution (same reasoning already relied on by the
  // sibling bulk-import/import-bank-questions lecturer routes).
  const exam = await prisma.exam.findFirst({
    where: { id: parsed.data.examId, createdById: session.user.id },
  });
  if (!exam) {
    return NextResponse.json({ error: "Exam not found" }, { status: 404 });
  }

  // launch.platformId is already proven to belong to the caller's own
  // institution by the institution-scoped fetch above — every LtiExamLink
  // this lookup can possibly return therefore also belongs to that same
  // institution (platformId -> exactly one platform -> at most one
  // institution). A lecturer can never observe or reassign a different
  // institution's existing link through this route.
  const existingLink = await prisma.ltiExamLink.findUnique({
    where: {
      platformId_resourceLinkId: {
        platformId: launch.platformId,
        resourceLinkId: launch.resourceLinkId,
      },
    },
  });

  let link;
  if (existingLink) {
    if (existingLink.examId !== exam.id) {
      return NextResponse.json(
        { error: "This Canvas resource is already linked to a different exam" },
        { status: 409 },
      );
    }
    link = existingLink;
  } else {
    link = await prisma.ltiExamLink.create({
      data: {
        examId: exam.id,
        platformId: launch.platformId,
        resourceLinkId: launch.resourceLinkId,
        canvasCourseId: launch.canvasCourseId || undefined,
        canvasAssignmentId: launch.canvasAssignmentId || undefined,
      },
    });
  }

  // Backfill every previously-unmatched launch for this resource link so the
  // unmatched-launches inbox and pilot readiness counts update immediately.
  // Scoped by launch.platformId, which — like the existingLink lookup above —
  // was already proven to belong to the caller's own institution by the
  // fetch at the top of this handler; this can never touch another
  // institution's launch rows.
  await prisma.ltiLaunch.updateMany({
    where: {
      platformId: launch.platformId,
      resourceLinkId: launch.resourceLinkId,
      examId: null,
    },
    data: { examId: exam.id },
  });

  return NextResponse.json({ linkId: link.id, examId: link.examId });
}

export const dynamic = "force-dynamic";
