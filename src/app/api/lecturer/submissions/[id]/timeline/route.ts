/**
 * Tether Integrity Evidence Timeline v1 — see
 * docs/integrity-evidence-timeline-v1.md.
 *
 * GET /api/lecturer/submissions/[id]/timeline
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  buildIntegrityEvidenceTimeline,
  IntegrityEvidenceTimelineForbiddenError,
  IntegrityEvidenceTimelineNotFoundError,
} from "@/lib/integrityEvidenceTimeline";
import { institutionErrorResponse } from "@/lib/institutionScope";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || (session.user.role !== "LECTURER" && session.user.role !== "PLATFORM_ADMIN")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const timeline = await buildIntegrityEvidenceTimeline(id, session);
    return NextResponse.json(timeline);
  } catch (err) {
    if (err instanceof IntegrityEvidenceTimelineNotFoundError) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (err instanceof IntegrityEvidenceTimelineForbiddenError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export const dynamic = "force-dynamic";
