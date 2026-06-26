import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  buildEvidenceReport,
  evidenceReportToCsv,
  EvidenceForbiddenError,
  EvidenceNotFoundError,
} from "@/lib/evidenceReport";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const report = await buildEvidenceReport(id, session.user.id);
    const csv = evidenceReportToCsv(report);
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="evidence-${id}.csv"`,
      },
    });
  } catch (err) {
    if (err instanceof EvidenceNotFoundError) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (err instanceof EvidenceForbiddenError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    throw err;
  }
}

export const dynamic = "force-dynamic";
