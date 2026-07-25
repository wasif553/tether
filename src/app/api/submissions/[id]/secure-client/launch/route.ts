/**
 * Tether Secure Client Foundation v1 — see
 * docs/secure-client-foundation-seb-v1.md.
 *
 * POST /api/submissions/[id]/secure-client/launch
 *
 * Issues a short-lived, single-use signed launch manifest for this
 * attempt. The raw nonce is returned to the caller exactly once — only
 * its hash is ever persisted.
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { candidateOriginFromHeaders, resolveCanonicalOrigin, buildOriginAllowlist } from "@/lib/secureClient/canonicalOrigin";
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

  const activeConfig = await prisma.secureClientConfiguration.findFirst({
    where: { examId: context.submission.examId, status: "ACTIVE" },
  });

  const allowlist = buildOriginAllowlist(process.env.APP_URL);
  const candidateOrigin = candidateOriginFromHeaders(req.headers);
  const canonicalOrigin = resolveCanonicalOrigin(candidateOrigin, allowlist);

  const clientType = activeConfig?.provider === "TETHER_SECURE_CLIENT" ? "TETHER_SECURE_CLIENT" : "SAFE_EXAM_BROWSER";

  const { manifest, signature } = await issueLaunchManifest({
    institutionId: context.submission.institutionId ?? "",
    examId: context.submission.examId,
    submissionId: context.submission.id,
    studentId: context.submission.studentId,
    configurationId: activeConfig?.id ?? null,
    clientType,
    policy: context.policy,
    canonicalExamOrigin: canonicalOrigin,
    launchPath: `/student/exams/${context.submission.examId}`,
    audience: "tether-secure-client",
  });

  await prisma.secureClientEvent.create({
    data: {
      submissionId: context.submission.id,
      examId: context.submission.examId,
      institutionId: context.submission.institutionId ?? "",
      eventType: "SECURE_CLIENT_LAUNCH_REQUESTED",
      eventLevel: "INFORMATIONAL",
    },
  }).catch(() => {});

  return NextResponse.json({ manifest, signature }, { status: 201 });
}

export const dynamic = "force-dynamic";
