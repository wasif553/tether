import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { institutionWhere, institutionErrorResponse } from "@/lib/institutionScope";

const createLinkSchema = z.object({
  platformId: z.string().min(1),
  resourceLinkId: z.string().min(1),
  canvasCourseId: z.string().optional(),
  canvasAssignmentId: z.string().optional(),
  label: z.string().optional(),
});

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ examId: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { examId } = await params;
  try {
    const exam = await prisma.exam.findFirst({
      where: { id: examId, createdById: session.user.id, ...institutionWhere(session) },
    });
    if (!exam) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const links = await prisma.ltiExamLink.findMany({
      where: { examId },
      include: { platform: { select: { issuer: true } } },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(links);
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ examId: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { examId } = await params;
  try {
    const exam = await prisma.exam.findFirst({
      where: { id: examId, createdById: session.user.id, ...institutionWhere(session) },
    });
    if (!exam) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const body = await req.json();
    const parsed = createLinkSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    // Tenant Isolation Hardening v1 — the exam above is already
    // institution-scoped, but the platform lookup previously used
    // findUnique({ where: { id } }) with no institution check, letting a
    // lecturer bind their own exam to another institution's LtiPlatform.
    // Scoped via the same institutionWhere() convention as everywhere
    // else — a cross-institution platform id now fails this query exactly
    // like a genuinely nonexistent one, so both hit the identical "Unknown
    // Canvas platform" response below (the pre-existing response shape for
    // "not found" is preserved unchanged; only the query's own scope
    // widened to also reject a foreign-institution match).
    const platform = await prisma.ltiPlatform.findFirst({
      where: { id: parsed.data.platformId, ...institutionWhere(session) },
    });
    if (!platform) {
      return NextResponse.json({ error: "Unknown Canvas platform" }, { status: 400 });
    }

    // parsed.data.platformId is already proven to belong to the caller's
    // own institution by the scoped fetch above — every LtiExamLink this
    // composite lookup can possibly return therefore also belongs to that
    // same institution (platformId -> exactly one platform -> at most one
    // institution). A lecturer can never observe or trigger a 409 caused
    // by a different institution's existing link through this route.
    const existing = await prisma.ltiExamLink.findUnique({
      where: {
        platformId_resourceLinkId: {
          platformId: parsed.data.platformId,
          resourceLinkId: parsed.data.resourceLinkId,
        },
      },
    });
    if (existing) {
      return NextResponse.json(
        { error: "This Canvas resource link is already linked to an exam" },
        { status: 409 },
      );
    }

    const link = await prisma.ltiExamLink.create({
      data: { ...parsed.data, examId },
    });

    return NextResponse.json(link, { status: 201 });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export const dynamic = "force-dynamic";
