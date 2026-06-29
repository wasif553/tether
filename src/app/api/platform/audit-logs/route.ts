import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requirePlatformAdmin } from "@/lib/platformAdmin";

export async function GET(req: Request) {
  const session = await auth();
  const denied = requirePlatformAdmin(session);
  if (denied) return denied;

  const url = new URL(req.url);
  const limitParam = Number(url.searchParams.get("limit") ?? "50");
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(1, limitParam), 200) : 50;
  const institutionId = url.searchParams.get("institutionId") ?? undefined;
  const action = url.searchParams.get("action") ?? undefined;

  const logs = await prisma.platformAuditLog.findMany({
    where: {
      ...(institutionId ? { institutionId } : {}),
      ...(action ? { action } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      actorId: true,
      actor: { select: { name: true, email: true } },
      action: true,
      targetType: true,
      targetId: true,
      institutionId: true,
      metadata: true,
      createdAt: true,
    },
  });

  return NextResponse.json(logs);
}

export const dynamic = "force-dynamic";
