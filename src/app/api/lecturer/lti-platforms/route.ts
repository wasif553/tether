import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { institutionWhere, institutionErrorResponse } from "@/lib/institutionScope";

export async function GET() {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Tenant Isolation Hardening v1 — this previously queried every
  // LtiPlatform row with no institution filter at all, so any lecturer
  // could enumerate every institution's Canvas platform ids/issuers. Scoped
  // via the same institutionWhere() convention used throughout the
  // lecturer API surface — this route accepts LECTURER only (see the role
  // check above), so institutionWhere's internal PLATFORM_ADMIN bypass is
  // never reachable here; it's kept only because institutionWhere is
  // always used as-is, never partially reimplemented.
  try {
    const platforms = await prisma.ltiPlatform.findMany({
      where: { ...institutionWhere(session) },
      select: { id: true, issuer: true },
      orderBy: { createdAt: "asc" },
    });

    return NextResponse.json(platforms);
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export const dynamic = "force-dynamic";
