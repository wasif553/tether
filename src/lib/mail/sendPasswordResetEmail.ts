/**
 * Password Reset v1 — see docs/password-reset-v1.md.
 *
 * The one place a reset email is actually dispatched. Provider-specific
 * code (the Resend SDK call) stays entirely behind this function's
 * provider-independent signature (`{ to, resetUrl }`) — a future provider
 * swap only needs to change this file. Never logs the plaintext token or
 * the full reset URL (which contains it); never returns the reset link to
 * a caller. Tests mock this module rather than calling a real provider.
 */
import { Resend } from "resend";

let cachedClient: Resend | null = null;

function getClient(apiKey: string): Resend {
  if (!cachedClient) cachedClient = new Resend(apiKey);
  return cachedClient;
}

function buildTextBody(resetUrl: string): string {
  return [
    "Reset your Tether password",
    "",
    "We received a request to reset the password for your Tether account.",
    "Use the link below to choose a new password. This link expires in 30 minutes.",
    "",
    resetUrl,
    "",
    "If you did not request this, you can safely ignore this email — your password will not be changed.",
  ].join("\n");
}

function buildHtmlBody(resetUrl: string): string {
  const safeUrl = resetUrl.replace(/"/g, "&quot;");
  return `<!doctype html>
<html>
  <body style="font-family: -apple-system, Helvetica, Arial, sans-serif; color: #111;">
    <p>We received a request to reset the password for your Tether account.</p>
    <p>
      <a href="${safeUrl}" style="display:inline-block;padding:10px 16px;background:#000;color:#fff;text-decoration:none;border-radius:6px;">
        Reset password
      </a>
    </p>
    <p>This link expires in 30 minutes.</p>
    <p>If you did not request this, you can safely ignore this email — your password will not be changed.</p>
  </body>
</html>`;
}

export async function sendPasswordResetEmail(params: { to: string; resetUrl: string }): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.PASSWORD_RESET_FROM_EMAIL;
  if (!apiKey || !from) {
    throw new Error("Password reset email is not configured (RESEND_API_KEY / PASSWORD_RESET_FROM_EMAIL missing).");
  }

  const resend = getClient(apiKey);
  const { error } = await resend.emails.send({
    from,
    to: params.to,
    subject: "Reset your Tether password",
    text: buildTextBody(params.resetUrl),
    html: buildHtmlBody(params.resetUrl),
  });

  if (error) {
    throw new Error(`Password reset email provider rejected the send request: ${error.name ?? "unknown error"}`);
  }
}
