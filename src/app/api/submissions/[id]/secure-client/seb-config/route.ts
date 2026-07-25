/**
 * Tether Secure Client Foundation v1 — see
 * docs/secure-client-foundation-seb-v1.md and Part 4 of the spec.
 *
 * GET /api/submissions/[id]/secure-client/seb-config
 *
 * Authenticated, short-lived, student-owned `.seb` configuration
 * download. Never caches by shared proxies, never places a secret in the
 * URL, and never allows directory traversal (the filename is always
 * server-derived, never taken from the request).
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { SecureClientError, loadValidatedSecureClientSubmission } from "@/lib/secureClientRunner";
import { generatePlainSebConfig } from "@/lib/secureClient/sebConfigGenerator";
import { buildOriginAllowlist } from "@/lib/secureClient/canonicalOrigin";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
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

  if (context.policy.deliveryMode !== "SEB_REQUIRED" && context.policy.deliveryMode !== "SEB_OPTIONAL") {
    return NextResponse.json({ error: "This exam does not use Safe Exam Browser" }, { status: 403 });
  }

  const config = await prisma.secureClientConfiguration.findFirst({
    where: { examId: context.submission.examId, provider: "SAFE_EXAM_BROWSER", status: "ACTIVE" },
  });
  if (!config) {
    return NextResponse.json({ error: "No active Safe Exam Browser configuration exists for this exam" }, { status: 404 });
  }

  const allowlist = buildOriginAllowlist(process.env.APP_URL);
  const origin = allowlist[0];
  const startUrl = config.startUrlTemplate?.replace("{examId}", context.submission.examId).replace("{submissionId}", context.submission.id) ?? `${origin}/student/exams/${context.submission.examId}`;
  const quitUrl = config.quitUrlTemplate ?? `${origin}/student`;

  const configBytes = generatePlainSebConfig({
    startUrl,
    quitUrl,
    allowedOrigins: [origin, ...((config.allowedOriginsJson as string[] | null) ?? [])],
    allowPrinting: context.policy.allowPrinting,
    allowClipboard: context.policy.allowClipboard,
    allowExternalNavigation: context.policy.allowExternalNavigation,
    maximumDisplays: context.policy.maximumDisplays,
    configurationName: config.displayName ?? "Tether Exam",
  });

  await prisma.secureClientEvent.create({
    data: {
      submissionId: context.submission.id,
      examId: context.submission.examId,
      institutionId: context.submission.institutionId ?? "",
      eventType: "SECURE_CLIENT_LAUNCH_REQUESTED",
      eventLevel: "INFORMATIONAL",
      metadataJson: {},
    },
  }).catch(() => {});

  return new NextResponse(configBytes, {
    status: 200,
    headers: {
      "Content-Type": "application/seb",
      "Content-Disposition": 'attachment; filename="tether-exam.seb"',
      "Cache-Control": "private, no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
    },
  });
}

export const dynamic = "force-dynamic";
