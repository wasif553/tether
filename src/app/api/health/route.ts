import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import packageJson from "../../../../package.json";

export async function GET() {
  let database: "ok" | "error" = "ok";
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    database = "error";
  }

  return NextResponse.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    database,
    version: packageJson.version,
  });
}

export const dynamic = "force-dynamic";
