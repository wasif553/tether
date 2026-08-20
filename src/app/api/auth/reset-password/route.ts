/**
 * Password Reset v1 — see docs/password-reset-v1.md. Public,
 * unauthenticated (proof of identity is the token itself).
 *
 * Never distinguishes unknown / expired / already-consumed token in its
 * response — see src/lib/passwordReset.ts's resetPasswordWithToken, whose
 * return type collapses all three into "invalid".
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { passwordSchema } from "@/lib/selfServiceSignup";
import { resetPasswordWithToken } from "@/lib/passwordReset";
import { resolveTrustedRequestSource } from "@/lib/security/clientSource";

const bodySchema = z
  .object({
    token: z.string().min(1),
    password: passwordSchema,
  })
  .strict();

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  }

  const sourceIp = resolveTrustedRequestSource(req);
  const { outcome, retryAfterSeconds } = await resetPasswordWithToken(parsed.data.token, parsed.data.password, sourceIp);

  if (outcome === "rate_limited") {
    return NextResponse.json(
      { ok: false, error: "rate_limited" },
      { status: 429, headers: retryAfterSeconds ? { "Retry-After": String(retryAfterSeconds) } : undefined },
    );
  }
  if (outcome !== "ok") {
    return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
