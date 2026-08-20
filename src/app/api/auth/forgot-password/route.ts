/**
 * Password Reset v1 — see docs/password-reset-v1.md. Public,
 * unauthenticated. One flow for STUDENT and LECTURER alike.
 *
 * The response is deliberately identical — same status, same body — for
 * every case: an existing account, a nonexistent account, an unsupported
 * account condition, or an ordinary delivery failure. See
 * src/lib/passwordReset.ts's requestPasswordReset for why: it never
 * throws and never returns anything this route could branch on, so there
 * is no code path here by which a caller's response could reveal whether
 * a given email is registered.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requestPasswordReset } from "@/lib/passwordReset";
import { resolveTrustedRequestSource } from "@/lib/security/clientSource";

const bodySchema = z
  .object({
    email: z.string().trim().min(1),
  })
  .strict();

const GENERIC_MESSAGE = "If an account exists for that email, we've sent password reset instructions.";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);

  if (parsed.success) {
    try {
      const sourceIp = resolveTrustedRequestSource(req);
      await requestPasswordReset(parsed.data.email, sourceIp);
    } catch (err) {
      console.error(
        "Password reset request failed unexpectedly",
        err instanceof Error ? err.message : "unknown error",
      );
    }
  }

  return NextResponse.json({ message: GENERIC_MESSAGE });
}

export const dynamic = "force-dynamic";
