import { NextResponse } from "next/server";

/**
 * Lets the Electron Lockdown Browser (or any future native client)
 * confirm it's talking to a real SES deployment and check minimum
 * supported version, without exposing any secret or session state.
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    app: "safe-exam-system",
    lockdownSupported: true,
    minVersion: "1.0.0",
  });
}

export const dynamic = "force-dynamic";
