import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  buildEvidenceReport,
  EvidenceForbiddenError,
  EvidenceNotFoundError,
} from "@/lib/evidenceReport";
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
    const report = await buildEvidenceReport(id, session);
    return NextResponse.json(report);
  } catch (err) {
    if (err instanceof EvidenceNotFoundError) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (err instanceof EvidenceForbiddenError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export const dynamic = "force-dynamic";
