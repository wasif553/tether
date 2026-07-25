/**
 * Tether Secure Client Foundation v1 — see
 * docs/secure-client-foundation-seb-v1.md.
 *
 * GET/PUT /api/lecturer/exams/[id]/secure-client/configuration
 */
import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { assertSameInstitution, institutionErrorResponse, isPlatformAdmin } from "@/lib/institutionScope";
import { createPlatformAuditLog } from "@/lib/platformAdmin";
import { createDraftConfiguration, updateDraftConfiguration, listMaskedSebAllowedExamKeys, SecureClientError } from "@/lib/secureClientRunner";
import { z } from "zod";

function findExamForPermissionCheck(examId: string) {
  return prisma.exam.findUnique({ where: { id: examId }, select: { id: true, createdById: true, institutionId: true } });
}
type ExamPermission = { response: NextResponse } | { session: Session; exam: NonNullable<Awaited<ReturnType<typeof findExamForPermissionCheck>>> };

async function requireExamPermission(examId: string): Promise<ExamPermission> {
  const session = await auth();
  if (!session || (session.user.role !== "LECTURER" && session.user.role !== "PLATFORM_ADMIN")) {
    return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const exam = await findExamForPermissionCheck(examId);
  if (!exam) return { response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  if (!isPlatformAdmin(session) && exam.createdById !== session.user.id) {
    return { response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  try {
    assertSameInstitution(session, exam.institutionId);
  } catch (err) {
    const response = institutionErrorResponse(err);
    if (response) return { response };
    throw err;
  }
  return { session, exam };
}

const configInputSchema = z.object({
  provider: z.enum(["SAFE_EXAM_BROWSER", "TETHER_SECURE_CLIENT"]),
  displayName: z.string().max(200).optional(),
  startUrlTemplate: z.string().max(500).optional(),
  quitUrlTemplate: z.string().max(500).optional(),
  allowedOrigins: z.array(z.string().max(300)).max(20).optional(),
  allowedPlatforms: z.array(z.string().max(50)).max(20).optional(),
  minimumVersions: z.record(z.string(), z.string().max(50)).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const permission = await requireExamPermission(id);
  if ("response" in permission) return permission.response;

  const configurations = await prisma.secureClientConfiguration.findMany({ where: { examId: id }, orderBy: { createdAt: "desc" } });
  const withKeys = await Promise.all(
    configurations.map(async (c) => ({
      id: c.id,
      provider: c.provider,
      status: c.status,
      displayName: c.displayName,
      configurationVersion: c.configurationVersion,
      configurationHash: c.configurationHash,
      startUrlTemplate: c.startUrlTemplate,
      quitUrlTemplate: c.quitUrlTemplate,
      allowedOrigins: c.allowedOriginsJson,
      allowedPlatforms: c.allowedPlatformsJson,
      activatedAt: c.activatedAt,
      revokedAt: c.revokedAt,
      sebKeys: await listMaskedSebAllowedExamKeys(c.id),
    })),
  );

  return NextResponse.json({ configurations: withKeys });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const permission = await requireExamPermission(id);
  if ("response" in permission) return permission.response;
  const { session, exam } = permission;

  const body = await req.json().catch(() => null);
  const parsed = configInputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const existingDraft = await prisma.secureClientConfiguration.findFirst({
    where: { examId: id, provider: parsed.data.provider, status: "DRAFT" },
  });

  try {
    const configuration = existingDraft
      ? await updateDraftConfiguration(existingDraft.id, parsed.data)
      : await createDraftConfiguration({ institutionId: exam.institutionId ?? "", examId: id, ...parsed.data }, session.user.id);

    createPlatformAuditLog({
      actorId: session.user.id,
      action: existingDraft ? "SECURE_CLIENT_CONFIGURATION_UPDATED" : "SECURE_CLIENT_CONFIGURATION_CREATED",
      targetType: "SecureClientConfiguration",
      targetId: configuration.id,
      institutionId: exam.institutionId,
      metadata: { examId: id, provider: parsed.data.provider },
    }).catch(() => {});

    return NextResponse.json({ ok: true, configurationId: configuration.id }, { status: existingDraft ? 200 : 201 });
  } catch (err) {
    if (err instanceof SecureClientError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    throw err;
  }
}

export const dynamic = "force-dynamic";
