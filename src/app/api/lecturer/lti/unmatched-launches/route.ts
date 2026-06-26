import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { maskSubject, unmatchedLaunchWhere } from "@/lib/lti/unmatchedLaunches";

export async function GET() {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const launches = await prisma.ltiLaunch.findMany({
    where: unmatchedLaunchWhere(),
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  const platforms = await prisma.ltiPlatform.findMany({
    where: { id: { in: [...new Set(launches.map((l) => l.platformId))] } },
    select: { id: true, issuer: true },
  });
  const issuerByPlatformId = new Map(platforms.map((p) => [p.id, p.issuer]));

  return NextResponse.json(
    launches.map((l) => ({
      id: l.id,
      createdAt: l.createdAt,
      platformId: l.platformId,
      platformIssuer: issuerByPlatformId.get(l.platformId) ?? "Unknown platform",
      resourceLinkId: l.resourceLinkId,
      deploymentId: l.deploymentId,
      canvasCourseId: l.canvasCourseId || null,
      canvasAssignmentId: l.canvasAssignmentId,
      launchRole: l.launchRole,
      subject: maskSubject(l.canvasUserId),
      status: "UNMATCHED",
    })),
  );
}

export const dynamic = "force-dynamic";
