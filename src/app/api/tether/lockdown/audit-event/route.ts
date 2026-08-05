/**
 * Tether Windows Lockdown Hardening v1 — POST /api/tether/lockdown/audit-event.
 * See docs/tether-windows-lockdown-hardening-v1.md, "Audit and evidence".
 *
 * The ONE place every PlatformAuditLog-only lockdown fact is written —
 * preflight blocked, process inspection unavailable, restoration
 * started/completed/failed, detection-service failure, an application
 * closed before content opened, a denied navigation/download/window-open,
 * a remote-session check that failed closed, a virtual-machine
 * indicator. Never IntegrityEvent (Part 11: these are technical/
 * administrative facts, not integrity signals) — the ONLY lockdown
 * signal that ever becomes an IntegrityEvent is a prohibited application
 * actually detected during an ACTIVE exam, which goes through the
 * existing POST /api/submissions/[id]/integrity-events route instead
 * (extended with the new event types — see that route's own comment).
 *
 * `action` is validated against a fixed allow-list
 * (isLockdownAuditAction) — the client can never write an arbitrary
 * free-text action string. Metadata is restricted to primitive values
 * and capped in size, mirroring every other bounded-metadata endpoint in
 * this codebase (see integrity-events/route.ts's own
 * metadataContainsMediaData guard) — never a raw process list, command-
 * line arguments, window contents, or a screenshot.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createPlatformAuditLog } from "@/lib/platformAdmin";
import { isLockdownAuditAction } from "@/lib/lockdownEventClassification";

const bodySchema = z
  .object({
    action: z.string().min(1).max(100),
    examId: z.string().min(1).max(100).optional(),
    submissionId: z.string().min(1).max(100).optional(),
    metadata: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean()])).optional(),
  })
  .refine((v) => Boolean(v.examId) !== Boolean(v.submissionId) || (!v.examId && !v.submissionId), {
    message: "Provide at most one of examId or submissionId.",
  });

export async function POST(req: Request) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  if (!isLockdownAuditAction(parsed.data.action)) {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  let targetType = "User";
  let targetId: string | null = session.user.id;
  let institutionId: string | null = null;

  if (parsed.data.submissionId) {
    const submission = await prisma.submission.findUnique({
      where: { id: parsed.data.submissionId },
      include: { exam: { select: { institutionId: true } } },
    });
    if (!submission || submission.studentId !== session.user.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    targetType = "Submission";
    targetId = submission.id;
    institutionId = submission.exam.institutionId;
  } else if (parsed.data.examId) {
    const exam = await prisma.exam.findUnique({ where: { id: parsed.data.examId }, select: { id: true, institutionId: true } });
    if (!exam) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    targetType = "Exam";
    targetId = exam.id;
    institutionId = exam.institutionId;
  }

  await createPlatformAuditLog({
    actorId: session.user.id,
    action: parsed.data.action,
    targetType,
    targetId,
    institutionId,
    metadata: parsed.data.metadata ?? null,
  });

  return NextResponse.json({ ok: true }, { status: 201 });
}

export const dynamic = "force-dynamic";
