/**
 * Tether Secure Client Foundation v1 — see
 * docs/secure-client-foundation-seb-v1.md and Part 13 of the spec.
 *
 * POST /api/submissions/[id]/secure-client/mock-launch
 *
 * Issues a launch manifest for the MOCK_TETHER_CLIENT development
 * simulator ONLY. Never available in Production; requires an explicit
 * server-side environment flag AND an authorised test institution — a
 * frontend query parameter can never enable this (Part 9/13).
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { candidateOriginFromHeaders, resolveCanonicalOrigin, buildOriginAllowlist } from "@/lib/secureClient/canonicalOrigin";
import { isMockSecureClientAllowed } from "@/lib/secureClientAvailability";
import { SecureClientError, loadValidatedSecureClientSubmission, issueLaunchManifest } from "@/lib/secureClientRunner";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  let context;
  try {
    context = await loadValidatedSecureClientSubmission(id, session.user.id);
  } catch (err) {
    if (err instanceof SecureClientError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    throw err;
  }

  const institution = context.submission.institutionId
    ? await prisma.institution.findUnique({ where: { id: context.submission.institutionId }, select: { slug: true } })
    : null;

  if (!isMockSecureClientAllowed(institution?.slug ?? null)) {
    return NextResponse.json({ error: "The Tether Secure Client development simulator is not available." }, { status: 403 });
  }

  const allowlist = buildOriginAllowlist(process.env.APP_URL);
  const canonicalOrigin = resolveCanonicalOrigin(candidateOriginFromHeaders(req.headers), allowlist);

  const { manifest, signature } = await issueLaunchManifest({
    institutionId: context.submission.institutionId ?? "",
    examId: context.submission.examId,
    submissionId: context.submission.id,
    studentId: context.submission.studentId,
    configurationId: null,
    clientType: "MOCK_TETHER_CLIENT",
    policy: context.policy,
    canonicalExamOrigin: canonicalOrigin,
    launchPath: `/student/exams/${context.submission.examId}`,
    audience: "tether-secure-client",
  });

  return NextResponse.json({ manifest, signature }, { status: 201 });
}

export const dynamic = "force-dynamic";
