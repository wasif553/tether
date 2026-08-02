/**
 * Tether Secure Exam Recovery and Resilient Autosave v1 — see
 * docs/tether-secure-resume-recovery-v1.md, "Server-authoritative
 * recovery state" (Part 1).
 *
 * GET /api/submissions/[id]/recovery-status — the ONE place the student
 * exam page and the lecturer submissions surface both read a submission's
 * current recovery state from (see src/lib/tetherRecoveryRunner.ts's own
 * doc comment: "the ONE read path every recovery-status surface must
 * call"). Student-only, own submission only — a lecturer's own view of
 * this same information goes through
 * GET /api/lecturer/submissions/[id]/recovery-status instead (narrower,
 * lecturer-safe fields only — see Part 12).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { resolveSubmissionRecoveryState } from "@/lib/tetherRecoveryRunner";
import { RECOVERY_STATE_COPY } from "@/lib/tetherRecovery";

const querySchema = z.object({
  // A client claim only — see ResolveRecoveryStateInput.requestingInstallationId's
  // own doc comment in src/lib/tetherRecovery.ts. Optional: an ordinary
  // browser, or a Tether instance that hasn't registered an installation
  // yet, simply omits it.
  installationId: z.string().min(1).max(100).optional(),
});

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const url = new URL(req.url);
  const parsedQuery = querySchema.safeParse({ installationId: url.searchParams.get("installationId") ?? undefined });
  const requestingInstallationId = parsedQuery.success ? (parsedQuery.data.installationId ?? null) : null;

  const status = await resolveSubmissionRecoveryState({
    submissionId: id,
    requestingUserId: session.user.id,
    requestingInstallationId,
  });
  if (!status) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const copy = RECOVERY_STATE_COPY[status.state];
  return NextResponse.json({
    state: status.state,
    label: copy.label,
    detail: copy.detail,
    redirectTo: status.redirectTo,
    resumeCount: status.resumeCount,
    lastResumedAt: status.lastResumedAt,
    lastAutosaveAcknowledgedAt: status.lastAutosaveAcknowledgedAt,
    lastServerContactAt: status.lastServerContactAt,
    deadline: status.deadline,
  });
}

export const dynamic = "force-dynamic";
