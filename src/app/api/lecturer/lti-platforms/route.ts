import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const platforms = await prisma.ltiPlatform.findMany({
    select: { id: true, issuer: true },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json(platforms);
}

export const dynamic = "force-dynamic";
