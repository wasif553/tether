import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

/**
 * Platform admin v1 — read-only institution list. Creating institutions or
 * inviting lecturers is deferred to "Multi-Tenant Admin v2" (see
 * docs/multi-tenant-migration.md); for v1, new institutions are created
 * manually via direct DB insert or the seed script.
 */
export async function GET() {
  const session = await auth();
  if (!session || session.user.role !== "PLATFORM_ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const institutions = await prisma.institution.findMany({
    select: {
      id: true,
      name: true,
      slug: true,
      plan: true,
      active: true,
      createdAt: true,
      _count: { select: { users: true, exams: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json(institutions);
}

export const dynamic = "force-dynamic";
